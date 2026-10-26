/**
 * Advisor Mode —— DSH 顾问模式宿主插件（零依赖，纯 ESM）
 *
 * 形态：一个会话级模式。模式开启时，system prompt 多一段 `advisor:policy` 引导，
 * 模型可以在关键决策点调用 `consult_advisor`：
 *   插件把「当前会话的完整 transcript + 一个具体问题」发给配置里指定的
 *   第二个（更强）模型，把 {verdict, guidance, risks} 作为工具结果回给主模型。
 *
 * 设计取自 Claude Code 的 advisor（code.claude.com/docs/en/advisor）与 DSH 自己的
 * plan-mode（packages/plan/plan-mode）：
 *   1. 工具**永远**注册，开关只改 system prompt 段 —— 请求里的工具目录保持稳定，
 *      避免每一步都让提示词前缀变化（KV cache 抖动）。
 *   2. 模式状态**不写自定义会话事件**：第三方插件禁止发明事件类型
 *      （dsh-session 的 KNOWN_SESSION_EVENT_TYPES 白名单）。状态改为折叠标准事件
 *      `command/run` + `command/done`（`/advisor on|off` 由命令注册表自动记录），
 *      经 `ctx.sessionProjections` 复现，因此 resume / fork / 重启后仍正确。
 *   3. transcript 用正式 API `session.deriveMessages()` 读取（snapshotEvents 已 deprecated）。
 *      顾问请求本身只发一条纯文本 user 消息，所以这里清洗悬空 tool-call / 孤儿 tool 结果
 *      的目的不是绕开 provider 的 tool 配对校验，而是让顾问读到可读、无残缺的历史
 *      （将来若改成直接发 messages，这层清洗也正好是必需的）。
 *   4. 顾问请求不传 tools，配合 AsyncLocalStorage 再入守卫，顾问不可能反向调用顾问。
 *
 * 零依赖：本文件不 import 任何 @deepseek-ai/* 包 —— 工具定义直接手写受支持的
 * JSON Schema（dsh-tools 的 enforced subset），流式 chunk 直接按公开协议消费。
 * 这样第三方包不需要在 profile 里安装 peer，也不受 DSH peer 版本闸门影响。
 *
 * @module dsh-advisor-mode
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'advisor-mode'

/** 必需服务：缺任何一个都不挂载（commands 可选，用 ctx.inject 延迟注入）。 */
export const inject = ['llm', 'tools', 'systemPrompt', 'sessionProjections']

/** 模型可见的顾问工具名。 */
export const TOOL_NAME = 'consult_advisor'

/** 斜杠命令名。 */
export const COMMAND_NAME = 'advisor'

/** system prompt 段落名。 */
export const SECTION_NAME = 'advisor:policy'

/** 模式状态投影键（host-only，不向浏览器暴露）。 */
export const PROJECTION_KEY = 'advisor'

/** 投影状态版本：折叠语义变化时递增。 */
export const PROJECTION_VERSION = 1

/** 配置项白名单：未知键直接报错，避免拼写错误被静默吞掉。 */
const CONFIG_KEYS = new Set([
  'provider',
  'model',
  'section',
  'system',
  'defaultOn',
  'maxTranscriptChars',
  'maxSystemChars',
  'maxTokens',
  'temperature',
  'timeoutMs',
])

/** 默认的模式引导（模型可见，英文；DSH 的系统提示词统一用英文）。 */
export const DEFAULT_SECTION = `ADVISOR_MODE
Advisor mode is on for this session. You are the working agent; a stronger advisor model is available for second opinions at decision points.

Call consult_advisor before you commit to a consequential decision:
- before choosing an approach that is expensive to reverse (architecture, data model, public API, migrations, dependency or configuration changes, deleting or rewriting existing files);
- when the same error survives two failed fixes;
- before you declare a large, risky, or cross-cutting task complete;
- whenever the user explicitly asks you to seek a second opinion.

Do not consult the advisor for routine reads, small edits, or simple factual questions: every consultation re-reads the conversation transcript and costs tokens and time.

Write each consultation so an outside reviewer who sees only the transcript can judge it: state the decision you are about to make, what you intend to do, the evidence you have, the alternatives you considered, and one specific question.

The advisor cannot act and cannot authorize anything. Treat its verdict as a strong second opinion, not an override of evidence: follow the guidance when it fits the evidence; when a recommended step fails or the files contradict it, say so explicitly and explain the conflict instead of following it blindly. A "proceed" verdict never replaces user confirmation for risky actions.`

