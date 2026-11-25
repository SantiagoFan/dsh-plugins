# dsh-release

monorepo 里 5 个 DSH 插件的命名规范与发布工具。解决的问题：包名散落在多个文件里（`package.json`、`cordis.patch.yml`、`client.js` 的模块 id、测试断言、README），手工改名必漏；版本、git tag、npm 上的版本三者长期漂移。

零依赖，Node ≥ 20。

## 快速开始

在 monorepo 根目录执行：

```powershell
npm run list                                   # 5 个包一览
npm run check                                  # 只读体检（会查 npm registry 与 GitHub）
npm run fix                                    # 预演要改什么
npm run fix -- --write                         # 真正写入
npm run test                                   # 本工具的单元测试
npm run release -- --plugin wechat-bot --bump minor          # 发布预演
npm run release -- --plugin wechat-bot --bump minor --yes    # 真正执行
```

等价于：

```powershell
node tools/dsh-release/bin/dsh-release.mjs check
node tools/dsh-release/bin/dsh-release.mjs release --plugin wechat-bot --bump minor --yes --via-ci
```

## 命令

| 命令 | 作用 | 是否改文件 |
|---|---|---|
| `list` | 列出配置里的包、包名、版本 | 否 |
| `check` | 校验命名/清单/git/npm 状态，`--json` 可机读；有 error 时 exit 1 | 否 |
| `fix` | 生成改名与补字段方案，默认只预演；`--write` 真正写入 | 可选 |
| `release` | bump 版本 → commit → tag → push → npm publish（或交给 CI） | 是，需 `--yes` |

通用参数：`--config <路径>`、`--plugin <目录>`（可重复）、`--offline`（不查 npm/GitHub）、`--no-color`、`--json`。

`fix` 参数：`--write` 写入；`--force` 允许给「已发布过的包」改名、或改被 DSH profile 引用的私有包名。

`release` 参数：`--bump patch|minor|major`、`--version x.y.z`、`--yes`、`--allow-dirty`、`--no-push`、`--via-ci`。

## monorepo 支持

配置里的 `monorepo.repo` 一旦存在，工具自动切换成 monorepo 语义：

- 包目录不必自己带 `.git`：向上查找仓库根，`git add`/`commit`/`tag`/`push` 都在仓库根执行，且只 `git add` 本包目录。
- 「未提交改动」按包过滤：别的包的改动不会阻塞本包发布。
- 发布标签变成 `<短包名>@v<版本>`，例如 `dsh-wechat-bot@v1.4.0`。
- `repository` 校验要求带 `directory`，指向 `packages/<包目录>`。
- `homepage`/`bugs` 必须指向 monorepo 仓库，旧的独立仓库地址会被告警并自动改写。

## 校验规则

**命名与一致性**

- `NAME_SLUG_MISMATCH` — 包名必须等于配置里的 `@scope/dsh-<slug>`
- `NAME_PENDING_RENAME` / `OLD_NAME_LEFTOVER` — 代码里仍写着旧包名（模块 id、测试断言都算）；已带 `@scope/` 或 GitHub 仓库地址里的同名片段不会被误判
- `PATCH_MISSING` / `PATCH_NAME_MISMATCH` — `cordis.patch.yml` 的 `name:` 必须与 `package.json` 一致
- `TARGET_NAME_TAKEN` — 改名的目标包名已被别人占用

**npm 发布要求**

- `PRIVATE_PUBLISH_CONFLICT` / `ACCESS_NOT_PUBLIC` — 要发布就不能 `private: true`，scoped 包必须 `publishConfig.access: "public"`
- `REPO_FIELD_MISSING` / `REPO_NAME_MISMATCH` / `REPO_DIRECTORY_MISMATCH` / `HOMEPAGE_MISMATCH` / `BUGS_MISMATCH`
- `GITHUB_REPO_404` — `repository` 指向的 GitHub 仓库不存在
- `FILES_MISSING` / `FILES_ENTRY_MISSING` / `FILES_FORBIDDEN` — `files` 白名单缺失、条目不存在、或混入密钥/`node_modules`
- `NPM_AHEAD` / `NPM_BEHIND` — 本地版本与 npm 最新版的关系
- `RENAME_PUBLISHES_NEW` / `TAG_DRIFT` — 改名即新包；tag 与版本不同步

**git 与清单**

- `GIT_MISSING` / `GIT_REMOTE_MISSING` — 要发布的包必须位于带 origin 的 git 仓库内
- `DSH_PATCH_FIELD` / `DSH_PATCH_FILE` / `EXPORTS_MISSING` / `ENGINES_MISSING` / `VERSION_INVALID`
- `PROFILE_REFERENCES_OLD_NAME` — `$DSH_PROFILE_DIR/package.json` 里引用了旧包名

## 配置

`tools/dsh-release/dsh-release.config.json`：

```json
{
  "scope": "@mindlink-ai",
  "prefix": "dsh-",
  "owner": "SantiagoFan",
  "monorepo": { "repo": "dsh-plugins" },
  "root": "../../packages",
  "plugins": [
    { "dir": "wechat-bot", "slug": "wechat-bot", "publish": true }
  ]
}
```

- `root` 相对配置文件所在目录，指向包目录集合。
- `publish: false` 的包会跳过 git/仓库/GitHub 相关硬性要求，只做命名与清单校验。
- 新增插件：在 `packages/<name>` 建包，再往 `plugins` 加一条 `{ dir, slug, publish }`。

## 测试

```powershell
npm test
```

覆盖：semver bump/比较、改名不会被 `@scope/` 前缀二次污染、GitHub 仓库地址里的仓库名不被误当旧包名、离线体检能查出包名与清单缺口、`fix --write` 后多处引用全部同步且 JSON 合法、已发布包改名默认被拦、monorepo 标签格式（`dsh-x@v1.2.3`）与提交信息模板。
