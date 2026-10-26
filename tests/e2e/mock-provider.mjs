#!/usr/bin/env node
/**
 * 本地假 provider：OpenAI chat-completions 兼容的 SSE 流式服务（零依赖）。
 *
 * 目的：给 `dsh-advisor-mode` 的端到端验收提供一个「完全本地、不花钱」的模型端点。
 * DSH 的 llm-pi-ai 适配器通过官方 openai SDK 打 `POST {baseURL}/chat/completions`
 * （见 @earendil-works/pi-ai/dist/api/openai-completions.js 的 createClient/buildParams），
 * 所以这里用 node:http 手写标准 SSE 即可，无需任何三方依赖。
 *
 * 路由规则（按请求体里的 model 分派）：
 *   - model=mock-advisor：返回顾问回包文本
 *     {"verdict":"revise","guidance":"先补测试再改","risks":["数据丢失"]}
 *   - model=mock-main：
 *       * 请求里带了 consult_advisor 工具、且还没有任何 tool 结果 → 返回一次
 *         consult_advisor 工具调用（arguments 是合法 JSON，分两片流式下发，
 *         顺带验证 pi-ai 的 partialArgs 拼接）；
 *       * 请求里已经带了 tool 结果 → 返回最终文本，并记录收到的 tool 文本是否
 *         包含 ADVISOR_REVIEW（供 run-e2e.mjs 断言 d）；
 *       * 请求里没带 consult_advisor 工具（例如会话标题之类的主模型附属调用）→
 *         返回一段普通文本，不参与核心断言。
 *   - 其它 model：返回 404 + JSON 错误，并落盘记录（用于断言「没有意外路由」）。
 *
 * 所有请求（method/url/headers/body）与每个决定都会落到 --log-dir：
 *   req-NNN-<model>.json  原始请求
 *   decisions.jsonl       每个请求的路由决定
 *   summary.json          run-e2e 读的汇总（计数、最后一次 tool 结果等）
 *
 * 用法：
 *   node mock-provider.mjs --port 0 --log-dir /tmp/xxx/mock
 * 就绪后向 stdout 打印一行（机器可读）：
 *   MOCK_PROVIDER_READY {"port":54321}
 */

import { createServer } from 'node:http'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 顾问回包（插件 parseAdvice 要求一个 JSON 对象，verdict 必须在集合内）。 */
const ADVICE = {
  verdict: 'revise',
  guidance: '先补测试再改：当前改动缺少回归用例，建议补齐后再动实现。',
  risks: ['数据丢失'],
}

/** 主模型最终答复里的标记，run-e2e 用它断言 stdout 里拿到了最终文本。 */
const FINAL_TEXT = 'E2E_MOCK_FINAL: 已按顾问意见处理，先补测试再改实现。'

/** 主模型发起的 consult_advisor 调用的参数（分两片流式下发）。 */
const CONSULT_ARGUMENTS = JSON.stringify({
  purpose: 'approach',
  question: '我要直接改 lib/index.js 里 transcript 的裁剪逻辑，是否该先补回归测试？证据：单测已有覆盖、但没覆盖悬空 tool-call 场景；备选方案是先加断言不改实现。',
})
const CONSULT_ID = 'call_mock_advisor_1'

/** 单次进程内的观测状态。 */
const state = {
  seq: 0,
  requests: [],
  /** 结论：主模型第 1 次请求是否已是工具调用、第 2 次请求收到的 tool 文本等。 */
  mainToolCalls: 0,
  mainFinalCalls: 0,
  advisorCalls: 0,
  auxiliaryCalls: 0,
  unknownModelCalls: 0,
  /** 第 2 次主请求里收到的 tool 消息文本（用于断言 d）。 */
  toolResultText: null,
  toolCallIdSeen: null,
  /** 顾问请求里 system / user 的原文（用于断言 c）。 */
  advisorSystem: null,
  advisorUser: null,
  advisorHadTools: null,
}