/** 默认的顾问系统提示词（顾问模型可见，英文；要求严格 JSON 回包）。 */
export const DEFAULT_SYSTEM = `You are a senior engineering advisor reviewing another agent's work inside DeepSeek Harness.
You receive that agent's conversation transcript and one decision it is about to make. You cannot execute anything, and nothing you write is treated as user authorization.

Return exactly one JSON object and no text outside it:
{"verdict":"proceed|revise|stop","guidance":"...","risks":["..."]}

- "proceed": the intended action is sound. Say briefly what to keep watching.
- "revise": something in the plan, evidence, or sequencing must change first. "guidance" must contain concrete, actionable changes, not generalities.
- "stop": do not continue; escalate to the user. Use it when the action is unsafe, unauthorized, misaligned with the user's request, or built on a false premise.

Write "guidance" in the language of the user's latest message and keep it under 300 words unless the decision genuinely needs more. "risks" holds concrete risks, one sentence each; use [] when there are none. Do not restate the transcript, and do not invent facts that are not in it: when the evidence is insufficient, use "revise" and name exactly what to check first.`

/** 工具描述（模型可见）。 */
const TOOL_DESCRIPTION = `Ask a stronger advisor model for a second opinion on this session. The advisor receives the full conversation transcript plus your question, and returns a verdict (proceed / revise / stop), concrete guidance, and risks. Use it before consequential or hard-to-reverse decisions, when the same error keeps recurring after two fixes, or before declaring a large task complete. It cannot run tools and cannot authorize anything; its advice never replaces user confirmation.`

/** 单条消息 / 单个 text block 的渲染上限，防止一条巨大工具结果把预算吃光。 */
const MESSAGE_TEXT_CAP = 8_000
const TOOL_RESULT_CAP = 3_000

/** 顾问请求内部的再入守卫（递归防护第二层；第一层是不传 tools）。 */
const advisorScope = new AsyncLocalStorage()

/** 同一会话的并发咨询计数：同一会话不并行打多个顾问请求。 */
const inFlight = new WeakMap()

/**
 * 校验并冻结插件配置。未知键、越界值都在加载期报错，而不是等到第一次咨询。
 * @param {object} [raw] loader 传入的行 config。
 * @returns {object} 归一化后的配置。
 */
export function resolveConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('advisor-mode: config must be an object')
  const unknown = Object.keys(raw).filter((key) => !CONFIG_KEYS.has(key))
  if (unknown.length > 0) throw new Error(`advisor-mode: unknown config key(s) ${unknown.join(', ')}`)

  const provider = raw.provider ?? ''
  const model = raw.model ?? ''
  if (typeof provider !== 'string' || typeof model !== 'string') throw new Error('advisor-mode: `provider` and `model` must be strings')
  // 给 provider/model 就都要给；都不给则复用会话当前路由（auto-review 的做法）。
  if (provider.length === 0 !== (model.length === 0)) throw new Error('advisor-mode: set both `provider` and `model`, or neither (neither = reuse the session route)')

  const config = {
    provider,
    model,
    section: raw.section ?? DEFAULT_SECTION,
    system: raw.system ?? DEFAULT_SYSTEM,
    defaultOn: raw.defaultOn ?? true,
    maxTranscriptChars: raw.maxTranscriptChars ?? 80_000,
    maxSystemChars: raw.maxSystemChars ?? 12_000,
    maxTokens: raw.maxTokens ?? 3_000,
    temperature: raw.temperature ?? 0.2,
    timeoutMs: raw.timeoutMs ?? 180_000,
  }

  for (const key of ['section', 'system']) {
    if (typeof config[key] !== 'string' || config[key].trim().length === 0) throw new Error(`advisor-mode: \`${key}\` must be a non-empty string`)
  }
  if (typeof config.defaultOn !== 'boolean') throw new Error('advisor-mode: `defaultOn` must be a boolean')
  for (const key of ['maxTranscriptChars', 'maxSystemChars', 'maxTokens', 'timeoutMs']) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new Error(`advisor-mode: \`${key}\` must be a positive integer`)
  }
  if (typeof config.temperature !== 'number' || !Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2) throw new Error('advisor-mode: `temperature` must be a finite number in [0, 2]')
  // 上界只为拦住「明显是写错的量级」（例如多写三个 0 把上下文预算撑爆），不是产品限制。
  const bounds = {
    maxTranscriptChars: 2_000_000,
    maxSystemChars: 200_000,
    maxTokens: 200_000,
    timeoutMs: 3_600_000,
  }
  for (const [key, max] of Object.entries(bounds)) {
    if (config[key] > max) throw new Error(`advisor-mode: \`${key}\` must be <= ${String(max)} (got ${String(config[key])})`)
  }
  return Object.freeze(config)
}

