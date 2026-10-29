#!/usr/bin/env node
/**
 * test/api.mjs —— 设置页那组 HTTP 路由的离线测试（零 token、不连 Telegram、不起桥）
 * ============================================================================
 * 为什么值得单独一份：设置页最容易出的错不是「界面难看」，是
 *   · 前端能改的东西后端没钳位（填 999 就真写 999）
 *   · 脱敏漏了（apiHash / apiKey 原样吐给浏览器）
 *   · 打码串被当成新值存回去（存成「••••3456」，下次登录直接废）
 *   · 路由挂上了但同源没判（随便一个网页就能改配置、能点登录）
 * 这四类都能在没账号的机器上验完。
 *
 * 跑：`node test/api.mjs`（`npm test` 会顺带跑）
 * ============================================================================
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'

const HOME = mkdtempSync(join(tmpdir(), 'tgapi-'))
process.env.DSH_HOME = HOME
process.env.DSH_TELEGRAM_HOME = join(HOME, 'telegram-bridge')

const { apply } = await import('../index.js')

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`) }
  else { fail += 1; failures.push(name); console.log(`  ❌ ${name}${extra ? `  ${extra}` : ''}`) }
}
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}`)

/* ── 假的宿主 ctx（够 apply() 用就行） ─────────────── */
const tools = []
let route = null
const disposers = []
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  tools: { register: (t) => { tools.push(t); return () => {} } },
  effect: (fn) => { disposers.push(fn()); return () => {} },
  webServer: { register: (opts) => { route = opts; return () => {} } },
  get: () => undefined,
}

// enabled:false ⇒ 桥不会被拉起（这条很重要：测试不该碰真实账号）
apply(ctx, { enabled: false })

console.log('\n【装载】')
eq('注册了 13 个工具', tools.length, 13)
ok('有 tg_login_start', tools.some((t) => t.name === 'tg_login_start'))
ok('有 tg_pause', tools.some((t) => t.name === 'tg_pause'))
ok('路由挂上了 /api/tg-bridge', route?.path === '/api/tg-bridge' && typeof route.handler === 'function')
ok('路由 kind=prefix', route?.kind === 'prefix')

