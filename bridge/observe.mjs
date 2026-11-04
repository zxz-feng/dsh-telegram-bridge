/**
 * bridge/observe.mjs —— 群聊观察（视奸）
 * ============================================================================
 * 为什么要有这个：私聊时如果只知道对方这一句，接话会很干。知道他在群里刚聊了
 * 什么，回起来才像"认识他"。
 *
 * 三条铁律（实现上必须守住）：
 *   1. 只记录，不参与回复。观察模块永远不改决策、不产生消息。
 *   2. 机器人消息单独归零 —— 不进他的记录、不进摘要、不进上下文。
 *      群里签到/抽卡机器人一天几十条，混进来会把有用的信息淹掉。
 *   3. 上下文分两条线：
 *        时间线 —— 他这句前面 aroundLines 条（谁说的、说了啥）
 *        引用线 —— 他 reply_to 指向的那条（他从别人那句话接的话）
 *      只有时间线是不够的：他回的可能是一小时前某句话，光看前三条会接错。
 *
 * 存储（都在 <home>/observe/ 下）：
 *   <chatId>.jsonl   群里每条消息一行（原始层，keepDays 天滚动）
 *   his.jsonl        重点人物的发言 + 上下文（索引层，注入只用这一份）
 *   digest.json      { date, text } 每日摘要（花钱，默认一天一次）
 *
 * 体积：1000 条/天 × 7 天 ≈ 1MB，可以忽略。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { chat } from './llm.mjs'

export const OBSERVE_DEFAULTS = {
  enabled: false,
  groups: [],            // 只观察这些群（负数 chatId 字符串）
  targets: [],           // 重点人物 userId（字符串）
  aroundLines: 3,        // 时间线：他这句前面几条
  replyDepth: 2,         // 引用线：往上追几层
  keepDays: 7,
  injectLines: 8,        // 私聊时最多注入几条
  dailyDigest: false,    // 每日摘要（要调模型，花钱）
  digestHour: 5,         // 几点之后可以生成"昨天"的摘要
  digestMaxChars: 6000,  // 送进摘要模型的原文上限
}

const LINK_RE = /https?:\/\/[^\s<>"']+/g

/** 他这句话像不像"在指挥机器人"：命令、@某bot、踢人/禁言这类动作词 */
export function looksLikeBotCommand(text) {
  const t = String(text || '').trim()
  if (!t) return false
  if (/^[/!]/.test(t)) return true                                   // /kick、!ban
  if (/@[A-Za-z0-9_]{2,}bot\b/i.test(t)) return true                  // @xxx_bot
  if (/(踢|禁言|撤回|封禁|警告|ban|kick|mute|warn|purge)/i.test(t)) return true
  return false
}

/** 引用一条消息时，没文字就给个占位（广告常常只有图/链接预览） */
function quotedText(o) {
  if (!o) return ''
  const t = String(o.text || '').trim()
  if (t) return t
  const k = o.kind && o.kind !== 'text' ? o.kind : '空消息'
  return `[${k}]`
}

/** 读观察配置；文件不存在就用默认（默认关） */
export function loadObserveCfg(home) {
  const file = join(home, 'observe.json')
  if (!existsSync(file)) return { ...OBSERVE_DEFAULTS }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const cfg = { ...OBSERVE_DEFAULTS, ...raw }
    cfg.groups = (cfg.groups || []).map(String)
    cfg.targets = (cfg.targets || []).map(String)
    return cfg
  } catch {
    return { ...OBSERVE_DEFAULTS }
  }
}

