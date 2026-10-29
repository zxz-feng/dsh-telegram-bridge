# 给 AI 助手看的（本仓库 = 一个 DSH 插件）

`dsh-telegram-bridge`（中文名「**接管 Telegram**」）：让 DSH 接管**一个真实 Telegram 账号**
（用户态 MTProto，不是机器人号），替使用者回联系人消息。

## 帮使用者装的时候，按这个顺序

1. **装**：`dsh plugin --profile web add link:<绝对路径>` 或 `github:<user>/dsh-telegram-bridge`
   （后者需要机器上有 `git`；没有就让他先装 git，或者用本地目录 `link:`）
2. ⚠️ **提醒他重启一次 dsh**（必须，bundle 层要重启才组装）
3. 让他提供 `apiId` / `apiHash`（https://my.telegram.org → API development tools），
   用 `tg_config` 填进 `account`
4. 登录三步：`tg_login_start {phone}` → `tg_login_code {loginId, code}` →
   （有 2FA 才要）`tg_login_password {loginId, password}`
5. `tg_verify` 应该 6/6 通过。不通就看它报哪一条：
   - 「依赖」不通 ⇒ 这台机器到不了 Telegram，让他配 `socksUrl`
   - 「登录态」不通 ⇒ session 无效/被踢，重新走第 4 步
6. 配白名单：`tg_config { "direct": { "users": ["<对方id>"] } }` —— **不配就谁都不回**

## 必须提前说清的三件事

- ⚠️ **一个账号同一时间只能挂一个客户端**。用这个插件时别同时开官方桌面版/网页版，
  否则两边抢 update state，表现是「它突然不说话」而且**不报错**。
  他自己要手动发消息，用 `tg_send`（走 bridge 自己的连接），别另起脚本。
- ⚠️ **`session.txt` 等于账号密码**。别让它进仓库、别同步到网盘、别贴进对话。
- ⚠️ **群聊默认是关的**（`groups.mode: "off"`）。要用群得自己开并写 `groups.chats`，
  接管群的翻车成本比私聊高得多。

## 自检/自愈是零 token 的

`tg_verify` 和每 5 分钟的自动自检**都不调模型**，只查进程、TCP、HTTP、登录态。
所以「它是不是活着」这类问题，直接跑 `tg_verify`，不要用 `tg_log` 猜，
也不要为了诊断去发消息（那会真的发出去）。

## 常见故障

| 现象 | 先查什么 |
|---|---|
| 一句话都不回 | `tg_verify` → 进程/连接/登录态；再看 `tg_status` 的白名单是不是空 |
| 偶尔漏消息 | 轮询兜底在跑（`behavior.pollSec`，默认 60 秒），等一轮；一直漏说明 session 被别处抢了 |
| 发不出去 | `tg_status.bridge.mode` 是不是 `draft`；`FloodWait` 会自动等，日志里有 |
| 报「缺 apiId/apiHash」 | `tg_config` 里 `account` 还没填 |
| 贴纸发不出来 | 索引没导（`node scripts/import-stickers.mjs`）或 `fileReference` 过期，重导一次 |

## 别做的事

- 别为了「看看能不能发」给真实联系人发测试消息 —— 用 `mode: "draft"` 或发给自己的收藏夹
- 别把 `session.txt` 的内容打印到日志/对话里
- 别改 `bridge/` 下的协议代码后又去跑第二个客户端脚本（会抢 session）

## 改设置页的时候

- `client.js` **不是 ESM**，是 `window.__ModuleLoader__.load({ id, factory })` 自注册脚本；
  `id` 必须等于 `package.json` 的 `name`，否则那一栏静默不出现（控制台才有报错）。
- 路由一律挂在 `/api/tg-bridge/*` 下，并且**必须**先 `sameOriginOk(req)`：别的网页在你浏览器里
  也能打 `127.0.0.1`。
- 页面上能改的每一项，都要经过 `lib/api.mjs` 的同一个方法 —— 不要在路由里直接写文件，
  否则「工具能改的」和「页面能改的」迟早分叉。
- 敏感字段（`account.apiHash`、`llm.apiKey`）**打码输出**，提交回来时用 `keepMasked()`：
  以 `••••` 开头的值等于「没改」。这条有测试守着（`test/api.mjs` 的「脱敏与打码回写」）。
- 数字项在 `api.mjs` 里钳位，前端只负责显示范围。填 99999 会被压回上限，这是故意的。
- 改完跑 `npm test`：三段（桥逻辑 / 路由 / 设置页冒烟）都该是绿的；设置页冒烟能抓到
  「变量写错 / 属性名不对 / 空数组没兜住」这类只有点进页面才看得见的错。
