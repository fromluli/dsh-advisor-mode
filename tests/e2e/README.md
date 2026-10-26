# dsh-advisor-mode 端到端验收（E2E）

一套**完全本地、零成本、不联网**的验收：用本地假 provider（mock provider）驱动真实 DSH
headless 会话，证明「顾问模式」真的生效 —— 不是 mock 环境的巧合。

- 不花一分钱：全程只和 `127.0.0.1` 上的 mock provider 通信。
- 不碰用户数据：每次运行都重建独立的 `DSH_HOME`（默认 `/tmp/dsh-advisor-e2e-home`），
  **绝不读写 `~/.dsh/profiles/desktop`**，也不动仓库里 `lib/`、`scripts/`、`package.json`。
- 一条命令：`node tests/e2e/run-e2e.mjs`

## 一键运行

```bash
cd ~/Documents/Projects/dsh-advisor-mode   # 换成你 clone 下来的仓库目录
node tests/e2e/run-e2e.mjs
```

实测耗时约 2–3 秒（正/负向各一次 init + dump-config + headless，共 6 次 DSH CLI 调用），退出码即验收结论：

- `0` = 全部断言 PASS（当前 8/8）；
- `1` = 有 FAIL，终端会打印逐条原因与证据文件路径。

> 建议 Lead 在 `package.json` 的 `scripts` 里加一行
> `"test:e2e": "node tests/e2e/run-e2e.mjs"`（本目录不负责改 `package.json`）。

## 前置条件

| 依赖 | 说明 |
| --- | --- |
| DSH Desktop（含 CLI） | 默认路径 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`；用 `DSH_CLI` 覆盖 |
| Node.js ≥ 18（实测 v24.15.0） | 只需要系统 `node` 跑两个零依赖脚本；脚本内部用 `spawn` 调 DSH CLI |
| 插件本体 | `lib/index.js`（profile patch 以绝对路径插入） |
| 无网络 | 不需要 API key、不需要联网；mock provider 用的是假 key |

不需要 `pnpm install`，不需要装任何三方包。

## 它到底怎么证明「顾问模式生效」

```
run-e2e.mjs
  │  ① 重建 DSH_HOME，用 dsh --profile headless --dump-config 初始化 headless profile
  │  ② 启动 tests/e2e/mock-provider.mjs（OpenAI chat-completions 兼容 SSE，随机端口）
  │  ③ 写 profile 的 cordis.patch.yml：
  │       - llm-pi-ai 的 providers.e2e-mock → baseURL=http://127.0.0.1:<port>/v1
  │         模型 mock-main / mock-advisor，apiKeyEnv=DSH_E2E_MOCK_KEY
  │       - agent-default-model → e2e-mock / mock-main
  │       - insert 一行 dsh-advisor-mode（绝对路径），config {provider: e2e-mock,
  │         model: mock-advisor, defaultOn: true}
  │       - 关掉 session-title-llm（避免额外的标题 LLM 调用干扰请求计数）与 OTEL
  │  ④ dsh --profile headless "请评估：我要直接改 lib/index.js 的 transcript 裁剪逻辑…"
        │
        ├─ 主模型请求#1（model=mock-main，带 26 个工具）→ mock 回一次 consult_advisor 工具调用
        │    断言 a：system 含 ADVISOR_MODE（插件 systemPrompt section 生效）
        │    断言 b：tools 里有 consult_advisor（插件工具注册生效）
        │
        ├─ 插件执行 consult_advisor：读 session.deriveMessages() → 渲染 transcript+question
        │  → ctx.llm.stream(provider=e2e-mock, model=mock-advisor) → mock-advisor 请求
        │    断言 c：顾问 system 是插件默认顾问提示词、user 含 CONSULTATION/Question/
        │            --- CONVERSATION ---/--- END CONVERSATION --- 与主会话任务文本，
        │            且**不带 tools**（递归防护第一层，顾问不可能再叫顾问）
        │
        ├─ 主模型请求#2（带 tool 结果）→ mock 回最终文本
        │    断言 d：tool 结果文本含 ADVISOR_REVIEW / revise / 顾问原话（"先补测试再改"、"数据丢失"），
        │            且 tool_call_id 与前一次 tool_call 对齐；主模型确实拿到了顾问意见
        │
        └─ 断言 e：headless 退出码 0，stdout 含主模型最终答复标记 E2E_MOCK_FINAL
  │  ⑤ 负向对照：同样的 mock、同样的任务，但 patch 里**不插插件行**，再跑一次 headless
  │     断言 g：system 无 ADVISOR_MODE、tools 无 consult_advisor、mock-advisor 0 次请求
  │     （证明 a/b/c 的 PASS 来自插件，而不是 mock 环境巧合）
  └─ 打印 PASS/FAIL 清单 + 落盘证据