function observeDir(home) {
  const d = join(home, 'observe')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

function dayKey(d = new Date()) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

function senderName(m) {
  const s = m?.sender
  if (!s) return String(m?.senderId ?? '?')
  return s.firstName || s.title || s.username || String(m?.senderId ?? '?')
}

function textOf(m) {
  const t = m?.text ?? m?.message?.text ?? ''
  return String(t || '').trim()
}

function kindOf(m) {
  if (m?.photo || m?.media?.photo) return 'photo'
  if (m?.document || m?.media?.document) return 'file'
  if (m?.video || m?.media?.video) return 'video'
  if (m?.sticker || m?.media?.sticker) return 'sticker'
  if (m?.voice || m?.audio || m?.media?.audio) return 'voice'
  return 'text'
}

/**
 * 造观察器
 * @param {{home: string, log: Function}} o
 */
export function makeObserver({ home, log = () => {} }) {
  const dir = observeDir(home)
  /** 每个群最近几条，用于时间线上下文 */
  const ring = new Map()
  let lastPrune = 0
  let digestBusy = false
  /** chatId → { ts, id, text } 他上一条消息（用来判断机器人是不是在回应他） */
  const lastHim = new Map()

  function ringOf(chatId) {
    if (!ring.has(chatId)) ring.set(chatId, [])
    return ring.get(chatId)
  }

  /** 启动时把每个群最后 aroundLines 条读回内存，避免重启后第一条缺上下文 */
  function warm(cfg) {
    for (const chatId of cfg.groups) {
      const file = join(dir, `${chatId}.jsonl`)
      if (!existsSync(file)) continue
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-20)
      const r = []
      for (const ln of lines) {
        try {
          const o = JSON.parse(ln)
          if (o && o.text) r.push({ name: o.name, text: o.text })
        } catch { /* 坏行跳过 */ }
      }
      ring.set(chatId, r.slice(-Math.max(cfg.aroundLines, 3)))
    }
  }

  /** 记一条群消息。返回 true 表示这条被观察了 */
  function record(m, cfg) {
    if (!cfg?.enabled) return false
    const chatId = String(m?.chatId ?? '')
    if (!cfg.groups.includes(chatId)) return false

    const isBot = m?.sender?.bot === true
    const via = m?.viaBotId ? String(m.viaBotId) : ''
    const fwd = m?.fwdFrom ? 1 : 0
    const text = textOf(m)
    const kind = kindOf(m)
    if (!text && kind === 'text') return false

    const from = String(m?.senderId ?? '')
    const name = senderName(m)
    const replyTo = m?.replyTo?.replyToMsgId ? String(m.replyTo.replyToMsgId) : ''

    const row = {
      ts: new Date().toISOString(),
      id: String(m?.id ?? ''),
      from,
      name,
      bot: isBot ? 1 : 0,
      via,
      fwd,
      kind,
      text: text.slice(0, 500),
      links: text.match(LINK_RE)?.slice(0, 3) ?? [],
    }
    if (replyTo) row.replyTo = replyTo

    // 原始层：全部落盘（机器人也记，但打标记）
    appendFileSync(join(dir, `${chatId}.jsonl`), JSON.stringify(row) + '\n')

    // 时间线：他这句前面几条
    const around = ringOf(chatId).slice(-cfg.aroundLines)
    // 机器人的话不进时间线：签到/抽卡会把人话挤掉，而且对"他在跟谁聊"毫无帮助
    if (!isBot) {
      ringOf(chatId).push({ name, text: row.text })
      if (ringOf(chatId).length > 30) ringOf(chatId).shift()
    }

    // 机器人消息：不记时间线，但如果是"他在指挥机器人"的回应，要留痕
    // （场景：管理员引用广告消息、用指令召唤 bot 踢人 —— 光看他那句命令
    //   不知道结果，下次私聊就会问"你刚踢了谁"这种蠢问题）
    if ((isBot || via) && !cfg.targets.includes(from)) {
      const prev = lastHim.get(chatId)
      const fresh = prev && Date.now() - new Date(prev.ts).getTime() < 90_000
      const isReplyToHim = prev && replyTo && String(replyTo) === String(prev.id)
      if (fresh && (isReplyToHim || looksLikeBotCommand(prev.text))) {
        appendFileSync(join(dir, 'his.jsonl'), JSON.stringify({
          ts: row.ts, chat: chatId, role: 'bot', forTs: prev.ts,
          name, text: row.text.slice(0, 200),
        }) + '\n')
        log(`[observe] 记下机器人回应：${row.text.slice(0, 30)}`)
      }
    }

    // 索引层：只记重点人物
    if (cfg.targets.includes(from) && !isBot) {
      let quoted = null
      if (replyTo) {
        // 先在原始层里找（绝大多数能命中，零 API 调用）
        quoted = findInFile(join(dir, `${chatId}.jsonl`), replyTo)
        if (quoted) quoted = { name: quoted.name, text: quotedText(quoted) }
      }
      const his = {
        ts: row.ts,
        chat: chatId,
        role: 'him',
        text: row.text,
        links: row.links,
        kind,
        around: around.map((x) => `${x.name}: ${x.text.slice(0, 60)}`),
        reply: quoted,
      }
      appendFileSync(join(dir, 'his.jsonl'), JSON.stringify(his) + '\n')
      lastHim.set(chatId, { ts: row.ts, id: String(m?.id ?? ''), text: row.text })
      log(`[observe] 记下他的一句：${row.text.slice(0, 30)}${quoted ? '（有引用）' : ''}`)
    }

    maybePrune(cfg)
    return true
  }

  function findInFile(file, id) {
    try {
      const lines = readFileSync(file, 'utf8').split('\n')
      // 全文件回扫（7 天上限 ~7000 行，1MB 以内，比漏掉被引用的那条划算）
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i]) continue
        try {
          const o = JSON.parse(lines[i])
          if (String(o.id) === String(id)) return o
        } catch { /* 坏行 */ }
      }
    } catch { /* 文件不在 */ }
    return null
  }

  /** 每天最多一次：把超过 keepDays 的行删掉 */
  function maybePrune(cfg) {
    const now = Date.now()
    if (now - lastPrune < 3600_000) return
    lastPrune = now
    const cut = now - cfg.keepDays * 86400_000
    const files = [join(dir, 'his.jsonl'), ...cfg.groups.map((c) => join(dir, `${c}.jsonl`))]
    for (const f of files) {
      if (!existsSync(f)) continue
      try {
        const kept = readFileSync(f, 'utf8').split('\n').filter((ln) => {
          if (!ln) return false
          try { return new Date(JSON.parse(ln).ts).getTime() >= cut } catch { return false }
        })
        writeFileSync(f, kept.join('\n') + (kept.length ? '\n' : ''))
      } catch { /* 忽略 */ }
    }
  }

  function readDigest() {
    const f = join(dir, 'digest.json')
    if (!existsSync(f)) return null
    try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null }
  }

  /** 私聊时注入的背景块（委托给模块级实现，方便 reply.mjs 直接用） */
  function promptBlock(chatId, cfg) {
    return buildObserveBlock(home, chatId, cfg)
  }

  /**
   * 生成"昨天"的摘要。fire-and-forget：不阻塞回复，失败就下次再说。
   */
  async function maybeDigest(cfg, mainCfg) {
    if (!cfg?.enabled || !cfg.dailyDigest) return
    if (!mainCfg?.llm?.models?.length) { log('[observe] 没有可用模型，跳过摘要'); return }
    if (digestBusy) return
    const now = new Date()
    if (now.getHours() < cfg.digestHour) return
    const yesterday = dayKey(new Date(now.getTime() - 86400_000))
    const dig = readDigest()
    if (dig?.date === yesterday) return

    const chunks = []
    for (const chatId of cfg.groups) {
      const f = join(dir, `${chatId}.jsonl`)
      if (!existsSync(f)) continue
      for (const ln of readFileSync(f, 'utf8').split('\n')) {
        if (!ln) continue
        try {
          const o = JSON.parse(ln)
          if (dayKey(new Date(o.ts)) !== yesterday) continue
          if (o.bot) continue
          if (!o.text) continue
          chunks.push(`${o.name}: ${o.text.slice(0, 60)}`)
        } catch { /* 坏行 */ }
      }
    }
    // 原来写 20：群一天说不到 20 句就永远不出摘要（11-03 只有 19 条，白等一天）
    if (chunks.length < 6) return

    digestBusy = true
    try {
      const body = chunks.join('\n').slice(-cfg.digestMaxChars)
      const r = await chat(mainCfg, [
        {
          role: 'system',
          content: '你在做群聊摘要，只输出要点，不要评价、不要建议、不要客套。'
            + '4~6 行，每行一句，说清楚：谁在聊什么、重点人物说了什么、群里什么气氛。',
        },
        { role: 'user', content: `这是昨天群里的一部分聊天记录：\n${body}` },
      ], { maxTokens: 400, temperature: 0.3 })
      const text = String(r.text || '').trim()
      if (text) {
        writeFileSync(join(dir, 'digest.json'), JSON.stringify({ date: yesterday, text }, null, 2))
        log(`[observe] 昨天摘要已生成（${chunks.length} 条 → ${text.length} 字）`)
      }
    } catch (e) {
      log(`[observe] 摘要失败：${e?.message ?? e}`)
    } finally {
      digestBusy = false
    }
  }

  return { record, promptBlock, maybeDigest, warm, dir }
}


