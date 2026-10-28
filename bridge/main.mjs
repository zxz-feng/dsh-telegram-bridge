#!/usr/bin/env node
/**
 * bridge/main.mjs —— Telegram 桥主循环（子进程）
 * ============================================================================
 * 它做的事，按顺序：
 *   1. 读配置（缺 apiId/apiHash 或没 session 就**不连**，只在状态里说明）
 *   2. 连上 → 启动补漏（离线期间漏掉的消息）
 *   3. 监听新消息 → 防抖合并 → 生成 → 按 mode 发出去（auto / draft）
 *   4. 60 秒轮询兜底（GramJS 的 update loop 会**静默死掉**，日志干净得很）
 *   5. 开本机控制口（127.0.0.1 + token）给 `npm run verify` 和外部看护用
 *   6. 收 IPC 命令（宿主工具的 send/pause/status/config…）
 *   7. SIGTERM / shutdown → 等在途回复发完再退（systemctl restart 会杀进程）
 *
 * 可以单独跑：`BRIDGE_HOME=~/.dsh/telegram-bridge node bridge/main.mjs`
 * ============================================================================
 */
import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { NewMessage } from 'telegram/events/index.js'
import { FloodWaitError } from 'telegram/errors/index.js'
import { Api } from 'telegram'
import { loadConfig, saveConfig } from './config.mjs'
import { makeClient, loadSession, hasSession } from './client.mjs'
import { ensurePersonaDir, personaVersion, personaSizes } from './persona.mjs'
import { describeMessage } from './media.mjs'
import { generateReply, seedContext, contextInfo, clearContext } from './reply.mjs'
import { sendSticker, stickerCount } from './sticker.mjs'
import { backfill } from './backfill.mjs'
import { startControl } from './control.mjs'
import { T } from '../lib/protocol.mjs'

// ── 家目录 & 配置 ─────────────────────────────────────
const HOME = process.env.BRIDGE_HOME || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'telegram-bridge')
let cfg = loadConfig(HOME)
let pdir = ensurePersonaDir(cfg).dir

const INBOX = join(HOME, 'inbox.jsonl')
const DRAFTS = join(HOME, 'drafts.jsonl')

function reloadCfg() {
  cfg = loadConfig(HOME)
  pdir = ensurePersonaDir(cfg).dir
  return cfg
}

// ── 运行态 ────────────────────────────────────────────
let client = null
let connected = false
let authorized = false
let me = null
let inflight = 0
let inflightSince = 0
let stuckCount = 0
let shuttingDown = false
let lastActivityAt = Date.now()
let control = { port: 0, close: () => {} }
const seenIds = new Set()
const sentIds = new Set()
const pending = new Map()      // chatId → { msgs, peerName, timer }
const seededChats = new Set()
const counters = { received: 0, replied: 0, failed: 0, skipped: 0 }

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function send(m, cb) {
  try { process.send?.(m, cb) } catch { /* 独立跑的时候没有 IPC */ }
}

// ── 发送 ──────────────────────────────────────────────
async function safeSend(peer, text) {
  for (let i = 0; i < 3; i += 1) {
    try {
      const sent = await client.sendMessage(peer, { message: text })
      if (sent?.id) sentIds.add(sent.id)
      return sent
    } catch (e) {
      if (e instanceof FloodWaitError) {
        log(`  FloodWait ${e.seconds}s…`)
        await sleep((e.seconds + 2) * 1000)
        continue
      }
      throw e
    }
  }
  throw new Error('发送失败（FloodWait 三次）')
}

// ── 上下文 ────────────────────────────────────────────
async function recentContext(chatId) {
  try {
    await client.getDialogs({ limit: 200 })
    const peer = await client.getInputEntity(chatId)
    const out = []
    for await (const m of client.iterMessages(peer, { limit: cfg.behavior.ctxTurns })) {
      out.push(`${m.out ? '我' : '对方'}: ${m.message ?? '[媒体]'}`)
    }
    return out.reverse()
  } catch { return [] }
}

