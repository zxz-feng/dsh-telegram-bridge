/**
 * dsh-telegram-bridge —— 宿主半端
 * ============================================================================
 * 它是什么：让 DSH 接管**一个真实 Telegram 账号**（用户态 MTProto，不是机器人号），
 * 替你回联系人消息。插件本身不碰 Telegram 协议，它只做四件事：
 *
 *   1. **托管 bridge 子进程**：拉起、退避重启、优雅收摊（自愈第一层，零 token）
 *   2. **注册工具**：tg_status / tg_send / tg_pause / tg_config / tg_login_* / tg_verify …
 *   3. **周期性自检**：查进程、连接、代理端口、登录态、卡死、家目录 —— 只修不喊（零 token）
 *   4. **扫尾**：卸载插件时把子进程收掉，不留野进程
 *   5. **设置页的数据面**：`/api/tg-bridge/*`（见 lib/api.mjs），和工具共用同一套实现
 *
 * 子进程（`bridge/main.mjs`）才是干活的：连 MTProto、收消息、生成、发出去。
 * 分开的好处：它崩了宿主不受影响；它也能单独跑（服务器上想用 systemd 管也行），
 * 同一份代码，本地端和服务器端一样。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { loadDeps } from './lib/deps.mjs'
import { Supervisor } from './lib/supervisor.mjs'
import { homeDir, readJson, tail } from './lib/home.mjs'
import { runChecks, formatReport, tailLog } from './lib/health.mjs'
import { normalize, loadConfig, saveConfig, configPath, migrateLegacy, DEFAULTS } from './bridge/config.mjs'
import { ensurePersonaDir, personaVersion, personaSizes } from './bridge/persona.mjs'
import { makeApi } from './lib/api.mjs'
import { sendJson, readBody, sameOriginOk } from './lib/http.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const BRIDGE_SCRIPT = join(HERE, 'bridge', 'main.mjs')
const LOGIN_SCRIPT = join(HERE, 'bridge', 'login.mjs')
const PLUGIN_ID = 'telegram-bridge'

const { z, defineTool, notes } = await loadDeps()

export const name = PLUGIN_ID
export const inject = ['tools', 'settings', 'webServer']

/**
 * ⚠️ 每个字段都要 `.extra('volatile', true)`：DSH 的设置层只认 volatile 字段。
 * 这里只是**首次启用时的种子值**；之后以 `<家目录>/config.json` 为准，
 * 改配置用 `tg_config`（改完即时生效，不用重启）。
 */
export const Config = !z ? undefined : z.object({
  enabled: z.boolean().default(true).extra('volatile', true),
  mode: z.string().default('auto').extra('volatile', true),
  socksUrl: z.string().default('').extra('volatile', true),
  apiId: z.natural().default(0).extra('volatile', true),
  apiHash: z.string().default('').extra('volatile', true),
  personaDir: z.string().default('').extra('volatile', true),
  personaName: z.string().default('小鲸鱼').extra('volatile', true),
  llmBaseUrl: z.string().default('').extra('volatile', true),
  llmApiKey: z.string().default('').extra('volatile', true),
  llmModels: z.string().default('deepseek-v4.1-flash,hy3').extra('volatile', true),
  selfHealEveryMin: z.natural().max(120).default(5).extra('volatile', true),
  controlPort: z.natural().max(65535).default(17901).extra('volatile', true),
})

// ── 登录子进程管理（按需拉起，用完即退）───────────────
const logins = new Map()
let loginSeq = 0

