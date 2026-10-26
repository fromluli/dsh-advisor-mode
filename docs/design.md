# 顾问模式（Advisor Mode）设计说明

> 目标：把 Claude Code 的 advisor（<https://code.claude.com/docs/en/advisor>）那套「关键决策点向更强模型求助」的经验，落成 DSH（DeepSeek Harness）里一个可用、可关、可回滚的**新模式**。
>
> 本文记录「为什么这样设计」；怎么装、怎么用见 [README](../README.md)。

---

## 1. 从原文提炼的 7 条经验

| # | Claude Code 的做法 | 我们保留 / 怎么改 |
|---|---|---|
| 1 | advisor 是**工具**：主模型在需要时调用它 | 保留：`consult_advisor` |
| 2 | advisor 收到**完整会话**（含每次工具调用与结果） | 保留：`session.deriveMessages()` 取模型可见全量 transcript，清洗后投喂 |
| 3 | **时机是模型驱动**，不是规则驱动；提示词负责引导「什么时候问」 | 保留：不在代码里卡触发条件，只给一段模式引导（`advisor:policy`），另加可选的硬性再入/并发保护 |
| 4 | 三种可见结果：Reviewed / Declined / Unavailable | 改成结构化三态 `verdict: proceed / revise / stop` + 解析兜底 `note`；技术失败照原文思路报 `Advisor unavailable (<code>)` |
| 5 | 主模型**一般遵从，但与自身证据冲突时明说不盲从** | 保留：写进工具结果与模式引导 |
| 6 | 只在决策点调用，因此比「全程用强模型」便宜 | 保留：默认只在上限内投喂 transcript，并可随时 `/advisor off` |
| 7 | 开关不动主模型 prompt 缓存（不换主模型） | 保留并强化：工具**永远**注册，开关只改一段 system prompt，工具目录不变 |

原文里「配对检查（advisor 必须比主模型更强）」「server tool 只能跑 Anthropic API」「Fable 计费授权」这些是 Anthropic 产品特定约束，DSH 没有模型排行与官方 server tool，因此改成：**显式配置 provider/model，写错路由就报错**；是否「更强」由用户自己挑。

## 2. 为什么在 DSH 里做成「模式」而不是只做一个工具

原文的 advisor 本质是工具，用户问的是「一个新的模式」。DSH 没有「模式」这个一等公民，只有三种载体（结论来自对 DSH 0.2.1-rc.3 源码的逐包核对）：

| 载体 | 能表达什么 | 不适合的原因 |
|---|---|---|
| permission preset | 沙箱 × 审批两个旋钮 | 不支持第三方新增，语义也不对 |
| agent preset | 新任务页「模式选择器」里的一项 | 换的是整个 per-agent 插件树，会话中途不能切 |
| plan-mode 形状的会话级开关 | `/plan` 这种开关 + 提示词段 + 命令 | 不会出现在模式选择器里 |

结论是**组合**：

- **agent preset** 负责「模式选择器里出现『顾问模式』」——用户开新任务时像选「标准/创造」一样选它；
- **plan-mode 形状的插件**负责「会话中途 `/advisor on|off`」——preset 把插件装进这棵插件树，开关只切换提示词段。

于是这个包同时是：

```
dsh-advisor-mode/
├── package.json          # dsh.bundle.patch → cordis.patch.yml
├── cordis.patch.yml      # 声明 preset「顾问模式」= 标准模式插件树 + advisor-mode 行
└── lib/index.js          # 一行 Cordis 插件：投影 + 提示词段 + /advisor 命令 + consult_advisor 工具
```

`cordis.patch.yml` 由 `scripts/sync-preset.mjs` 从当前 DSH 的 standard preset 生成（复制 + 改名 + 插入一行）。代价：**DSH 升级后要重跑脚本**，否则新版本标准模式新增的工具不会出现在顾问模式里。这是 DSH preset 只能整份声明造成的，已在 README 写明。

## 3. 运行形态

```
用户选「顾问模式」（新任务页模式选择器）
        │
        ▼
会话 per-agent 插件树 = 标准模式全部能力 + advisor-mode 插件
        │
        ├── system prompt 多一段 advisor:policy（默认开启）
        │     告诉主模型：什么时候问、怎么写问题、怎么对待建议
        │
        ├── 工具目录多一个 consult_advisor（始终注册，开关不改工具目录）
        │
        └── 斜杠命令 /advisor on|off|（空=查状态）
```

主模型调用 `consult_advisor` 时，插件：

1. 用 `session.deriveMessages()` 取当前会话的完整模型可见历史；
2. 清掉 developer 消息、悬空 tool-call、孤儿 tool 结果（顾问请求是单条纯文本，这层清洗是为了可读性；若将来改成直接发 messages，它也是绕开 provider 工具配对校验的前提）；
3. 按不可切分的「assistant tool-call + 其 tool 结果」分组裁剪到预算内（保留第一条任务说明 + 最近上下文）；
4. 拼上 `purpose / question / focus` 与顾问系统提示词，发一次**单轮、不带 tools**的请求给顾问模型；
5. 解析顾问回包为 `{verdict, guidance, risks}`，渲染成工具结果回给主模型；
6. 顺带把路由、usage、transcript 规模写进日志，便于排成本。

## 4. 协议

### 4.1 工具入参

| 参数 | 必填 | 含义 |
|---|---|---|
| `purpose` | ✅ | `approach`（动手前）/ `debug`（反复卡住）/ `review`（宣布完成前） |
| `question` | ✅ | 要复核的那一个决定：打算做什么、手上证据、考虑过哪些替代 |
| `focus` | | 希望顾问特别盯的点（迁移顺序、回滚路径……） |

