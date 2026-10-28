/**
 * bridge/llm.mjs —— 生成用的模型客户端（子进程侧，只用 HTTP，不依赖宿主）
 * ============================================================================
 * 为什么不用宿主那棵树里的 ctx.llm：
 *   bridge 是**独立进程**（可以单跑、可以被 systemd 管），拿不到宿主的服务对象。
 *   为了「同一份代码在哪都能跑」，这里就走 OpenAI 兼容 HTTP，配置里填地址和 key。
 *   宿主那一侧只管进程和工具，不参与生成。
 *
 * ⚠️ 2026-10-28 踩到的坑（已在 QQ 侧复现并修）：
 *   `reasoning_effort` 会把 `max_tokens` 预算算进 thinking 里，一起花。
 *   上限给小了（比如 300）⇒ thinking 吃满、`finish_reason=length`、正文是空字符串，
 *   换哪个模型都"空回复"。所以这里：
 *     ① 空内容 + finish=length ⇒ **去掉推理档重试一次**，额度翻三倍；
 *     ② 调用方仍然该给足上限（≥600）。
 * ============================================================================
 */
import { detectLlmBase } from './config.mjs'

async function once(base, key, model, messages, { maxTokens, temperature, effort, timeoutMs }) {
  const body = { model, messages, max_tokens: maxTokens, temperature }
  if (effort) body.reasoning_effort = effort
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const j = await res.json()
  const c = j?.choices?.[0]
  return { text: (c?.message?.content ?? '').trim(), finish: c?.finish_reason ?? '', usage: j?.usage ?? null }
}

/**
 * @param {object} cfg   完整配置
 * @param {Array}  messages
 * @param {{maxTokens?:number, temperature?:number, effort?:string}} opts
 * @returns {Promise<{text:string, model:string, usage:any}>}
 */
export async function chat(cfg, messages, { maxTokens = 2000, temperature = 0.8, effort } = {}) {
  const base = detectLlmBase(cfg.llm)
  const key = cfg.llm.apiKey || 'local'
  const timeoutMs = cfg.llm.timeoutMs
  const errors = []

  for (const model of cfg.llm.models) {
    try {
      let r = await once(base, key, model, messages, { maxTokens, temperature, effort, timeoutMs })
      if (!r.text && r.finish === 'length') {
        r = await once(base, key, model, messages, {
          maxTokens: Math.min(Math.max(maxTokens * 3, 600), 8000),
          temperature, effort: undefined, timeoutMs,
        })
        if (r.text) errors.push(`${model}: 推理档吃满预算，已降级重试`)
      }
      if (r.text) return { text: r.text, model, usage: r.usage }
      errors.push(`${model}: 空回复(finish=${r.finish || '?'})`)
    } catch (e) {
      errors.push(`${model}: ${e?.message ?? e}`)
    }
  }
  throw new Error(`所有模型失败: ${errors.join(' | ')}`)
}

/** 用量一行，方便日志里看每轮花多少 */
export function usageLine(usage, effort) {
  const u = usage ?? {}
  const think = u.completion_tokens_details?.reasoning_tokens ?? u.completion_thinking_tokens ?? 0
  const cached = u.prompt_cache_hit_tokens ?? 0
  return `推理${effort || '-'} 入${u.prompt_tokens ?? '?'}(缓存${cached}) 出${u.completion_tokens ?? '?'}(想${think})`
}
