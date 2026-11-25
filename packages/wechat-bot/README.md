# @mindlink-ai/dsh-wechat-bot

个人微信 bot 的 DSH 插件：把「微信官方 iLink（ClawBot）通道」封装成

- **左侧边栏入口「微信bot」**：点开主面板即可看到连接状态、**推送失败记录**（哪个智能体、发送内容、发送时间）、账号信息、扫码登录入口、最近推送与最近消息；
- **Agent 工具**：`wechat_status` / `wechat_login` / `wechat_send` / `wechat_recent`，供定时任务调用把日报推送到你的微信；
- **同源调试接口**：`/wechat-bot/state`、`/wechat-bot/login`、`/wechat-bot/send`、`/wechat-bot/failures`（与 GUI 同端口，无独立端口暴露）。

## 安装（给其他 DSH 用户）

在 DSH 的插件管理器（左侧边栏「插件」→ 安装插件）里输入以下任一目标：

| 方式 | 输入 |
|---|---|
| npm 包名（推荐，发布后） | `@mindlink-ai/dsh-wechat-bot` |
| GitHub 仓库地址 | `https://github.com/SantiagoFan/dsh-wechat-bot` |
| 本地目录 | 插件目录绝对路径 |

安装后左侧边栏出现「微信bot」，工具列表出现 `wechat_*` 工具。

**运行要求**：DSH Web/桌面 profile（需要 `webServer`、`tools`、`sessionController` 服务）；手机微信需支持 ClawBot 插件；Node ≥ 20（由 DSH 自带，无需另装）。

## 发布到 npm（维护者）

```bash
cd wechat-bot-plugin

# 1) 登录 npm（@mindlink-ai scope 需属于你的 npm 账号或组织）
npm login

# 2) 发布（包已声明 publishConfig.access=public，scoped 包必须 public）
npm publish --access public

# 3) 验证
npm view @mindlink-ai/dsh-wechat-bot version
```

> 本机 npm 默认源可能指向失效镜像（如旧淘宝源）。发布前确认：
> `npm config get registry`，必要时 `npm config set registry https://registry.npmjs.org`。
> 若遇到 `EPERM` 缓存目录错误，可临时指定可写缓存：`npm publish --cache /tmp/npm-cache`。

升级流程：改代码 → `npm version patch`（或 minor/major）→ `git push --follow-tags` → `npm publish`。

### 自动发布（GitHub Actions）

仓库已内置 [`.github/workflows/publish.yml`](.github/workflows/publish.yml)：推送 `v*` 标签时自动校验版本并发布到 npm。

> **npm token 有效期限制**：自 2025-10 起，写权限的 granular token **最长 90 天**（新建默认只有 7 天），
> 所以 CI 里长期放 `NPM_TOKEN` 需要定期轮换。更推荐 **npm Trusted Publishing（OIDC）**：不用任何长期 token，
> 也就没有 90 天问题，并自动生成 provenance 供应链签名。

#### 方式 A（推荐）：Trusted Publishing（OIDC，无 token）

1. 首次发布要先把包发布到 npm（手动一次）：
   ```bash
   npm publish --access public --otp=<验证器6位码>
   ```
2. 打开 npm 包页面 → Settings → **Trusted Publisher** → 选择 **GitHub Actions**，填写：
   - Organization / Repository：你的仓库
   - Workflow file name：`publish.yml`
3. 仓库无需配置 `NPM_TOKEN`。之后：
   ```bash
   npm version patch
   git push --follow-tags
   ```
   Action 通过 OIDC 直接发布（已含 `--provenance`）。

#### 方式 B（备选）：NPM_TOKEN

1. 生成 **Granular Access Token**（`Read and write` + 作用域 `@mindlink-ai` + 勾选 **Bypass 2FA**），
   注意**最长 90 天**，到期需重新生成。
2. 仓库 Settings → Secrets and variables → Actions 新建 `NPM_TOKEN`。
3. 把 workflow 的 publish 步骤临时改回 token 模式：
   ```yaml
   - name: Publish to npm
     run: npm publish --access public
     env:
       NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
   ```


## 首次使用

> 数据与配置目录：`~/.dsh/wechat-bot/`（`credentials.json` / `state.json` / `settings.json` / `push.log` / `push-failures.json`），可用环境变量 `DSH_WECHAT_BOT_DIR` 覆盖。
> 会话转发的默认工作目录是用户主目录（`os.homedir()`）；如需指定，编辑 `settings.json` 的 `workspaceCwd`，例如 `"workspaceCwd": "D:\\\\projects\\\\wechat-chat"`。
> 微信专用会话的预设 / 模型 / 权限预设见下一节「微信专用会话与进度回传」。

