# dsh-plugins

思链科技（MindLink）的 DeepSeek Harness 插件 monorepo：5 个可安装插件 + 一套命名/发布工具。

```
dsh-plugins/
├─ packages/
│  ├─ company-knowledge/     @mindlink-ai/dsh-company-knowledge   企业知识库（本机/内网，不发布）
│  ├─ sales-workbench/       @mindlink-ai/dsh-sales-workbench     市场线索 + 内置 CRM（发布）
│  ├─ newmedia-workbench/    @mindlink-ai/dsh-newmedia-workbench  新媒体工作台（暂不发布）
│  ├─ todo-workbench/        @mindlink-ai/dsh-todo-workbench      个人待办（私有）
│  └─ wechat-bot/            @mindlink-ai/dsh-wechat-bot          微信推送（发布，npm 已到 1.0.4）
├─ tools/dsh-release/        命名规范校验 + 版本/tag/发布编排
├─ scripts/                  测试聚合、tag → workspace 解析
└─ .github/workflows/        一个 publish workflow，按 tag 发布对应包
```

## 常用命令

在仓库根目录执行：

```powershell
npm run list          # 列出 5 个包、包名、版本、是否发布
npm run check         # 只读体检：包名规范 / patch 一致 / 元数据 / git / npm 状态
npm run fix           # 预演要改什么（-- --write 真正写入）
npm test              # 发布工具的单元测试
npm run test:all      # 依次跑 5 个包自己的测试
```

单独发一个包（先在预演，再加 `--yes`）：

```powershell
npm run release -- --plugin wechat-bot --bump minor
npm run release -- --plugin wechat-bot --bump minor --yes --via-ci
```

## 发布约定

- **版本各自独立**，包名统一 `@mindlink-ai/dsh-<slug>`。
- **git tag 带包名**：`dsh-wechat-bot@v1.4.0`。一个仓库里不能只用 `v1.4.0`，否则多个包会撞标签。
- 推 tag → `.github/workflows/publish.yml` 解析出对应 workspace → `npm publish --access public --provenance`（OIDC Trusted Publishing，本机不用放 token）。
- npm 上的 Trusted Publisher 需要按仓库 + workflow 登记。迁入本仓库后要登记成：
  - Provider `GitHub Actions`，Repository `SantiagoFan/dsh-plugins`，Workflow `publish.yml`
- 各包的 `repository` 字段带 `directory`，指向本仓库里的子目录：

```json
"repository": {
  "type": "git",
  "url": "git+https://github.com/SantiagoFan/dsh-plugins.git",
  "directory": "packages/wechat-bot"
}
```

## 与 DSH 的关系

monorepo 只影响开发与发布，不影响安装形态：npm 上仍是 5 个独立包，DSH 侧仍逐个安装。
本机 profile（`~/.dsh/profiles/desktop`）通过 `link:` 指向 `packages/<name>`，改动后需要重装：

```powershell
# 在 DSH 里让 agent 调 plugin_manager：remove_bundle <包名> → install_bundle <目录>
```

注意 `install_bundle` 不允许在已安装状态下换路径，必须先 `remove_bundle`。

## 迁移说明（2026-11-25）

从「一个插件一个目录」迁到本仓库。原来的 `data-collector-plugin` → `packages/sales-workbench`、`wechat-bot-plugin` → `packages/wechat-bot`、`company-kb-plugin` → `packages/company-knowledge`、`newmedia-workbench-plugin` → `packages/newmedia-workbench`、`todo-workbench-plugin` → `packages/todo-workbench`。

- 旧的独立 GitHub 仓库 `SantiagoFan/dsh-sales-workbench`、`SantiagoFan/dsh-wechat-bot` 保留为历史归档，后续开发都在本仓库。
- 本仓库是全新 git 历史（旧仓库提交很少，未做 filter-repo 合并）。
- 旧包名 `dsh-sales-workbench`（npm 3.1.1）仍需 `npm deprecate`，指向前 `@mindlink-ai/dsh-sales-workbench`。

## 已知边界

- 本机 npm 缓存曾在 `D:\nodejs\node_cache`（受限环境不可写），工具会把 `npm_config_cache` 指到 `tools/dsh-release/.cache/npm`。
- 某些受限会话里 `git push` 的 SSH/HTTPS 出口会被挡，推送需要在本机正常终端执行。
