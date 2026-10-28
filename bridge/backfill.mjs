/**
 * bridge/backfill.mjs —— 启动补漏：离线期间对方发了我没回的消息，补一次
 * ============================================================================
 * 规则（都踩过，别改）：
 *   · 只看白名单私聊，暂停的人不补
 *   · 从最新往前找，遇到"我发的"就停（说明后面都回过了）
 *   · 太老（backfillHours，默认 6h）不补 —— 补了反而奇怪
 *   · 多条未回合并成一次输入，只回一次（避免刷屏）
 *   · ⚠️ **收藏夹（自己）绝对不能补**：Saved Messages 里自己发的回复 `out` 也是 false，
 *     分不清谁说的，会把历史合并成一条莫名其妙的回复（2026-10-28 实测踩过）
 * ============================================================================
 */
import { describeMessage } from './media.mjs'
import { generateReply, seedContext } from './reply.mjs'

const MAX_LOOKBACK = 30
const MAX_AGE_HOURS = 6

/**
 * @param {object} o
 * @param {object} o.client
 * @param {object} o.cfg
 * @param {string} o.home
 * @param {string} o.pdir
 * @param {(chatId:string, text:string)=>Promise<any>} o.send
 * @returns {Promise<Array<{chatId,label,unanswered,reply,status}>>}
 */
export async function backfill({ client, cfg, home, pdir, send, hours = MAX_AGE_HOURS }) {
  const results = []
  const paused = new Set((cfg.direct?.paused ?? []).map(String))
  const selfId = String(client.__selfId ?? '')
  const users = (cfg.direct?.users ?? [])
    .map(String)
    .filter((u) => u !== selfId)
    .filter((u) => !paused.has(u))
  if (!users.length) return results

  const labels = cfg.direct?.labels ?? {}
  const cutoff = Date.now() - hours * 3600 * 1000
  try { await client.getDialogs({ limit: 200 }) } catch { /* 忽略 */ }

  for (const chatId of users) {
    const label = labels[chatId] ?? chatId
    try {
      const peer = await client.getInputEntity(chatId)
      const msgs = []
      for await (const m of client.iterMessages(peer, { limit: MAX_LOOKBACK })) msgs.push(m)
      msgs.reverse()

      const unanswered = []
      for (let i = msgs.length - 1; i >= 0; i -= 1) {
        const m = msgs[i]
        if (m.out) break
        if ((m.date ?? 0) * 1000 < cutoff) break
        unanswered.unshift(m)
      }
      if (!unanswered.length) continue

      const parts = []
      for (const m of unanswered.slice(-6)) {
        const d = await describeMessage(cfg, m, { client })
        if (d?.text) parts.push(d.text)
      }
      if (!parts.length) continue

      const incoming = parts.join('\n')
      console.log(`[backfill] ${label}: ${unanswered.length} 条未回`)

      try {
        const hist = []
        for await (const m of client.iterMessages(peer, { limit: 20 })) {
          hist.push(`${m.out ? '我' : label}: ${m.message ?? '[媒体]'}`)
        }
        hist.reverse()
        if (hist.length) seedContext({ home, chatId, historyLines: hist, peerName: label, maxTurns: cfg.llm.maxTurns })
      } catch { /* 忽略 */ }

      const result = await generateReply({ cfg, home, pdir, chatId, incoming, peerName: label })
      if (!result?.parts?.length) {
        results.push({ chatId, label, unanswered: unanswered.length, reply: null, status: 'empty' })
        continue
      }
      for (let i = 0; i < result.parts.length; i += 1) {
        await send(chatId, result.parts[i])
        if (i < result.parts.length - 1) await new Promise((r) => setTimeout(r, 1200))
      }
      console.log(`  💬 补回: ${result.text}`)
      results.push({ chatId, label, unanswered: unanswered.length, reply: result.text, status: 'sent' })
    } catch (e) {
      console.error(`[backfill] ${label} 失败: ${e?.message ?? e}`)
      results.push({ chatId, label, reply: null, status: 'error', error: e?.message ?? String(e) })
    }
  }
  return results
}