// ── 主流程 ────────────────────────────────────────────
function decision(event, msg) {
  if (event.isPrivate === true) {
    if (cfg.direct.mode === 'off') return { ok: false }
    const s = String(msg.senderId ?? '')
    if (!cfg.direct.users.includes(s)) return { ok: false }
    if (cfg.direct.paused.includes(s)) return { ok: false, paused: true, chatId: String(msg.chatId) }
    return { ok: true, chatId: String(msg.chatId) }
  }
  if (cfg.groups.mode !== 'allowlist') return { ok: false }
  const cid = String(event.chatId ?? '')
  const variants = [cid, cid.replace(/^-100/, ''), `-100${cid}`, `-${cid}`]
  return variants.some((v) => cfg.groups.chats.includes(v)) ? { ok: true, chatId: cid } : { ok: false }
}

function randomDelay() {
  const lo = cfg.behavior.debounceMinSec * 1000
  const hi = cfg.behavior.debounceMaxSec * 1000
  if (hi <= lo) return lo
  return lo + Math.floor(Math.random() * (hi - lo))
}

/** 事件流和轮询兜底共用的单条处理 */
async function handleOne(m, event) {
  try {
    reloadCfg()
    if (!m || m.out) return
    if (sentIds.has(m.id)) return
    if (m.sender?.bot === true) return
    seenIds.add(m.id)
    lastActivityAt = Date.now()

    const desc = await describeMessage(cfg, m, { client })
    if (!desc) return

    const d = decision(event, m)
    const chatId = d.chatId ?? String(m.chatId ?? '')
    if (d.paused) {
      appendFileSync(INBOX, JSON.stringify({
        ts: new Date().toISOString(), chatId, senderId: String(m.senderId),
        text: desc.text, kind: desc.kind, msgId: m.id, mode: 'paused',
      }) + '\n')
      log(`[${new Date().toLocaleTimeString('zh-CN')}] [${chatId}] ${desc.text}  (已暂停，不回)`)
      counters.skipped += 1
      return
    }
    if (!d.ok) return

    counters.received += 1
    const peerName = m.sender?.firstName ?? '对方'
    log(`[${new Date().toLocaleTimeString('zh-CN')}] [${chatId}] ${desc.text}${desc.kind !== 'text' ? `  (${desc.kind})` : ''}`)
    appendFileSync(INBOX, JSON.stringify({
      ts: new Date().toISOString(), chatId, senderId: String(m.senderId),
      senderName: peerName, text: desc.text, kind: desc.kind, msgId: m.id, mode: cfg.mode,
    }) + '\n')

    let e = pending.get(chatId)
    if (!e) { e = { msgs: [], peerName, timer: null }; pending.set(chatId, e) }
    e.msgs.push(desc.text)
    if (e.timer) clearTimeout(e.timer)
    const wait = randomDelay()
    e.timer = setTimeout(() => { void flush(chatId) }, wait)
    log(`  ⏳ 排队 ${e.msgs.length} 条，${(wait / 1000).toFixed(1)}s 无新消息则回复`)
  } catch (err) {
    log('[handler]', err?.message ?? err)
  }
}

async function flush(chatId) {
  const entry = pending.get(chatId)
  if (!entry) return
  pending.delete(chatId)
  inflight += 1
  if (inflight === 1) inflightSince = Date.now()
  try {
    await flushInner(chatId, entry)
  } catch (e) {
    counters.failed += 1
    log('  ❌ 生成/发送失败:', e?.message ?? e)
  } finally {
    inflight -= 1
    if (inflight === 0) { inflightSince = 0; stuckCount = 0 }
    else if (Date.now() - inflightSince > 90000) stuckCount += 1
  }
}

