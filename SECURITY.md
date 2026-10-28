# 安全说明

这个插件用**你自己的 Telegram 账号**发消息，所以有两个东西一等一敏感：

| 东西 | 在哪 | 等于什么 |
|---|---|---|
| `session.txt` | `<DSH_HOME>/telegram-bridge/` | **等于账号密码**。拿到它就能直接收发你的消息，不需要验证码 |
| `config.json` | 同上 | 里面有 `apiHash`、`llm.apiKey` |

## 仓库里永远不会有它们

`.gitignore` 已经把 `session.txt` / `*.session` / `config.json` / `control.json` / `*.log` /
`inbox.jsonl` / `drafts.jsonl` / `contexts/` / `stickers-index.json` 全部挡在外面。
提交前还会跑一次关键字扫描（`session` / `apiHash` / `apiKey` / 手机号 / 账号 id）。

## 它们只在你的机器上

- `session.txt` 写入时权限 **600**
- `control.json` 里是控制口的 token，同样 600
- 控制口只绑 `127.0.0.1`，而且要求 `Authorization: Bearer <token>`

## 你该做的

1. **别把家目录同步到网盘 / git / 聊天软件**。
2. 怀疑泄露了（或者换了机器），去 Telegram → 设置 → 设备，把那个会话**踢掉**。
   踢掉之后这边的 session 自然失效，重新 `tg_login_start` 即可。
3. `apiId`/`apiHash` 泄露的风险比 session 低，但也别公开。

## 这个插件做什么、不做什么

- ✅ 只读你**白名单里**的私聊（`direct.users`），群聊默认关（`groups.mode: "off"`）
- ✅ 消息内容只在你自己机器上处理：本地上下文文件 + 你配的模型网关
- ❌ 不上传任何东西到插件作者的服务器（没有这种东西）
- ❌ 不读你的其它文件、不执行消息里来的命令（`guard.txt` 是防注入用的）

## 报告问题

如果发现能绕过上面任何一条的路子，请开 issue 并**不要**在 issue 里贴真实的
`session.txt` / `apiHash` / 手机号。
