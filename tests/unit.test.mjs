/**
 * Advisor Mode 纯函数单元测试（node --test）。
 *
 * 这些测试不启动 DSH、不需要模型：lib/index.js 是零依赖 ESM，
 * 直接 import 就能测配置校验、状态折叠、transcript 清洗/截断与回包解析。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_SECTION,
  DEFAULT_SYSTEM,
  PROJECTION_KEY,
  PROJECTION_VERSION,
  buildTranscript,
  createAdvisorProjection,
  parseAdvice,
  parseCommandArgument,
  renderAdviceText,
  renderAdvisorRequest,
  renderConversation,
  resolveConfig,
  roughTokens,
} from '../lib/index.js'

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

test('resolveConfig: 默认值完整且冻结', () => {
  const config = resolveConfig({ provider: 'acme', model: 'gpt-6.1-sol' })
  assert.equal(config.provider, 'acme')
  assert.equal(config.model, 'gpt-6.1-sol')
  assert.equal(config.defaultOn, true)
  assert.equal(config.section, DEFAULT_SECTION)
  assert.equal(config.system, DEFAULT_SYSTEM)
  assert.equal(config.maxTranscriptChars, 80_000)
  assert.equal(config.maxSystemChars, 12_000)
  assert.equal(config.maxTokens, 3_000)
  assert.equal(config.temperature, 0.2)
  assert.equal(config.timeoutMs, 180_000)
  assert.ok(Object.isFrozen(config))
})

test('resolveConfig: provider/model 必须成对', () => {
  assert.throws(() => resolveConfig({ provider: 'acme' }), /set both `provider` and `model`/)
  assert.throws(() => resolveConfig({ model: 'gpt-6.1-sol' }), /set both `provider` and `model`/)
  // 都不给 = 复用会话当前路由，允许。
  assert.equal(resolveConfig({}).provider, '')
})

test('resolveConfig: 未知键 / 非法值报错', () => {
  assert.throws(() => resolveConfig({ provider: 'acme', model: 'm', unknownKey: 1 }), /unknown config key/)
  assert.throws(() => resolveConfig({ defaultOn: 'yes' }), /`defaultOn` must be a boolean/)
  assert.throws(() => resolveConfig({ maxTokens: 0 }), /`maxTokens` must be a positive integer/)
  assert.throws(() => resolveConfig({ timeoutMs: -1 }), /`timeoutMs` must be a positive integer/)
  assert.throws(() => resolveConfig({ section: '   ' }), /`section` must be a non-empty string/)
  assert.throws(() => resolveConfig({ temperature: -0.1 }), /`temperature` must be a finite number in \[0, 2\]/)
  assert.throws(() => resolveConfig({ temperature: 5 }), /`temperature` must be a finite number in \[0, 2\]/)
  assert.throws(() => resolveConfig({ maxTranscriptChars: 10_000_000 }), /`maxTranscriptChars` must be <= 2000000/)
})

// ---------------------------------------------------------------------------
// /advisor 参数
// ---------------------------------------------------------------------------

test('parseCommandArgument: 归一化参数', () => {
  assert.equal(parseCommandArgument(undefined), 'status')
  assert.equal(parseCommandArgument(''), 'status')
  assert.equal(parseCommandArgument('  status '), 'status')
  assert.equal(parseCommandArgument('ON'), 'on')
  assert.equal(parseCommandArgument('enable'), 'on')
  assert.equal(parseCommandArgument('off'), 'off')
  assert.equal(parseCommandArgument('disable'), 'off')
  assert.equal(parseCommandArgument('maybe'), null)
  assert.equal(parseCommandArgument(42), null)
})

// ---------------------------------------------------------------------------
// 模式状态投影
// ---------------------------------------------------------------------------

const run = (args, commandId = 'c1') => ({ type: 'command/run', data: { name: 'advisor', args, commandId } })
const done = (kind, commandId = 'c1') => ({ type: 'command/done', data: { commandId, kind } })

test('投影: 默认值来自 defaultOn', () => {
  const definition = createAdvisorProjection({ defaultOn: true })
  assert.equal(definition.key, PROJECTION_KEY)
  assert.equal(definition.stateVersion, PROJECTION_VERSION)
  assert.deepEqual(definition.init({}, 0), { active: true, running: null })
  assert.equal(createAdvisorProjection({ defaultOn: false }).init({}, 0).active, false)
})

test('投影: /advisor off 成功后才提交', () => {
  const definition = createAdvisorProjection({ defaultOn: true })
  let state = definition.init({}, 0)
  state = definition.apply(state, run('off'))
  assert.equal(state.active, true, 'run 阶段只是意图，不能提前翻转')
  assert.deepEqual(state.running, { commandId: 'c1', wanted: false })
  state = definition.apply(state, done('success'))
  assert.equal(state.active, false)
  assert.equal(state.running, null)
})

test('投影: 命令失败/非法参数不翻转状态', () => {
  const definition = createAdvisorProjection({ defaultOn: true })
  let state = definition.apply(definition.init({}, 0), run('off'))
  state = definition.apply(state, done('error'))
  assert.equal(state.active, true)

  let status = definition.apply(definition.init({}, 0), run(''))
  assert.deepEqual(status.running, null, '/advisor 不带参数是查状态，不应改写状态')

  let invalid = definition.apply(definition.init({}, 0), run('maybe'))
  assert.deepEqual(invalid.running, null)
})

test('投影: 无关事件返回同一引用', () => {
  const definition = createAdvisorProjection({ defaultOn: true })
  const state = definition.init({}, 0)
  assert.equal(definition.apply(state, { type: 'user/message', data: {} }), state)
  assert.equal(definition.apply(state, { type: 'command/done', data: { commandId: 'other', kind: 'success' } }), state)
})

test('投影: stateSchema.parse 能修复/校验持久化行', () => {
  const definition = createAdvisorProjection({ defaultOn: true })
  assert.deepEqual(definition.stateSchema.parse({ active: false, running: null }), { active: false, running: null })
  assert.deepEqual(definition.stateSchema.parse(null), { active: true, running: null })
  assert.deepEqual(definition.stateSchema.parse({ active: 'x', running: { commandId: 1 } }), { active: true, running: null })
})

// ---------------------------------------------------------------------------
// transcript
// ---------------------------------------------------------------------------

/** 构造一个最小 Session 替身：只实现 deriveMessages()。 */
function fakeSession(messages) {
  return { deriveMessages: () => messages }
}