/**
 * 解析 `/advisor` 的原始参数。
 * @param {unknown} raw 命令的 rawInput（可能为 undefined）。
 * @returns {'on'|'off'|'status'|null} 目标状态；`null` 表示非法参数。
 */
export function parseCommandArgument(raw) {
  if (raw === undefined || raw === null) return 'status'
  if (typeof raw !== 'string') return null
  const argument = raw.trim().toLowerCase()
  if (argument === '' || argument === 'status') return 'status'
  if (argument === 'on' || argument === 'enable') return 'on'
  if (argument === 'off' || argument === 'disable') return 'off'
  return null
}

/**
 * 构造模式状态投影：只折叠标准事件（第三方不能写自定义事件类型）。
 *
 * `/advisor on|off` 由命令注册表自动记录 `command/run`（含 args）与 `command/done`
 * （含 kind）。两阶段折叠：run 只记意图，done 且 success 才提交 —— 非法参数或
 * handler 报错不会翻转状态。
 *
 * @param {object} options
 * @param {boolean} options.defaultOn 没有历史选择时的默认值。
 * @param {string} [options.commandName] 命令名，默认 `advisor`。
 * @returns {object} 可交给 ctx.sessionProjections.register() 的定义。
 */
export function createAdvisorProjection({ defaultOn, commandName = COMMAND_NAME }) {
  // 投影的 stateSchema 只被注册表用于 `.parse()` 校验持久化行；这里手写等价校验，
  // 避免为一个字段引入 zod 依赖。
  const stateSchema = {
    parse(value) {
      const record = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
      const active = typeof record.active === 'boolean' ? record.active : defaultOn
      const running = record.running !== null && typeof record.running === 'object' && typeof record.running.commandId === 'string' && typeof record.running.wanted === 'boolean'
        ? { commandId: record.running.commandId, wanted: record.running.wanted }
        : null
      return { active, running }
    },
  }
  return {
    key: PROJECTION_KEY,
    stateVersion: PROJECTION_VERSION,
    stateSchema,
    init: () => ({ active: defaultOn, running: null }),
    apply: (state, event) => {
      if (event.type === 'command/run' && event.data !== null && typeof event.data === 'object' && event.data.name === commandName) {
        const wanted = parseCommandArgument(event.data.args)
        if (wanted !== 'on' && wanted !== 'off') return state
        return { ...state, running: { commandId: event.data.commandId, wanted: wanted === 'on' } }
      }
      if (event.type === 'command/done' && state.running !== null && event.data !== null && typeof event.data === 'object' && event.data.commandId === state.running.commandId) {
        const committed = event.data.kind === 'success' ? state.running.wanted : state.active
        return { ...state, active: committed, running: null }
      }
      // 无关事件必须返回同一个引用，否则每一步都会触发下游重算。
      return state
    },
  }
}

/** 抽取一条消息里的纯文本（忽略图片、思考块）。 */
function textBlocksOf(message) {
  const content = Array.isArray(message.content) ? message.content : []
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') parts.push('[image omitted]')
  }
  return parts.join('\n')
}

