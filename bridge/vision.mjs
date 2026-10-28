/**
 * bridge/vision.mjs —— 图片/贴纸识别（下载媒体 → base64 → 视觉模型 → 一句描述）
 * ============================================================================
 * 为什么需要：Telegram 贴纸的 alt（关联 emoji）**不一定反映真实画面**
 * —— 一个画着"晚安"的贴纸，alt 可能是 💛，只看 alt 会理解错。
 *
 * ⚠️ max_tokens 别给小：视觉模型也可能带思考，给 120 会被 thinking 吃光（见 llm.mjs 注释）。
 * ============================================================================
 */
import sharp from 'sharp'
import { detectLlmBase } from './config.mjs'

async function toBase64Png(buf) {
  const out = await sharp(buf)
    .resize(384, 384, { fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer()
  return out.toString('base64')
}

/**
 * @param {object} cfg 完整配置
 * @param {Buffer} buf 原始图片字节（webp/png/jpg 均可）
 * @param {string} hint 提示这是什么（贴纸/图片/动图）
 * @returns {Promise<string|null>}
 */
export async function describeImage(cfg, buf, hint = '贴纸') {
  if (!buf || buf.length === 0) return null
  let b64
  try { b64 = await toBase64Png(buf) } catch (e) {
    console.error('[vision] 图片转换失败:', e?.message ?? e)
    return null
  }

  const base = detectLlmBase(cfg.llm)
  const key = cfg.llm.apiKey || 'local'
  const model = cfg.llm.visionModel || cfg.llm.models[0]
  const prompt = `用户发来一张 Telegram ${hint}。请用简短中文描述它的画面内容和传达的情绪，20 字以内，不要加引号。`

  const body = (maxTokens) => JSON.stringify({
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
      ],
    }],
    max_tokens: maxTokens,
  })

  for (const maxTokens of [400, 1200]) {
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: body(maxTokens),
        signal: AbortSignal.timeout(45000),
      })
      if (!res.ok) { console.error('[vision] 网关返回', res.status); return null }
      const j = await res.json()
      const text = (j?.choices?.[0]?.message?.content ?? '').trim()
      if (text) return text
    } catch (e) {
      console.error('[vision] 识别失败:', e?.message ?? e)
      return null
    }
  }
  return null
}