/**
 * 模块级：直接按 home + chatId 拼出注入块。
 * reply.mjs 用它（不需要先造一个 observer 实例）。
 */
export function buildObserveBlock(home, chatId, cfg) {
  if (!cfg?.enabled) return ''
  if (!cfg.targets.includes(String(chatId))) return ''
  const dir = join(home, 'observe')
  const hisFile = join(dir, 'his.jsonl')
  if (!existsSync(hisFile)) return ''

  const cut = Date.now() - cfg.keepDays * 86400_000
  const rows = []
  for (const ln of readFileSync(hisFile, 'utf8').split('\n')) {
    if (!ln) continue
    try {
      const o = JSON.parse(ln)
      if (new Date(o.ts).getTime() >= cut) rows.push(o)
    } catch { /* 坏行 */ }
  }
  if (!rows.length) return ''
  const take = rows.slice(-cfg.injectLines)

  const fmt = (iso) => {
    const d = new Date(iso)
    const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    return dayKey(d) === dayKey() ? hm : `${md} ${hm}`
  }

  const lines = []
  for (const o of take) {
    if (o.role === 'bot') {
      // 机器人回应挂在"他那句命令"下面，不单独占一行（否则看起来像他在说话）
      if (lines.length) lines[lines.length - 1] += `\n  ↳ 机器人回应：${String(o.text).slice(0, 50)}`
      continue
    }
    let s = `· ${fmt(o.ts)} 他：${String(o.text).slice(0, 60)}`
    if (o.reply) s += `\n  ↳ 回的是 ${o.reply.name} 说的「${String(o.reply.text).slice(0, 40)}」`
    else if (o.around?.length) s += `\n  ↳ 当时在聊：${String(o.around[o.around.length - 1]).slice(0, 40)}`
    lines.push(s)
  }

  let digLine = ''
  const df = join(dir, 'digest.json')
  if (existsSync(df)) {
    try {
      const dig = JSON.parse(readFileSync(df, 'utf8'))
      if (dig?.text) digLine = `\n【群里最近的气氛】\n${String(dig.text).slice(0, 400)}`
    } catch { /* 忽略 */ }
  }

  return `\n\n【他最近在群里（只是背景，别像汇报监控，一次最多自然提一条）】\n`
    + lines.join('\n') + digLine
}