/** 截断一段文本到上限，附加省略标记。 */
function clip(text, limit) {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]`
}

/** 把 tool-call block 渲染成一行。 */
function renderToolCall(block) {
  const rawArguments = block.arguments
  const argumentsText = typeof rawArguments === 'string' ? rawArguments : JSON.stringify(rawArguments ?? {})
  return `[calls ${String(block.name ?? 'tool')} ${clip(argumentsText, 600)}]`
}

/**
 * 去掉 assistant 消息里没有对应 tool 结果的 tool-call（悬空调用）。
 * `consult_advisor` 自身这次调用在执行时就是悬空的：不清理会让顾问看到一次
 * 没有结果的调用，误以为会话中断。若将来把 transcript 作为 messages 直发，
 * 这层清洗同时也是 provider 工具配对校验所必需的。
 */
function stripDanglingToolCalls(messages) {
  const answered = new Set(messages.filter((message) => message.role === 'tool').map((message) => message.toolCallId))
  const output = []
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      output.push(message)
      continue
    }
    const kept = []
    const dropped = []
    for (const block of message.content) {
      if (block !== null && typeof block === 'object' && block.type === 'tool-call' && !answered.has(block.id)) dropped.push(block)
      else kept.push(block)
    }
    if (dropped.length === 0) {
      output.push(message)
      continue
    }
    const note = { type: 'text', text: `[a tool call was started here and its result is not recorded yet: ${dropped.map((block) => String(block.name ?? 'tool')).join(', ')}]` }
    output.push({ ...message, content: kept.length === 0 ? [note] : [...kept, note] })
  }
  return output
}

/** 丢弃没有对应 assistant tool-call 的 tool 结果（截断后可能落在开头）。 */
function dropOrphanToolResults(messages) {
  const declared = new Set()
  const output = []
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block !== null && typeof block === 'object' && block.type === 'tool-call') declared.add(block.id)
      }
      output.push(message)
      continue
    }
    if (message.role === 'tool') {
      if (declared.has(message.toolCallId)) output.push(message)
      continue
    }
    if (message.role === 'system' && (!Array.isArray(message.content) || message.content.length === 0)) continue
    output.push(message)
  }
  return output
}

/** 估算 token 量级（chars/4 + 每条消息 4）。 */
export function roughTokens(messages) {
  let total = 0
  for (const message of messages) {
    total += 4
    for (const block of Array.isArray(message.content) ? message.content : []) {
      total += 4 + Math.ceil(JSON.stringify(block).length / 4)
    }
  }
  return total
}

/**
 * 从会话取出「顾问可见的完整对话」。
 *
 * 只用正式 API `session.deriveMessages()`；随后按需清掉 developer 消息、悬空
 * tool-call、孤儿 tool 结果，再按「不可切分组」从最旧处裁剪。
 *
 * @param {object} session DSH Session 实例。
 * @param {object} [options]
 * @param {boolean} [options.includeSystemPrompt=true] 是否带上宿主 system prompt（单独返回）。
 * @param {number} [options.maxSystemChars=12000] system prompt 上限。
 * @param {number} [options.maxTranscriptChars=80000] 对话序列化字符上限。
 * @returns {{messages: object[], systemText: string, droppedMessages: number, tokens: number}} 顾问输入。
 */
export function buildTranscript(session, options = {}) {
  const {
    includeSystemPrompt = true,
    maxSystemChars = 12_000,
    maxTranscriptChars = 80_000,
  } = options

  const derived = session.deriveMessages()
  const systemParts = []
  const conversation = []
  for (const message of derived) {
    if (message.role === 'system') {
      if (includeSystemPrompt) for (const part of textBlocksOf(message).split('\n')) if (part.trim() !== '') systemParts.push(part)
      continue
    }
    // developer/message 记录工具目录变更，对顾问没有价值，还可能触发 provider 报错。
    if (message.role === 'developer') continue
    conversation.push(message)
  }

  const cleaned = dropOrphanToolResults(stripDanglingToolCalls(conversation)).map((message) => ({
    role: message.role,
    ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
    ...(message.isError === undefined ? {} : { isError: message.isError }),
    content: Array.isArray(message.content) ? message.content : [],
  }))

  // 按「组」裁剪：assistant tool-call 与其后的 tool 结果不可切开；
  // 第一组（通常是用户的任务说明）作为锚点保留，其余从最新往回塞。
  const groups = []
  for (let index = 0; index < cleaned.length; index += 1) {
    const group = [cleaned[index]]
    if (cleaned[index].role === 'assistant' && Array.isArray(cleaned[index].content)) {
      const calls = cleaned[index].content.filter((block) => block !== null && typeof block === 'object' && block.type === 'tool-call')
      if (calls.length > 0) {
        while (index + 1 < cleaned.length && cleaned[index + 1].role === 'tool') {
          index += 1
          group.push(cleaned[index])
        }
      }
    }
    groups.push(group)
  }

  const sizeOf = (group) => JSON.stringify(group).length
  let budget = maxTranscriptChars
  let anchor = null
  if (groups.length > 0 && groups[0][0].role === 'user') {
    anchor = groups[0]
    budget -= sizeOf(anchor)
  }
  const kept = []
  for (let index = groups.length - 1; index >= (anchor === null ? 0 : 1); index -= 1) {
    const cost = sizeOf(groups[index])
    if (cost > budget) break
    budget -= cost
    kept.unshift(...groups[index])
  }
  const keptBeforeOrphans = anchor === null ? kept.length : anchor.length + kept.length
  const messages = dropOrphanToolResults(anchor === null ? kept : [...anchor, ...kept])

  return {
    messages,
    systemText: clip(systemParts.join('\n'), maxSystemChars),
    // 只统计「因 maxTranscriptChars 预算被裁掉的对话消息」；
    // system 消息另行投喂、developer 消息被丢弃，都不算「顾问少看了上下文」。
    droppedMessages: Math.max(0, cleaned.length - keptBeforeOrphans),
    tokens: roughTokens(messages),
  }
}

/**
 * 把清洗后的消息渲染成顾问可读的纯文本对话记录。
 * @param {object[]} messages buildTranscript 返回的消息。
 * @returns {string} 角色标注的文本记录。
 */
export function renderConversation(messages) {
  const blocks = []
  for (const message of messages) {
    if (message.role === 'user') {
      const text = textBlocksOf(message)
      if (text.trim() !== '') blocks.push('### user\n' + clip(text, MESSAGE_TEXT_CAP))
      continue
    }
    if (message.role === 'assistant') {
      const lines = []
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block === null || typeof block !== 'object') continue
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') lines.push(clip(block.text, MESSAGE_TEXT_CAP))
        else if (block.type === 'tool-call') lines.push(renderToolCall(block))
      }
      if (lines.length > 0) blocks.push('### assistant\n' + lines.join('\n'))
      continue
    }
    if (message.role === 'tool') {
      const text = textBlocksOf(message)
      blocks.push(`### tool result${message.isError === true ? ' (error)' : ''}\n` + (text.trim() === '' ? '[]' : clip(text, TOOL_RESULT_CAP)))
    }
  }
  return blocks.join('\n\n')
}

