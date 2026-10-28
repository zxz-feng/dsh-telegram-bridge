/**
 * bridge/sticker.mjs —— 按情绪词挑一张贴纸并发出去
 * ============================================================================
 * 索引文件：`<home>/stickers-index.json`（**属于你账号的贴纸集**，不随插件发布）
 *   [{ id, accessHash, fileReference, emoji, mime, desc, tags[] }, ...]
 * 生成：`node scripts/import-stickers.mjs`（遍历你装了的贴纸集 + 视觉识别）
 *
 * 匹配优先级（踩出来的顺序，别随便调）：
 *   1. 标签完全命中  2. 标签互相包含  3. 描述包含  4. emoji 兜底
 * 同类多个候选随机选，避免每次都发同一张。
 *
 * ⚠️ fileReference 会过期。失败就静默降级不发表情（别因此中断整条回复）。
 * ============================================================================
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

let cache = null
let cacheAt = 0
let cacheKey = ''

function indexFile(home) { return join(home, 'stickers-index.json') }

/** 读索引（60 秒缓存；文件改了会重读） */
export function pool(home) {
  const now = Date.now()
  const f = indexFile(home)
  if (cache && cacheKey === f && now - cacheAt < 60_000) return cache
  cacheKey = f
  cacheAt = now
  try {
    const list = JSON.parse(readFileSync(f, 'utf8'))
    cache = Array.isArray(list) ? list : []
  } catch { cache = [] }
  return cache
}

export function stickerCount(home) { return pool(home).length }

function pickFrom(list) {
  if (!list.length) return null
  return list[Math.floor(Math.random() * list.length)]
}

/**
 * 按情绪词挑一张
 * @param {string} home
 * @param {string} query 情绪词，如「嫌弃」「开心」「晚安」
 */
export function pickSticker(home, query = '') {
  const list = pool(home)
  if (!list.length) return null
  const q = String(query).trim()
  if (!q) return pickFrom(list)

  let hit = list.filter((s) => Array.isArray(s.tags) && s.tags.includes(q))
  if (hit.length) return pickFrom(hit)

  hit = list.filter((s) => Array.isArray(s.tags) && s.tags.some((t) => t && (t.includes(q) || q.includes(t))))
  if (hit.length) return pickFrom(hit)

  hit = list.filter((s) => s.desc && s.desc.includes(q))
  if (hit.length) return pickFrom(hit)

  hit = list.filter((s) => s.emoji && s.emoji === q)
  if (hit.length) return pickFrom(hit)

  return null
}

function randomLong() {
  const b = randomBytes(8)
  let v = BigInt(`0x${b.toString('hex')}`)
  if (v > 0x7fffffffffffffffn) v -= 0x10000000000000000n
  return v
}

/**
 * 发一张贴纸
 * @returns {Promise<boolean>} 发出去没有
 */
export async function sendSticker(home, client, peer, query, { Api } = {}) {
  if (!Api) return false
  const s = pickSticker(home, query)
  if (!s) {
    console.log(`  [sticker] 没有匹配「${query}」的贴纸${pool(home).length ? '' : '（索引为空，跑 scripts/import-stickers.mjs）'}`)
    return false
  }
  try {
    await client.invoke(new Api.messages.SendMedia({
      peer,
      media: new Api.InputMediaDocument({
        id: new Api.InputDocument({
          id: BigInt(s.id),
          accessHash: BigInt(s.accessHash),
          fileReference: Buffer.from(s.fileReference ?? '', 'base64'),
        }),
      }),
      message: '',
      randomId: randomLong(),
    }))
    console.log(`  [sticker] 发「${query}」→ ${s.emoji || '-'} ${s.desc || ''}`)
    return true
  } catch (e) {
    console.error(`  [sticker] 发送失败（${s.emoji || s.id}）: ${e?.message ?? e}`)
    return false
  }
}

/** 所有标签按出现次数排序（给提示词里的"可用情绪词"用） */
export function allTags(home) {
  const m = new Map()
  for (const s of pool(home)) {
    for (const t of s.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1)
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1])
}
