#!/usr/bin/env node
/**
 * test/client.mjs —— 设置页浏览器半端的「冒烟渲染」（零 token、无浏览器、无 react）
 * ============================================================================
 * 为什么值得单独测：client.js 一旦有运行时错误，设置页那一栏会**整块空白**，
 * 而宿主日志里一个字都没有（报错在浏览器控制台）。这种错只有真点进去才看得见，
 * 所以这里用一个 40 行的假 React 把它渲染一遍：
 *
 *   · 校验自注册协议（__ModuleLoader__.load 的 id 必须等于包名）
 *   · 校验槽位注册（settings.section / id / order / label）
 *   · 真跑一遍 Panel 的函数体（所有 useState 都喂真数据，走完整棵树）
 *   · 关掉总开关时，下面的分区要真的被 data-tg-away 收起来
 *
 * 它抓不到样式问题（那得用眼睛），但能抓到「变量写错 / 属性名不对 / 空数组没兜住」。
 * ============================================================================
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, '..', 'client.js'), 'utf8')

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`) }
  else { fail += 1; failures.push(name); console.log(`  ❌ ${name}${extra ? `  ${extra}` : ''}`) }
}

/* ── 假 React：createElement 只造节点，useState 按队列发值 ── */
let queue = []
let qi = 0
const react = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
  useState: (init) => { const v = qi < queue.length ? queue[qi] : init; qi += 1; return [v, () => {}] },
  useEffect: () => {},
  useCallback: (fn) => fn,
}

/* ── 迷你渲染器：函数组件就地调用；原生标签连属性一起吐出来（input 的 value 也要看得见） ── */
function attrs(props) {
  const out = []
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'children' || v === null || v === undefined || v === false) continue
    if (typeof v === 'function' || typeof v === 'object') continue
    out.push(v === true ? k : `${k}=${v}`)
  }
  return out.length ? ` ${out.join(' ')}` : ''
}
function render(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((n) => render(n)).join('')
  if (typeof node.type === 'function') {
    const props = { ...node.props }
    if (node.children.length) props.children = node.children.length === 1 ? node.children[0] : node.children
    return render(node.type(props))
  }
  return `<${node.type}${attrs(node.props)}>${node.children.map((c) => render(c)).join('')}</${node.type}>`
}

/* ── 假 window / document / slots ── */
let loaded = null
const styleEl = { setAttribute() {}, remove() {}, textContent: '' }
const document = { createElement: () => styleEl, head: { appendChild() {} } }
const window = { __ModuleLoader__: { load: (o) => { loaded = o } } }

new Function('window', 'document', SRC)(window, document)

console.log('\n【自注册协议】')
ok('调用了 __ModuleLoader__.load', Boolean(loaded))
ok('id 等于包名 dsh-telegram-bridge', loaded?.id === 'dsh-telegram-bridge', `实际=${loaded?.id}`)
ok('factory 是函数', typeof loaded?.factory === 'function')

const mod = loaded.factory((name) => (name === 'react' ? react : {}))
ok('返回 { inject, apply }', Boolean(mod?.apply) && Array.isArray(mod?.inject))
ok('inject 要 slots', (mod.inject || []).includes('slots'))

/* ── 槽位注册 ── */
let registered = null
const slots = {
  inject: (_name, fn) => fn(),
  register: (meta, comp) => { registered = { meta, comp }; return () => {} },
}
const ctx = {
  get: (k) => (k === 'slots' ? slots : undefined),
  slots,
  effect: (fn) => { const d = fn(); return () => { try { if (typeof d === 'function') d() } catch { /* 忽略 */ } } },
}
mod.apply(ctx)

console.log('\n【槽位】')
ok('注册进 settings.section', registered?.meta?.name === 'settings.section')
ok('id=telegram-bridge', registered?.meta?.id === 'telegram-bridge')
ok('order=50（排在 QQ 后面）', registered?.meta?.order === 50)
ok('左侧导航叫「Telegram 小鲸鱼」', registered?.meta?.label === 'Telegram 小鲸鱼')
ok('组件是函数', typeof registered?.comp === 'function')

/* ── 真数据渲染一遍 ── */
const status = {
  ok: true,
  enabled: true,
  home: '/root/dsh/telegram-bridge',
  process: { state: 'up', pid: 1234 },
  bridge: {
    configured: true, hasSession: true, connected: true, authorized: true,
    me: '号主', account: 'id 100000001', mode: 'auto',
    direct: { count: 1, paused: 0 }, groups: { mode: 'off', chats: [] },
    inflight: 0, stickers: 12,
    persona: { name: '小鲸鱼', version: 'e6a17cce6266', dir: '/root/dsh/telegram-bridge/persona' },
    counters: { in: 5, out: 4, skipped: 1 },
  },
  config: { enabled: true, mode: 'auto' },
  logins: [],
}
const config = {
  enabled: true, mode: 'auto',
  socksUrl: 'socks5://127.0.0.1:17890',
  account: { apiId: 123456, apiHash: '••••6789' },
  llm: { models: ['deepseek-v4.1-flash', 'hy3'], maxChars: 600, maxTurns: 12 },
  direct: { mode: 'allowlist', users: ['1807430990'], paused: [], labels: { 1807430990: '主人' } },
  groups: { mode: 'off', chats: [] },
}
const chats = {
  ok: true, mode: 'auto', bridgeUp: true,
  direct: config.direct,
  groups: config.groups,
  users: [{ id: '1807430990', label: '主人', paused: false, context: { turns: 6 } }],
}