/**
 * 拼出顾问请求的 user 部分。
 * @param {object} input
 * @param {string} input.conversation renderConversation 的输出。
 * @param {string} input.purpose 咨询目的（approach / debug / review）。
 * @param {string} input.question 要复核的具体决定。
 * @param {string} [input.focus] 额外聚焦点。
 * @param {string} [input.systemText] 主 agent 的 system prompt（可空）。
 * @param {number} [input.droppedMessages] 因预算被裁掉的消息数。
 * @returns {string} 完整的顾问请求文本。
 */
export function renderAdvisorRequest(input) {
  const sections = []
  if (typeof input.systemText === 'string' && input.systemText.trim() !== '') {
    sections.push('MAIN_AGENT_SYSTEM_PROMPT (context only; follow the conversation and question below)\n' + input.systemText)
  }
  sections.push(
    'CONSULTATION',
    `Purpose: ${input.purpose}`,
    `Question: ${input.question}`,
    ...(typeof input.focus === 'string' && input.focus.trim() !== '' ? [`Focus: ${input.focus}`] : []),
    'The conversation transcript follows, oldest first, role-tagged. '
      + (input.droppedMessages > 0 ? `${input.droppedMessages} earliest message(s) were omitted to fit the budget.\n` : '')
      + '--- CONVERSATION ---',
    input.conversation,
    '--- END CONVERSATION ---',
    'Return exactly one JSON object: {"verdict":"proceed|revise|stop","guidance":"...","risks":["..."]}',
  )
  return sections.join('\n\n')
}

