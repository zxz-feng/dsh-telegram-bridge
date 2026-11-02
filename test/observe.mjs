/**
 * test/observe.mjs —— 群聊观察的单元测试
 * 覆盖：白名单群 / 机器人隔离 / 时间线 / 引用线 / 注入格式 / 过期清理
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeObserver, loadObserveCfg, buildObserveBlock, looksLikeBotCommand, OBSERVE_DEFAULTS } from '../bridge/observe.mjs'

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}

const home = mkdtempSync(join(tmpdir(), 'obs-'))
const GROUP = '-1001906049324'
const OTHER = '-1009999999999'
const HE = '8079117108'

const cfg = {
  ...OBSERVE_DEFAULTS,
  enabled: true,
  groups: [GROUP],
  targets: [HE],
  dailyDigest: false,
}

const obs = makeObserver({ home, log: () => {} })
const appendRaw = (o) => writeFileSync(join(home, 'observe', `${GROUP}.jsonl`), readFileSync(join(home, 'observe', `${GROUP}.jsonl`), 'utf8') + JSON.stringify(o) + '\n')

const mk = (o) => ({
  chatId: o.chatId ?? GROUP,
  id: o.id ?? String(Math.random()),
  senderId: o.senderId ?? '111',
  sender: o.bot ? { firstName: o.name ?? 'BOT', bot: true } : { firstName: o.name ?? '甲' },
  text: o.text ?? '',
  ...(o.replyTo ? { replyTo: { replyToMsgId: o.replyTo } } : {}),
})

console.log('===== 观察器 =====')

// 1. 别的群不记
ok('不观察的群 → 返回 false', obs.record(mk({ chatId: OTHER, text: '别处的话' }), cfg) === false)
ok('别的群没落盘', !existsSync(join(home, 'observe', `${OTHER}.jsonl`)))

// 2. 观察群：普通人一句
ok('观察群 → 记下', obs.record(mk({ id: '1', text: '新版本出了', name: '乙' }), cfg) === true)
ok('原始层有文件', existsSync(join(home, 'observe', `${GROUP}.jsonl`)))
ok('他不是目标 → 不进 his', !existsSync(join(home, 'observe', 'his.jsonl')))

// 3. 机器人消息：落原始层，不进 his
obs.record(mk({ id: '2', text: '签到成功 +1', name: '签到机器人', bot: true, senderId: '900' }), cfg)
const raw = readFileSync(join(home, 'observe', `${GROUP}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse)
ok('机器人也落原始层', raw.length === 2)
ok('机器人行带 bot=1', raw[1].bot === 1)

// 4. 他说话 → 进 his，带时间线
obs.record(mk({ id: '3', senderId: HE, name: '烛天', text: '这游戏又更新了' }), cfg)
const his1 = readFileSync(join(home, 'observe', 'his.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
ok('他的消息进 his', his1.length === 1 && his1[0].text === '这游戏又更新了')
ok('带时间线上下文', Array.isArray(his1[0].around) && his1[0].around.length >= 1)
ok('时间线里不含机器人', his1[0].around.every((x) => !x.includes('签到')))

// 5. 引用线：他回的是第 1 条
obs.record(mk({ id: '4', senderId: HE, name: '烛天', text: '是啊', replyTo: '1' }), cfg)
const his2 = readFileSync(join(home, 'observe', 'his.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
ok('引用被解析出来', his2[1].reply && his2[1].reply.text === '新版本出了')
ok('引用带说话人', his2[1].reply.name === '乙')

// 6. 链接提取
obs.record(mk({ id: '5', senderId: HE, name: '烛天', text: '看这个 https://b23.tv/abc 笑死' }), cfg)
const his3 = readFileSync(join(home, 'observe', 'his.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
ok('抽出链接', his3[2].links[0] === 'https://b23.tv/abc')

// 7. 注入块
const block = buildObserveBlock(home, HE, cfg)
ok('注入块有标题', block.includes('他最近在群里'))
ok('注入块含他的原话', block.includes('这游戏又更新了'))
ok('注入块含引用', block.includes('回的是 乙 说的'))
ok('非目标不给注入', buildObserveBlock(home, '999', cfg) === '')
ok('关掉就不注入', buildObserveBlock(home, HE, { ...cfg, enabled: false }) === '')

// 8. 摘要文件参与注入
writeFileSync(join(home, 'observe', 'digest.json'), JSON.stringify({ date: '2026-01-01', text: '群里在聊新卡池' }))
ok('摘要进注入块', buildObserveBlock(home, HE, cfg).includes('群里在聊新卡池'))

// 9. 过期清理
const old = { ts: new Date(Date.now() - 30 * 86400_000).toISOString(), chat: GROUP, text: '很久以前', around: [], links: [] }
const hisFile = join(home, 'observe', 'his.jsonl')
writeFileSync(hisFile, JSON.stringify(old) + '\n' + readFileSync(hisFile, 'utf8'))
const obs2 = makeObserver({ home, log: () => {} })
obs2.record(mk({ id: '6', senderId: HE, name: '烛天', text: '触发一次清理' }), cfg)
const after = readFileSync(hisFile, 'utf8').trim().split('\n').map(JSON.parse)
ok('过期行被删掉', after.every((r) => r.text !== '很久以前'), `剩 ${after.length} 行`)

// 10. 配置读取
writeFileSync(join(home, 'observe.json'), JSON.stringify({ enabled: true, groups: [GROUP], targets: [HE] }))
const lc = loadObserveCfg(home)
ok('配置能读', lc.enabled === true && lc.groups[0] === GROUP)
ok('缺字段用默认', lc.keepDays === OBSERVE_DEFAULTS.keepDays)
ok('坏配置退回默认', (() => {
  writeFileSync(join(home, 'observe.json'), '{ 这不是 json')
  return loadObserveCfg(home).enabled === OBSERVE_DEFAULTS.enabled
})())


// 11. 他指挥机器人：命令 + 机器人回应，要留痕
ok('命令识别：/kick', looksLikeBotCommand('/kick 123') === true)
ok('命令识别：@xxx_bot', looksLikeBotCommand('@jjbot 踢了他') === true)
ok('命令识别：普通聊天不算', looksLikeBotCommand('今天天气不错') === false)

obs.record(mk({ id: '20', senderId: HE, name: '烛天', text: '@jjbot 把这个人踢了' }), cfg)
obs.record(mk({ id: '21', senderId: '900', name: 'JJBot', bot: true, text: '已禁言该用户 10 分钟', replyTo: '20' }), cfg)
const hisFile2 = join(home, 'observe', 'his.jsonl')
const rows2 = readFileSync(hisFile2, 'utf8').trim().split('\n').map(JSON.parse)
const botRow = rows2.find((r) => r.role === 'bot')
ok('机器人回应被记进 his', !!botRow && botRow.text.includes('已禁言'))
ok('机器人回应绑定到他那条', botRow && botRow.forTs === rows2.find((r) => r.id === undefined && r.text.startsWith('@jjbot')).ts)
const blk2 = buildObserveBlock(home, HE, cfg)
ok('注入块里机器人挂在命令下面',
  blk2.indexOf('机器人回应：已禁言') > blk2.indexOf('@jjbot 把这个人踢了')
  && blk2.indexOf('机器人回应：已禁言') - blk2.indexOf('@jjbot 把这个人踢了') < 200, '\n' + blk2)
ok('机器人不冒充他说话', !/他：已禁言/.test(blk2))

// 12. 他没下命令时，机器人自己刷屏不该记
obs.record(mk({ id: '30', senderId: HE, name: '烛天', text: '今天天气不错' }), cfg)
const before = readFileSync(hisFile2, 'utf8').trim().split('\n').length
obs.record(mk({ id: '31', senderId: '901', name: '签到机器人', bot: true, text: '签到成功 +1' }), cfg)
const after2 = readFileSync(hisFile2, 'utf8').trim().split('\n').length
ok('无关机器人不进 his', after2 === before, `${before} → ${after2}`)

// 13. 引用一条没有文字的广告图
obs.record(mk({ id: '40', senderId: '777', name: '广告号', text: '' }), cfg)
const adLine = { ts: new Date().toISOString(), id: '40', from: '777', name: '广告号', bot: 0, via: '', fwd: 0, kind: 'photo', text: '', links: [] }
appendRaw(adLine)
obs.record(mk({ id: '41', senderId: HE, name: '烛天', text: '这广告又来了', replyTo: '40' }), cfg)
const rows3 = readFileSync(hisFile2, 'utf8').trim().split('\n').map(JSON.parse)
const quotedRow = rows3.find((r) => r.text === '这广告又来了')
ok('引用空文本广告 → 占位', quotedRow && quotedRow.reply && quotedRow.reply.text === '[photo]', JSON.stringify(quotedRow?.reply))


// 14. 真实场景复刻（主人截图 + 口述修正）
//   广告号发广告 → 烛天先判「斩」→ 引用广告发 /spam@nmmnfunbot → nmBot 回他 → 广告被删
obs.record(mk({ id: '50', senderId: '666', name: '皇太后 ♡⭐', text: '低价出号 私聊秒回 加V看货' }), cfg)
obs.record(mk({ id: '51', senderId: HE, name: '烛天', text: '斩' }), cfg)
obs.record(mk({ id: '52', senderId: HE, name: '烛天', text: '/spam@nmmnfunbot', replyTo: '50' }), cfg)
obs.record(mk({ id: '53', senderId: '902', name: 'nmBot', bot: true,
  text: '皇太后 ♡⭐ 被管理员 烛天 封禁并向 nmBot 举报。回复此消息可对用户进行其他操作。', replyTo: '52' }), cfg)

const rows4 = readFileSync(hisFile2, 'utf8').trim().split('\n').map(JSON.parse)
const verdict = rows4.find((r) => r.text === '斩')
ok('复刻：他的判词「斩」被记下', !!verdict && verdict.role === 'him')
const spam = rows4.find((r) => r.text === '/spam@nmmnfunbot')
ok('复刻：引用广告被抄成快照', spam && spam.reply && spam.reply.text.includes('低价出号'))
const nm = rows4.filter((r) => r.role === 'bot').pop()
ok('复刻：nmBot 的封禁结果被记下', nm && nm.text.includes('封禁'))

// 关键：广告被踢后被删掉了 —— 我们的快照必须还在
const rawFile = join(home, 'observe', `${GROUP}.jsonl`)
const kept = readFileSync(rawFile, 'utf8').split('\n').filter((ln) => {
  if (!ln) return false
  try { return JSON.parse(ln).id !== '50' } catch { return true }
})
writeFileSync(rawFile, kept.join('\n') + '\n')
const blk3 = buildObserveBlock(home, HE, cfg)
ok('广告被删后快照仍在注入块里', blk3.includes('低价出号'), '\n' + blk3)
ok('复刻：注入里能看到「封禁」', blk3.includes('封禁') && blk3.indexOf('封禁') > blk3.indexOf('/spam@nmmnfunbot'))

rmSync(home, { recursive: true, force: true })
console.log(`\n===== ${fail === 0 ? '✓ 观察器' : '✗ 观察器'} ${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail === 0 ? 0 : 1)
