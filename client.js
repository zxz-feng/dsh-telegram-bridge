/**
 * dsh-telegram-bridge —— 浏览器半端（「设置」里的「Telegram 小鲸鱼」那一页）
 * ============================================================================
 * ⭐ client bundle **不是 ESM，是自注册脚本**（约定来自官方包）：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<包名>',                        // 必须等于 package.json 的 name
 *       factory: (require) => ({ inject: [...], apply(ctx) {...} }),
 *     })
 *
 * ⭐ 进「设置」的唯一正确写法（和 dsh-bili-scroll / QQ 那套一致）：
 *
 *     slots.inject('settings.section', () => slots.register(
 *       { name: 'settings.section', id: 'telegram-bridge', order: 50, label: 'Telegram 小鲸鱼' },
 *       () => h(Panel),
 *     ))
 *
 * 这一页和 QQ 那页同一个骨架（CSS 前缀换成 data-tg-，两边互不打架）：
 *   · 总开关在最上面，关掉之后下面全部收起（不是灰一片）
 *   · 会话**一人一行**，改完自己保存 —— 不要「保存全部」
 *   · 数字项能自己填，但**钳位以服务端为准**（前端只显示范围，不当唯一真相）
 *   · 登录是三步：手机号 → 验证码 →（要的话）两步密码，状态全在页面上
 *   · 会花 token 的（模型、字数、轮数）都给出默认值，别让人乱调
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-telegram-bridge',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const API = '/api/tg-bridge'

    /* ⚠️ 不要无脑 .json()：HTTP 500 的 {ok:false} 会被当成「保存成功」，
     *    绿色提示把故障盖掉（bili 那边踩过一次）。 */
    const asJson = async (res) => {
      if (res.status === 204) return { ok: true, empty: true }
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录 / 没权限）' : res.status === 403 ? '（被宿主拦了：非同源）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const CSS = `
[data-tg-page]{display:flex;flex-direction:column;gap:16px;padding:2px 2px 10px;max-width:720px;}
[data-tg-sec]{display:flex;flex-direction:column;gap:9px;}
[data-tg-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-tg-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-tg-col]{display:flex;flex-direction:column;gap:3px;min-width:0;}
[data-tg-grow]{flex:1;min-width:0;}
[data-tg-label]{font-size:13px;}
[data-tg-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-tg-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-tg-sw][data-on]{background:#3b82f6;}
[data-tg-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;
  transition:left .15s;display:block;}
[data-tg-sw][data-on] i{left:19px;}
[data-tg-sw][disabled]{opacity:.45;cursor:default;}
[data-tg-input]{box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-tg-input]:focus{outline:none;border-color:#3b82f6;}
[data-tg-num]{width:82px;text-align:center;}
[data-tg-full]{width:100%;}
[data-tg-btn]{padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.14));color:inherit;}
[data-tg-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-tg-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-tg-btn][data-danger]{color:#f87171;border-color:rgba(248,113,113,.4);}
[data-tg-btn][disabled]{opacity:.5;cursor:default;}
[data-tg-msg]{font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;word-break:break-all;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-tg-msg][data-good]{color:#22c55e;}
[data-tg-msg][data-warn]{color:#f59e0b;}
[data-tg-card]{display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:12px;
  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.22));}
[data-tg-card-h]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-tg-badge]{font-size:11px;padding:2px 7px;border-radius:6px;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.14));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-tg-badge][data-live]{color:#22c55e;}
[data-tg-badge][data-dry]{color:#f59e0b;}
[data-tg-grid]{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:9px 12px;}
[data-tg-pre]{margin:0;padding:8px 9px;border-radius:8px;max-height:200px;overflow:auto;font-size:11px;
  line-height:15px;white-space:pre-wrap;word-break:break-all;
  background:var(--dsw-alias-bg-layer-4,rgba(0,0,0,.25));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-tg-kv]{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary,#9aa0a6);word-break:break-all;}
[data-tg-away]{display:none !important;}
[data-tg-qr]{display:flex;gap:12px;align-items:flex-start;}
[data-tg-qr] img{width:150px;height:150px;border-radius:8px;background:#fff;padding:6px;}
[data-tg-tbl]{display:flex;flex-direction:column;gap:6px;}
[data-tg-tr]{display:flex;align-items:center;gap:8px;font-size:12px;}
[data-tg-mono]{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
`

    /* ────────────── 小组件 ────────────── */

    function Sw({ on, onChange, disabled }) {
      return h('button', {
        type: 'button', 'data-tg-sw': '', 'data-on': on ? '1' : undefined,
        disabled: Boolean(disabled),
        'aria-pressed': on ? 'true' : 'false',
        onClick: () => { if (!disabled) onChange(!on) },
      }, h('i'))
    }

    function Num({ value, onChange, min, max, step = 1, width }) {
      return h('input', {
        'data-tg-input': '', 'data-tg-num': '', type: 'number',
        style: width ? { width } : undefined,
        value: value === undefined || value === null ? '' : value,
        min, max, step,
        onChange: (e) => onChange(e.target.value === '' ? '' : Number(e.target.value)),
      })
    }

    function Text({ value, onChange, placeholder, mono }) {
      return h('input', {
        'data-tg-input': '', 'data-tg-full': '', type: 'text',
        'data-tg-mono': mono ? '' : undefined,
        value: value ?? '', placeholder: placeholder ?? '',
        onChange: (e) => onChange(e.target.value),
      })
    }

    function Msg({ m }) {
      if (!m) return null
      return h('div', { 'data-tg-msg': '', 'data-good': m.kind === 'good' ? '' : undefined, 'data-warn': m.kind === 'warn' ? '' : undefined }, m.text)
    }

    const pct = (v) => Math.round(Number(v ?? 0) * 1000) / 10   // 0.02 → 2

    /* ────────────── 群卡片 ────────────── */

    function Sec({ title, note, away, children }) {
      return h('div', { 'data-tg-sec': '', 'data-tg-away': away ? '' : undefined },
        h('div', { 'data-tg-h': '' }, title),
        note ? h('div', { 'data-tg-note': '' }, note) : null,
        children)
    }

    const bt = (label, onClick, disabled, kind) => h('button', {
      type: 'button', 'data-tg-btn': '', 'data-kind': kind || undefined,
      disabled: Boolean(disabled), onClick,
    }, label)

    /* ────────────── 会话行 ────────────── */
    function ChatCard({ row, busy, onSave, onPause, onClear, onRemove }) {
      const [label, setLabel] = useState(row.label || '')
      const rounds = row.context?.turns ?? row.context?.count ?? null
      return h('div', { 'data-tg-card': '', 'data-tg-off': row.paused ? '' : undefined },
        h('div', { 'data-tg-row': '' },
          h('div', { 'data-tg-col': '', 'data-tg-grow': '' },
            h('div', { 'data-tg-label': '' }, row.label || row.id),
            h('div', { 'data-tg-note': '' }, row.id + (rounds === null ? '' : ` · 上下文 ${rounds} 轮`))),
          h('div', { 'data-tg-row': '' },
            h('span', { 'data-tg-note': '' }, row.paused ? '已暂停' : '在回'),
            h(Sw, { on: !row.paused, onChange: (v) => onPause(row.id, !v), disabled: Boolean(busy) }))),
        h('div', { 'data-tg-row': '' },
          h('div', { 'data-tg-grow': '' },
            h(Text, { value: label, onChange: setLabel, placeholder: '备注（比如：主人 / 烛天）' })),
          bt('存备注', () => onSave(row.id, label), Boolean(busy) || label === (row.label || '')),
          bt('清上下文', () => onClear(row.id), Boolean(busy)),
          bt('删', () => onRemove(row.id), Boolean(busy), 'danger')),
      )
    }

    /* ────────────── 整页 ────────────── */
    function Panel() {
      const [st, setSt] = useState(null)
      const [cfg, setCfg] = useState(null)
      const [chats, setChats] = useState(null)
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState(null)
      const [tail, setTail] = useState('')
      const [report, setReport] = useState('')
      const [newId, setNewId] = useState('')
      const [newLabel, setNewLabel] = useState('')
      const [login, setLogin] = useState({ phone: '', id: '', step: '', code: '', pw: '' })

      const load = useCallback(async () => {
        try {
          const [a, b, c] = await Promise.all([jget('/status'), jget('/config'), jget('/chats')])
          setSt(a); setCfg(b.config); setChats(c)
        } catch (e) { setMsg({ kind: 'warn', text: '读不到状态：' + e.message }) }
      }, [])

      useEffect(() => { void load() }, [load])

      // 只在草稿上改；点「保存」才发出去 —— 避免滑一下数字就把配置改了
      const set = (path, value) => {
        setCfg((cur) => {
          const next = JSON.parse(JSON.stringify(cur ?? {}))
          const keys = path.split('.')
          let o = next
          for (let i = 0; i < keys.length - 1; i += 1) { o[keys[i]] = o[keys[i]] || {}; o = o[keys[i]] }
          o[keys[keys.length - 1]] = value
          return next
        })
      }
      const v = (path, dflt) => {
        let o = cfg
        for (const k of path.split('.')) { if (o === null || o === undefined) return dflt; o = o[k] }
        return o === undefined ? dflt : o
      }

      const save = async (patch, label) => {
        setBusy(label || 'save'); setMsg(null)
        try {
          const r = await jpost('/config', { patch })
          if (r.config) setCfg(r.config)
          setMsg({ kind: 'good', text: r.note || '已保存' })
        } catch (e) { setMsg({ kind: 'warn', text: '保存失败：' + e.message }) }
        finally { setBusy('') }
      }

      const act = async (name, fn, okText) => {
        setBusy(name); setMsg(null)
        try { const r = await fn(); if (r?.ok === false) setMsg({ kind: 'warn', text: r.error || '失败' }); else if (okText) setMsg({ kind: 'good', text: okText }); return r }
        catch (e) { setMsg({ kind: 'warn', text: e.message }); return null }
        finally { setBusy(''); void load() }
      }

      if (!st || !cfg) {
        return h('div', { 'data-tg-page': '' }, h('div', { 'data-tg-note': '' }, '正在读状态…'), h(Msg, { m: msg }))
      }

      const on = st.enabled !== false
      const away = !on
      const br = st.bridge || {}
      const proc = st.process || {}
      const who = br.me || br.account || (br.configured === false ? '没配 apiId/apiHash' : br.hasSession ? '有 session，没连上' : '还没登录')
      const linked = br.connected && br.authorized

      const doLogin = async (step, body) => {
        const r = await act('login', () => jpost('/login/' + step, body))
        if (!r) return
        if (r.ok === false) { setLogin((s) => ({ ...s, step: '', id: '' })); return }
        setLogin((s) => ({ ...s, id: r.loginId || s.id, step: r.step === 'done' ? '' : (r.step || '') }))
        if (r.hint) setMsg({ kind: r.step === 'done' ? 'good' : 'info', text: r.hint })
      }

      return h('div', { 'data-tg-page': '' },

        /* ① 总开关 */
        h('div', { 'data-tg-row': '' },
          h('div', { 'data-tg-col': '', 'data-tg-grow': '' },
            h('div', { 'data-tg-label': '' }, '让 Telegram 小鲸鱼上线'),
            h('div', { 'data-tg-note': '' }, '关掉 = 桥不跑（进程停掉），配置和登录态都留着')),
          h(Sw, { on, onChange: (x) => save({ enabled: x }, 'enabled'), disabled: Boolean(busy) })),
        h(Msg, { m: msg }),

        /* ② 状态 */
        h(Sec, { title: '现在什么状态', away },
          h('div', { 'data-tg-row': '' },
            h('span', { 'data-tg-badge': '', 'data-good': linked ? '' : undefined }, linked ? '已连接' : '未连接'),
            h('span', { 'data-tg-badge': '' }, '进程 ' + (proc.state || '?')),
            proc.pid ? h('span', { 'data-tg-note': '' }, 'pid ' + proc.pid) : null,
            br.inflight ? h('span', { 'data-tg-badge': '', 'data-warn': '' }, '在途 ' + br.inflight) : null),
          h('div', { 'data-tg-note': '' }, '登录的是：' + who),
          h('div', { 'data-tg-note': '' },
            '模式 ' + (br.mode || st.config?.mode || 'auto')
            + ' · 白名单 ' + (br.direct?.count ?? st.config?.direct?.users?.length ?? 0) + ' 个'
            + ' · 暂停 ' + (br.direct?.paused ?? 0) + ' 个'
            + ' · 贴纸 ' + (br.stickers ?? 0)),
          br.persona ? h('div', { 'data-tg-note': '' },
            '人设 ' + (br.persona.name || '') + ' · 指纹 ' + (br.persona.version || '') + ' · ' + (br.persona.dir || '')) : null,
          br.error ? h('div', { 'data-tg-note': '', 'data-warn': '' }, '桥没响应：' + br.error) : null,
          h('div', { 'data-tg-note': '' }, '家目录 ' + (st.home || '')),
          br.counters ? h('div', { 'data-tg-note': '' }, '收到 ' + (br.counters.in ?? 0) + ' / 回 ' + (br.counters.out ?? 0) + ' / 跳过 ' + (br.counters.skipped ?? 0)) : null,
          h('div', { 'data-tg-row': '' },
            bt('刷新', () => { void load() }, false))),

        /* ③ 连接 */
        h(Sec, { title: '连接与模型', away, note: '改完点保存，下一句消息就按新配置走' },
          h('div', { 'data-tg-row': '' },
            h('div', { 'data-tg-col': '', 'data-tg-grow': '' },
              h('div', { 'data-tg-label': '' }, 'SOCKS5 代理'),
              h('div', { 'data-tg-note': '' }, '留空 = 直连（这台机器直连 api.telegram.org 会超时）')),
            h('div', { 'data-tg-grow': '' },
              h(Text, { value: v('socksUrl', ''), onChange: (x) => set('socksUrl', x), placeholder: 'socks5://127.0.0.1:17890', mono: true }))),
          h('div', { 'data-tg-row': '' },
            h('div', { 'data-tg-col': '', 'data-tg-grow': '' },
              h('div', { 'data-tg-label': '' }, '回话模式'),
              h('div', { 'data-tg-note': '' }, 'auto 自动回 / draft 只写草稿 / confirm 先问再发')),
            h('select', {
              'data-tg-input': '', value: v('mode', 'auto'),
              onChange: (e) => set('mode', e.target.value),
            }, ['auto', 'draft', 'confirm'].map((x) => h('option', { key: x, value: x }, x)))),
          h('div', { 'data-tg-row': '' },
            h('div', { 'data-tg-col': '', 'data-tg-grow': '' },
              h('div', { 'data-tg-label': '' }, '模型链'),
              h('div', { 'data-tg-note': '' }, '逗号分隔，前面的挂了自动往后换')),
            h('div', { 'data-tg-grow': '' },
              h(Text, { value: (v('llm.models', []) || []).join(','), onChange: (x) => set('llm.models', x.split(',').map((s) => s.trim()).filter(Boolean)), placeholder: 'deepseek-v4.1-flash,hy3', mono: true }))),
          h('div', { 'data-tg-row': '' },
            h('div', { 'data-tg-col': '', 'data-tg-grow': '' }, h('div', { 'data-tg-label': '' }, '每条最多几个字')),
            h(Num, { value: v('llm.maxChars', 600), onChange: (x) => set('llm.maxChars', x), min: 120, max: 4000, step: 20, width: 90 })),
          h('div', { 'data-tg-row': '' },
            h('div', { 'data-tg-col': '', 'data-tg-grow': '' }, h('div', { 'data-tg-label': '' }, '记多少轮上下文')),
            h(Num, { value: v('llm.maxTurns', 12), onChange: (x) => set('llm.maxTurns', x), min: 2, max: 60, width: 80 })),
          h('div', { 'data-tg-row': '' },
            bt('保存连接设置', () => save({
              socksUrl: v('socksUrl', ''),
              mode: v('mode', 'auto'),
              llm: { models: v('llm.models', []), maxChars: v('llm.maxChars', 600), maxTurns: v('llm.maxTurns', 12) },
            }, 'conn'), Boolean(busy)))),

        /* ④ 账号 + 登录 */
        h(Sec, { title: '账号', away, note: 'apiId/apiHash 在 my.telegram.org 申请；改完保存再登录' },
          h('div', { 'data-tg-row': '' },
            h('div', { 'data-tg-col': '', 'data-tg-grow': '' }, h('div', { 'data-tg-label': '' }, 'apiId')),
            h(Num, { value: v('account.apiId', ''), onChange: (x) => set('account.apiId', x), min: 0, width: 110 })),
          h('div', { 'data-tg-row': '' },
            h('div', { 'data-tg-col': '', 'data-tg-grow': '' },
              h('div', { 'data-tg-label': '' }, 'apiHash'),
              h('div', { 'data-tg-note': '' }, '打码显示；不动它就等于不改')),
            h('div', { 'data-tg-grow': '' },
              h(Text, { value: v('account.apiHash', ''), onChange: (x) => set('account.apiHash', x), placeholder: '••••••••', mono: true }))),
          h('div', { 'data-tg-row': '' },
            bt('保存账号', () => save({ account: { apiId: v('account.apiId', 0), apiHash: v('account.apiHash', '') } }, 'account'), Boolean(busy))),

          h('div', { 'data-tg-row': '' },
            h('div', { 'data-tg-col': '', 'data-tg-grow': '' },
              h('div', { 'data-tg-label': '' }, '登录手机号'),
              h('div', { 'data-tg-note': '' }, '国际格式，例 +8613800138000；验证码会发到这个号的 Telegram')),
            h('div', { 'data-tg-grow': '' },
              h(Text, { value: login.phone, onChange: (x) => setLogin((s) => ({ ...s, phone: x })), placeholder: '+86…', mono: true })),
            bt('发验证码', () => doLogin('start', { phone: login.phone }), Boolean(busy) || !login.phone)),

          login.step === 'code' ? h('div', { 'data-tg-row': '' },
            h('div', { 'data-tg-grow': '' },
              h(Text, { value: login.code, onChange: (x) => setLogin((s) => ({ ...s, code: x })), placeholder: '手机收到的 5 位验证码', mono: true })),
            bt('确认', () => doLogin('code', { loginId: login.id, code: login.code }), Boolean(busy) || !login.code),
            bt('取消', () => doLogin('cancel', { loginId: login.id }), false, 'ghost')) : null,

          login.step === 'password' ? h('div', { 'data-tg-row': '' },
            h('div', { 'data-tg-grow': '' },
              h(Text, { value: login.pw, onChange: (x) => setLogin((s) => ({ ...s, pw: x })), placeholder: '两步验证密码' })),
            bt('提交密码', () => doLogin('password', { loginId: login.id, password: login.pw }), Boolean(busy) || !login.pw),
            bt('取消', () => doLogin('cancel', { loginId: login.id }), false, 'ghost')) : null,

          (st.logins || []).length
            ? h('div', { 'data-tg-note': '' }, '进行中的登录：' + st.logins.map((x) => `${x.id.slice(0, 6)}…(${x.step || '?'})`).join('、'))
            : null),

        /* ⑤ 会话 */
        h(Sec, { title: '谁能跟她说上话', away, note: '不在名单里的私聊一律不回；暂停 = 消息照记录只是不回' },
          !chats || chats.bridgeUp === false
            ? h('div', { 'data-tg-note': '', 'data-warn': '' }, '桥没在跑，读不到上下文（名单仍然能改）')
            : null,
          (chats?.users || []).map((row) => h(ChatCard, {
            key: row.id, row, busy,
            onSave: (id, label) => act('label', () => jpost('/user', { id, label }), '备注已存'),
            onPause: (id, paused) => act('pause', () => jpost('/pause', { chatId: id, paused }), paused ? '已暂停' : '已恢复'),
            onClear: (id) => act('clear', () => jpost('/context-clear', { chatId: id }), '上下文清了'),
            onRemove: (id) => act('del', () => jpost('/user', { id, remove: true }), '已从名单移除'),
          })),
          (chats?.users || []).length === 0
            ? h('div', { 'data-tg-note': '' }, '名单是空的 —— 谁跟她说话她都不回。先加一个。')
            : null,
          h('div', { 'data-tg-row': '' },
            h('div', { 'data-tg-col': '', 'data-tg-grow': '' }, h('div', { 'data-tg-label': '' }, '加一个人')),
            h('div', { 'data-tg-grow': '' },
              h(Text, { value: newId, onChange: setNewId, placeholder: '用户 id（数字）', mono: true })),
            h('div', { 'data-tg-grow': '' },
              h(Text, { value: newLabel, onChange: setNewLabel, placeholder: '备注' })),
            bt('加', () => act('add', async () => {
              const r = await jpost('/user', { id: newId, label: newLabel })
              if (r.ok) { setNewId(''); setNewLabel('') }
              return r
            }, '已加入'), Boolean(busy) || !newId)),

          h('div', { 'data-tg-row': '' },
            h('div', { 'data-tg-col': '', 'data-tg-grow': '' },
              h('div', { 'data-tg-label': '' }, '私聊'),
              h('div', { 'data-tg-note': '' }, 'off = 谁都不回（名单留着）；allowlist = 只回名单里的')),
            h('select', {
              'data-tg-input': '', value: chats?.direct?.mode || 'allowlist',
              onChange: (e) => act('direct', () => jpost('/config', { patch: { direct: { mode: e.target.value } } }), '已保存'),
            }, ['allowlist', 'off'].map((x) => h('option', { key: x, value: x }, x)))),
          h('div', { 'data-tg-row': '' },
            h('div', { 'data-tg-col': '', 'data-tg-grow': '' },
              h('div', { 'data-tg-label': '' }, '群聊'),
              h('div', { 'data-tg-note': '' }, 'off = 群里的消息一概不理；allowlist = 只理名单里的群')),
            h('select', {
              'data-tg-input': '', value: chats?.groups?.mode || 'off',
              onChange: (e) => act('groups', () => jpost('/groups', { mode: e.target.value }), '已保存'),
            }, ['off', 'allowlist'].map((x) => h('option', { key: x, value: x }, x)))),
          (chats?.groups?.chats || []).length
            ? h('div', { 'data-tg-note': '' }, '群名单：' + chats.groups.chats.join('、'))
            : null),

        /* ⑥ 运维 */
        h(Sec, { title: '运维', away },
          h('div', { 'data-tg-row': '' },
            bt('跑一遍自检', async () => {
              const r = await act('verify', () => jpost('/verify', {}))
              if (r?.report) setReport(r.report)
            }, Boolean(busy)),
            bt('看日志', async () => {
              const r = await act('log', () => jget('/log?lines=60'))
              if (r?.tail) setTail(r.tail)
            }, Boolean(busy)),
            bt('重启桥', () => act('restart', () => jpost('/restart', {}), '重启了，5 秒后刷新'), Boolean(busy), 'danger')),
          report ? h('pre', { 'data-tg-pre': '' }, report) : null,
          tail ? h('pre', { 'data-tg-pre': '' }, tail) : null),

        h('div', { 'data-tg-note': '' }, '数据都在 ' + (st.home || '家目录') + '：config.json / session.txt / contexts/'),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.slots || ctx.get?.('slots')
        if (!slots) return
        const off = slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'telegram-bridge', order: 50, label: 'Telegram 小鲸鱼' },
          () => h(Panel),
        ))
        ctx.effect?.(() => off)
      },
    }
  },
})