/** 顾问返回的合法 verdict 集合（`note` 是解析失败时的兜底）。 */
const VERDICTS = new Set(['proceed', 'revise', 'stop', 'note'])

/**
 * 宽松解析顾问回包：先剥代码围栏，再取第一个 `{` 到最后一个 `}`。
 * 结构化解析失败时把整段文本当作 guidance（verdict=note），不丢建议。
 * @param {string} text 顾问返回的文本。
 * @returns {{verdict: string, guidance: string, risks: string[]}} 归一化建议。
 */
export function parseAdvice(text) {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed === '') throw new Error('the advisor returned no text')
  const unfenced = trimmed.replace(/^```[a-zA-Z]*\s*/u, '').replace(/\s*```$/u, '').trim()
  const start = unfenced.indexOf('{')
  const end = unfenced.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      const value = JSON.parse(unfenced.slice(start, end + 1))
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const verdict = typeof value.verdict === 'string' && VERDICTS.has(value.verdict) ? value.verdict : 'note'
        const guidance = typeof value.guidance === 'string' ? value.guidance.trim() : ''
        const risks = Array.isArray(value.risks) ? value.risks.filter((risk) => typeof risk === 'string' && risk.trim() !== '').map((risk) => risk.trim()).slice(0, 8) : []
        if (guidance !== '' || risks.length > 0) return { verdict, guidance: guidance === '' ? '(no guidance text)' : guidance, risks }
      }
    } catch {
      // 落到下面的纯文本兜底。
    }
  }
  return { verdict: 'note', guidance: unfenced, risks: [] }
}

/** verdict → 中文标签（仅用于渲染给模型/用户看的文本，不影响协议）。 */
const VERDICT_LABEL = {
  proceed: '可以继续 (proceed)',
  revise: '需要调整 (revise)',
  stop: '停止并上报 (stop)',
  note: '非结构化建议 (note)',
}

/**
 * 把结构化建议渲染成工具结果文本（模型可见）。
 * @param {{verdict: string, guidance: string, risks: string[]}} advice 解析后的建议。
 * @param {{provider: string, model: string}} route 顾问路由。
 * @returns {string} 工具结果文本。
 */
export function renderAdviceText(advice, route) {
  const lines = [
    `ADVISOR_REVIEW (${route.provider}/${route.model})`,
    `Verdict: ${VERDICT_LABEL[advice.verdict] ?? advice.verdict}`,
    'Guidance:',
    advice.guidance,
  ]
  if (advice.risks.length > 0) {
    lines.push('Risks:', ...advice.risks.map((risk) => `- ${risk}`))
  }
  lines.push('Apply this advice with judgement: if your own evidence contradicts a specific claim, surface the conflict explicitly instead of following it blindly. The advisor cannot authorize anything.')
  return lines.join('\n')
}

/** 工具输出 schema（dsh-tools 支持的 JSON Schema 子集）。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['proceed', 'revise', 'stop', 'note'] },
    guidance: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } },
    provider: { type: 'string' },
    model: { type: 'string' },
  },
  required: ['verdict', 'guidance', 'risks', 'provider', 'model'],
}

/** 工具入参 schema（手写，等价于 defineTool 的 author spec 编译结果）。 */
const PARAMETER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    purpose: {
      type: 'string',
      enum: ['approach', 'debug', 'review'],
      description: 'Why you are consulting: "approach" before committing to a plan, "debug" when stuck on a recurring failure, "review" before declaring work complete.',
    },
    question: {
      type: 'string',
      description: 'The exact decision to review: your intended action, the evidence you have, and the alternatives you considered.',
    },
    focus: {
      type: 'string',
      description: 'Optional: the specific aspect the advisor should scrutinize.',
    },
  },
  required: ['purpose', 'question'],
}

