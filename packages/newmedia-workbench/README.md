# 新媒体工作台（@mindlink-ai/dsh-newmedia-workbench）

DSH 左侧边栏的「新媒体工作台」：管理账号的**定位卡**（赛道、受众、人设、语气、内容支柱、禁忌……）和独立的**平台账号**。
定位卡只放人设，**平台账号单独维护，可以关联到任意一张定位卡**（例如「老板IP」关联抖音的老板账号 + 视频号的老板IP账号），并**一键获取粉丝量**；写口播文案时定位卡及其关联账号会作为上下文交给 AI。

- 侧边栏入口 + 主面板：**顶栏固定**（标题、版本、四个统计卡：定位卡 / 平台账号 / 粉丝合计 / 上次获取）+ **页签切换**（定位卡 / 平台账号 / 凭证设置），只有页签内容区滚动，长列表不再被截断。
- **每个页签的操作按钮都在页签内容区顶部**（定位卡：凭证设置 / 一键获取粉丝量 / 新建定位卡；平台账号：凭证设置 / 一键获取粉丝量 / 新增平台账号；凭证设置：返回定位卡 / 保存设置），顶栏只放全局信息与统计。
- 两个页签都是**左列表 + 右编辑**的主从布局：左栏固定宽度并随滚动吸顶，右边就地编辑保存，不用跳页面。
- **定位卡页签**：只编辑人设字段（名称/阶段/赛道/受众/人设/价值/支柱/语气/钩子/差异点/目标/变现/禁忌/关键词/对标/备注），底部只读展示这张卡关联的平台账号（可「解除关联」），并存一份「口播上下文预览」可一键复制。
- **平台账号页签**：新增 / 编辑 / 删除平台账号，字段含平台、账号名、账号 ID、主页、handle、粉丝量、备注，以及**「关联定位卡」下拉**（可留「未关联」）；按平台能力单独获取粉丝量。
- 凭证设置页签：Cookie / API Key / 代理，面板只回显掩码。
- 一键获取粉丝量：按平台能力逐个更新；能自动的自动，取不到的会说明原因并保留手动填写。
- Agent 工具 `newmedia_workbench`：写文案前用 `action="context"` 读取定位卡（含关联账号）；`action="link"` 把平台账号关联到定位卡；`action="sync_followers"` 获取粉丝量。
- 数据只存本机：`~/.dsh/newmedia-workbench/accounts.json`（定位卡 + 平台账号）、`settings.json`（凭证/代理，权限 0600），不上传、不写日志正文。

## 安装

插件已在当前 profile 安装并启用。重新安装或换机器时：

```bash
# 在 DSH 里用 plugin_manager 安装本地目录（不是 npm 包）
plugin_manager(action="install_bundle", target="E:\\Administrator\\Documents\\newmedia-workbench-plugin")
```

安装后侧边栏会出现「新媒体工作台」按钮；如果没有，刷新一次 Web 页面。卸载：`plugin_manager(action="remove_bundle", target="@mindlink-ai/dsh-newmedia-workbench")`。

## 数据结构

```jsonc
// ~/.dsh/newmedia-workbench/accounts.json（version: 4）
{
  "version": 4,
  "cards": [
    {
      "id": "acc_xxx",
      "name": "老板IP",           // 定位卡名（一个人设，不含任何平台账号）
      "stage": "成长期",
      "niche": "企业管理", "audience": "...", "persona": "...",
      "value": "...", "pillars": "...", "tone": "...", "hookStyle": "...",
      "differentiator": "...", "goal": "...", "monetization": "...",
      "taboo": "...", "keywords": "...", "references": "...", "notes": "...",
      "createdAt": "...", "updatedAt": "..."
    }
  ],
  "accounts": [                    // 平台账号独立存储，cardId 指向关联的定位卡
    {
      "id": "pa_xxx",
      "cardId": "acc_xxx",        // 空字符串 = 未关联
      "platform": "douyin",       // douyin/shipinhao/xiaohongshu/wechat/bilibili/kuaishou/youtube/tiktok/other
      "name": "老板账号",
      "uid": "MS4wLjAB...",       // 平台账号 ID（抖音 sec_uid / B站 UID / 小红书 user_id / 视频号 ID …）
      "homepage": "https://www.douyin.com/user/MS4wLjAB...",
      "handle": "",
      "note": "",
      "followers": "3.2万",       // 展示值
      "followersCount": 32000,    // 精确数（自动采集或从展示值解析）
      "followersUpdatedAt": "2026-11-17T02:00:00.000Z",
      "followersSource": "auto",  // auto 自动采集 / manual 手动填写 / "" 未知
      "createdAt": "...", "updatedAt": "..."
    }
  ]
}
```