```

## 断言清单（终端逐条打印）

| 编号 | 断言 | 失败即意味着 |
| --- | --- | --- |
| 0 | patch 后的 composed config 里有 `e2e-mock` provider、`agent-default-model=mock-main`、`advisor-mode` 插件行 | profile patch 没生效 / 插件没插进去 |
| a | 主请求 system 含 `ADVISOR_MODE` 且是插件默认引导段 | `systemPrompt.section` 没生效（模式段没注入） |
| b | 主请求 tools 里有 `consult_advisor`，参数含 `purpose`/`question` | 工具没注册（或 schema 不对） |
| c | 顾问请求恰好 1 次；system=顾问提示词；user 含完整 transcript+question；**无 tools**；temperature=0.2；有 max_tokens | 插件没有用 transcript 去问顾问模型 / 请求形态不对 |
| d | 第二次主请求的 tool 消息含 `ADVISOR_REVIEW`、`revise`、顾问原话，`tool_call_id` 对齐 | 顾问回包没解析 / 工具结果没回给主模型 |
| e | headless 退出码 0，stdout 含 `E2E_MOCK_FINAL` | 会话中途失败（看 stderr / 报告） |
| f | 0 个未知模型请求；主工具请求恰好 2 次；顾问请求恰好 1 次 | 有重试 / 意外路由 / 重复咨询 |
| g | 负向对照：无插件时 system 无 `ADVISOR_MODE`、tools 无 `consult_advisor`、顾问 0 次请求 | 正向断言是假阳性（mock 环境自己就会这样） |

每条的实测细节会打印在 PASS 行下面（system 字符数、工具数量、tool_call_id、请求计数等）。

## 产物与证据（每次运行重建）

全部落在 `$DSH_HOME`（默认 `/tmp/dsh-advisor-e2e-home`）下：

```
artifacts/
  report.txt                     # 与终端一致的 PASS/FAIL 清单
  report.json                    # 机器可读的断言结果
  profile-patch.yml              # 本次写入 profile 的 patch（含 mock 端口）
  dump-config-initial.yml        # 初始化后的 profile 树
  dump-config-patched.yml        # patch 后的 composed config（断言 0 的证据）
  dump-config-patched-negative.yml
  profile-patch-negative.yml     # 负向对照的 patch（无插件行）
  headless.stdout.log            # 主模型最终答复（断言 e）
  headless.stderr.log
  headless.meta.json             # 退出码/signal/超时/起止时间
  headless-negative.stdout.log
  mock/                          # 正向会话收到的每个请求体（req-001…, decisions.jsonl, summary.json）
  mock-negative/                 # 负向对照收到的每个请求体
