#!/usr/bin/env node
/**
 * bridge/login.mjs —— 交互式登录（被插件按需拉起，用完就退）
 * ============================================================================
 * 为什么单独一个进程：
 *   登录要"先在手机收到码、再把它输回来"，跨了好几次工具调用。如果塞进主循环，
 *   主循环就得维护一堆中间状态，而且登录失败会连带影响正常收消息。
 *   这里做成一个**长驻但短命**的进程：宿主写一行 JSON 进来，这里回一行 JSON 出去。
 *
 * 协议（stdin/stdout，一行一个 JSON）：
 *   入：{ "type": "code", "value": "12345" } / { "type": "password", "value": "..." } / { "type": "cancel" }
 *   出：{ "event": "ready" } → { "event": "need-code" } → …
 *       { "event": "ok", "me": "名字", "id": "123" } | { "event": "error", "message": "..." }
 *
 * session 成功时写 `<home>/session.txt`（600 权限）。**它就是账号本身，别外传。**
 * ============================================================================
 */
import { createInterface } from 'node:readline'
import { makeClient, saveSession } from './client.mjs'

const out = (obj) => {
  try { process.stdout.write(`${JSON.stringify(obj)}\n`) } catch { /* 父进程没了 */ }
}

const waiters = new Map()
function nextInput(kind, timeoutMs = 5 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(kind)
      reject(new Error(`等 ${kind} 超时（${Math.round(timeoutMs / 60000)} 分钟），重新来一次`))
    }, timeoutMs)
    waiters.set(kind, (v) => { clearTimeout(timer); resolve(v) })
  })
}

function deliver(msg) {
  const w = waiters.get(msg.type)
  if (w) { waiters.delete(msg.type); w(String(msg.value ?? '')); return }
  if (msg.type === 'cancel') {
    for (const [, fn] of waiters) fn('')
    out({ event: 'cancelled' })
    setTimeout(() => process.exit(0), 50)
  }
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const s = line.trim()
  if (!s) return
  try { deliver(JSON.parse(s)) } catch { out({ event: 'warn', message: '收到非 JSON 行，忽略' }) }
})

// ── 参数：从环境变量取（宿主 spawn 时传）──────────────
const cfg = JSON.parse(process.env.BRIDGE_CFG || '{}')
const HOME = process.env.BRIDGE_HOME || ''
const phone = String(process.env.BRIDGE_PHONE || '').replace(/[^\d+]/g, '')

if (!cfg?.account?.apiId || !cfg?.account?.apiHash) {
  out({ event: 'error', message: '缺 apiId/apiHash：先 tg_config 填 account.apiId / account.apiHash' })
  process.exit(1)
}
if (!phone) {
  out({ event: 'error', message: '缺手机号：tg_login_start 里传 phone（国际格式，例 +8613800138000）' })
  process.exit(1)
}

out({ event: 'ready', phone })

try {
  const client = makeClient(cfg, '')
  await client.connect()

  const me = await client.signInUser(
    { apiId: Number(cfg.account.apiId), apiHash: cfg.account.apiHash },
    {
      phoneNumber: async () => phone,
      phoneCode: async () => {
        out({ event: 'need-code' })
        return String(await nextInput('code')).trim()
      },
      password: async () => {
        out({ event: 'need-password' })
        return String(await nextInput('password'))
      },
      onError: (err) => {
        const msg = String(err?.message ?? err)
        // 验证码错了要能让用户重输，别直接退出
        if (/PHONE_CODE_INVALID|PHONE_CODE_EXPIRED|PHONE_CODE_EMPTY/i.test(msg)) {
          out({ event: 'bad-code', message: msg })
          return true          // true = 继续（GramJS 会再次要验证码）
        }
        if (/PASSWORD_HASH_INVALID/i.test(msg)) {
          out({ event: 'bad-password', message: msg })
          return true
        }
        out({ event: 'error', message: msg })
        return false
      },
    },
  )

  const sessionStr = client.session.save()
  if (!sessionStr || sessionStr.length < 20) throw new Error('拿到的 session 是空的，登录没成功')
  saveSession(HOME, sessionStr)
  const name = [me?.firstName, me?.lastName].filter(Boolean).join(' ') || me?.username || '已登录'
  out({ event: 'ok', me: name, id: String(me?.id ?? '') })
  try { await client.disconnect() } catch { /* 忽略 */ }
  process.exit(0)
} catch (e) {
  out({ event: 'error', message: String(e?.message ?? e).slice(0, 300) })
  process.exit(1)
}
