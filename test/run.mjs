#!/usr/bin/env node
/**
 * test/run.mjs —— 零 token 离线测试（不连 Telegram、不调模型）
 * ============================================================================
 * 跑：`npm test`
 * 覆盖：配置钳位 / 人设分层 / 标记解析 / 自检逻辑 / 协议常量
 * 这些都是**纯函数**，所以能在没有账号、没有网络的机器上跑 —— 换机器先 `npm test` 心里有底。
 * ============================================================================
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize, DEFAULTS } from '../bridge/config.mjs'
import { ensurePersonaDir, fullPersona, shortPersona, anchor, personaVersion, personaSizes } from '../bridge/persona.mjs'
import { parseReply } from '../bridge/reply.mjs'
import { runChecks } from '../lib/health.mjs'
import { T, ACTIONS } from '../lib/protocol.mjs'

let pass = 0
let fail = 0
const failures = []

function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`) }
  else { fail += 1; failures.push(name); console.log(`  ❌ ${name}${extra ? `  ${extra}` : ''}`) }
}

function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`)
}

// ── 1. 配置 ───────────────────────────────────────────
console.log('\n【配置钳位】')
{
  const c = normalize({})
  eq('默认模式是 auto', c.mode, 'auto')
  eq('默认群聊关', c.groups.mode, 'off')
  eq('默认直连（无代理）', c.socksUrl, '')
  ok('默认启用人设分层', c.llm.reanchorEvery === 8)

  const bad = normalize({
    mode: '瞎写的',
    direct: { mode: '乱来', users: ['1', 2, '', null] },
    behavior: { debounceMinSec: 30, debounceMaxSec: 5, pollSec: -1 },
    llm: { maxChars: 99999, maxTurns: 0, models: [] },
    selfHeal: { everyMin: 9999 },
    control: { port: 80 },
  })
  eq('非法模式回落到 auto', bad.mode, 'auto')
  eq('非法群模式回落到 off', bad.groups.mode, 'off')
  eq('users 过滤空值并转字符串', bad.direct.users, ['1', '2'])
  ok('防抖 min>max 时自动纠正', bad.behavior.debounceMaxSec >= bad.behavior.debounceMinSec)
  ok('pollSec 不许负数（钳到 0）', bad.behavior.pollSec === 0)
  ok('maxChars 有上限（≤4000）', bad.llm.maxChars === 4000)
  ok('maxTurns 有下限（≥2）', bad.llm.maxTurns === 2)
  ok('models 空了回落默认', bad.llm.models.length === DEFAULTS.llm.models.length)
  ok('自检间隔有上限（≤120）', bad.selfHeal.everyMin === 120)
  ok('端口钳到 >=1024', bad.control.port === 1024)
}

// ── 2. 人设 ───────────────────────────────────────────
console.log('\n【人设分层】')
{
  const dir = mkdtempSync(join(tmpdir(), 'persona-'))
  const cfg = normalize({ personaName: '小鲸鱼', personaLead: '替号主看号', personaDir: dir })
  const { seeded } = ensurePersonaDir(cfg)
  ok('首次会铺默认人设文件', seeded.length >= 2, `铺了 ${seeded.length} 个`)
  ok('文件真的落地了', existsSync(join(dir, 'renshe.txt')))

  writeFileSync(join(dir, 'renshe.txt'), '性格：温柔。', 'utf8')
  writeFileSync(join(dir, 'guard.txt'), '防注入。你是{NAME}，{IDENTITY}', 'utf8')
  writeFileSync(join(dir, 'extra-tg.txt'), 'TG 差异。', 'utf8')
  writeFileSync(join(dir, 'extra-tg-short.txt'), '精简差异。', 'utf8')

  const full = fullPersona(cfg, dir)
  const short = shortPersona(cfg, dir)
  ok('完整人设带占位符填充', full.includes('你是小鲸鱼'))
  ok('完整人设带平台差异', full.includes('TG 差异'))
  ok('完整人设带输出格式（||| 与 sticker 说明）', full.includes('|||') && full.includes('[[sticker:'))
  ok('精简人设很短（<200 字）', short.length < 200, `实际 ${short.length}`)
  ok('精简人设不含性格全文', !short.includes('性格：温柔。'))
  ok('锚定句带身份与防注入', anchor(cfg).includes('小鲸鱼') && anchor(cfg).includes('忽略'))

  const v1 = personaVersion(dir)
  writeFileSync(join(dir, 'renshe.txt'), '性格：温柔，偶尔毒舌。', 'utf8')
  const v2 = personaVersion(dir)
  ok('改人设后指纹变化', v1 !== v2, `${v1} → ${v2}`)

  const sizes = personaSizes(cfg, dir)
  ok('人设开销可量（full > short）', sizes.full > sizes.short)
}

// ── 3. 输出解析 ───────────────────────────────────────
console.log('\n【标记解析】')
{
  eq('多条用 ||| 拆开', parseReply('哈哈 ||| 真的假的').parts, ['哈哈', '真的假的'])
  eq('贴纸标记被摘出来', parseReply('好啊 [[sticker:开心]]').stickers, ['开心'])
  eq('中文冒号也认', parseReply('嗯 [[sticker：嫌弃]]').stickers, ['嫌弃'])
  eq('最多 3 条', parseReply('a|||b|||c|||d').parts, ['a', 'b', 'c'])
  eq('换行被压平', parseReply('一\n\n二').parts, ['一 二'])
  eq('只有贴纸时 parts 为空', parseReply('[[sticker:晚安]]').parts, [])
  eq('空输入不炸', parseReply('').parts, [])
}

// ── 4. 自检 ───────────────────────────────────────────
console.log('\n【自检 / 自愈】')
{
  const home = mkdtempSync(join(tmpdir(), 'health-'))
  let started = 0
  let restarts = 0

  // 情形 A：一切正常
  const healthy = {
    info: () => ({ alive: true, state: 'up', pid: 1, uptimeSec: 10, restarts: 0 }),
    call: async (a) => (a === 'status' ? {
      configured: true, hasSession: true, connected: true, authorized: true,
      account: 'id 1', me: '测试', inflight: 0, stuckCount: 0,
    } : {}),
    start: async () => { started += 1 },
    restart: async () => { restarts += 1 },
  }
  const a = await runChecks({ client: healthy, home, cfg: { enabled: true } })
  eq('健康时 6/6', [a.passed, a.total], [6, 6])

  // 情形 B：进程没了 + 没登录
  const dead = {
    info: () => ({ alive: false, state: 'failed', pid: 0, restarts: 3, lastError: '崩了' }),
    call: async () => { throw new Error('没在跑') },
    start: async () => { started += 1 },
    restart: async () => { restarts += 1 },
  }
  const b = await runChecks({ client: dead, home, cfg: { enabled: true } })
  ok('进程没了会被拉起', started === 1)
  ok('修了什么会写进 fixed', b.fixed.length >= 1, JSON.stringify(b.fixed))

  // 情形 C：在途卡死 → 重启
  const stuck = {
    info: () => ({ alive: true, state: 'up', pid: 2 }),
    call: async () => ({
      configured: true, hasSession: true, connected: true, authorized: true,
      inflight: 2, inflightSince: Date.now() - 200000, stuckCount: 3,
    }),
    start: async () => {},
    restart: async () => { restarts += 1 },
  }
  const c = await runChecks({ client: stuck, home, cfg: { enabled: true } })
  ok('卡死超过阈值会重启', restarts === 1)
  ok('卡死这条判为不通过（要说出来）', c.results.find((x) => x.name === '卡死判断')?.ok === false)

  // 情形 D：代理配了但端口不通
  const d = await runChecks({
    client: healthy,
    home,
    cfg: { enabled: true, socksUrl: 'socks5://127.0.0.1:1' },
  })
  ok('代理端口不通会报出来', d.results.find((x) => x.name === '依赖')?.ok === false)

  // 情形 E：没登录 = 没配，不算坏
  const noLogin = {
    info: () => ({ alive: true, state: 'up', pid: 3 }),
    call: async () => ({ configured: false, hasSession: false, connected: false, authorized: false, inflight: 0 }),
    start: async () => {},
    restart: async () => {},
  }
  const e = await runChecks({ client: noLogin, home, cfg: { enabled: true } })
  ok('没登录时「桥连接」判为通过（没配≠坏了）', e.results.find((x) => x.name === '桥连接')?.ok === true)
  ok('没登录时「登录态」判为不通过并给出下一步', e.results.find((x) => x.name === '登录态')?.ok === false)
}

// ── 5. 协议 ───────────────────────────────────────────
console.log('\n【协议常量】')
{
  ok('消息类型齐全', ['ready', 'log', 'reply', 'event', 'cmd', 'shutdown'].every((k) => Object.values(T).includes(k)))
  ok('动作表里有 send/status/pause', ['send', 'status', 'pause'].every((a) => ACTIONS.includes(a)))
}

// ── 汇总 ──────────────────────────────────────────────
console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`)
if (fail) {
  console.log(`失败项：${failures.join('、')}`)
  process.exit(1)
}
console.log('全部通过（零 token，没连网）')