const text = (value) => [{ type: 'text', text: value }]

test('buildTranscript: 抽出 system、丢弃 developer、清理悬空 tool-call', () => {
  const session = fakeSession([
    { role: 'system', content: text('SYSTEM RULES') },
    { role: 'developer', content: text('tool catalog update') },
    { role: 'user', content: text('帮我重构这个模块') },
    { role: 'assistant', content: [...text('先看代码'), { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"a.js"}' }] },
    { role: 'tool', toolCallId: 'call-1', content: text('file body') },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call-2', name: 'consult_advisor', arguments: '{"question":"?"}' }] },
  ])

  const transcript = buildTranscript(session, { maxTranscriptChars: 10_000 })
  assert.match(transcript.systemText, /SYSTEM RULES/)
  assert.deepEqual(transcript.messages.map((message) => message.role), ['user', 'assistant', 'tool', 'assistant'])
  // developer 已丢弃
  assert.ok(transcript.messages.every((message) => message.role !== 'developer'))
  // 悬空 tool-call 被换成文本说明
  const last = transcript.messages.at(-1)
  assert.ok(last.content.some((block) => block.type === 'text' && /tool call was started here/.test(block.text)))
  assert.ok(!last.content.some((block) => block.type === 'tool-call'))
  assert.ok(transcript.tokens > 0)
})

test('buildTranscript: 孤儿 tool 结果被丢弃', () => {
  const session = fakeSession([
    { role: 'tool', toolCallId: 'lost', content: text('orphan') },
    { role: 'user', content: text('hi') },
  ])
  const transcript = buildTranscript(session)
  assert.deepEqual(transcript.messages.map((message) => message.role), ['user'])
})

test('buildTranscript: 超预算时保留任务锚点 + 最近上下文', () => {
  const filler = (index) => ({ role: 'user', content: text(`message-${index} ` + 'x'.repeat(200)) })
  const session = fakeSession([
    { role: 'user', content: text('ANCHOR 任务目标') },
    ...Array.from({ length: 30 }, (_, index) => filler(index)),
    { role: 'assistant', content: text('LATEST ANSWER') },
  ])
  const transcript = buildTranscript(session, { maxTranscriptChars: 2_000 })
  assert.ok(transcript.messages.length < 31)
  assert.equal(transcript.messages[0].content[0].text, 'ANCHOR 任务目标')
  assert.equal(transcript.messages.at(-1).content[0].text, 'LATEST ANSWER')
  assert.ok(transcript.droppedMessages > 0)
})

test('buildTranscript: system prompt 可裁剪、可关闭', () => {
  const session = fakeSession([
    { role: 'system', content: text('S'.repeat(500)) },
    { role: 'user', content: text('hi') },
  ])
  assert.equal(buildTranscript(session, { maxSystemChars: 100 }).systemText.length < 200, true)
  const without = buildTranscript(session, { includeSystemPrompt: false })
  assert.equal(without.systemText, '')
  assert.ok(without.messages.every((message) => message.role !== 'system'))
})

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

test('renderConversation: 角色标注 + 工具调用/结果/错误', () => {
  const rendered = renderConversation([
    { role: 'user', content: text('请审查这个方案') },
    { role: 'assistant', content: [...text('我的计划是 A'), { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' }] },
    { role: 'tool', toolCallId: 'c1', isError: true, content: text('boom') },
  ])
  assert.match(rendered, /### user\n请审查这个方案/)
  assert.match(rendered, /### assistant\n我的计划是 A\n\[calls bash \{"command":"ls"\}\]/)
  assert.match(rendered, /### tool result \(error\)\nboom/)
})

test('renderAdvisorRequest: 必含片段齐全', () => {
  const request = renderAdvisorRequest({
    conversation: '### user\nhello',
    purpose: 'approach',
    question: '要不要现在就删表？',
    focus: '数据迁移顺序',
    systemText: 'MAIN RULES',
    droppedMessages: 3,
  })
  assert.match(request, /MAIN_AGENT_SYSTEM_PROMPT \(context only/)
  assert.match(request, /Purpose: approach/)
  assert.match(request, /Question: 要不要现在就删表？/)
  assert.match(request, /Focus: 数据迁移顺序/)
  assert.match(request, /3 earliest message\(s\) were omitted/)
  assert.match(request, /--- CONVERSATION ---\n\n### user\nhello\n\n--- END CONVERSATION ---/)
  assert.match(request, /\{"verdict":"proceed\|revise\|stop"/)
})

// ---------------------------------------------------------------------------
// 回包解析
// ---------------------------------------------------------------------------

test('parseAdvice: 纯 JSON / 代码围栏 / 夹带说明', () => {
  const expected = { verdict: 'revise', guidance: '先补迁移脚本', risks: ['数据丢失'] }
  assert.deepEqual(parseAdvice(JSON.stringify(expected)), expected)
  assert.deepEqual(parseAdvice('```json\n' + JSON.stringify(expected) + '\n```'), expected)
  assert.deepEqual(parseAdvice('我会这样建议：\n' + JSON.stringify(expected) + '\n以上。'), expected)
})

test('parseAdvice: 非法 JSON 退回纯文本建议（不丢内容）', () => {
  const advice = parseAdvice('建议先跑测试再合并，注意回滚路径。')
  assert.equal(advice.verdict, 'note')
  assert.match(advice.guidance, /先跑测试/)
  assert.deepEqual(advice.risks, [])
})

test('parseAdvice: 空回包抛错、risks 被过滤与限量', () => {
  assert.throws(() => parseAdvice('   '), /returned no text/)
  const advice = parseAdvice(JSON.stringify({ verdict: 'stop', guidance: '别动', risks: ['a', 42, '  ', 'b'] }))
  assert.equal(advice.verdict, 'stop')
  assert.deepEqual(advice.risks, ['a', 'b'])
})

test('renderAdviceText: 结论/建议/风险/冲突提示', () => {
  const rendered = renderAdviceText({ verdict: 'revise', guidance: '先补测试', risks: ['数据丢失'] }, { provider: 'acme', model: 'gpt-6.1-sol' })
  assert.match(rendered, /ADVISOR_REVIEW \(acme\/gpt-6\.1-sol\)/)
  assert.match(rendered, /需要调整 \(revise\)/)
  assert.match(rendered, /先补测试/)
  assert.match(rendered, /- 数据丢失/)
  assert.match(rendered, /surface the conflict explicitly/)
})

test('roughTokens: 随内容单调增长', () => {
  const small = roughTokens([{ role: 'user', content: text('hi') }])
  const large = roughTokens([{ role: 'user', content: text('hi'.repeat(400)) }])
  assert.ok(large > small)
})

test('buildTranscript: droppedMessages 只统计因预算裁剪的对话消息（回归 P1）', () => {
  // system 单独投喂、developer 直接丢弃，都不应算成「顾问少看了上下文」。
  const session = fakeSession([
    { role: 'system', content: text('SYSTEM') },
    { role: 'developer', content: text('tool catalog') },
    { role: 'user', content: text('问题') },
    { role: 'assistant', content: text('回答') },
  ])
  const roomy = buildTranscript(session, { maxTranscriptChars: 80_000 })
  assert.equal(roomy.droppedMessages, 0)
  assert.equal(roomy.systemText, 'SYSTEM')

  const tiny = buildTranscript(session, { maxTranscriptChars: 60 })
  assert.ok(tiny.droppedMessages > 0)
  // 渲染给顾问的请求里，只有真的裁了才出现「omitted」提示。
  const withRoom = renderAdvisorRequest({
    conversation: renderConversation(roomy.messages),
    purpose: 'approach',
    question: '要不要动？',
    systemText: roomy.systemText,
    droppedMessages: roomy.droppedMessages,
  })
  assert.ok(!/were omitted to fit the budget/.test(withRoom))
})
