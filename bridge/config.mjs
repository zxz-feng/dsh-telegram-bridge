/**
 * bridge/config.mjs —— 配置的读、合并、钳位、迁移
 * ============================================================================
 * 配置只有一份：`<home>/config.json`。改完即时生效（bridge 每条消息前重读，
 * 或者用工具的 config 动作 / 控制口 POST /config 立刻刷新）。
 *
 * 环境变量优先级最高（方便服务器上/systemd 里覆盖），其次 config.json，最后默认值。
 *
 * 迁移：老版本留下的 `allowlist.json` / `mode.json` 第一次启动时自动吸进来，
 * 原文件改名 `.migrated` 留着（不删，出问题能回头对）。
 * ============================================================================
 */
import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, writeJson } from '../lib/home.mjs'

export const DEFAULTS = {
  enabled: true,
  account: { apiId: 0, apiHash: '' },          // 从 my.telegram.org 申请；也可用 TG_API_ID/TG_API_HASH
  socksUrl: '',                                 // 留空 = 直连；例：socks5://127.0.0.1:17890
  mode: 'auto',                                 // auto | draft | confirm
  direct: {
    mode: 'allowlist',                          // allowlist | off
    users: [],                                  // 只回这些人的私信
    paused: [],                                 // 这些人照记录、不回复
    labels: {},                                 // { "123456": "备注名" }
  },
  groups: { mode: 'off', chats: [] },           // 群聊默认关；mode=allowlist 才看 chats
  personaDir: '',                               // 留空 = <DSH_HOME>/persona
  personaName: '小鲸鱼',
  personaIdentity: '你是 DeepSeek 小鲸鱼（蓝白配色、蓝色长发、鲸鱼尾巴的 Q 版形象），替号主看号代聊。',
  personaLead: '替号主看号代聊，不是本人',
  llm: {
    baseUrl: '',                                // OpenAI 兼容；留空按 detectLlmBase() 猜
    apiKey: '',
    models: ['deepseek-v4.1-flash', 'hy3', 'deepseek-v4-pro'],
    visionModel: '',
    effortFull: 'max',
    effortShort: 'low',
    maxChars: 500,
    maxTurns: 12,
    reanchorEvery: 8,
    timeoutMs: 60000,
  },
  behavior: {
    debounceMinSec: 3,
    debounceMaxSec: 10,
    pollSec: 60,
    ctxTurns: 20,
  },
  sticker: { enabled: true },
  vision: { enabled: true },
  selfHeal: { everyMin: 5, autoRestart: true },
  control: { port: 17901, host: '127.0.0.1' },
}

function num(v, lo, hi, dflt) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, n))
}

function str(v, dflt = '', max = 400) {
  const s = String(v ?? '').trim()
  return s ? s.slice(0, max) : dflt
}

function arr(v) {
  if (!Array.isArray(v)) return []
  return v
    .filter((x) => x !== null && x !== undefined && x !== '')
    .map((x) => String(x).trim())
    .filter(Boolean)
}