async function flushInner(chatId, entry) {
  const combined = entry.msgs.join('\n')

  // 首次对话：把真实历史当背景注入一次
  if (!seededChats.has(chatId)) {
    seededChats.add(chatId)
    try {
      const hist = await recentContext(chatId)
      if (hist.length && seedContext({ home: HOME, chatId, historyLines: hist, peerName: entry.peerName, maxTurns: cfg.llm.maxTurns })) {
        log(`  [tg] 已注入 ${hist.length} 条历史背景`)
      }
    } catch (e) { log('  [tg] 历史注入失败:', e?.message ?? e) }
  }

  log(`  模式 ${cfg.mode}，生成中（聚合 ${entry.msgs.length} 条）…`)
  const result = await generateReply({
    cfg, home: HOME, pdir, chatId, incoming: combined, peerName: entry.peerName,
  })
  if (!result?.parts?.length && !result?.stickers?.length) {
    log('  ❌ 模型返回空')
    counters.failed += 1
    return
  }
  log(`  💬 ${result.parts.map((x, i) => `[${i + 1}] ${x}`).join('  ')}`)

  if (cfg.mode === 'auto') {
    for (let i = 0; i < result.parts.length; i += 1) {
      await safeSend(chatId, result.parts[i])
      if (i < result.parts.length - 1) await sleep(800 + Math.random() * 1700)
    }
    let stickerSent = false
    if (result.stickers?.length && cfg.sticker?.enabled !== false && stickerCount(HOME) > 0) {
      await sleep(600 + Math.random() * 900)
      stickerSent = await sendSticker(HOME, client, chatId, result.stickers[0], { Api })
    }
    appendFileSync(DRAFTS, JSON.stringify({
      ts: new Date().toISOString(), chatId, incoming: combined, draft: result.text,
      parts: result.parts, stickers: result.stickers, stickerSent, status: 'sent',
    }) + '\n')
    counters.replied += 1
    log(`  ✅ 已发出（${result.parts.length} 条文字${stickerSent ? ' + 1 张表情' : ''}）`)
  } else {
    appendFileSync(DRAFTS, JSON.stringify({
      ts: new Date().toISOString(), chatId, incoming: combined, draft: result.text,
      parts: result.parts, stickers: result.stickers, status: 'pending',
    }) + '\n')
    log(`  📝 待发送（模式 ${cfg.mode}）：${result.text}`)
  }
}

// ── 连接 ──────────────────────────────────────────────
async function connect() {
  if (!cfg.enabled) { log('配置 enabled=false，不连'); return false }
  if (!cfg.account.apiId || !cfg.account.apiHash) { log('缺 apiId/apiHash，不连（用 tg_config 填）'); return false }
  if (!hasSession(HOME)) { log('没有 session.txt，不连（用 tg_login_start 登录）'); return false }

  client = makeClient(cfg, loadSession(HOME))
  await client.connect()
  connected = true
  authorized = await client.checkAuthorization().catch(() => false)
  if (!authorized) {
    log('session 在，但授权失败（可能要重新登录 / 代理不通）')
    await client.disconnect().catch(() => {})
    connected = false
    return false
  }
  me = await client.getMe().catch(() => null)
  client.__selfId = String(me?.id ?? '')
  const name = [me?.firstName, me?.lastName].filter(Boolean).join(' ') || me?.username || '未知'
  log(`已登录: ${name}（id ${client.__selfId}）`)
  log(`私信白名单: ${cfg.direct.users.length ? cfg.direct.users.join(', ') : '(空)'}`
    + ` | 暂停: ${cfg.direct.paused.length ? cfg.direct.paused.join(', ') : '(无)'}`)
  log(`群聊: ${cfg.groups.mode}${cfg.groups.mode === 'allowlist' ? ` → ${cfg.groups.chats.join(',')}` : ''}`)
  log(`模式: ${cfg.mode}`)

  // 补漏
  try {
    const rs = await backfill({
      client, cfg, home: HOME, pdir,
      send: async (chatId, text) => { await safeSend(chatId, text) },
    })
    const sent = rs.filter((r) => r.status === 'sent')
    log(sent.length ? `补漏: 补了 ${sent.length} 个会话` : '补漏: 没有需要补的')
  } catch (e) {
    log('补漏失败（不影响监听）:', e?.message ?? e)
  }

  // 种入历史 id：轮询只处理"启动之后新来的"
  try {
    for (const chatId of cfg.direct.users) {
      try {
        const peer = await client.getInputEntity(chatId)
        for await (const m of client.iterMessages(peer, { limit: 5 })) {
          seenIds.add(m.id)
          if (m.out) sentIds.add(m.id)
        }
      } catch { /* 单个会话失败不影响启动 */ }
    }
    log(`已种入历史 id ${seenIds.size} 条`)
  } catch (e) { log('种入历史 id 失败:', e?.message ?? e) }

  client.addEventHandler(async (event) => { await handleOne(event.message, event) }, new NewMessage({}))
  log('监听中…')
  return true
}