1. 打开左侧边栏「微信bot」→ 点「开始 / 刷新登录」；
2. 面板出现二维码链接 → 复制到手机微信打开并确认；
3. 登录成功后，**在微信里给机器人发一条任意消息**（让 bot 记录 `context_token`）；
4. 回到面板点「发送到微信」验证链路；
5. 定时任务里调用 `wechat_send`（可传日报文件绝对路径）。

## 数据与凭证

- 状态与凭证目录：`~/.dsh/wechat-bot/`（`credentials.json` / `state.json` / `settings.json` / `push.log` / `push-failures.json`）
- 可用环境变量 `DSH_WECHAT_BOT_DIR` 覆盖；
- 首次启动会尝试从旧版桥接目录 `E:\Administrator\Documents\daily-news\wechat` 迁移凭证与上下文，无需重复扫码（若旧凭证仍有效）。

## 作者信息

- 作者：思链科技（MindLink）
- 插件：`@mindlink-ai/dsh-wechat-bot` v1.3.0
- 通道：微信官方 iLink（ClawBot）；本地优先，聊天数据只留在本机
- 许可：MIT

## 页面与路径

- 侧边栏入口：`sidebar.panellist` 注册项 `id = wechat-bot`（不是独立 URL 路由，点击切换主面板）
- 主面板：`main` keyed slot，`key = wechat-bot`（渲染文件 `client.js`）
- Host 同源调试页：`http://127.0.0.1:<GUI端口>/wechat-bot/`
- 状态接口：`/wechat-bot/state`
- 推送失败记录：`/wechat-bot/failures`

## 其他插件如何调用

### 方式 1：Host 服务 `wechatBot`（推荐，同进程零网络）

其他 Host 插件声明依赖后直接调用：

```js
// 你的插件 index.js
export const inject = ['wechatBot']

export function apply(ctx) {
  const bot = ctx.get('wechatBot')

  // 1) 推送一段文本
  await bot.send('日报已生成，请查收')

  // 2) 推送日报文件：自动压缩成群发版短消息 + 1900 字节分片
  await bot.sendFile('E:\\Administrator\\Documents\\daily-news\\2026-11-11-应急行业日报.md')

  // 3) 查状态 / 最近消息
  const state = bot.status()   // { connection, account, lastPush, counters, ... }
  const msgs = bot.recent(20)  // 最近收到的入站消息（仅元数据）

  // 4) 登录控制（一般交给面板，脚本化时才用）
  await bot.login('start')     // start | refresh | logout
}
```

返回值约定：`{ ok, chunks, chars, target }`；失败为 `{ ok:false, error, message }`，`error` 取值：
`not_logged_in`（未扫码）、`not_online`（连接失效/异常）、`no_context`（需要先给机器人发一条消息）、`read_failed`、`send_failed`。

服务方法：

| 方法 | 说明 |
|---|---|
| `status()` | 连接状态 + 账号 + 计数 + 最近推送 |
| `send(text, opts?)` | 推送文本，`opts.source` 仅用于审计 |
| `sendFile(path)` | 读取日报 Markdown → 压缩 → 分片推送 |
| `sendDigest(path)` | `sendFile` 的别名 |
| `failures(limit?)` | 推送失败记录（最多 50 条，面板同源） |
| `login(action)` | `start` / `refresh` / `logout` |
| `recent(limit)` | 最近入站消息（≤100） |

> 服务在插件激活时通过 `ctx.provide('wechatBot', api)` 注册；依赖方 `inject: ['wechatBot']` 后 Cordis 会自动等待该服务可用。

### 方式 2：同源 HTTP（跨进程 / Client 插件可用）

与 DSH Web GUI 同端口，仅同源请求通过：

```
GET  /wechat-bot/state        → 连接/账号/计数状态（含 preset 名册与当前会话）
GET  /wechat-bot/failures     → 推送失败记录（?limit= 限制条数）
GET  /wechat-bot/qr.png       → 当前登录二维码 PNG（登录中才有）
POST /wechat-bot/login        → { "action": "start" | "cancel" | "logout" }
POST /wechat-bot/send         → { "text": "要推送的文本" }
POST /wechat-bot/preset       → { "id": "预设 id" }（"" = 跟随 DSH 默认；热生效）
POST /wechat-bot/failures/clear   → 清空失败记录
POST /wechat-bot/failures/delete  → { "id": "记录 id" } 删除单条
```

Host 插件里拿端口：`ctx.get('webServer')?.getOrigin()`。

### 方式 3：Agent 工具（给模型用，不是给插件用）