function spawnLogin({ home, cfg, phone }) {
  const child = spawn(process.execPath, [LOGIN_SCRIPT], {
    env: {
      ...process.env,
      BRIDGE_HOME: home,
      BRIDGE_PHONE: phone,
      BRIDGE_CFG: JSON.stringify(cfg),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const id = `login${++loginSeq}`
  const state = { id, child, queue: [], waiter: null, closed: false, stderr: '' }
  createInterface({ input: child.stdout }).on('line', (line) => {
    const s = line.trim()
    if (!s) return
    let evt
    try { evt = JSON.parse(s) } catch { return }
    if (state.waiter) { const w = state.waiter; state.waiter = null; w(evt) } else state.queue.push(evt)
  })
  child.stderr?.on('data', (c) => { state.stderr = (state.stderr + c).slice(-2000) })
  child.on('exit', () => { state.closed = true })
  logins.set(id, state)
  return state
}

function waitEvent(state, timeoutMs = 90000) {
  if (state.queue.length) return Promise.resolve(state.queue.shift())
  if (state.closed) return Promise.resolve({ event: 'error', message: `登录进程已退出：${state.stderr.slice(-300)}` })
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.waiter = null
      resolve({ event: 'timeout', message: `${Math.round(timeoutMs / 1000)}s 没等到下一步（可能短信还没到，重试 tg_login_start）` })
    }, timeoutMs)
    state.waiter = (e) => { clearTimeout(timer); resolve(e) }
  })
}

function sendLogin(state, msg) {
  try { state.child.stdin.write(`${JSON.stringify(msg)}\n`) } catch { /* 进程没了 */ }
}

function killLogin(state) {
  try { state.child.kill('SIGKILL') } catch { /* 忽略 */ }
  logins.delete(state.id)
}

/**
 * 登录门面：工具（tg_login_*）和设置页（POST /login/*）共用一套流程，
 * 免得「工具能登、页面登不了」或者两边判空不一致。
 */
function makeLogin({ home, loadCfg }) {
  return {
    list() {
      return [...logins.values()].map((s) => ({ id: s.id, closed: s.closed, step: s.step ?? '' }))
    },

    async start(phone) {
      const cfg = loadCfg()
      if (!cfg.account.apiId || !cfg.account.apiHash) {
        return { ok: false, error: '先去 my.telegram.org 申请 apiId/apiHash，填进「账号」里' }
      }
      const state = spawnLogin({ home, cfg, phone })
      state.step = 'start'
      const evt = await waitEvent(state, 60000)
      if (evt.event === 'error') { killLogin(state); return { ok: false, step: 'start', ...evt } }
      if (evt.event === 'need-code') {
        state.step = 'code'
        return { ok: true, loginId: state.id, step: 'code', hint: '把手机收到的验证码填回来' }
      }
      if (evt.event === 'ok') { killLogin(state); return { ok: true, step: 'done', ...evt, hint: '已登录，点一下自检确认' } }
      return { ok: false, loginId: state.id, step: 'start', ...evt }
    },

    async code(loginId, code) {
      const state = logins.get(loginId)
      if (!state) return { ok: false, error: '这个登录已经过期了，重新发一次验证码' }
      sendLogin(state, { type: 'code', value: String(code) })
      const evt = await waitEvent(state, 90000)
      if (evt.event === 'ok') { killLogin(state); return { ok: true, step: 'done', ...evt } }
      if (evt.event === 'need-password') { state.step = 'password'; return { ok: true, loginId, step: 'password', hint: '开了两步验证，要密码' } }
      if (evt.event === 'bad-code') return { ok: false, loginId, step: 'code', hint: '验证码不对/过期，再填一次', ...evt }
      if (evt.event === 'error' || evt.event === 'timeout') { killLogin(state); return { ok: false, ...evt } }
      return { ok: true, loginId, step: evt.event, ...evt }
    },

    async password(loginId, password) {
      const state = logins.get(loginId)
      if (!state) return { ok: false, error: '这个登录已经过期了，重新发一次验证码' }
      sendLogin(state, { type: 'password', value: String(password) })
      const evt = await waitEvent(state, 90000)
      if (evt.event === 'ok') { killLogin(state); return { ok: true, step: 'done', ...evt } }
      if (evt.event === 'bad-password') return { ok: false, loginId, step: 'password', hint: '密码不对，再试', ...evt }
      if (evt.event === 'error' || evt.event === 'timeout') { killLogin(state); return { ok: false, ...evt } }
      return { ok: true, loginId, step: evt.event, ...evt }
    },

    cancel(loginId) {
      const state = logins.get(loginId)
      if (!state) return { ok: true, already: true }
      killLogin(state)
      return { ok: true }
    },
  }
}