// Panel 的 useState 顺序：st / cfg / chats / busy / msg / tail / report / newId / newLabel / login
// 然后是 ChatCard 的 label
queue = [status, config, chats, '', null, '', '', '', '', { phone: '', id: '', step: '', code: '', pw: '' }, '主人']
qi = 0
let out = ''
let err = null
try { out = render(registered.comp({})) } catch (e) { err = e }

console.log('\n【渲染】')
ok('渲染不抛异常', !err, err ? String(err?.stack || err).slice(0, 400) : '')
ok('画出了「现在什么状态」', out.includes('现在什么状态'))
ok('连接徽章是「已连接」', out.includes('已连接'))
ok('登录身份画出来', out.includes('号主'))
ok('白名单 / 暂停 / 贴纸计数', out.includes('白名单 1 个') && out.includes('暂停 0 个') && out.includes('贴纸 12'))
ok('人设指纹', out.includes('e6a17cce6266'))
ok('总开关在', out.includes('让 Telegram 小鲸鱼上线'))
ok('SOCKS5 代理填的值看得见', out.includes('socks5://127.0.0.1:17890'))
ok('模型链是逗号串', out.includes('deepseek-v4.1-flash,hy3'))
ok('apiId 画出来', out.includes('123456'))
ok('apiHash 是打码的', out.includes('••••6789') && !out.includes('abcdef0123456789'))
ok('手机号输入 + 发验证码按钮', out.includes('+86…') && out.includes('发验证码'))
ok('会话卡片：备注 + id + 上下文轮数', out.includes('主人') && out.includes('1807430990') && out.includes('上下文 6 轮'))
ok('会话卡片按钮齐全', out.includes('存备注') && out.includes('清上下文'))
ok('私聊/群聊两个下拉都在', out.includes('私聊') && out.includes('群聊'))
ok('加人一行', out.includes('加一个人'))
ok('运维按钮齐全', out.includes('跑一遍自检') && out.includes('看日志') && out.includes('重启桥'))
ok('页脚有家目录', out.includes('/root/dsh/telegram-bridge'))

/* ── 关掉总开关：下面要真收起来 ── */
queue = [{ ...status, enabled: false }, { ...config, enabled: false }, chats, '', null, '', '', '', '', { phone: '', id: '', step: '', code: '', pw: '' }, '主人']
qi = 0
let outOff = ''
try { outOff = render(registered.comp({})) } catch (e) { outOff = 'ERR:' + String(e?.message ?? e) }
ok('关掉后渲染不炸', !outOff.startsWith('ERR:'), outOff.slice(0, 200))
ok('关掉后分区带上 data-tg-away（CSS 会藏）', (outOff.match(/data-tg-away/g) || []).length >= 4)
ok('关掉后仍能看到总开关（不然打不开了）', outOff.includes('让 Telegram 小鲸鱼上线'))

/* ── 桥没跑 + 名单空：不许崩 ── */
queue = [
  { ...status, bridge: { error: 'bridge 没在跑（state=idle）' }, process: { state: 'idle' }, logins: [] },
  config,
  { ok: false, bridgeUp: false, users: [], direct: { mode: 'allowlist', users: [], paused: [], labels: {} }, groups: { mode: 'off', chats: [] } },
  '', null, '', '', '', '', { phone: '', id: '', step: '', code: '', pw: '' },
]
qi = 0
let outDown = ''
try { outDown = render(registered.comp({})) } catch (e) { outDown = 'ERR:' + String(e?.message ?? e) }
ok('桥没跑时渲染不炸', !outDown.startsWith('ERR:'), outDown.slice(0, 200))
ok('桥没跑时给出原因', outDown.includes('桥没响应'))
ok('桥没跑时名单给提示', outDown.includes('名单是空的'))

/* ── 登录进行中：验证码那一步要出现 ── */
queue = [status, config, chats, '', null, '', '', '', '', { phone: '+8613800138000', id: 'lg-123456', step: 'code', code: '', pw: '' }, '主人']
qi = 0
let outLogin = ''
try { outLogin = render(registered.comp({})) } catch (e) { outLogin = 'ERR:' + String(e?.message ?? e) }
ok('登录态渲染不炸', !outLogin.startsWith('ERR:'), outLogin.slice(0, 200))
ok('出现验证码输入 + 确认', outLogin.includes('手机收到的 5 位验证码') && outLogin.includes('确认'))

console.log(`\n===== 设置页冒烟：${pass} 通过 / ${fail} 失败 =====`)
if (fail) { console.log('失败项：' + failures.join('、')); process.exitCode = 1 }
