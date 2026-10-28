/**
 * bridge/client.mjs —— GramJS 客户端工厂（含 SOCKS5 注入）+ session 读写
 * ============================================================================
 * 两个坑：
 *   ① GramJS 的 `proxy` 只支持 MTProxy ⇒ 走 socks.mjs 里的自实现 networkSocket
 *   ② StringSession 就是**账号本身**（等于密码），文件权限必须是 600，绝不能进仓库
 * ============================================================================
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { ProxiedNetSockets, parseSocks } from './sockets.mjs'

export function sessionFile(home) { return join(home, 'session.txt') }

export function loadSession(home) {
  try { return readFileSync(sessionFile(home), 'utf8').trim() } catch { return '' }
}

export function saveSession(home, str) {
  writeFileSync(sessionFile(home), str, { mode: 0o600 })
}

/**
 * @param {object} cfg
 * @param {string} sessionStr
 */
export function makeClient(cfg, sessionStr = '') {
  const apiId = cfg.account?.apiId
  const apiHash = cfg.account?.apiHash
  if (!apiId || !apiHash) {
    throw new Error('缺 apiId/apiHash：去 my.telegram.org 申请，然后 tg_config 填进 account.apiId / account.apiHash')
  }

  const opts = {
    connectionRetries: 3,
    connectionTimeout: 30000,
    autoReconnect: true,
  }

  const socks = String(cfg.socksUrl ?? '').trim()
  if (socks) {
    const p = parseSocks(socks)
    opts.networkSocket = class extends ProxiedNetSockets {
      constructor() { super(p) }
    }
  }

  return new TelegramClient(new StringSession(sessionStr), Number(apiId), apiHash, opts)
}

export function hasSession(home) {
  return existsSync(sessionFile(home)) && loadSession(home).length > 20
}