/** 解析命令行参数。 */
function parseArgs(argv) {
  const parsed = { port: 0, logDir: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--port') parsed.port = Number(argv[index + 1])
    else if (arg === '--log-dir') parsed.logDir = argv[index + 1]
  }
  return parsed
}

const args = parseArgs(process.argv.slice(2))
if (!args.logDir) {
  process.stderr.write('mock-provider: --log-dir is required\n')
  process.exit(2)
}
const logDir = args.logDir
mkdirSync(logDir, { recursive: true })
const decisionsPath = join(logDir, 'decisions.jsonl')
const summaryPath = join(logDir, 'summary.json')

/** 追加一条路由决定（JSONL，便于排障）。 */
function recordDecision(entry) {
  appendFileSync(decisionsPath, `${JSON.stringify(entry)}\n`)
}

/** 把当前观测状态写盘（run-e2e 在进程结束后读取）。 */
function flushSummary() {
  writeFileSync(summaryPath, `${JSON.stringify(state, null, 2)}\n`)
}

/** 读取完整请求体（带体积上限，防止异常请求打爆内存）。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024 * 1024) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 发一条 SSE 事件。 */
function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

/** 组装一个 chat.completion.chunk。 */
function chunk(model, choices, extra = {}) {
  return {
    id: `chatcmpl-mock-${state.seq}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices,
    ...extra,
  }
}

/** 以 SSE 流式返回一段纯文本，并以 finish_reason=stop 收尾。 */
function streamText(res, model, text) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  sse(res, chunk(model, [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]))
  // 分两片下发文本，模拟真实流式。
  const middle = Math.max(1, Math.floor(text.length / 2))
  sse(res, chunk(model, [{ index: 0, delta: { content: text.slice(0, middle) }, finish_reason: null }]))
  sse(res, chunk(model, [{ index: 0, delta: { content: text.slice(middle) }, finish_reason: null }]))
  sse(res, chunk(model, [{ index: 0, delta: {}, finish_reason: 'stop' }]))
  sse(res, chunk(model, [], {
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  }))
  res.write('data: [DONE]\n\n')
  res.end()
}

/** 以 SSE 流式返回一次 consult_advisor 工具调用。 */
function streamToolCall(res, model) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  sse(res, chunk(model, [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]))
  // 工具调用参数分两片下发：验证 pi-ai 对 partialArgs 的增量拼接。
  const middle = Math.floor(CONSULT_ARGUMENTS.length / 2)
  sse(res, chunk(model, [{
    index: 0,
    delta: {
      tool_calls: [{
        index: 0,
        id: CONSULT_ID,
        type: 'function',
        function: { name: 'consult_advisor', arguments: CONSULT_ARGUMENTS.slice(0, middle) },
      }],
    },
    finish_reason: null,
  }]))
  sse(res, chunk(model, [{
    index: 0,
    delta: {
      tool_calls: [{ index: 0, function: { arguments: CONSULT_ARGUMENTS.slice(middle) } }],
    },
    finish_reason: null,
  }]))
  sse(res, chunk(model, [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]))
  sse(res, chunk(model, [], {
    usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 },
  }))
  res.write('data: [DONE]\n\n')
  res.end()
}

/** 取请求体里的工具名列表（OpenAI 形态：{type:'function', function:{name}}）。 */
function toolNames(body) {
  const tools = Array.isArray(body.tools) ? body.tools : []
  return tools.map((tool) => (tool && tool.type === 'function' && tool.function ? tool.function.name : undefined)).filter((name) => typeof name === 'string')
}

/** 判断请求是不是主模型的「工具目录请求」（带 consult_advisor 工具）。 */
function carriesConsultTool(body) {
  return toolNames(body).includes('consult_advisor')
}

/** 处理一次 chat-completions 请求。 */
async function handleCompletions(req, res, rawBody) {
  state.seq += 1
  const index = state.seq
  let body
  try {
    body = JSON.parse(rawBody)
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'mock-provider: request body is not JSON' } }))
    return
  }

  const model = typeof body.model === 'string' ? body.model : '(missing)'
  const safeModel = model.replace(/[^a-zA-Z0-9._-]/gu, '_')
  const fileName = `req-${String(index).padStart(3, '0')}-${safeModel}.json`
  writeFileSync(join(logDir, fileName), `${JSON.stringify({
    method: req.method,
    url: req.url,
    headers: req.headers,
    body,
  }, null, 2)}\n`)

  const messages = Array.isArray(body.messages) ? body.messages : []

  if (model === 'mock-advisor') {
    state.advisorCalls += 1
    const system = messages.find((message) => message && message.role === 'system')
    const user = messages.find((message) => message && message.role === 'user')
    state.advisorSystem = typeof system?.content === 'string' ? system.content : JSON.stringify(system?.content ?? null)
    state.advisorUser = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content ?? null)
    state.advisorHadTools = Array.isArray(body.tools) && body.tools.length > 0
    recordDecision({ index, file: fileName, model, route: 'advisor', advisorHadTools: state.advisorHadTools })
    flushSummary()
    streamText(res, model, JSON.stringify(ADVICE))
    return
  }

  if (model === 'mock-main') {
    const toolMessages = messages.filter((message) => message && message.role === 'tool')
    if (!carriesConsultTool(body)) {
      // 附属调用（例如会话标题生成）：返回普通文本，不参与核心断言。
      state.auxiliaryCalls += 1
      recordDecision({ index, file: fileName, model, route: 'auxiliary', tools: toolNames(body) })
      flushSummary()
      streamText(res, model, 'E2E mock auxiliary response')
      return
    }
    if (toolMessages.length === 0) {
      state.mainToolCalls += 1
      recordDecision({ index, file: fileName, model, route: 'main-tool-call' })
      flushSummary()
      streamToolCall(res, model)
      return
    }
    state.mainFinalCalls += 1
    const toolMessage = toolMessages[toolMessages.length - 1]
    state.toolResultText = typeof toolMessage.content === 'string' ? toolMessage.content : JSON.stringify(toolMessage.content)
    state.toolCallIdSeen = typeof toolMessage.tool_call_id === 'string' ? toolMessage.tool_call_id : null
    recordDecision({ index, file: fileName, model, route: 'main-final', hasAdvisorReview: /ADVISOR_REVIEW/u.test(state.toolResultText ?? '') })
    flushSummary()
    streamText(res, model, FINAL_TEXT)
    return
  }

  state.unknownModelCalls += 1
  recordDecision({ index, file: fileName, model, route: 'unknown-model' })
  flushSummary()
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: { message: `mock-provider: no route for model "${model}"`, type: 'invalid_request_error' } }))
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      const url = req.url ?? '/'
      if (req.method === 'GET' && /\/models(?:\?.*)?$/u.test(url)) {
        // 模型发现接口：某些启动路径会探测它。返回我们声明的两个模型即可。
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          object: 'list',
          data: [
            { id: 'mock-main', object: 'model', owned_by: 'mock' },
            { id: 'mock-advisor', object: 'model', owned_by: 'mock' },
          ],
        }))
        return
      }
      if (req.method === 'POST' && /\/chat\/completions(?:\?.*)?$/u.test(url)) {
        const rawBody = await readBody(req)
        await handleCompletions(req, res, rawBody)
        return
      }
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `mock-provider: unsupported ${req.method} ${url}` } }))
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: String(error?.stack ?? error) } }))
      } else {
        res.end()
      }
    }
  })()
})

server.listen(args.port, '127.0.0.1', () => {
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : args.port
  flushSummary()
  process.stdout.write(`MOCK_PROVIDER_READY ${JSON.stringify({ port })}\n`)
})

/** 收到信号时先落盘再退出，避免 run-e2e 读到半截证据。 */
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    flushSummary()
    server.close(() => process.exit(0))
    // 兜底：连接未关闭时也尽快退出。
    setTimeout(() => process.exit(0), 1000).unref()
  })
}
