# dsh-telegram-bridge · 接管 Telegram

> DSH 插件。**接管一个真实的 Telegram 账号**（用户态 MTProto，不是机器人号），
> 替你回联系人消息 —— 分层人设、贴纸、防抖、轮询兜底、**零 token 自检自愈**。

这个插件的重点是三件事：

1. **不是机器人**：用的是你自己的账号、你自己的身份。对方看到的是你，不是 `xxx_bot`。
   （所以要求：`apiId`/`apiHash` + 手机号登录，登录后 session 存在插件家目录里）
2. **像人**：3~10 秒随机防抖、多条分开发（`|||`）、偶尔配一张贴纸、人设分层省 token。
3. **不出事也不用管**：进程崩了自己拉起、连接断了自己重连、每 5 分钟自检一次 ——
   全程只看进程/端口/HTTP/登录态，**一个 token 都不花**。

---

## 装

```bash
# 本地目录直接装（开发/自用最省事）
dsh plugin --profile web add link:/绝对/路径/dsh-telegram-bridge

# 或者从 GitHub 装（需要机器上有 git）
dsh plugin --profile web add github:<你的用户名>/dsh-telegram-bridge
```

装完**重启一次 dsh**（bundle 层要重启才组装）。

> ⚠️ **如果安装报 `ERR_PNPM_IGNORED_BUILDS`**（pnpm 12 默认把"跳过的构建脚本"当错误）：
> 三条可选依赖 `bufferutil` / `utf-8-validate` / `es5-ext` 会触发它 —— 它们都是**可选的原生加速件**，
> 不编译也完全能用。加一个开关就行：
>
> ```bash
> dsh plugin --profile web add <本仓库地址> --config.strict-dep-builds=false
> ```
>
> （`dsh plugin` 会把多余参数原样转给 pnpm。装完 `dsh plugin --profile web list` 能看到本包即成功。）

> ⚠️ **装上不会自动连**。没有 `session.txt` 时它就是不连接的空壳，所以不会抢你现有
> 客户端（官方 App / 桌面版）的 update state。这条很重要：同一个账号**同一时间只能有
> 一个客户端在收消息**，两个一起收会双开抢状态，表现是「它突然不说话」而且不报错。

## 配（三步）

```text
1) tg_config  { "account": { "apiId": 123456, "apiHash": "abcdef..." } }
   apiId/apiHash 去 https://my.telegram.org → API development tools 申请

2) tg_login_start  { "phone": "+8613800138000" }
   → 返回 loginId，Telegram 会给你发验证码
3) tg_login_code   { "loginId": "login1", "code": "12345" }
   开了两步验证的账号会再要一次：tg_login_password { loginId, password }

4) tg_verify    → 应该看到 6/6 通过
```

连不上 Telegram 的机器（比如国内服务器）要配代理：

```text
tg_config { "socksUrl": "socks5://127.0.0.1:7890" }
```

本机直连就通的**不要填**，留空就是直连。

## 用

| 工具 | 干什么 |
|---|---|
| `tg_status` | 进程/连接/登录人/白名单/在途/人设指纹/贴纸条数 |
| `tg_verify` | 跑一遍自检（零 token），能修的当场修，输出 `n/6 通过` |
| `tg_config` | 读/改配置，改完即时生效 |
| `tg_login_start` / `_code` / `_password` / `_cancel` | 登录流程 |
| `tg_chats` | 白名单会话 + 每个会话的上下文轮数 |
| `tg_send` | 用这个账号发一条消息（走 bridge 自己那条连接，不会抢 session） |
| `tg_pause` | 暂停/恢复某个会话的自动回复（消息照记录，只是不回） |
| `tg_context_clear` | 清某个会话的上下文 |
| `tg_restart` | 优雅重启（等在途回复发完） |
| `tg_log` | 看日志最后几十行 |

常见配置：

```jsonc
// 只回这几个人
{ "direct": { "users": ["111111111", "222222222"], "labels": { "111111111": "老朋友" } } }
// 暂停某个人（照记录不回）
{ "direct": { "paused": ["111111111"] } }
// 只看不回（每句都生成，写成 drafts.jsonl）
{ "mode": "draft" }
// 换模型
{ "llm": { "models": ["deepseek-v4.1-flash", "hy3"], "effortFull": "max", "effortShort": "low" } }
```

## 设置页

装好之后 DSH 的「设置」里会多一栏 **Telegram 小鲸鱼**（和「刷B站」「QQ 小鲸鱼」并排），
不用记工具名、不用改 JSON：

| 区块 | 能干什么 |
|---|---|
| 总开关 | 一键停/起桥（关掉 = 子进程停掉，配置和登录态都留着） |
| 现在什么状态 | 连没连上、登录的是谁、白名单几个、在途几条、人设指纹、今天收发计数 |
| 连接与模型 | SOCKS5 代理、回话模式（auto/draft/confirm）、模型链、每条字数上限、记多少轮上下文 |
| 账号 | apiId / apiHash，**手机号登录三步**（发验证码 → 填码 → 两步密码），全程不出这个页面 |
| 谁能跟她说上话 | 一人一行：备注、暂停/恢复、清上下文、移出名单；私聊与群聊各自的开关 |
| 运维 | 跑自检、看日志、重启桥 |

几条设计上的规矩（踩过坑才这么定的）：