const server = createServer((req, res) => { route.handler(req, res) })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`
const API = `${BASE}/api/tg-bridge`
const same = { origin: BASE }

const jget = async (p, headers = {}) => {
  const res = await fetch(API + p, { headers })
  let body = null
  try { body = await res.json() } catch { body = null }
  return { status: res.status, body }
}
const jpost = async (p, obj, headers = {}) => {
  const res = await fetch(API + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(obj ?? {}),
  })
  let body = null
  try { body = await res.json() } catch { body = null }
  return { status: res.status, body }
}

/* ── 1. 状态 / 配置 ─────────────────────────────── */
console.log('\n【状态】')
{
  const r = await jget('/status')
  eq('status 200', r.status, 200)
  eq('enabled 读出来是 false', r.body.enabled, false)
  ok('带 process 字段', r.body.process && typeof r.body.process === 'object')
  ok('桥没跑时 bridge.error 有值（不抛 500）', typeof r.body.bridge?.error === 'string')
  ok('带 logins 数组', Array.isArray(r.body.logins))
}

console.log('\n【配置】')
{
  const r = await jget('/config')
  eq('config 200', r.status, 200)
  eq('默认 mode=auto', r.body.config.mode, 'auto')
  ok('带家目录', typeof r.body.home === 'string' && r.body.home.length > 0)

  const w = await jpost('/config', { patch: { mode: 'draft' } }, same)
  eq('改 mode 200', w.status, 200)
  eq('mode 落盘成 draft', w.body.config.mode, 'draft')

  const cl = await jpost('/config', { patch: { llm: { maxChars: 99999, maxTurns: 1 } } }, same)
  eq('maxChars 钳到 4000', cl.body.config.llm.maxChars, 4000)
  eq('maxTurns 抬到 2', cl.body.config.llm.maxTurns, 2)

  const b = await jpost('/config', { patch: { behavior: { pollSec: 99999, debounceMinSec: -5 } } }, same)
  eq('pollSec 钳到 1800', b.body.config.behavior.pollSec, 1800)
  eq('debounceMinSec 钳到 0', b.body.config.behavior.debounceMinSec, 0)

  const m = await jpost('/config', { patch: { llm: { models: 'a, b ,,c' } } }, same)
  eq('模型链按逗号切干净', m.body.config.llm.models, ['a', 'b', 'c'])
}

console.log('\n【脱敏与打码回写】')
{
  await jpost('/config', { patch: { account: { apiId: 123456, apiHash: 'abcdef0123456789' }, llm: { apiKey: 'sk-very-secret-9876' } } }, same)
  const m = await jget('/config')
  eq('apiHash 打码', m.body.config.account.apiHash, '••••6789')
  eq('llm.apiKey 打码', m.body.config.llm.apiKey, '••••9876')
  ok('响应里没有明文 apiHash', !JSON.stringify(m.body).includes('abcdef0123456789'))
  ok('响应里没有明文 key', !JSON.stringify(m.body).includes('sk-very-secret'))

  // 关键：打码串原样提交回来 = 没改（不然一保存就把真 key 冲成 ••••6789）
  const w = await jpost('/config', { patch: { account: { apiHash: '••••6789' } } }, same)
  eq('打码串回写后仍是打码', w.body.config.account.apiHash, '••••6789')
  const real = await jpost('/config', { patch: { account: { apiHash: 'new-hash-0000' } } }, same)
  eq('真值能覆盖', real.body.config.account.apiHash, '••••0000')
}

/* ── 2. 会话名单 ───────────────────────────────── */
console.log('\n【会话名单】')
{
  const c0 = await jget('/chats')
  eq('chats 200', c0.status, 200)
  ok('初始没有会话', Array.isArray(c0.body.users) && c0.body.users.length === 0)
  eq('桥没跑时 bridgeUp=false', c0.body.bridgeUp, false)
  eq('私聊默认 allowlist', c0.body.direct.mode, 'allowlist')
  eq('群聊默认 off', c0.body.groups.mode, 'off')

  const a = await jpost('/user', { id: '1807430990', label: '主人' }, same)
  eq('加人 200', a.status, 200)
  ok('进名单了', a.body.users.includes('1807430990'))
  eq('备注存下', a.body.labels['1807430990'], '主人')

  const p = await jpost('/pause', { chatId: '1807430990', paused: true }, same)
  eq('暂停 200', p.status, 200)
  ok('进 paused', p.body.paused.includes('1807430990'))

  const c1 = await jget('/chats')
  eq('chats 反映暂停', c1.body.users[0].paused, true)

  const bad = await jpost('/user', { id: 'abc' }, same)
  eq('id 不是数字 ⇒ ok:false', bad.body.ok, false)
  ok('给得出原因', typeof bad.body.error === 'string' && bad.body.error.length > 0)

  const rn = await jpost('/user', { id: '1807430990', label: '涅槃周' }, same)
  eq('改备注', rn.body.labels['1807430990'], '涅槃周')

  const d = await jpost('/user', { id: '1807430990', remove: true }, same)
  ok('删掉了', !d.body.users.includes('1807430990'))
  eq('备注也清了', d.body.labels['1807430990'], undefined)
}

console.log('\n【群聊模式】')
{
  const g = await jpost('/groups', { mode: 'allowlist', chats: ['-1001906049324'] }, same)
  eq('切 allowlist', g.body.groups.mode, 'allowlist')
  eq('群名单落盘', g.body.groups.chats, ['-1001906049324'])
  const back = await jpost('/groups', { mode: '乱写' }, same)
  eq('乱写 mode 回到 off', back.body.groups.mode, 'off')
}

console.log('\n【登录】')
{
  const noPhone = await jpost('/login/start', { phone: '' }, same)
  eq('空手机号 ⇒ ok:false', noPhone.body.ok, false)
  const badPhone = await jpost('/login/start', { phone: '13800138000' }, same)
  eq('缺 + 号 ⇒ ok:false', badPhone.body.ok, false)
  ok('提示要国际格式', /国际格式/.test(badPhone.body.error || ''))

  // apiId 有了、手机号合法 ⇒ 会真的去拉起登录子进程。为了不联网，这里把 apiHash 清空，
  // 让它在「先填 apiId/apiHash」这一步就返回。
  await jpost('/config', { patch: { account: { apiHash: '' } } }, same)
  const noHash = await jpost('/login/start', { phone: '+8613800138000' }, same)
  eq('没 apiHash ⇒ ok:false', noHash.body.ok, false)
  ok('提示去申请 apiId/apiHash', /apiId|apiHash/.test(noHash.body.error || ''))

  const code = await jpost('/login/code', { loginId: 'nope', code: '12345' }, same)
  eq('拿不存在的 loginId 提交验证码 ⇒ ok:false', code.body.ok, false)
  const cancel = await jpost('/login/cancel', { loginId: 'nope' }, same)
  eq('取消不存在的登录也不炸', cancel.status, 200)
}

/* ── 3. 运维 / 安全 ─────────────────────────────── */
console.log('\n【运维与安全】')
{
  const l = await jget('/log?lines=20')
  eq('log 200', l.status, 200)
  ok('tail 是字符串', typeof l.body.tail === 'string')

  const nf = await jget('/nope')
  eq('未知路由 404', nf.status, 404)
  eq('404 带 ok:false', nf.body.ok, false)

  const cross = await jget('/status', { origin: 'http://evil.example' })
  eq('别的网页来打 ⇒ 403', cross.status, 403)
  ok('403 说明是同源问题', /同源/.test(cross.body.error || ''))

  const crossPost = await jpost('/login/start', { phone: '+8613800138000' }, { origin: 'http://evil.example' })
  eq('跨站 POST 也 403（连登录都不让点）', crossPost.status, 403)

  const noOrigin = await jget('/status')
  eq('本机脚本（无 Origin）放行', noOrigin.status, 200)
}

/* ── 4. 坏 body 不该把服务搞崩 ─────────────────── */
console.log('\n【健壮性】')
{
  const res = await fetch(API + '/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: '这不是 JSON',
  })
  eq('非法 JSON body ⇒ 200（当成空 patch）', res.status, 200)
  const after = await jget('/status')
  eq('服务还活着', after.status, 200)
}

/* ── 收摊 ─────────────────────────────────────── */
server.close()
for (const d of disposers) { try { if (typeof d === 'function') d() } catch { /* 忽略 */ } }

console.log(`\n===== API 测试：${pass} 通过 / ${fail} 失败 =====`)
if (fail) { console.log('失败项：' + failures.join('、')); process.exitCode = 1 }