```

典型证据：

- `mock/req-001-mock-main.json` → `body.messages[0].role=system`，内容含 `ADVISOR_MODE`；`body.tools` 有 26 个工具，含 `consult_advisor`。
- `mock/req-002-mock-advisor.json` → `body.model=mock-advisor`，`messages=[system,user]`，`tools` 不存在；user 是 `MAIN_AGENT_SYSTEM_PROMPT…CONSULTATION…--- CONVERSATION ---…`。
- `mock/req-003-mock-main.json` → `messages` 里有 `role=tool`、`tool_call_id=call_mock_advisor_1`，内容 `ADVISOR_REVIEW (e2e-mock/mock-advisor) / Verdict: 需要调整 (revise) / … 数据丢失`。
- `headless.stdout.log` → `E2E_MOCK_FINAL: 已按顾问意见处理，先补测试再改实现。`

## 已验证项（2026-10-26，macOS，DSH 0.2.1-rc.3）

- 一次命令 8/8 PASS、退出码 0，耗时约 2–3s；从仓库任意 cwd 运行、`DSH_E2E_HOME` 换目录也 PASS。
- 顾问模式全链路：system 段注入（a）→ 工具注册（b）→ 插件发顾问请求且不带 tools（c）→ 顾问回包渲染成 `ADVISOR_REVIEW` 工具结果并回到主模型（d）→ 会话正常结束（e）。
- 负向对照（g）：摘掉插件行后同一套 mock/任务完全不产生顾问链路。
- 整链路 `127.0.0.1` 本地回环，无真实模型请求、无 API key、无 OTEL 上报。

## 未验证项（本套 E2E 的边界，别当成已验收）

- **`defaultOn` 之外的交互**：`/advisor off` 之后 consult_advisor 应拒绝执行、`/advisor on` 恢复、
  `status` 文案 —— 需要多轮 headless 或 `--session-id` 续跑，本套只覆盖 `defaultOn=true` 主链路。
- **resume / fork / 重启后的模式状态**：投影折叠（`command/run`+`command/done`）的持久化语义未验。
- **失败分支**：顾问模型报错 / 超时 / 回包无法解析（`verdict=note` 兜底）/ token 截断（`MAX_TOKENS`）/
  同一会话并发咨询被拒 —— mock 只实现 happy path。
- **真实 provider 兼容性**：mock 是标准 OpenAI chat-completions SSE；对真实网关（鉴权、限流、
  特殊 header、`reasoning` 字段）不做保证。
- **Desktop/Web profile 与 TUI**：只验了 headless profile；Web 会话里卡片渲染
  （`presentCall`/`presentResult`）未验。
- **工具目录稳定性**：断言了 consult_advisor 一直在 tools 里（模式开关只改 system 段的设计），
  但没跨模式切换对比工具目录字节级一致性。

## 可调项（环境变量）

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `DSH_CLI` | Desktop 安装路径 | 换一个 DSH CLI |
| `DSH_E2E_HOME` | `/tmp/dsh-advisor-e2e-home` | 换临时 DSH_HOME（负向对照用 `<HOME>-negative`） |
| `DSH_E2E_TIMEOUT_MS` | `180000` | headless 进程超时 |

改行为时主要动两个文件：

- `mock-provider.mjs` 顶部常量：`ADVICE`（顾问回包）、`FINAL_TEXT`、`CONSULT_ARGUMENTS`（主模型发起的咨询参数）、
  以及 `streamToolCall`（工具调用分片方式）。
- `run-e2e.mjs` 顶部常量：`TASK`（触发顾问模式的任务文本）、`FINAL_MARKER`、`ADVICE_MARKERS`、
  `renderProfilePatch`（provider/插件配置形态）。

## 注意事项

- **不要**把 `DSH_E2E_HOME` 指到 `~/.dsh`：脚本每次运行会 `rm -rf` 整个 `DSH_HOME`。
- mock provider 用随机端口（`--port 0`），并发跑两次本脚本不会端口冲突，但会争用同一个
  `DSH_HOME` 目录；并发需求请用不同的 `DSH_E2E_HOME`。
- 插件是**始终注册在 profile 里**的：如果 `lib/index.js` 正在被其他人改，E2E 测的就是改动后的真实行为
  （这正好是端到端验收想要的效果）。
- 本文件与两个脚本属于 `tests/e2e/**` 写作用域；不改 `lib/`、`scripts/`、`package.json`、`cordis.patch.yml`、`docs/`。

## 实现备忘：为什么 mock 长这样

DSH 的 `@deepseek-ai/dsh-llm-pi-ai` 适配器不是自己拼 HTTP —— 它走
`@earendil-works/pi-ai` 的 `openai-completions` 协议实现（内部用官方 openai SDK）。
所以 mock 只需要实现标准 OpenAI 流式契约（依据 pi-ai 源码确认）：

- `POST {baseURL}/chat/completions`，请求体 `stream: true`、`stream_options:{include_usage:true}`；
- 响应 `Content-Type: text/event-stream`，每行 `data: <json>\n\n`，最后 `data: [DONE]`；
- 每个 chunk 的形状 `{id,object:"chat.completion.chunk",created,model,choices:[{index,delta,finish_reason}]}`；
- **必须**给终态 `finish_reason`（`stop` / `tool_calls`），否则 pi-ai 报 "Stream ended without finish_reason"；
- 工具调用 = `delta.tool_calls:[{index,id,type:"function",function:{name,arguments}}]`，
  arguments 可以分多片增量下发（mock 故意分两片，顺带验证 pi-ai 的 partialArgs 拼接）；
- usage chunk 用 `{prompt_tokens,completion_tokens,total_tokens}`；
- 请求侧：system prompt 落在 `messages[0].role="system"`，工具结果落在 `role="tool"` + `tool_call_id`。