`wechat_status` / `wechat_login` / `wechat_send` / `wechat_recent` 由 Agent 在会话中调用（定时任务走这条）；插件代码不要依赖工具，直接走方式 1。

### 示例

见 [examples/consumer-plugin](E:\Administrator\Documents\wechat-bot-plugin\examples\consumer-plugin)：一个最小插件，`inject: ['wechatBot']` 后调用 `sendFile` 推送日报。

## 微信侧指令与消息路由

微信发给机器人的消息按规则分流：

- **以 `/` 开头的消息 = 指令**，直接由插件处理并回复，不进入 DSH 会话：
  | 指令 | 作用 |
  |---|---|
  | `/help` | 指令列表 |
  | `/status` | 连接、账号、计数、最近推送 |
  | `/login` | 扫码登录，回复二维码链接 |
  | `/logout` | 退出登录 |
  | `/recent` | 最近收到的消息 |
  | `/news` | 让 DSH 跑今天的新闻简报（转交会话，结果回传） |
  | `/new` | 重置对话会话，下一条消息新建 DSH 会话 |
- **其余消息全部转交给「微信专用会话」**：插件通过 `sessionController.prompt()` 把文本作为用户消息注入 `chatSessionId` 对应的会话（未设置时按 settings 新建：显式预设 `agentPreset`、模型 `model`、权限预设 `permissionPreset`）。回合内助手文本按步骤即时回传，静默超时回一条进度，`turn/end` 收尾；整轮没有任何文本时回兜底说明。

实现位置：`index.js` 的「微信 ⇄ DSH 会话转发」段（`forwardToChat` / `ensureChatSession` / `applySessionProfile` / `session/event` 监听）+ `bridge/relay.js`（回合内回传与进度的纯逻辑，带单测）。会话转发可通过 `settings.chatForward` 关闭。

## 微信专用会话与进度回传（settings.json）

微信消息默认进入**一个专用会话**，它的预设 / 模型 / 权限都由 `~/.dsh/wechat-bot/settings.json` 显式钉住，不随部署默认值漂移：

| 字段 | 默认 | 作用 |
|---|---|---|
| `chatForward` | `true` | 非指令消息是否转交会话 |
| `chatSessionId` | `""` | 绑定哪个会话；空字符串 = 下一条消息新建 |
| `agentPreset` | `"standard"` | 专用会话的 Agent 预设；空字符串 = 跟随 DSH 默认预设（可在面板下拉里改，无需改文件） |
| `model` | 部署默认（建会话时固化） | `{ "provider", "model", "reasoningEffort" }`，建会话后 `selectModel` |
| `permissionPreset` | `"read-only"` | 目标权限预设；部署没注册该预设时自动回退 `workspace-write` 并告警 |
| `sessionTitle` | `"微信 bot（专用会话）"` | 新建会话的标题，便于在 GUI 里辨认 |
| `bindingVersion` | `2` | 结构版本；升级后自动解绑旧会话（一次性迁移） |
| `stream.enabled` | `true` | `true`=按模型步骤流式回传；`false`=整轮结束一次性回传 |
| `stream.progressEveryMs` | `25000` | 静默多久回一条「⏳ 仍在处理…」；`0`=关闭 |
| `stream.minChars` | `12` | 增量短于该字符数时并入下一条，避免碎消息刷屏 |
| `stream.ack` | `""` | 回合开始立刻回的确认语（非空才发） |

- **生效时机**：插件只在激活时读一次 settings，改完请重启 DSH（桌面端重启应用即可）。**例外：面板里的「回答预设」下拉是热生效的**——切换后写回 settings 并解绑旧会话，下一条微信消息按新预设重建，无需重启。
- **升级迁移**：本版本首次启动会清空 `chatSessionId`（旧会话留在 GUI 不再接收微信消息），下一条微信消息按新配置新建专用会话。
- **权限回退**：`permissionPreset` 会在部署已注册的权限预设中校验；不可用时保持部署默认权限并写告警日志，不会阻断消息。
- **查看实际生效值**：侧边栏「微信bot」面板会显示「专用会话：预设 / 模型 / 权限」，`GET /wechat-bot/state` 的 `session` 字段同源。

### 面板切换回答预设（热生效）

面板新增「回答预设」卡片：下拉列出部署当前注册的所有 Agent 预设（含 `isDefault` 与「加载失败」标记），选项第一项是「跟随 DSH 默认预设」。