async function reconnect(why) {
  log(`[guard] 重连（${why}）`)
  try { await client?.disconnect() } catch { /* 忽略 */ }
  connected = false
  try {
    await client?.connect()
    connected = true
    authorized = await client.checkAuthorization().catch(() => false)
  } catch (e) {
    log('[guard] 重连失败:', e?.message ?? e)
  }
}

// ── 轮询兜底 ──────────────────────────────────────────
// GramJS 的 _updateLoop 在网络抖动时会**静默死掉**：不报错、不退出、就是收不到消息。
async function pollMissed() {
  if (shuttingDown || !connected) return
  for (const chatId of cfg.direct.users) {
    if (cfg.direct.paused.includes(chatId)) continue
    try {
      const peer = await client.getInputEntity(chatId)
      const recent = []
      for await (const m of client.iterMessages(peer, { limit: 4 })) recent.push(m)
      const missed = recent
        .filter((m) => !m.out && !sentIds.has(m.id) && !seenIds.has(m.id))
        .sort((a, b) => a.id - b.id)
      if (!missed.length) continue
      log(`[poll] 事件流漏了 ${missed.length} 条（${chatId}），补处理`)
      for (const m of missed) {
        await handleOne(m, { isPrivate: true, chatId: m.chatId ?? Number(chatId), message: m })
      }
      log('[poll] 重连以恢复 update 循环…')
      await reconnect('轮询发现漏消息')
    } catch (e) {
      log(`[poll] ${chatId} 检查失败:`, e?.message ?? e)
    }
  }
}

// ── 状态 ──────────────────────────────────────────────
function status() {
  return {
    configured: Boolean(cfg.account.apiId && cfg.account.apiHash),
    hasSession: hasSession(HOME),
    connected,
    authorized,
    me: me ? ([me.firstName, me.lastName].filter(Boolean).join(' ') || me.username) : '',
    account: client?.__selfId ? `id ${client.__selfId}` : '',
    mode: cfg.mode,
    direct: { count: cfg.direct.users.length, paused: cfg.direct.paused.length },
    groups: cfg.groups,
    inflight,
    inflightSince,
    stuckCount,
    lastActivityAt,
    counters,
    persona: { name: cfg.personaName, version: personaVersion(pdir), sizes: personaSizes(cfg, pdir), dir: pdir },
    stickers: stickerCount(HOME),
    control: { port: control.port },
    selfHeal: cfg.selfHeal,
    uptimeSec: Math.round(process.uptime()),
    pid: process.pid,
  }
}

// ── 控制动作（IPC 和 HTTP 共用一套）────────────────────
const actions = {
  async status() { return status() },

  async send({ chatId, text }) {
    if (!chatId || !text) throw new Error('send 需要 chatId 和 text')
    if (!connected || !authorized) throw new Error('还没连上/没授权，发不了')
    const sent = await safeSend(String(chatId), String(text))
    return { ok: true, messageId: sent?.id ?? null, chatId: String(chatId) }
  },

  async pause({ chatId, paused = true }) {
    const id = String(chatId)
    const list = new Set(reloadCfg().direct.paused)
    if (paused) list.add(id); else list.delete(id)
    saveConfig(HOME, { direct: { paused: [...list] } })
    reloadCfg()
    return { ok: true, paused: paused ? list.has(id) : false, pausedList: [...list] }
  },

  async config({ patch }) {
    if (!patch || typeof patch !== 'object') return { ok: true, config: reloadCfg() }
    saveConfig(HOME, patch)
    const next = reloadCfg()
    return { ok: true, config: next }
  },

  async reload() { return { ok: true, config: reloadCfg() } },

  async contexts() {
    return cfg.direct.users.map((id) => contextInfo(HOME, id, cfg))
  },

  async context_clear({ chatId }) {
    if (!chatId) throw new Error('context_clear 需要 chatId')
    return { ok: clearContext(HOME, String(chatId)) }
  },

  async restart_self() {
    log('[control] 收到 restart_self，退出等宿主拉起')
    setTimeout(() => { void gracefulExit('restart_self') }, 50)
    return { ok: true }
  },
}