- **打码字段原样存回 = 没改**。apiHash 显示成 `••••6789`，你不动它保存，文件里还是原值
  （否则一保存就把真 key 冲成打码串，下次登录直接废）。
- **钳位以服务端为准**。前端只标范围，填 99999 也会被压回上限 —— 页面能骗，落盘不会。
- **只接同源请求**。别的网页在你浏览器里也能打 `127.0.0.1`，所以跨站一律 403。
- **改完不用重启**。保存即生效：桥每条消息前都会重读配置。

设置页背后就是 `index.js` 里那组 `/api/tg-bridge/*` 路由，和 `tg_*` 工具共用同一套实现
（`lib/api.mjs`）—— 所以「页面上能改的」和「工具能改的」永远是一回事。

## 人设

人设只有一份，在 `<DSH_HOME>/persona/`（首次启用会把插件自带的默认值铺过去）：

| 文件 | 作用 |
|---|---|
| `renshe.txt` | 性格正文（温柔 / 短句 / 不客服腔…） |
| `guard.txt` | 防注入，`{IDENTITY}` 由插件填 |
| `extra-tg.txt` | 平台差异（你是谁、对方是谁、被识破怎么办） |
| `extra-tg-short.txt` | 精简版的差异（每轮都发，所以必须短） |

**分层发送**（省 token 的关键）：

| 什么时候 | 发什么 |
|---|---|
| 首次对话 / 每 `reanchorEvery` 轮 / 人设文件改动后第一句 | 完整人设 |
| 其余每一轮 | 精简人设（几十字）+ 末尾锚定 |

改完人设文件不用重启：指纹变了，下一个会话自动补发一次完整人设。

贴纸要单独导（索引属于账号，不随插件发）：

```bash
node scripts/import-stickers.mjs        # 会遍历你装了的贴纸集 + 视觉识别（调模型）
node scripts/import-stickers.mjs --no-desc   # 只存 emoji，不调模型
```

## 自检（零 token）

```bash
node scripts/verify.mjs         # 只查
node scripts/verify.mjs --fix   # 能修的顺手修（拉起进程、轮转日志）
```

六项：进程 / 桥连接 / 依赖（代理端口）/ 登录态 / 卡死判断 / 家目录。
插件自己也会每 5 分钟跑一遍（`selfHeal.everyMin`，设 0 关掉），**修了才写日志**。

## 结构

```
index.js           宿主半：托管子进程 + 工具 + 设置页路由 + 周期自检
client.js          设置页浏览器半端（自注册 bundle：window.__ModuleLoader__）
lib/               跨插件复用：deps（optional peer）/ home / supervisor / health / protocol
  api.mjs          数据面：工具与 HTTP 路由共用的唯一实现
  http.mjs         sendJson / readBody / 同源判定 / 打码回写
bridge/            子进程（**也可以单独跑**）
  main.mjs         主循环：连接 → 补漏 → 监听 → 防抖 → 生成 → 发送 → 轮询兜底
  config.mjs       配置合并钳位 + 老文件迁移
  persona.mjs      分层人设
  llm.mjs          OpenAI 兼容调用（含"推理档吃满预算"的降级重试）
  client.mjs       GramJS 工厂（含 SOCKS5 注入）
  sockets.mjs      SOCKS5 网络层（GramJS 原生 proxy 不支持 SOCKS5）
  media.mjs        消息类型 → 文字描述
  vision.mjs       图片/贴纸识别
  sticker.mjs      贴纸匹配与发送
  reply.mjs        生成 + 上下文
  backfill.mjs     启动补漏
  control.mjs      本机回环控制口（127.0.0.1 + token）
  login.mjs        交互式登录（行 JSON）
scripts/           verify / import-stickers
test/run.mjs       零 token 离线测试：桥逻辑
test/api.mjs       零 token 离线测试：设置页路由（钳位 / 脱敏 / 同源 / 坏 body）
test/client.mjs    零 token 冒烟：假 React 把设置页渲染一遍
```

**为什么子进程**：GramJS 的 update loop 遇到网络抖动会抛未捕获异常，塞进宿主会把整个 DSH 带下水；
分开之后它崩了宿主不受影响，还能自动重启。同一份 `bridge/` 也能被 systemd 直接管：

```bash
BRIDGE_HOME=/path/to/home node bridge/main.mjs
```

## 依赖说明

只装 `telegram`（MTProto）、`socks`（SOCKS5）、`sharp`（图片/贴纸压缩）、`schemastery`（配置）。
其中 `telegram` 会带出 ws 的可选原生加速件（`bufferutil` / `utf-8-validate`）和 `es5-ext`，
它们在 pnpm 12 上会触发 `ERR_PNPM_IGNORED_BUILDS` —— 见上面「装」那一节的一条命令。
不编译这几个包对本插件没有任何影响。

## 已知限制

- 一个账号同一时间只能挂一个客户端 —— 用它就别同时开官方桌面版。
- 贴纸 `fileReference` 会过期，发不出去时重跑 `import-stickers.mjs`。
- 没有设置页 UI（v0.1）。配置走 `tg_config`，写进 `<家目录>/config.json`。
- 群聊默认关（`groups.mode: "off"`）：接管群比私聊风险高，要用自己开并写白名单。

## 许可

MIT。
