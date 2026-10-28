/**
 * bridge/reply.mjs —— 生成一条回复（分层人设 + 多句 + 贴纸标记 + 上下文）
 * ============================================================================
 * 这里有几个踩出来的规矩，改之前先看：
 *   1. **上下文里只存对话，从不存 system**：人设不随轮数累积膨胀（省 token 的关键）。
 *   2. **分层发送**：首次 / 每 reanchorEvery 轮 / 人设文件改动后 → 完整人设；其余 → 精简。
 *   3. **每轮末尾再钉一次锚定**（ANCHOR），比系统提示更"近"，短回复更听话。
 *   4. 输出格式：`|||` 分多条（最多 3 条），`[[sticker:情绪词]]` 配表情包。
 *   5. 没有文字只有贴纸也算合法输出（用户直接说"发个表情包"时就这样）。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chat, usageLine } from './llm.mjs'
import { fullPersona, shortPersona, anchor, personaVersion, personaSizes } from './persona.mjs'
import { allTags } from './sticker.mjs'

function ctxDir(home) {
  const d = join(home, 'contexts')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

function loadStore(home, chatId) {
  try {
    const raw = JSON.parse(readFileSync(join(ctxDir(home), `${chatId}.json`), 'utf8'))
    if (Array.isArray(raw)) return { pv: null, msgs: raw }
    if (raw && Array.isArray(raw.msgs)) return { pv: raw.pv ?? null, msgs: raw.msgs }
  } catch { /* 没文件 / 坏了，当空 */ }
  return { pv: null, msgs: [] }
}

function saveStore(home, chatId, pv, msgs, maxTurns) {
  writeFileSync(join(ctxDir(home), `${chatId}.json`),
    JSON.stringify({ pv, msgs: msgs.slice(-maxTurns * 2) }, null, 2))
}

let tagCache = ''
let tagCacheAt = 0

function stickerTags(home) {
  const now = Date.now()
  if (tagCache && now - tagCacheAt < 5 * 60 * 1000) return tagCache
  try {
    tagCache = allTags(home).slice(0, 20).map(([t]) => t).join('、')
    tagCacheAt = now
  } catch { tagCache = '' }
  return tagCache
}

function buildPrompt(cfg, pdir, home, useFull) {
  const base = useFull ? fullPersona(cfg, pdir) : shortPersona(cfg, pdir)
  if (cfg.sticker?.enabled === false) return base
  const tags = stickerTags(home)
  if (!tags) return base
  return useFull
    ? `${base}\n\n【贴纸词表】情绪词只能从这些里选：${tags}`
    : `${base}\n【贴纸词表】${tags}`
}

/**
 * 解析模型输出：拆多条文本 + 贴纸标记
 *   "哈哈 ||| 真的假的 [[sticker:开心]]" → { parts:['哈哈','真的假的'], stickers:['开心'] }
 */
export function parseReply(raw, { maxParts = 3 } = {}) {
  const stickers = []
  let text = String(raw ?? '')
  text = text.replace(/\[\[sticker[:：]\s*([^\]]+)\]\]/gi, (_, emo) => { stickers.push(String(emo).trim()); return ' ' })
  const parts = text
    .split(/\|\|\|/)
    .map((x) => x.replace(/\n{2,}/g, ' ').replace(/\n/g, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean)
    .slice(0, maxParts)
  return { parts, stickers }
}

/**
 * 生成回复
 * @param {object} o
 * @param {object} o.cfg
 * @param {string} o.home
 * @param {string} o.pdir   人设目录
 * @param {string} o.chatId
 * @param {string} o.incoming 对方发来的文本
 * @param {string} [o.peerName]
 */
export async function generateReply({ cfg, home, pdir, chatId, incoming, peerName = '' }) {
  const store = loadStore(home, chatId)
  const ctx = store.msgs
  const pv = personaVersion(pdir)

  const turns = Math.floor(ctx.length / 2)
  const isFirst = ctx.length === 0
  const needReanchor = turns > 0 && turns % cfg.llm.reanchorEvery === 0
  const personaChanged = store.pv !== pv
  const useFull = isFirst || needReanchor || personaChanged

  const userText = String(incoming ?? '').slice(0, cfg.llm.maxChars)
  const messages = [
    { role: 'system', content: buildPrompt(cfg, pdir, home, useFull) },
    ...ctx,
    { role: 'user', content: peerName ? `[${peerName}] ${userText}` : userText },
    { role: 'system', content: anchor(cfg) },
  ]

  if (isFirst) console.log(`  [tg] ${chatId} 首次对话 → 完整人设`)
  else if (personaChanged) console.log(`  [tg] ${chatId} 人设已改动 → 补发完整人设`)
  else if (needReanchor) console.log(`  [tg] ${chatId} 第 ${turns} 轮 → 重锚`)

  const effort = useFull ? cfg.llm.effortFull : cfg.llm.effortShort
  const { text: raw, model, usage } = await chat(cfg, messages, { effort })
  const { parts, stickers } = parseReply(raw)
  const joined = parts.join(' ')

  console.log(`  [tg] ${model} | 人设${useFull ? '全' : '简'} | ${usageLine(usage, effort)}`
    + (parts.length > 1 ? ` | ${parts.length} 条` : '')
    + (stickers.length ? ` | 贴纸 ${stickers.join(',')}` : ''))

  ctx.push({ role: 'user', content: userText })
  ctx.push({ role: 'assistant', content: joined })
  saveStore(home, chatId, pv, ctx, cfg.llm.maxTurns)

  return { text: joined, parts, stickers, model, usage, personaFull: useFull }
}

/** 首次对话前注入真实聊天历史当背景（只在上下文为空时生效） */
export function seedContext({ home, chatId, historyLines, peerName = '', maxTurns = 12 }) {
  const store = loadStore(home, chatId)
  if (store.msgs.length > 0) return false
  if (!Array.isArray(historyLines) || historyLines.length === 0) return false
  const summary = historyLines.slice(-20).join('\n')
  const seed = [
    { role: 'user', content: `[背景] 以下是我和「${peerName}」之前的聊天记录，仅供你了解关系与语气，不要直接复述：\n${summary}` },
    { role: 'assistant', content: '好，我知道了。' },
  ]
  saveStore(home, chatId, store.pv, seed, maxTurns)
  return true
}

export function contextInfo(home, chatId, cfg) {
  const s = loadStore(home, chatId)
  return { chatId, turns: Math.floor(s.msgs.length / 2), pv: s.pv }
}

export function clearContext(home, chatId) {
  try {
    writeFileSync(join(ctxDir(home), `${chatId}.json`), JSON.stringify({ pv: null, msgs: [] }, null, 2))
    return true
  } catch { return false }
}

export function personaInfo(cfg, pdir) {
  return { name: cfg.personaName, ...personaSizes(cfg, pdir), reanchorEvery: cfg.llm.reanchorEvery }
}