- 选中即写回 `settings.agentPreset`，并**解绑旧会话**；下一条微信消息按新预设新建会话。已建会话的预设是创建时固化的，不会就地改变（旧会话仍留在 GUI，可手动删）。
- 之后在 DSH 里新增/修改 preset（装 bundle），面板名册会在 5 秒缓存过期后自动出现，无需重启插件。
- 同一个能力也走 HTTP：`POST /wechat-bot/preset`，body `{ "id": "minimal" }`（`""` = 跟随默认）；未知或加载失败的预设返回 400。
- 预设决定**人设提示词与可用工具**（preset 里挂 `@deepseek-ai/dsh-persona` 提供 persona），面板只负责选，不负责写提示词。

## 推送失败记录（面板可直接阅读）

推送失败不再只写日志或依赖巡检脚本，而是**自动落盘并在侧边栏「微信bot」面板里展示**：

- **什么时候记**：任何一次推送失败都会记录 —— 未登录（`not_logged_in`）、连接失效（`not_online`）、没有会话凭证（`no_context`，iLink 常表现为 `prepare failed`）、内容为空、分片发送失败（`send_failed`）、日报文件读取失败（`read_failed`）。
- **记了什么**：
  | 字段 | 含义 |
  |---|---|
  | `agent.label` | 哪个智能体：Agent 预设名（如「战略企划部负责人（strategy-lead）」）· 会话标题；面板手动推送记为「面板手动推送」 |
  | `agent.sessionId` / `agent.presetId` / `agent.sessionTitle` | 会话与预设的原始标识，便于对照 GUI |
  | `content` | 发送内容（最多保留 4000 字，超出标 `truncated`） |
  | `at` / `startedAt` | 失败时间 / 本次推送开始时间（当地时间，面板直接显示） |
  | `error` / `message` | 错误码与原始报错（如 `send_failed · iLink 请求失败: HTTP 200 {"ret":-2,"errmsg":"prepare failed"}`） |
  | `source` | 失败来源：`tool`（Agent 工具）/ `file`（日报文件）/ `panel`（面板测试推送）/ `service`（其他插件调用） |
- **存哪**：`~/.dsh/wechat-bot/push-failures.json`，最多保留最近 **50** 条，跨重启保留。
- **怎么看**：面板「推送失败记录」卡片，按时间倒序列出智能体、时间、失败原因，「查看发送内容」展开全文；「清空记录」一键清空（会二次确认）。
- **接口**：`GET /wechat-bot/failures`（`?limit=` 可限制条数）、`POST /wechat-bot/failures/clear`、`POST /wechat-bot/failures/delete` body `{ "id": "..." }`；Host 侧也可用 `ctx.get('wechatBot').failures(limit)`。

> 这一版刻意**不再内置定时巡检与自动补推**：失败原因、内容和时间都留在面板里，由你自己决定何时重推。

## 排错：面板显示「微信 bot 不可用：404 Not Found」

说明 Host 半没有挂上 `/wechat-bot/*` 路由（侧边栏面板与 `http://127.0.0.1:<端口>/wechat-bot/` 调试页都会 404，而插件本身是激活的，`wechat_*` 工具仍可用）。根因是插件与 `webServer` 的激活顺序：插件只依赖 `tools` 时，可能先于 `webServer` 就绪而激活，注册路由的分支被跳过且不会重试。

1.1.1 起已修：

- `inject` 中声明依赖 `webServer`，Cordis 会等它就绪后再激活，消除该竞态；
- 额外以 500ms 间隔重试最多 20 次作兜底；
- 状态里新增 `web` 字段（`registered` / `attempts` / `error`），可用 `wechat_status` 工具或 `GET /wechat-bot/state` 自查。

升级后**必须重启一次 DSH** 才会按新依赖顺序激活；若不想重启，可在插件管理器里对「微信bot」做一次启用/重载操作，触发重新挂载。

## 已知限制

- **二维码渲染为纯 JS**：登录二维码由随插件打包的 `vendor/qrcode.cjs`（qrcode-generator，MIT，© Kazuhiko Arase）在 Host 进程内生成 GIF data URL，然后在面板中以 `<img>` 直接显示；不依赖 Python、不访问网络。

- iLink 会话约 24 小时过期，过期后需要重新扫码（面板会提示「连接失效」）；
- 个人微信群无法加入官方机器人，因此推送目标是**你与机器人的 1:1 会话**，群里需要手动转发一次；
- 推送依赖最近一次入站消息带来的 `context_token`：长时间没人给机器人发消息时，可能需要先发一句任意内容；
- **审批仍然只在 GUI 弹窗**：微信侧没有批准入口，专用会话一旦触发需要审批的工具调用就会一直等（回合不结束、微信端静默）。无人值守时请用低权限预设（默认 `read-only`）或避免触发需要审批的操作；
- 回传按微信单条 1900 字节、最多 3 片切分，超长回答会被截断；
- 只处理文本消息：图片 / 语音 / 文件类型入站会被忽略（不会回复）。
