/**
 * lib/api.mjs —— 宿主半端的「数据面」（工具和设置页共用，TG 版）
 * ============================================================================
 * 和 QQ 那套同一个规矩：
 *
 *   工具   = 薄壳（解析参数 → 调 api → 包输出）
 *   路由   = 薄壳（解析请求 → 调 api → 序列化）
 *   api.*  = 唯一实现，校验/钳位/落盘都在这儿或它调的 bridge/config.mjs
 *
 * 和 QQ 的差别（别照抄错了）：
 *   · TG 没有单独的 allowlist.json —— 白名单就长在 config.json 的 `direct` / `groups` 里
 *   · TG 有「登录」这个动作（手机号 → 验证码 → 两步密码），要能从这里发起
 *   · TG 的敏感字段是 account.apiHash 和 llm.apiKey
 * ============================================================================
 */
import { loadConfig, saveConfig } from '../bridge/config.mjs'
import { runChecks, formatReport, tailLog } from './health.mjs'
import { maskConfig, keepMasked } from './http.mjs'

function toInt(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n) : fallback
}

export function makeApi({ ctx, home, sup, login, log }) {
  const call = async (name, params, ms = 8000) => {
    try { return { ok: true, data: await sup.call(name, params, { timeoutMs: ms }) } }
    catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 300) } }
  }

  const checks = () => runChecks({
    client: {
      info: () => sup.info(),
      call: (a, p, o) => sup.call(a, p, o),
      start: () => { sup.state = 'idle'; return sup.start() },
      restart: (why) => sup.restart(why),
    },
    home,
    cfg: loadConfig(home),
    fix: true,
  })

  return {
    home,

    /* ── 状态 ─────────────────────────────────────── */
    async status() {
      const cfg = loadConfig(home)
      const bridge = await call('status')
      return {
        ok: true,
        enabled: cfg.enabled,
        home,
        process: sup.info(),
        bridge: bridge.ok ? bridge.data : { error: bridge.error },
        config: maskConfig(cfg),
        logins: login.list(),
      }
    },

    /* ── 配置 ─────────────────────────────────────── */
    readConfig() { return maskConfig(loadConfig(home)) },

    async writeConfig(patch) {
      if (!patch || typeof patch !== 'object') return { ok: true, config: this.readConfig() }
      const cur = loadConfig(home)
      const clean = { ...patch }

      // 敏感字段：打码串原样回来 = 没改
      if (clean.account && typeof clean.account === 'object') {
        clean.account = { ...clean.account }
        if (clean.account.apiHash !== undefined) {
          clean.account.apiHash = keepMasked(clean.account.apiHash, cur.account.apiHash)
        }
        if (clean.account.apiId !== undefined) clean.account.apiId = Math.max(0, toInt(clean.account.apiId, cur.account.apiId))
      }
      if (clean.llm && typeof clean.llm === 'object') {
        clean.llm = { ...clean.llm }
        if (clean.llm.apiKey !== undefined) clean.llm.apiKey = keepMasked(clean.llm.apiKey, cur.llm.apiKey)
        if (clean.llm.models !== undefined) {
          const arr = Array.isArray(clean.llm.models)
            ? clean.llm.models
            : String(clean.llm.models).split(',').map((s) => s.trim())
          clean.llm.models = arr.filter(Boolean)
        }
        for (const [k, [lo, hi]] of Object.entries({
          maxChars: [120, 4000], maxTurns: [2, 60], reanchorEvery: [1, 100], timeoutMs: [5000, 180000],
        })) {
          if (clean.llm[k] !== undefined) clean.llm[k] = Math.min(hi, Math.max(lo, toInt(clean.llm[k], cur.llm[k])))
        }
      }
      if (clean.behavior && typeof clean.behavior === 'object') {
        clean.behavior = { ...clean.behavior }
        for (const [k, [lo, hi]] of Object.entries({
          debounceMinSec: [0, 120], debounceMaxSec: [0, 300], pollSec: [0, 1800], ctxTurns: [4, 100],
        })) {
          if (clean.behavior[k] !== undefined) {
            clean.behavior[k] = Math.min(hi, Math.max(lo, toInt(clean.behavior[k], cur.behavior[k])))
          }
        }
      }
      if (clean.selfHeal && typeof clean.selfHeal === 'object') {
        clean.selfHeal = { ...clean.selfHeal }
        if (clean.selfHeal.everyMin !== undefined) {
          clean.selfHeal.everyMin = Math.min(120, Math.max(0, toInt(clean.selfHeal.everyMin, cur.selfHeal.everyMin)))
        }
      }

      const next = saveConfig(home, clean)
      await call('config', { patch: clean })
      return { ok: true, config: maskConfig(next), note: '已保存，下一句消息就按新配置走' }
    },

    /* ── 会话（白名单 + 暂停 + 上下文）────────────────── */
    async listChats() {
      const cfg = loadConfig(home)
      const r = await call('contexts', {}, 8000)
      const list = r.ok && Array.isArray(r.data) ? r.data : []
      return {
        ok: true,
        mode: cfg.mode,
        bridgeUp: r.ok,
        direct: cfg.direct,
        groups: cfg.groups,
        users: cfg.direct.users.map((id) => ({
          id: String(id),
          label: cfg.direct.labels?.[String(id)] ?? '',
          paused: cfg.direct.paused.includes(String(id)),
          context: list.find((x) => String(x.chatId) === String(id)) ?? null,
        })),
      }
    },

    /** 加人 / 改备注 / 停用（删除）/ 暂停 */
    async writeUser({ id, label, remove, paused } = {}) {
      const uid = String(id ?? '').trim()
      if (!/^-?\d{4,20}$/.test(uid)) return { ok: false, error: '会话 id 不对（数字，群是 -100 开头）' }
      const cur = loadConfig(home)
      const users = [...cur.direct.users]
      const pausedList = new Set(cur.direct.paused)
      const labels = { ...(cur.direct.labels ?? {}) }

      if (remove) {
        const i = users.indexOf(uid)
        if (i >= 0) users.splice(i, 1)
        pausedList.delete(uid)
        delete labels[uid]
      } else {
        if (!users.includes(uid)) users.push(uid)
        if (label !== undefined) {
          const s = String(label).slice(0, 40).trim()
          if (s) labels[uid] = s; else delete labels[uid]
        }
        if (paused !== undefined) { if (paused) pausedList.add(uid); else pausedList.delete(uid) }
      }

      const next = saveConfig(home, {
        direct: { users, paused: [...pausedList], labels },
      })
      // 桥那边立刻知道（暂停是「消息照记录只是不回」，必须让它生效）
      if (paused !== undefined && !remove) {
        await call('pause', { chatId: uid, paused: Boolean(paused) })
      }
      await call('config', { patch: { direct: next.direct } })
      return { ok: true, users: next.direct.users, paused: next.direct.paused, labels: next.direct.labels }
    },

    async setPaused(chatId, paused) {
      return this.writeUser({ id: chatId, paused: Boolean(paused) })
    },

    async contextClear(chatId) {
      const id = String(chatId ?? '').trim()
      if (!id) return { ok: false, error: '没有会话 id' }
      const r = await call('context_clear', { chatId: id }, 8000)
      return r.ok ? { ok: true, ...r.data } : { ok: false, error: r.error }
    },

    async setGroups(patch = {}) {
      const cur = loadConfig(home)
      const clean = {}
      if (patch.mode !== undefined) clean.mode = patch.mode === 'allowlist' ? 'allowlist' : 'off'
      if (patch.chats !== undefined) {
        clean.chats = (Array.isArray(patch.chats) ? patch.chats : String(patch.chats).split(','))
          .map((s) => String(s).trim()).filter(Boolean)
      }
      const next = saveConfig(home, { groups: { ...cur.groups, ...clean } })
      await call('config', { patch: { groups: next.groups } })
      return { ok: true, groups: next.groups }
    },

    /* ── 自检 / 日志 / 重启 ────────────────────────── */
    async verify() {
      const r = await checks()
      return { ok: r.passed === r.total, report: formatReport(r, { name: 'Telegram 桥' }), ...r }
    },

    readLog(lines = 40) {
      return tailLog(home, Math.min(200, Math.max(10, toInt(lines, 40))))
    },

    async restart() {
      const r = await sup.restart('设置页点了重启')
      return { ok: Boolean(r), process: sup.info() }
    },

    /* ── 登录（手机号 → 验证码 → 两步密码）────────────── */
    async loginStart(phone) {
      const cfg = loadConfig(home)
      if (!cfg.account.apiId || !cfg.account.apiHash) {
        return { ok: false, error: '先填 apiId / apiHash（my.telegram.org 申请），再登录' }
      }
      const p = String(phone ?? '').trim()
      if (!/^\+\d{6,20}$/.test(p)) return { ok: false, error: '手机号要国际格式，例 +8613800138000' }
      return await login.start(p)
    },

    async loginCode(loginId, code) {
      if (!String(code ?? '').trim()) return { ok: false, error: '验证码是空的' }
      return await login.code(String(loginId), String(code).trim())
    },

    async loginPassword(loginId, password) {
      if (!String(password ?? '')) return { ok: false, error: '密码是空的' }
      return await login.password(String(loginId), String(password))
    },

    async loginCancel(loginId) {
      return login.cancel(String(loginId))
    },
  }
}