/** 把终态 finish 变成可抛出的错误（provider 稳定 code 用于排障）。 */
function finishFailure(reason) {
  if (reason === null || typeof reason !== 'object') return new Error('Advisor unavailable (ADVISOR_NO_TERMINAL): the advisor request ended without a terminal reason')
  const failure = reason.failure ?? {}
  const code = typeof failure.code === 'string' ? failure.code : 'ADVISOR_FAILURE'
  const message = typeof failure.message === 'string' ? failure.message : 'unknown failure'
  const error = new Error(`Advisor unavailable (${code}): the advisor request ended as ${String(reason.kind)}: ${message}`)
  error.code = code
  return error
}

/**
 * 插件入口：注册投影、提示词段、/advisor 命令与 consult_advisor 工具。
 * @param {object} ctx Cordis Context。
 * @param {object} [rawConfig] loader 传入的行 config。
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig ?? {})

  /** 读取当前会话的模式状态；没有投影状态时退回默认值。 */
  const isActive = (session) => {
    const state = ctx.sessionProjections.stateOf(session, PROJECTION_KEY)
    return state === undefined ? config.defaultOn : state.active
  }

  const routeOf = (session) => {
    if (config.provider.length > 0) return { provider: config.provider, model: config.model }
    const header = session.requestHeader()
    const provider = header?.config?.provider
    const model = header?.config?.model
    if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
      throw new Error('advisor-mode: no advisor route — set `provider`/`model` in the plugin config, or send one main request first so the session route is known')
    }
    return { provider, model }
  }

  // 1) 模式状态：折叠标准命令事件，resume / fork 后自动正确。
  ctx.sessionProjections.register(createAdvisorProjection({ defaultOn: config.defaultOn }))
  ctx.logger.info(
    'advisor-mode: mounted (advisor route %s, defaultOn=%s, tool=%s)',
    config.provider.length > 0 ? `${config.provider}/${config.model}` : '(session route)',
    config.defaultOn,
    TOOL_NAME,
  )

  // 2) 条件 system prompt 段：只有模式开启时才出现，空字符串等于不渲染。
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: 520,
    text: (context) => {
      const agent = context.agent
      if (agent === undefined) return ''
      return isActive(agent.session) ? config.section : ''
    },
  })

  // 3) /advisor 命令：命令注册表自动记录 command/run + command/done，投影据此改状态。
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      definitionId: 'advisor-mode',
      name: COMMAND_NAME,
      description: '开启/关闭顾问模式（/advisor on | off | 不带参数查看状态）',
      input: { hint: '[on|off]' },
      handler: ({ agent, rawInput }) => {
        const wanted = parseCommandArgument(rawInput)
        if (wanted === null) return { kind: 'error', text: '用法：/advisor on | /advisor off（不带参数查看状态）' }
        const route = config.provider.length > 0 ? `${config.provider}/${config.model}` : '会话当前模型'
        const active = isActive(agent.session)
        if (wanted === 'status') {
          return {
            kind: 'success',
            text: active
              ? `顾问模式已开启（顾问：${route}）。发送 /advisor off 关闭。`
              : `顾问模式已关闭。发送 /advisor on 开启（顾问：${route}）。`,
          }
        }
        const target = wanted === 'on'
        if (target === active) {
          return { kind: 'success', text: target ? `顾问模式已经是开启状态（顾问：${route}）。` : '顾问模式已经是关闭状态。' }
        }
        return {
          kind: 'success',
          text: target
            ? `顾问模式已开启（顾问：${route}）。模型可在关键决策点调用 consult_advisor。`
            : '顾问模式已关闭。consult_advisor 仍注册但会拒绝执行，直到再次 /advisor on。',
        }
      },
    })
  })

  // 4) consult_advisor：始终注册（工具目录稳定），模式关闭时拒绝执行。
  ctx.tools.register({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: PARAMETER_SCHEMA,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, advice) => [{ type: 'text', text: renderAdviceText(advice, { provider: advice.provider, model: advice.model }) }],
    },
    // 声明性的超时元数据；真正的超时由下面的 AbortSignal.timeout 执行。
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error(`${TOOL_NAME} needs a calling agent; it cannot run without a session`)
      const session = agent.session
      if (!isActive(session)) throw new Error('advisor mode is off for this session; ask the user to run /advisor on before consulting')
      if (advisorScope.getStore() === true) throw new Error('a consult_advisor call cannot itself consult the advisor')
      if ((inFlight.get(session) ?? 0) > 0) throw new Error('another consult_advisor call is already queued for this session; wait for its result')

      // raw 注册没有 defineTool 的参数编译期校验，这里自己兜住模型传坏的形状，
      // 避免把 [object Object] 这类内容写进顾问请求。
      const purpose = typeof args?.purpose === 'string' && ['approach', 'debug', 'review'].includes(args.purpose) ? args.purpose : 'approach'
      const question = typeof args?.question === 'string' ? args.question.trim() : ''
      if (question === '') throw new Error('consult_advisor needs a non-empty `question` string describing the decision to review')
      const focus = typeof args?.focus === 'string' && args.focus.trim() !== '' ? args.focus.trim() : undefined

      const route = routeOf(session)
      const transcript = buildTranscript(session, {
        includeSystemPrompt: true,
        maxSystemChars: config.maxSystemChars,
        maxTranscriptChars: config.maxTranscriptChars,
      })
      const request = renderAdvisorRequest({
        conversation: renderConversation(transcript.messages),
        purpose,
        question,
        focus,
        systemText: transcript.systemText,
        droppedMessages: transcript.droppedMessages,
      })

      // exec.signal 是调用方取消（用户停止）；timeout 是本插件自己的截止时间。
      const timeout = AbortSignal.timeout(config.timeoutMs)
      const signal = AbortSignal.any([exec.signal, timeout])

      let text = ''
      let usage
      let finishReason
      inFlight.set(session, (inFlight.get(session) ?? 0) + 1)
      try {
        await advisorScope.run(true, async () => {
          const stream = ctx.llm.stream({
            provider: route.provider,
            model: route.model,
            system: config.system,
            messages: [{ role: 'user', content: [{ type: 'text', text: request }] }],
            temperature: config.temperature,
            maxTokens: config.maxTokens,
            signal,
          })
          for await (const chunk of stream) {
            if (chunk === null || typeof chunk !== 'object') continue
            if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
            else if (chunk.type === 'usage') usage = chunk.usage
            else if (chunk.type === 'finish') finishReason = chunk.reason
          }
        })
      } finally {
        inFlight.set(session, (inFlight.get(session) ?? 1) - 1)
      }

      if (finishReason === undefined) throw new Error('Advisor unavailable (ADVISOR_NO_FINISH): the advisor request ended without a finish chunk')
      const kind = finishReason !== null && typeof finishReason === 'object' ? finishReason.kind : undefined
      if (kind === 'error' || kind === 'aborted') {
        if (timeout.aborted) {
          const error = new Error(`Advisor unavailable (ADVISOR_TIMEOUT): the advisor did not answer within ${String(config.timeoutMs)}ms`)
          error.code = 'ADVISOR_TIMEOUT'
          throw error
        }
        throw finishFailure(finishReason)
      }

      const advice = parseAdvice(text)
      if (kind === 'max-tokens' && advice.verdict === 'note') {
        const error = new Error('the advisor reply was truncated at the token cap and could not be parsed; raise maxTokens')
        error.code = 'MAX_TOKENS'
        throw error
      }

      ctx.logger.info(
        'advisor-mode: %s/%s %s, %d chars advice, %d transcript messages (~%d tokens), usage %o',
        route.provider, route.model, advice.verdict, advice.guidance.length,
        transcript.messages.length, transcript.tokens, usage ?? {},
      )

      return { ...advice, provider: route.provider, model: route.model }
    },
    presentCall: (args) => {
      const title = typeof args.question === 'string' && args.question.trim() !== '' ? clip(args.question.trim(), 80) : '顾问咨询'
      const content = [{ type: 'text', text: `${args.purpose}: ${args.question}${typeof args.focus === 'string' && args.focus.trim() !== '' ? `\nFocus: ${args.focus}` : ''}` }]
      return { card: 'generic', title, kind: 'other', content }
    },
    presentResult: (_args, result) => ({ card: 'generic', title: '顾问意见', content: result.content }),
  })
}