// ── 插件主体 ──────────────────────────────────────────
export function apply(ctx, config = {}) {
  const log = (m) => ctx.logger?.info?.(m)
  const home = homeDir(PLUGIN_ID)
  for (const f of notes) log(`依赖：${f}`)

  // 首次启用：用 Config 当种子铺一份 config.json（之后以文件为准）
  migrateLegacy(home)
  if (!existsSync(configPath(home))) {
    const seed = normalize({
      enabled: config.enabled !== false,
      mode: config.mode || DEFAULTS.mode,
      socksUrl: config.socksUrl || '',
      account: { apiId: config.apiId || 0, apiHash: config.apiHash || '' },
      personaDir: config.personaDir || '',
      personaName: config.personaName || DEFAULTS.personaName,
      llm: {
        baseUrl: config.llmBaseUrl || '',
        apiKey: config.llmApiKey || '',
        models: String(config.llmModels || '').split(',').map((s) => s.trim()).filter(Boolean),
      },
      selfHeal: { everyMin: config.selfHealEveryMin ?? 5 },
      control: { port: config.controlPort ?? 17901 },
    })
    saveConfig(home, seed)
  }

  let cfg = loadConfig(home)
  const pdir = ensurePersonaDir(cfg).dir
  log(`家目录 ${home}；人设 ${pdir}`)

  const sup = new Supervisor({
    script: BRIDGE_SCRIPT,
    env: { BRIDGE_HOME: home, DSH_HOME: process.env.DSH_HOME || '' },
    logFile: join(home, 'bridge.log'),
    log,
  })

  // ── 数据面：工具和设置页共用同一套实现 ────────────────
  // 这样「页面上能改的」和「工具能改的」永远是一回事，校验/钳位/落盘只有一份。
  const login = makeLogin({ home, loadCfg: () => loadConfig(home) })
  const api = makeApi({ ctx, home, sup, login, log })
  const API_PREFIX = '/api/tg-bridge'

  // ── 工具（薄壳：参数进、api 出）───────────────────────
  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  }
  const safe = (v) => {
    if (typeof v === 'string') return v
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
  }
  const tool = (spec) => ctx.tools.register(defineTool({
    ...spec,
    output: textOutput,
    async execute(args, exec) { return safe(await spec.execute(args, exec)) },
  }))

  tool({
    name: 'tg_status',
    description: '看 Telegram 桥现在什么状态：进程活着没、连上没、登录的是谁、白名单几条、在途几条、人设指纹、贴纸几条。',
    parameters: {},
    execute: () => api.status(),
  })

  tool({
    name: 'tg_verify',
    description: '跑一遍自检（零 token，不调模型）：进程/连接/代理/登录态/卡死/家目录。能修的会当场修，输出「n/6 通过」。',
    parameters: {},
    execute: () => api.verify(),
  })

  tool({
    name: 'tg_config',
    description: '读/改 Telegram 桥的配置（改完即时生效，不用重启）。不传 patch 就是读。',
    parameters: {
      patch: { type: 'object', description: '要改的字段（可省）', additionalProperties: true },
    },
    execute: ({ patch } = {}) => (patch && typeof patch === 'object'
      ? api.writeConfig(patch)
      : { ok: true, config: api.readConfig(), home }),
  })

  tool({
    name: 'tg_login_start',
    description: '开始登录：传手机号（国际格式，例 +8613800138000）。会往那个号的 Telegram 发验证码，返回 loginId，然后立刻用 tg_login_code 把码填回来。apiId/apiHash 要先在 tg_config 里填好。',
    parameters: { phone: { type: 'string', description: '手机号，国际格式带 +' } },
    execute: ({ phone } = {}) => api.loginStart(phone),
  })

  tool({
    name: 'tg_login_code',
    description: '把 Telegram 发来的验证码填进去。可能还会要两步验证密码，那就接着用 tg_login_password。',
    parameters: {
      loginId: { type: 'string', description: 'tg_login_start 返回的那个 id' },
      code: { type: 'string', description: '手机收到的验证码' },
    },
    execute: ({ loginId, code } = {}) => api.loginCode(loginId, code),
  })

  tool({
    name: 'tg_login_password',
    description: '两步验证密码（开了 2FA 的账号才需要）。',
    parameters: {
      loginId: { type: 'string', description: 'tg_login_start 返回的那个 id' },
      password: { type: 'string', description: '两步验证密码' },
    },
    execute: ({ loginId, password } = {}) => api.loginPassword(loginId, password),
  })

  tool({
    name: 'tg_login_cancel',
    description: '取消正在进行的登录。',
    parameters: { loginId: { type: 'string', description: 'tg_login_start 返回的那个 id' } },
    execute: ({ loginId } = {}) => api.loginCancel(loginId),
  })

  tool({
    name: 'tg_chats',
    description: '列出白名单会话 + 每个会话的上下文轮数。',
    parameters: {},
    execute: () => api.listChats(),
  })

  tool({
    name: 'tg_send',
    description: '用这个账号给某个会话发一条消息。⚠️ 走的是 bridge 自己那条连接（不会抢 session），所以一次只能有一个客户端收消息这条铁律在这里是天然成立的。',
    parameters: {
      chatId: { type: 'string', description: '会话 id（用户 id 或 -100 开头的群 id）' },
      text: { type: 'string', description: '要发的话' },
    },
    execute: ({ chatId, text } = {}) => {
      if (!String(chatId ?? '').trim()) return { ok: false, error: '没有会话 id' }
      if (!String(text ?? '').trim()) return { ok: false, error: '正文是空的' }
      return sup.call('send', { chatId: String(chatId), text: String(text) }, { timeoutMs: 60000 })
        .then((r) => ({ ok: true, ...r }))
    },
  })

  tool({
    name: 'tg_pause',
    description: '暂停/恢复某个会话的自动回复（消息照记录，只是不回）。改完即时生效。',
    parameters: {
      chatId: { type: 'string', description: '会话 id' },
      paused: { type: 'boolean', description: 'true 暂停 / false 恢复' },
    },
    execute: ({ chatId, paused } = {}) => api.setPaused(chatId, paused),
  })

  tool({
    name: 'tg_context_clear',
    description: '清掉某个会话的上下文（下次对话会重新注入一次历史背景）。',
    parameters: { chatId: { type: 'string', description: '会话 id' } },
    execute: ({ chatId } = {}) => api.contextClear(chatId),
  })

  tool({
    name: 'tg_restart',
    description: '优雅重启 bridge 子进程（会等在途回复发完再重启）。',
    parameters: {},
    execute: () => api.restart(),
  })

  tool({
    name: 'tg_log',
    description: '看 bridge 日志最后几十行（排查用）。',
    parameters: { lines: { type: 'integer', description: '要几行，默认 40，最多 200' } },
    execute: ({ lines = 40 } = {}) => ({ ok: true, tail: api.readLog(lines) }),
  })

  // ── 设置页的路由（浏览器只碰这里）──────────────────────
  // 只挂在自己前缀下，只接受同源请求；所有写操作都过 api.*，和工具同一套校验。
  async function route(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1')
    const path = url.pathname.slice(API_PREFIX.length) || '/'
    const m = req.method
    const body = (m === 'POST' || m === 'PUT') ? await readBody(req) : {}

    if (m === 'GET' && path === '/status') return sendJson(res, 200, await api.status())
    if (m === 'GET' && path === '/config') return sendJson(res, 200, { ok: true, config: api.readConfig(), home })
    if (m === 'POST' && path === '/config') return sendJson(res, 200, await api.writeConfig(body.patch ?? body))
    if (m === 'GET' && path === '/chats') return sendJson(res, 200, await api.listChats())
    if (m === 'POST' && path === '/user') return sendJson(res, 200, await api.writeUser(body))
    if (m === 'POST' && path === '/pause') return sendJson(res, 200, await api.setPaused(body.chatId, body.paused))
    if (m === 'POST' && path === '/context-clear') return sendJson(res, 200, await api.contextClear(body.chatId))
    if (m === 'POST' && path === '/groups') return sendJson(res, 200, await api.setGroups(body))
    if (m === 'POST' && path === '/verify') return sendJson(res, 200, await api.verify())
    if (m === 'GET' && path === '/log') return sendJson(res, 200, { ok: true, tail: api.readLog(url.searchParams.get('lines') || 40) })
    if (m === 'POST' && path === '/restart') return sendJson(res, 200, await api.restart())
    if (m === 'POST' && path === '/login/start') return sendJson(res, 200, await api.loginStart(body.phone))
    if (m === 'POST' && path === '/login/code') return sendJson(res, 200, await api.loginCode(body.loginId, body.code))
    if (m === 'POST' && path === '/login/password') return sendJson(res, 200, await api.loginPassword(body.loginId, body.password))
    if (m === 'POST' && path === '/login/cancel') return sendJson(res, 200, await api.loginCancel(body.loginId))
    return sendJson(res, 404, { ok: false, error: `没有这条路由：${m} ${path}` })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
        // 别的网页在你浏览器里也能打 127.0.0.1，所以先判同源
        if (!sameOriginOk(req)) return sendJson(res, 403, { ok: false, error: '只接受同源请求' })
        try { await route(req, res) } catch (e) {
          sendJson(res, 500, { ok: false, error: String(e?.message ?? e).slice(0, 300) })
        }
      },
    }), 'tg-bridge: /api/tg-bridge 路由')
  } catch (e) { log(`HTTP 路由没挂上：${e?.message ?? e}`) }

  // ── 启动托管 ────────────────────────────────────────
  if (cfg.enabled) {
    try { sup.start() } catch (e) { log(`启动失败：${e?.message ?? e}`) }
  } else {
    log('配置 enabled=false —— 已装载但不启动')
  }

  // ── 周期自检（零 token）──────────────────────────────
  const everyMin = cfg.selfHeal?.everyMin ?? 5
  if (everyMin > 0) {
    const timer = setInterval(async () => {
      try {
        const cur = loadConfig(home)
        if (!cur.enabled) return
        await runChecks({
          client: {
            info: () => sup.info(),
            call: (a, p, o) => sup.call(a, p, o),
            start: () => { sup.state = 'idle'; return sup.start() },
            restart: (why) => sup.restart(why),
          },
          home,
          cfg: cur,
          fix: true,
        })
      } catch (e) { log(`自检异常：${e?.message ?? e}`) }
    }, everyMin * 60 * 1000)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer), 'telegram-bridge: 周期自检')
  }

  // ── 收摊 ────────────────────────────────────────────
  ctx.effect(() => () => {
    for (const [, s] of logins) { try { s.child.kill('SIGKILL') } catch { /* 忽略 */ } }
    logins.clear()
    void sup.stop()
  }, 'telegram-bridge: 收 bridge 子进程')

  log(`已挂载（家=${home}，pdir=${pdir}，自检每 ${everyMin} 分钟，贴纸 ${tail(home).length ? '' : ''}${personaSizes(cfg, pdir).full} 字人设）`)
  log(`人设指纹 ${personaVersion(pdir)}`)
}