### 4.2 顾问回包（严格单 JSON）

```json
{"verdict":"proceed|revise|stop","guidance":"...","risks":["..."]}
```

- `proceed`：方案成立，指出要盯什么；
- `revise`：必须先改什么，`guidance` 必须是具体可执行的改动；
- `stop`：别继续，上报用户（不安全、越权、与用户请求不符、建立在错误前提上）；
- 解析失败不丢建议：退回纯文本 `note`。

### 4.3 主模型看到的结果

```
ADVISOR_REVIEW (acme/gpt-6.1-sol)
Verdict: 需要调整 (revise)
Guidance: ...
Risks:
- ...
Apply this advice with judgement: ...
```

刻意保留「判断而非命令」的语气：顾问没有工具、没有授权能力；`proceed` 也不等于用户批准高风险动作。

## 5. 状态与持久化：为什么不用自定义事件

第三方插件**不能**写自定义会话事件：`dsh-session` 的 `KNOWN_SESSION_EVENT_TYPES` 是硬编码白名单，白名单外的事件除非带 `ignorable: true`（只有仓库内 `appendPluginRecord` 能写），否则持久化读回时整份日志会被拒绝解析。

所以模式状态改为**折叠标准事件**：

- `/advisor on|off` 由命令注册表自动写 `command/run`（含 args）+ `command/done`（含 kind）；
- 插件注册一个 host-only 投影 `advisor`，两阶段折叠：`run` 只记意图，`done` 且 `success` 才提交；
- 因此：非法参数、handler 报错不会翻转状态；resume / fork / 重启后状态自动正确；不需要任何自定义事件。

投影的 `stateSchema` 手写了等价校验（只用到 `.parse`），因此插件保持**零依赖**。

## 6. 成本与上下文策略

| 旋钮 | 默认 | 说明 |
|---|---|---|
| `maxTranscriptChars` | 80 000 | 对话序列化字符上限，超出从最旧处裁剪 |
| `maxSystemChars` | 12 000 | 主 agent system prompt 的上限（含 AGENTS.md 规则，值得给顾问看，但要设上限） |
| `maxTokens` | 3 000 | 顾问回包上限（回包会整段进主上下文） |
| `timeoutMs` | 180 000 | 插件自己用 `AbortSignal.timeout` 兜底；同时 DSH 的 `dsh-tool-call-timeout-policy` 会按工具定义的 `timeoutMs` 处理 `exec.signal`（两边同值，改配置时保持一致） |
| `temperature` | 0.2 | 复核任务要稳定 |

另外两条硬保护：

- 同一会话同时只允许一个咨询在飞（`WeakMap` 计数）；
- `AsyncLocalStorage` 再入守卫 + 顾问请求不传 `tools`：顾问不可能反向调用顾问，也不可能触发工具。

> 注意：如果 profile 装了 `@deepseek-ai/dsh-experimental-auto-review`，我们的 `consult_advisor` 调用也会被它再审一次（它没有白名单机制）。这是预期行为：多一次安全审查，多一点成本。

## 7. 与 DSH 现有能力的分工

| 能力 | 更强的模型什么时候跑 | 上下文 | 适合 |
|---|---|---|---|
| **顾问模式** | 决策点，由主模型决定 | 主会话完整 transcript（裁剪后） | 长任务里的方向性判断、反复报错、完工前复核 |
| subagent | 整段委派 | 独立新上下文 | 可切分的独立子任务 |
| goal round driver | 每轮继续推进 | 同会话 | 长目标的自动续跑 |
| plan mode | 规划阶段 | 同会话 | 先出计划再执行 |
| agent team | 并行成员 | 各自上下文 + 共享任务板 | 可并行的多线程工作 |

一句话：**subagent 是「派出去的人」，advisor 是「请过来看一眼的专家」**。

## 8. 验收

1. `node --test tests/unit.test.mjs`：配置校验、参数解析、状态折叠、transcript 清洗/裁剪、回包解析、渲染 —— 20 项，全部离线。
2. `node tests/e2e/run-e2e.mjs`：本地 mock provider + DSH headless 会话，验证模式段进入请求、工具注册、顾问请求携带 transcript、工具结果回灌主模型。
3. `node scripts/verify.mjs`：安装后只读检查 profile 是否真的挂上了 bundle。
4. 人工：重启 DSH → 新任务页模式选择器出现「顾问模式」→ 让它做一个有风险的决定 → 观察 `/advisor` 状态与工具卡片。

## 9. 已知限制 / 后续可选

- **preset 名单是复制的**：DSH 升级后需重跑 `scripts/sync-preset.mjs`；不做则只是少了新版本新增的工具，不会坏。
- **没有 composer 芯片**：会话内状态目前靠 `/advisor` 命令与工具卡片展示；要常驻芯片得再写一个预构建的 `lib/client.js`（`conversation.input.left` 是唯一空着的 list 座位）。
- **没有模型强弱排序**：DSH 不提供模型排行，配对是否「更强」由用户决定；写错 route 会得到明确的 provider/model 错误。
- **transcript 裁剪是启发式**：极端长会话会丢最早的中段上下文；顾问若因此证据不足，会按协议返回 `revise` 并要求先查什么。
- **没有自动「每次完成前必问」的硬闸**：坚持 Claude 原文的「模型驱动时机」；需要更硬的流程时，在模式引导里加规则即可（`section` 可配置）。