旧数据（v1–v3：平台账号嵌在定位卡里）在插件启动时自动迁移：卡里的 `platforms` 拆成独立 `accounts` 并写回 `cardId`，磁盘结构升级为 v4；删除定位卡只解绑（账号保留，`cardId` 置空），不会连带删掉账号。

## 一键获取粉丝量：各平台实测能力

2026-11-17 在本机（Windows，国内网络 + 本地代理 `127.0.0.1:6696`）实测，结论直接决定面板里每个平台的能力标签：

| 平台 | 面板标签 | 需要什么 | 实测情况 |
| --- | --- | --- | --- |
| B站 | 免配置自动获取 | 数字 UID 或空间页链接 | ✅ `api.bilibili.com/x/relation/stat` 公开接口，稳定 |
| 快手 | 免配置·需国内直连 | 快手 ID（主页 `/profile/xxx`） | ✅ 主页 HTML 的 `window.INIT_STATE` 自带 `ownerCount.fan`；**必须国内直连**，走海外代理会降级拿不到 |
| YouTube | 需 API Key 或代理 | 频道 ID / @handle；Data API v3 Key | 配 Key 得精确数（`youtube/v3/channels`）；没 Key 时解析页面缩写值（如 `30.7M`），**国内需代理** |
| TikTok | 免配置·需代理 | 用户名；**需要代理** | ✅ 页面 `__UNIVERSAL_DATA_FOR_REHYDRATION__` 里有精确 `followerCount`，免 Cookie；国内直连不可达 |
| 抖音 | 需 Cookie·可能风控 | sec_uid + 抖音 Cookie | ⚠️ 有 `a_bogus`/`msToken` 签名风控，免凭证必被拦；配 Cookie 也常失败 → **建议直接手动填** |
| 小红书 | 需 Cookie | user_id + Cookie（含 `a1`、`web_session`） | ⚠️ 全站登录墙（302 到 /login），配 Cookie 才可能读到 → 失败就手填 |
| 视频号 | 仅手动填写 | 无 | ❌ 没有公开接口，只能手动填 |
| 公众号 | 仅手动填写 | 无 | ❌ 没有公开接口，只能手动填 |

- 「一键获取粉丝量」= 遍历全部平台账号（不管有没有关联定位卡）逐个更新；在定位卡页签点「获取粉丝量」= 只更新这张卡关联的账号；在平台账号页签点「获取粉丝量」= 只更新当前选中的账号。
- 结果分三类呈现：**已更新** / **需手动填写**（视频号、公众号，属于正常情况，不会标红）/ **没取到**（缺账号 ID、需要 Cookie、被风控、网络不通）；失败不会覆盖已有数字。
- 手动改「粉丝量」输入框时，会自动把来源标成「手动填写」并重新解析精确数；改回可自动获取的账号 ID 后点获取即可重新变成「自动采集」。
- 保存平台账号时要求「平台 + 账号名/账号 ID/主页/平台内 handle 至少一项」，避免存出无法辨认的空账号；定位卡则只校验名称唯一。
- 列表头显示「上次获取」时间；定位卡列表显示关联账号数与粉丝合计，账号列表显示粉丝量与所属定位卡。

## 凭证设置（面板「凭证设置」页签）