/** 合并 + 钳位：无论用户填了什么，出来的都是能用的 */
export function normalize(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const d = DEFAULTS
  const llm = { ...d.llm, ...(r.llm ?? {}) }
  const b = { ...d.behavior, ...(r.behavior ?? {}) }
  const out = {
    enabled: r.enabled !== false,
    account: {
      apiId: num(r.account?.apiId ?? process.env.TG_API_ID, 0, 1e10, 0),
      apiHash: str(r.account?.apiHash ?? process.env.TG_API_HASH, '', 64),
    },
    socksUrl: str(r.socksUrl ?? process.env.SOCKS_URL, '', 200),
    mode: ['auto', 'draft', 'confirm'].includes(r.mode) ? r.mode : d.mode,
    direct: {
      mode: r.direct?.mode === 'off' ? 'off' : 'allowlist',
      users: arr(r.direct?.users),
      paused: arr(r.direct?.paused),
      labels: (r.direct?.labels && typeof r.direct.labels === 'object') ? r.direct.labels : {},
    },
    groups: {
      mode: r.groups?.mode === 'allowlist' ? 'allowlist' : 'off',
      chats: arr(r.groups?.chats),
    },
    personaDir: str(r.personaDir, '', 400),
    personaName: str(r.personaName, d.personaName, 40),
    personaIdentity: str(r.personaIdentity, d.personaIdentity, 800),
    personaLead: str(r.personaLead, d.personaLead, 120),
    llm: {
      baseUrl: str(llm.baseUrl ?? process.env.DSH_GATEWAY, '', 300),
      apiKey: str(llm.apiKey ?? process.env.WORKBUDDY_GATEWAY_API_KEY, '', 200),
      models: arr(llm.models).length ? arr(llm.models) : d.llm.models,
      visionModel: str(llm.visionModel, '', 80) || arr(llm.models)[0] || d.llm.models[0],
      effortFull: str(llm.effortFull, d.llm.effortFull, 12),
      effortShort: str(llm.effortShort, d.llm.effortShort, 12),
      maxChars: num(llm.maxChars, 120, 4000, d.llm.maxChars),
      maxTurns: num(llm.maxTurns, 2, 60, d.llm.maxTurns),
      reanchorEvery: num(llm.reanchorEvery, 1, 100, d.llm.reanchorEvery),
      timeoutMs: num(llm.timeoutMs, 5000, 180000, d.llm.timeoutMs),
    },
    behavior: {
      debounceMinSec: num(b.debounceMinSec, 0, 120, d.behavior.debounceMinSec),
      debounceMaxSec: num(b.debounceMaxSec, 0, 300, d.behavior.debounceMaxSec),
      pollSec: num(b.pollSec, 0, 1800, d.behavior.pollSec),
      ctxTurns: num(b.ctxTurns, 4, 100, d.behavior.ctxTurns),
    },
    sticker: { enabled: r.sticker?.enabled !== false },
    vision: { enabled: r.vision?.enabled !== false },
    selfHeal: {
      everyMin: num(r.selfHeal?.everyMin, 0, 120, d.selfHeal.everyMin),
      autoRestart: r.selfHeal?.autoRestart !== false,
    },
    control: {
      port: num(r.control?.port, 1024, 65535, d.control.port),
      host: str(r.control?.host, d.control.host, 40),
    },
  }
  if (out.behavior.debounceMaxSec < out.behavior.debounceMinSec) {
    out.behavior.debounceMaxSec = out.behavior.debounceMinSec
  }
  return out
}

export function configPath(home) {
  return join(home, 'config.json')
}

/** 老文件迁移（allowlist.json / mode.json → config.json），只做一次 */
export function migrateLegacy(home) {
  const cfgFile = configPath(home)
  const legacyAll = join(home, 'allowlist.json')
  const legacyMode = join(home, 'mode.json')
  if (existsSync(cfgFile)) return false
  if (!existsSync(legacyAll) && !existsSync(legacyMode)) return false

  const old = readJson(legacyAll, {}) ?? {}
  const raw = {
    direct: {
      mode: old.direct?.mode ?? 'allowlist',
      users: old.direct?.users ?? [],
      paused: old.direct?.paused ?? [],
      labels: old.direct?.labels ?? {},
    },
    groups: { mode: old.groups?.mode ?? 'off', chats: old.groups?.chats ?? [] },
  }
  const m = readJson(legacyMode, null)
  if (m?.mode) raw.mode = m.mode
  writeJson(cfgFile, normalize(raw))
  for (const f of [legacyAll, legacyMode]) {
    try { if (existsSync(f)) renameSync(f, `${f}.migrated`) } catch { /* 改不了就留着 */ }
  }
  return true
}

export function loadConfig(home) {
  migrateLegacy(home)
  return normalize(readJson(configPath(home), {}))
}

/** 部分更新：合并进现有配置，钳位后落盘；返回新配置 */
export function saveConfig(home, patch = {}) {
  const cur = readJson(configPath(home), {}) ?? {}
  const merged = {
    ...cur,
    ...patch,
    account: { ...(cur.account ?? {}), ...(patch.account ?? {}) },
    direct: { ...(cur.direct ?? {}), ...(patch.direct ?? {}) },
    groups: { ...(cur.groups ?? {}), ...(patch.groups ?? {}) },
    llm: { ...(cur.llm ?? {}), ...(patch.llm ?? {}) },
    behavior: { ...(cur.behavior ?? {}), ...(patch.behavior ?? {}) },
    sticker: { ...(cur.sticker ?? {}), ...(patch.sticker ?? {}) },
    vision: { ...(cur.vision ?? {}), ...(patch.vision ?? {}) },
    selfHeal: { ...(cur.selfHeal ?? {}), ...(patch.selfHeal ?? {}) },
    control: { ...(cur.control ?? {}), ...(patch.control ?? {}) },
  }
  const next = normalize(merged)
  writeJson(configPath(home), next)
  return next
}

/** OpenAI 兼容网关地址：没填就按常见端口猜（找到哪个用哪个） */
export function detectLlmBase(llm) {
  if (llm.baseUrl) return llm.baseUrl
  const env = process.env.DSH_GATEWAY
  if (env) return env
  return 'http://127.0.0.1:8327/v1'
}
