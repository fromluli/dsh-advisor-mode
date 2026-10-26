# 顾问模式（dsh-advisor-mode）

[![tests](https://github.com/fromluli/dsh-advisor-mode/actions/workflows/ci.yml/badge.svg)](https://github.com/fromluli/dsh-advisor-mode/actions/workflows/ci.yml)

给 [DeepSeek Harness](https://deepseek.com)（DSH）加一个「顾问模式」agent preset：**主模型在执行关键决策前，调用 `consult_advisor` 向第二个（更强的）模型要一次「第二意见」**，顾问模型拿到完整会话 transcript，回一份带结论、具体建议和风险提示的评审意见。

> **English**: a third-party [DeepSeek Harness](https://deepseek.com) (DSH) bundle that adds an **Advisor Mode** agent preset. At decision points the working model calls `consult_advisor`; a second, typically stronger model reads the full session transcript and returns a structured verdict (`proceed` / `revise` / `stop`), concrete guidance, and risks. Zero dependencies, no build step, local-first (no Anthropic server tool needed).

它解决的问题是「一个模型既当选手又想当裁判」：让执行用快模型、判断用强模型，比只换一个大模型更省，也更专注。

一个第三方 bundle 包，**零依赖、纯 ESM、无构建步骤**。

---

## 怎么用（30 秒版）

```sh
# 1. 先看会发生什么（不写任何文件）
node scripts/install.mjs --dry-run

# 2. 装进 DSH 桌面应用的 desktop profile
node scripts/install.mjs --yes

# 3. 完全退出并重启 DSH 桌面应用 → 新建任务 → 模式选择器里选「顾问模式」

# 4. 复查（只读）
node scripts/verify.mjs
```

装好之后：

- **新任务页的模式选择器**多一个「顾问模式」；
- 会话里可以用斜杠命令开合：`/advisor on`、`/advisor off`、`/advisor`（看状态）；
- 主模型在「难以回退的决定」前会调用 `consult_advisor`；
- 顾问只给建议，**不能执行工具、不能授权任何操作、不会替你确认用户问题**。

---

## 工作原理

```
会话 = agent preset「顾问模式」
   └─ 插件行 dsh-advisor-mode（本包）
        ├─ /advisor on|off 斜杠命令         ← 状态靠标准的 command/run 事件持久化
        ├─ system prompt 段 advisor:policy  ← 模式开启时注入，指导何时该咨询
        ├─ 工具 consult_advisor             ← 永远注册，关闭时拒绝执行（保工具目录稳定）
        └─ 顾问调用的实现                    ← ctx.llm.stream() 打给配置的 provider/model
```

三点设计取舍（决定了它长这样）：

1. **模式 = agent preset，不是会话中途的开关。** DSH 的「模式选择器」其实是新任务页的 preset 芯片（`conversation.hero.agentPreset`），会话创建后不能换 preset。所以「顾问模式」在**新建任务时选**；会话中途用 `/advisor on|off` 调整同一份 preset 内的状态。两者叠加使用。
2. **preset 的插件名单是整份的，patch 语义是整块替换。** 所以本包的 `cordis.patch.yml` 完整复制了官方 `standard` preset 的插件树（约 120 行），再插入我们这一行 —— 见下面「DSH 升级后」。
3. **不发明会话事件类型。** 第三方插件不得调用 `appendPluginRecord`，自定义事件会让会话日志读不回来。状态因此折在标准的 `command/run` / `command/done` 上，resume / fork 自动正确。

顾问请求本身：只把「清洗过的会话 + 问题」当**文本**发给顾问模型，**不传 tools**，所以顾问不会反过来执行动作，也不会递归调用它自己。

---

## 安装

### 前置条件

| 项 | 要求 |
|---|---|
| DSH | 桌面版 **0.2.1-rc.3**（`package.json` 的 `engines.dsh` 限定 `>=0.2.1-rc.3 <0.3.0`） |
| 顾问模型 | 在你的 provider 配置里已经存在（见下面「配置项」） |
| Node | ≥ 20（只用内置模块，不需要 `npm install`） |

> `engines.dsh` 是刻意的：DSH 的版本兼容闸门在包声明了 `engines.dsh` 时**只看它**，忽略所有 `peerDependencies`。本包不 import 任何 `@deepseek-ai/*` 包（只从 `ctx` 取服务），所以不需要 peer 依赖。

### 方式一：脚本（推荐）

```sh
node scripts/install.mjs --dry-run     # 打印将执行的命令、目标 profile、备份位置
node scripts/install.mjs --yes         # 真装
```

脚本做四件事：

1. 定位 **DSH 桌面版自带的 CLI**（`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`）。
   PATH 上的普通 `dsh` 会拒绝 `desktop` profile（`error: profile "desktop" is managed exclusively by the Electron application`），必须用应用自带的这个入口。
2. 把 profile 的 `package.json` / `cordis.patch.yml` / `pnpm-lock.yaml` 备份到
   `~/.dsh/profiles/<profile>/backups/advisor-mode-<时间戳>/`。
3. 执行 `DSH_HOME=<home> <桌面 CLI> plugin --profile <profile> add <本包绝对路径>`。
4. 回读 profile 的 `package.json`，确认 `dsh.profile.bundles` 里真的出现了 `dsh-advisor-mode`（没出现就报 FAIL，不假装成功）。

之后**完全退出** DSH 桌面应用再打开（profile 组合只在启动时读取）。

几个实用参数：

```sh
node scripts/install.mjs --profile desktop                  # 默认就是 desktop
node scripts/install.mjs --app /path/to/DeepSeek\ Harness.app   # 应用装在别处
node scripts/install.mjs --home /tmp/dsh-test --profile web     # 测试用临时 home，不碰真实 ~/.dsh
```

### 方式二：DSH 插件页（图形化，等价）

侧栏「插件」→「添加插件」→ 输入本目录的**绝对路径**（或 `npm pack` / `pnpm pack` 出来的 tgz、Git 地址）。
DSH 会先 `inspect`（没有 `dsh.bundle.patch` 的包会被直接拒绝）→ 跑 pnpm → 把它加进 `dsh.profile.bundles`。装完重启应用。

> 走**本地目录**时 pnpm 记录成 `link:<绝对路径>`（实测形态，不是 `file:`）：改代码重启即生效，但**别删这个目录**，否则那一行会加载失败。要走复制语义请自己 `npm pack` 出 tgz 再装。

### 安装到底改了什么

`~/.dsh/profiles/desktop/package.json` 里多两处：

```json
{
  "dependencies": { "dsh-advisor-mode": "link:/Users/you/Documents/Projects/dsh-advisor-mode" },
  "dsh": { "profile": { "bundles": [ "...", "dsh-advisor-mode" ] } }
}
```

bundle 层追加在**末尾**（晚于 `@deepseek-ai/dsh-web-app`），这是必要的：preset 注册表和模式选择器 UI 都来自 web-app。

#### 本地 `link:` 形态的含义

用**本地目录**安装时，pnpm 记的是软链（实测 `link:/Users/…/dsh-advisor-mode`，不是 `file:`）：

- ✅ **改本仓库的代码不用重装** —— `link:` 指向源码目录，改完**重启 DSH 桌面应用**即生效（profile 组合与模块在启动时读取）。
- ⚠️ 别删/别移动这个目录，否则 profile 里那一行加载失败（`verify.mjs` 会报 `node_modules/... 存在` FAIL）。
- 📦 **要分发给别人**（或要 `file:` 复制语义）时，先 `npm pack` / `pnpm pack` 出 tgz 再装：

  ```sh
  npm pack                        # 生成 dsh-advisor-mode-0.1.0.tgz（pnpm pack 等价）
  node scripts/install.mjs --yes  # 换成装 tgz：<桌面 CLI> plugin --profile desktop add ./dsh-advisor-mode-0.1.0.tgz
  ```

  `files` 白名单只带运行时需要的文件（实测 `npm pack` 7 个文件：`package.json` + `lib/index.js` + `cordis.patch.yml` + `locale/{zh,en}.json` + `icon.svg`，外加 npm 强制带上的 `README.md`）；`scripts/`、`tests/`、`docs/` 不进包。

---

## 配置项

配置写在 bundle patch 里那一行的 `config`（`cordis.patch.yml` 由脚本生成，改完重装或直接改 profile 层都行）：

```yaml
- id: advisor-mode
  name: 'dsh-advisor-mode'
  config:
    provider: acme            # 顾问模型的路由
    model: gpt-6.1-sol
    defaultOn: true           # 新会话默认开启顾问模式
```

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `provider` | string | 生成物里写死 `acme` | 顾问用的 provider 名（取自你 profile 的 `llm-*` 配置）。**和 `model` 要么都给、要么都不给**；都不给 = 复用会话当前路由。⚠️ `cordis.patch.yml` 生成时默认填了 `acme / gpt-6.1-sol`（作者本机路由），换机器/换网关请改这两行或重跑 `sync-preset.mjs` 时用 `--provider/--model` 覆盖 |
| `model` | string | — | 顾问模型 id |
| `section` | string | 内置 `DEFAULT_SECTION` | 注入 system prompt 的模式说明（英文），决定「什么时候该咨询」 |
| `system` | string | 内置 `DEFAULT_SYSTEM` | **发给顾问模型**的 system prompt（顾问的角色与输出格式要求） |
| `defaultOn` | boolean | `true` | 新会话的默认开关状态 |
| `maxTranscriptChars` | int | `80000` | 发给顾问的会话文本上限（超出按「保留任务锚点 + 最近上下文」裁剪） |
| `maxSystemChars` | int | `12000` | 随请求带过去的主 agent system prompt 上限 |
| `maxTokens` | int | `3000` | 顾问回包的 token 上限 |
| `temperature` | number | `0.2` | 顾问采样温度 |
| `timeoutMs` | int | `180000` | 单次咨询超时 |

未知键、越界值会在**加载期**直接报错（不是等到第一次咨询才炸）。

> 没有任何键叫 `advisorMode.provider` 之类的前缀 —— 配置是「这一行的 config」，DSH 里 provider/model 本来就是配置层概念，本包只是消费它。

---

## 用法

```text
/advisor            查看当前状态（开/关，以及顾问路由）
/advisor on         开启
/advisor off        关闭
```

主模型侧，`consult_advisor` 会在这些时刻被调用：

- 选择**难以回退**的方案之前（架构、数据模型、公共 API、迁移、依赖/配置变更、删除或重写已有文件）；
- 同一个错误修了两次以上还在复发；
- 声明一个大任务「完成」之前。

顾问返回：结论（`proceed` / `revise` / `stop`）、具体建议、风险。**建议不等于授权** —— 需要用户确认的事仍然要问用户。

---

## DSH 升级后

本包的 `cordis.patch.yml` 是**生成物**：它整份复制了 DSH 内置 `standard` preset 的插件树。DSH 升级后名单可能变（新增工具、改默认值），必须重跑：

```sh
node scripts/sync-preset.mjs           # 从当前已安装的 DSH 重新生成 cordis.patch.yml
node scripts/sync-preset.mjs --check   # 只校验，不写文件（CI / 测试用）
node scripts/install.mjs --yes         # 重新安装（link: 形态下其实重启即可，但重装会跑一次 pnpm 更稳）
```

脚本默认从 **app.asar 里读**当前 DSH 的 `standard.patch.yml`（用应用自带的 Electron node 模式读归档，和 DSH 桌面 CLI 同一条路），也可以用 `--source` 指定解包出来的副本：

```sh
node scripts/sync-preset.mjs --source /tmp/dshx/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml
```

生成规则（其余逐字节保留，含 `!!js` 表达式）：

| 改写 | 从 | 到 |
|---|---|---|
| preset 行 id | `preset-standard` | `preset-advisor` |
| `config.id` | `standard` | `advisor` |
| `config.name` / `description` | — | `顾问模式` / 一句说明（模式选择器与设置页读这两个字段） |
| `config.order` | `1` | `5`（standard/ptc/minimal/cordis 占 1–4） |
| 插件行 | `tool-goal` 之后、`planning` 之前 | 插入 `- id: advisor-mode`，让顾问模式下 plan 模式仍可用 |

上游结构变化时脚本会**明确报错**（找不到锚点就停，不会生成半坏的 YAML）；`--check` 让「生成物是否跟当前 DSH 一致」变成一条可断言的事实。

---

## 回滚 / 卸载

按侵入程度从轻到重：

```sh
# 1) 只关掉这一行（bundle 层还在，随时开回来）：在 profile 的 cordis.patch.yml 里加
- id: advisor-mode
  disabled: true
# 等价的做法：在同一文件里把 preset 行的 config.plugins 去掉 advisor-mode

# 2) 卸载（先备份，再让 DSH 把它从 bundles 和依赖里清掉）
node scripts/rollback.mjs --dry-run
node scripts/rollback.mjs --yes

# 3) 整档退回某个备份（安装中断、pnpm 卸不干净、想回到「装之前」）
node scripts/rollback.mjs --restore-last --yes
```

`--restore-last` 只覆盖文件（`package.json` / `cordis.patch.yml` / `pnpm-lock.yaml`），不跑 pnpm；如果 `node_modules` 和 `package.json` 对不上，再补一次：

> 还原前会先把当前状态另存为 `advisor-mode-<时间戳>-pre-restore/`（免得还原本身不可逆），这个后缀的备份**不会**被下一次 `--restore-last` 选中 —— 所以重复执行是幂等的，不会把上一次还原撤销。

```sh
DSH_HOME="$HOME/.dsh" "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop install
```

最后别忘了重启应用。

---

## 验证

`node scripts/verify.mjs [--profile desktop]` 是**只读**体检，输出 PASS / WARN / FAIL 与下一步建议（有 FAIL 时退出码 1）：

| 检查 | 说明 |
|---|---|
| profile 存在、`package.json` 可解析 | 基础 |
| `dependencies` 里有 `dsh-advisor-mode` | 装上了 |
| `dsh.profile.bundles` 含 `dsh-advisor-mode` | 它是**profile 层**，而不只是普通依赖 |
| bundle 顺序晚于 `@deepseek-ai/dsh-web-app` | preset 注册表 / 模式选择器 UI 来自 web-app |
| `node_modules/dsh-advisor-mode` 可解析（含 link 目标） | 依赖目录真实存在 |
| 安装包 `main`（`lib/index.js`）存在 | 缺了它启动会加载失败 |
| 安装包 patch 含 `preset-advisor` 与 `advisor-mode` | 生成物没坏 |
| profile 的 `cordis.patch.yml` 没有重复的 `advisor-mode` 行 | 防「bundle + 手工行」双挂载（工具重复注册会启动失败） |
| 本地 `cordis.patch.yml` 与当前 DSH 的 standard preset 一致 | 内部跑一次 `sync-preset.mjs --check` |
| DSH 版本满足 `engines.dsh` | 版本闸门 |
| 有可回滚的备份 | 出事能退 |

常用命令（`package.json` 里也注册了同名脚本，`pnpm <名字>` 等价）：

```sh
node --test tests/unit.test.mjs            # pnpm test              单元测试（21 项）
node tests/e2e/run-e2e.mjs                 # pnpm test:e2e          端到端验收（本地 mock provider + headless，8 项，约 3s，零联网零费用）
node tests/integration/preset-smoke.mjs    # pnpm test:integration  集成冒烟（临时 home + 真实 RPC，14 项）
node scripts/sync-preset.mjs               # pnpm sync-preset       重新生成 cordis.patch.yml
node scripts/verify.mjs                    # pnpm verify            只读体检
```

想看组合结果（不加载模块，只渲染插件树）：

```sh
DSH_HOME=/tmp/dsh-advisor-mode-check \
  "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  --profile web --dump-config | grep -n -A3 'id: preset-advisor'
```

> ⚠️ `--dump-config` **不能对 desktop profile 跑**（`error: profile "desktop" is managed exclusively by the Electron application`）。要验证组合，就在**临时 home + web profile** 上装一遍看 dump，这是本文档「已验证」一节的复现方式。

---

## 目录结构

```text
dsh-advisor-mode/
├─ package.json            # bundle 声明：dsh.bundle.patch + engines.dsh，零依赖
├─ cordis.patch.yml        # ⚙️ 生成物（scripts/sync-preset.mjs）—— 顾问模式 preset 层
├─ icon.svg                # 插件页图标（占位）
├─ locale/{zh,en}.json     # 插件页展示名与说明
├─ lib/index.js            # 插件实现（preset 里的那一行）
├─ tests/                  # unit.test.mjs（node --test）+ integration/（冒烟）+ e2e/
├─ docs/                   # 设计说明
└─ scripts/
   ├─ _shared.mjs          # 三个脚本共用的小工具（找路径、跑命令、备份、参数解析）
   ├─ sync-preset.mjs      # 生成 cordis.patch.yml（+ --check）
   ├─ install.mjs          # 安装（--dry-run / --yes）
   ├─ rollback.mjs         # 卸载 / --restore-last
   └─ verify.mjs           # 只读体检
```

> `scripts/` 不进 `files` 白名单：它是**给你在本仓库里用**的工具，不需要跟着包被装进 profile。`cordis.patch.yml` 必须进包（bundle 层靠它）。

---

## 已验证 / 未验证

实测环境：macOS，DSH Desktop **0.2.1-rc.3**，`pnpm 11.28.5`，Node 24.15.0，**2026-10-26**。
所有安装实测都在临时 `DSH_HOME=/tmp/advisor-mode-testhome*` 下进行（**没有**改动真实的 `~/.dsh/profiles/desktop`）。
标注「Lead 集成侧」的条目来自集成验证线（真实 RPC / 冒烟脚本），其余为打包与安装层的实测。

### 已验证 ✅

| 项 | 结果 |
|---|---|
| `sync-preset.mjs` 生成 | 147 行；`preset` 行 `preset-advisor`、`config.id: advisor`、`order: 5`；`advisor-mode` 位于 `tool-goal` 与 `planning` 之间（1-based 第 14 个插件 / 0-based 下标 13） |
| 生成物可解析 | `yaml.parseDocument(..., { customTags: [] })` → **0 error**，只有 2 条预期内的 `Unresolved tag: !!js` 警告（`!!js` 由 DSH 提供）；`config.plugins` 共 23 行 |
| 生成幂等 | 连续两次生成 sha1 相同（`9f0c2042…`）；`--check` 一致时退出码 0，手改一个值后 `--check` 退出码 1 |
| **安装链路** | `<桌面 CLI> plugin --profile web add <本包绝对路径>` → **退出码 0**；`dsh: initialized profile web at …`；`dependencies` 记录为 `link:<绝对路径>`；`dsh.profile.bundles` 追加 `dsh-advisor-mode` 到末尾 |
| **分发路径（tgz）实测** | `npm pack` 出 7 个文件的 tgz → `<桌面 CLI> plugin --profile web add ./dsh-advisor-mode-0.1.0.tgz` 退出码 0；依赖记录为 `file:…tgz`，profile 的 `node_modules/dsh-advisor-mode/` 是**复制**进去的真实文件（`link:` 的反面）；`--dump-config` 同样在 1233 行看到 `- id: preset-advisor` |
| **preset 被真正注册并启动（真实 RPC）** | 临时 home 的 web profile 装好后启动 web 应用，调真实 RPC `agentPresets/list` → `[standard, ptc, minimal, cordis, advisor]`；`advisor` 的 `name` 是「顾问模式」，且**没有** `broken` 字段 → preset 树里的 `dsh-advisor-mode` 行被解析并成功启动 |
| **对照实验：`broken` 字段确实能反映失败** | 把该行 `name` 改成不存在的包，`agentPresets/list` 的列表项出现 `"broken":"advisor-mode (…): never started"` → 证明上一条的「没有 broken」是有意义的绿灯，而不是字段没实现 |
| **`agentPresets/read` 能读回插件行** | `agentPresets/read {agentPreset:"advisor"}` 返回该 preset 的插件行 |
| **本地端到端（mock provider + headless，Lead 实测）** | `node tests/e2e/run-e2e.mjs` → **8/8 PASS**（约 3s，零联网零费用）：主模型请求的 system 含 `ADVISOR_MODE`、tools 26 个里含 `consult_advisor`；顾问请求恰好 1 次、带完整 transcript、**不带 tools**；工具结果回灌主模型后含 `ADVISOR_REVIEW / revise`；负向对照（摘掉插件行）system 无模式段、顾问 0 次请求 |
| **集成冒烟脚本（Lead 集成侧实测）** | `node tests/integration/preset-smoke.mjs` → **14/14 PASS**（临时 home 装一遍 + 启动 + 真实 RPC + 结束清理；`--keep` 可留现场） |
| **dump-config 看得到 preset** | `--profile web --dump-config` → 退出码 0、stderr 空；`# == dsh-advisor-mode` 层标记在 1232 行，`- id: preset-advisor` 在 **1233 行**（`preset-standard` 在 630 行），`- id: advisor-mode` / `name: dsh-advisor-mode` 在 **1277/1278 行**，`config` 是 `provider: acme / model: gpt-6.1-sol / defaultOn: true`，下一行就是 `- id: planning` |
| 安装脚本 | `install.mjs --dry-run` 只打印计划；`--yes` 全流程成功并在回读时确认 bundles 已写入；重复安装（覆盖）也成功 |
| 卸载 | `rollback.mjs --yes` → pnpm 移除依赖、bundles 恢复成 `[dsh-base, dsh-web-app]`，页面报「已移除」；卸载前自动备份 3 个文件 |
| 还原 | `rollback.mjs --restore-last --yes` 把 `package.json` 还原到「带 advisor」的状态；随后 `plugin --profile web install` 补齐依赖树，`verify.mjs` 14 项全 PASS |
| 体检 | `verify.mjs` 在「装好」「卸载后」两种状态下分别给出 PASS 14 / FAIL 2，退出码 0 / 1 符合预期 |
| `desktop` profile 的特殊规则 | 桌面 CLI **允许** `plugin --profile desktop`，但要求 profile 已被应用初始化过；未初始化时原始报错：`dsh: Error: Open DeepSeek Harness Desktop once to initialize its profile, then fully quit it before running dsh plugin --profile desktop.`（`install.mjs` 现已提前拦下并给指引） |
| 包自检 | 5 个脚本 `node --check` 通过；`package.json` 零 `dependencies`、零 `peerDependencies`；`lib/index.js` 解析通过、`node --test tests/unit.test.mjs` 21 项全过 |

### 未验证 / 请注意 ⚠️

1. **没有在真实 `~/.dsh/profiles/desktop` 上装过**。约束要求不碰用户真实 profile，所以 desktop 路径的实证是「临时 home 里手工造一个已初始化的 desktop profile + 同一套 CLI 命令」（成功）。第一次真装请先 `--dry-run`，并保留自动备份。
2. **还没在真实 `desktop` profile 里人工点过「顾问模式」+ 真实模型配对**：这是唯一剩下的验收缺口，需要**你自己重启应用后手工确认** —— 新建任务 → 选「顾问模式」 → 发一句会触发决策的话 → 看到 `consult_advisor` 调用并拿到顾问回包。桌面 profile 归应用独占，脚本无法代跑这一步。
3. **`consult_advisor` 连真实 provider 的端到端**：跨模型链路已由本地 mock provider 的 headless E2E 完整跑通（主模型 → 顾问 → 工具结果回灌），但还没走过真实的 acme/gpt-6.1-sol 网关（网络、鉴权、代理、限流都未实测）。
4. **Web 界面上「顾问模式」芯片的视觉呈现没截图确认**：preset 行、`name`/`order` 已进入组合树且 `agentPresets/list` 有 `advisor`，UI 由 `dsh-client-ui-agent-preset` 读取，属强推断而非截图证据。
5. **`link:` 形态下删掉本仓库目录**会让 profile 那一行加载失败（已写进限制）。
6. 安装是在 DSH 桌面应用**运行中**做的（测试里是我们自己），CLI 只用文件锁，不受影响；但组合只在启动时读取，所以**必须重启**才生效。

---

## 已知限制

- **preset 名单是快照**：`cordis.patch.yml` 复制了当前 DSH 的 `standard` 名单。DSH 升级后必须重跑 `sync-preset.mjs`，否则新工具不会出现在「顾问模式」里（`verify.mjs` 会 FAIL 提示）。
- **会话中途不能换 preset**：选了「顾问模式」的会话不会切回 standard。要换只能新开任务（这是 DSH preset 的语义，不是本包的取舍）。
- **`desktop` profile 只能由应用初始化**：第一次必须先打开一次桌面应用；CLI/脚本无法凭空创建它。
- **装完必须重启桌面应用**：profile 组合在启动时一次性读取。
- **会把会话内容发给顾问 provider**：`consult_advisor` 会把主会话的 transcript（含工具调用与结果）和主 agent 的 system prompt 一并发给配置的顾问模型——如果顾问 provider 与主模型不是同一家，等于把项目内容交给了第二个厂商。敏感项目请把顾问配成同一信任域，或关掉顾问模式。
- **额外的模型调用**：每次咨询是一次独立 LLM 请求；若同时开了「自动审核」（auto-review / Auto 权限预设），`consult_advisor` 这个工具调用本身还会被审一次 —— 等于多一次调用，成本上要算进去。
- **顾问看到的是「清洗 + 截断」后的对话**：包含用户消息、助手文本、工具调用与工具结果（含工具报错），但每条消息/结果都有渲染上限，超长会话会从最旧处丢消息（`maxTranscriptChars`）；早期上下文可能因此不完整。
- **不涉及前端**：没有自定义客户端 UI；状态与开关走 `/advisor` 命令 + 宿主端投影，界面上看到的是命令结果，不是专属卡片。

---

## 许可

MIT