| 项 | 说明 |
| --- | --- |
| 平台 Cookie | 抖音、小红书（可选 B站/快手）。浏览器登录后从开发者工具 Console 复制 `document.cookie` |
| YouTube Data API Key | Google Cloud 开通 YouTube Data API v3 后创建，免费配额够用 |
| HTTP 代理 | 例如 `http://127.0.0.1:6696`；**必须带 `http://`**，只支持 http/https 代理。代理对**所有平台**生效：配了代理后快手（以及国内平台）可能反而取不到，因为它们的页面要求国内直连出口 |
| 请求超时 | 3000–60000 ms |

- 只有需要凭证的平台（抖音、小红书、YouTube、TikTok）才会出现在「凭证设置」里；B站、快手免配置。
- 用环境变量配置过凭证时，面板顶部会提示「环境变量覆盖」，面板里保存的 Cookie 不会生效。

安全约定：

- 凭证只写本机 `settings.json`（目录 0700、文件 0600），面板只回显「已保存（长度 N，尾 xxxx）」掩码，接口不回传明文、日志不写正文。
- 请求地址必须是平台域名白名单（`api.bilibili.com`、`www.douyin.com`、`www.xiaohongshu.com` …），**不会请求用户填的任意 URL**，Cookie 只发给对应平台。
- 3xx 跳转视为「需要登录/被风控」，不跟随跳转（避免 Cookie 跨域泄漏）。
- 输入框留空 = 不修改；要清除点「清除该平台凭证」。
- 环境变量覆盖（只读，不落盘）：`DSH_NMW_PROXY`、`DSH_NMW_COOKIE_DOUYIN`、`DSH_NMW_COOKIE_XIAOHONGSHU`、`DSH_NMW_COOKIE_BILIBILI`、`DSH_NMW_COOKIE_KUAISHOU`、`DSH_NMW_COOKIE_YOUTUBE`、`DSH_NMW_COOKIE_TIKTOK`、`DSH_NMW_YOUTUBE_API_KEY`。

## 在对话里怎么用

1. 打开「新媒体工作台」→ 新建定位卡（例如「老板IP」）→ 在「关联平台账号」里加上抖音、视频号等账号 → 保存。
2. 点「一键获取粉丝量」（或卡片上的「刷新粉丝」），能自动的平台会更新，取不到的会提示手动填。
3. 直接在对话里说需求即可，例如：「按老板IP 的定位写一条 60 秒口播，主题是招人」。
4. AI 会在动笔前处理定位卡上下文（插件已注册全局提示，任何会话都生效）：
   - **没指定 + 只有一张卡** → 自动使用；
   - **没指定 + 多张卡** → 对话里弹出选择卡片，每个定位卡一个选项（名称、关联平台、阶段、赛道）；
   - **你点名了定位卡 / 平台账号**（如「用老板IP 的抖音账号写……」）→ 直接读那张卡；
   - **一张卡都没有** → 提醒你先去面板新建。
5. 也可以点卡片上的「复制上下文」，把内容直接粘到任何 AI 对话里。

## Agent 工具

工具名：`newmedia_workbench`

| action | 说明 |
| --- | --- |
| `list` | 列出定位卡摘要（可按 `platform` 过滤，任一关联平台命中即返回） |
| `get` | 读一张完整定位卡（含 platforms 数组） |
| `context` | 取口播文案用上下文（Markdown，推荐写文案前调用） |
| `upsert` | 新建或增量更新定位卡；`data.platforms` 可一次写入/替换关联的平台账号 |
| `link` | 给定位卡关联一个平台账号（按 `platform` + `uid`/`homepage`/`name` 命中则更新，否则新增）；默认顺带取一次粉丝量，`sync:false` 只保存 |
| `sync_followers` | 获取粉丝量：`account` 指定一张定位卡，不传则全部；`all:false` + 不传 account 会被拒绝 |
| `status` | 查各平台采集能力、凭证/代理配置状态（只返回掩码） |
| `delete` | 删除定位卡 |