async function runAction(name, params = {}) {
  const fn = actions[name]
  if (!fn) throw new Error(`未知动作：${name}`)
  return fn(params)
}

// ── IPC ───────────────────────────────────────────────
process.on('message', (m) => {
  if (!m || typeof m !== 'object') return
  if (m.t === T.SHUTDOWN) { void gracefulExit('ipc-shutdown'); return }
  if (m.t === T.CMD) {
    runAction(m.action, m.params)
      .then((data) => send({ t: T.REPLY, id: m.id, ok: true, data }))
      .catch((e) => send({ t: T.REPLY, id: m.id, ok: false, error: String(e?.message ?? e) }))
  }
})

// ── 退出 ──────────────────────────────────────────────
async function gracefulExit(sig) {
  if (shuttingDown) return
  shuttingDown = true
  log(`收到 ${sig}：在途 ${inflight} 条，等它们发完…`)
  const deadline = Date.now() + 25000
  while (inflight > 0 && Date.now() < deadline) await sleep(400)
  if (inflight > 0) log(`⚠️ 还有 ${inflight} 条没发完，超时退出`)
  try { control.close() } catch { /* 忽略 */ }
  try { await client?.disconnect() } catch { /* 忽略 */ }
  process.exit(0)
}
process.on('SIGTERM', () => { void gracefulExit('SIGTERM') })
process.on('SIGINT', () => { void gracefulExit('SIGINT') })

// 子进程自己的崩溃防护（在插件里跑时，这些异常**不会**影响宿主）
process.on('uncaughtException', (e) => {
  const msg = e?.message ?? String(e)
  if (/TIMEOUT|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket/i.test(msg)) log(`[guard] 网络异常: ${msg}（继续）`)
  else log(`[guard] 未捕获异常: ${msg}`)
})
process.on('unhandledRejection', (r) => {
  const msg = r?.message ?? String(r)
  if (/TIMEOUT|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket/i.test(msg)) log(`[guard] 未处理拒绝（网络）: ${msg}`)
  else log(`[guard] 未处理拒绝: ${msg}`)
})

// ── 启动 ──────────────────────────────────────────────
log(`=== Telegram 桥（家目录 ${HOME}）===`)
log(`人设目录 ${pdir}；模式 ${cfg.mode}；防抖 ${cfg.behavior.debounceMinSec}~${cfg.behavior.debounceMaxSec}s；轮询 ${cfg.behavior.pollSec}s`)

control = await startControl({ home: HOME, cfg, handlers: actions })

try {
  const ok = await connect()
  if (!ok) log('（未连接，但控制口和工具仍可用：配好 apiId/apiHash + 登录后会自动连）')
} catch (e) {
  log('连接失败:', e?.message ?? e)
}

if (cfg.behavior.pollSec > 0) {
  setInterval(() => { void pollMissed() }, cfg.behavior.pollSec * 1000)
}

// 心跳：每 5 分钟确认授权还活着，断了就重连
setInterval(async () => {
  if (shuttingDown || !connected) return
  try {
    const ok = await client.checkAuthorization().catch(() => false)
    if (!ok) await reconnect('心跳发现授权失效')
  } catch (e) {
    log('[guard] 心跳异常:', e?.message ?? e)
  }
}, 5 * 60 * 1000)

send({ t: T.READY, info: { home: HOME, mode: cfg.mode, controlPort: control.port, account: client?.__selfId ?? '' } })
log('就绪')