`data` 可用字段：`name`、`stage`、`niche`、`audience`、`persona`、`value`、`pillars`、`tone`、`hookStyle`、`differentiator`、`goal`、`monetization`、`taboo`、`keywords`、`references`、`notes`、`platforms`。
`platforms` 每项：`{ id?, platform, name, uid, homepage, handle, followers, followersCount, note }`。
`pillars` / `taboo` / `keywords` 可传数组，也可传换行、顿号或逗号分隔的字符串。
`platform` 取值：`douyin` 抖音、`shipinhao` 视频号、`xiaohongshu` 小红书、`wechat` 公众号、`bilibili` B站、`kuaishou` 快手、`youtube`、`tiktok`、`other`（也接受「抖音」「视频号」等中文写法与常见别名）。

## Host HTTP 路由

面板与 AI 使用同一份数据和同一套读写逻辑（同源，无需额外鉴权配置）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/newmedia-workbench/state` | 全部定位卡 + 平台/阶段/能力/凭证掩码 + 数据文件路径 |
| POST | `/newmedia-workbench/save` | `{ account: {...} }` 新建或更新定位卡（含 platforms） |
| POST | `/newmedia-workbench/delete` | `{ id }` 删除 |
| GET | `/newmedia-workbench/context?id=<id或名称>` | 口播上下文 Markdown |
| POST | `/newmedia-workbench/followers/sync` | `{ id?, account? }` 获取粉丝量；不传则全部 |
| GET | `/newmedia-workbench/settings` | 凭证/代理的掩码状态 + 平台能力 |
| POST | `/newmedia-workbench/settings` | 保存凭证/代理；`{ clear: ["douyin"] }` 清除指定平台凭证 |

同进程的其他插件也可以 `ctx.get('newmediaWorkbench')` 调用 `list / get / context / upsert / link / remove / syncFollowers / status`。

## 开发与测试

```bash
node --check index.js && node --check client.js && node --check lib/followers.js && node --check lib/settings.js
npm test   # = test/followers.mjs（采集器单测，假 fetch 不联网）+ test/smoke.mjs（Host 增删改查/关联/迁移）
           #   + test/http.mjs（HTTP 路由与掩码）+ test/client-render.mjs（假 React 渲染面板，检查四个统计卡/三个页签/滚动容器）
```

`test/client-render.mjs` 不需要浏览器、不需要装 React：用 vm 加载 `client.js`，喂假 React 与假 Host state，把组件树真的渲染一遍再断言。

改完代码要让改动生效：Host 代码（`index.js` / `lib/*.js`）用 `plugin_manager(action="set_plugin", target="include:newmedia-workbench", enabled=false)` 再 `enabled=true` 重启插件行（或重启 DSH）；`client.js` 改动刷新一次 Web 页面即可。

结构：

- `index.js` — Host：定位卡模型与校验、工具注册、HTTP 路由、Host 服务、JSON 存储、旧数据迁移。
- `lib/followers.js` — 各平台粉丝量采集器、域名白名单、代理隧道、计数解析。
- `lib/settings.js` — 凭证/代理存储与掩码、环境变量覆盖。
- `client.js` — Client：侧边栏图标（`sidebar.panellist`）与主面板（`main`），纯 React、只用 `--dsw-alias-*` 主题 token。
- `cordis.patch.yml` — 插入 `newmedia-workbench` 行。
- `locale/*.json`、`icon.svg` — 插件管理器里的标题、描述与图标。

## 限制

- **视频号、公众号没有公开接口**，粉丝量只能手动填写；抖音有签名风控，自动获取常失败，也建议手填。
- YouTube / TikTok 需要代理；代理是明文 HTTP 代理（CONNECT 隧道），不支持 SOCKS。
- 数据是单机单文件，无多人同步；多台机器各自一份。
- 面板不支持图片/附件字段（口播文案上下文用文本即可）。
- 面板视觉细节以实际页面为准：已验证 JS 语法、slot 注册、HTTP 路由、工具行为与真实平台采集，未做浏览器截图验证。
