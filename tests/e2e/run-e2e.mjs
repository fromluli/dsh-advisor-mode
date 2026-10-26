#!/usr/bin/env node
/**
 * dsh-advisor-mode 端到端验收（完全本地、零成本、不碰用户 ~/.dsh）。
 *
 * 一条命令：
 *   node tests/e2e/run-e2e.mjs
 *
 * 流程：
 *   1. 在独立的 DSH_HOME（默认 /tmp/dsh-advisor-e2e-home）里初始化 headless profile；
 *   2. 启动本地 mock provider（tests/e2e/mock-provider.mjs，OpenAI chat-completions
 *      兼容 SSE，mock-main / mock-advisor 两个模型）；
 *   3. 把 profile 的 cordis.patch.yml 改成：llm-pi-ai 指向 mock、默认模型 mock-main、
 *      插入本插件的绝对路径行（advisor 路由 = e2e-mock/mock-advisor，defaultOn=true）；
 *   4. 跑 `dsh --profile headless "任务"`；mock-main 第一次被请求时返回一次
 *      consult_advisor 工具调用 —— 插件应该带着 transcript 去问 mock-advisor，
 *      再把顾问回包渲染成工具结果回给主模型；
 *   5. 断言 0/a–g（见 checks 列表），打印中文 PASS/FAIL 清单并落盘证据；
 *   6. 负向对照：同一套 mock/任务但 profile 不插插件行，证明正向断言不是假阳性。
 *
 * 全程不联网、不发真实模型请求；mock provider 的临时请求体全部落在
 * $DSH_HOME/artifacts 下供回查。
 *
 * 环境变量（都可选）：
 *   DSH_CLI           覆盖 DSH CLI 路径（默认 Desktop 安装路径）
 *   DSH_E2E_HOME      覆盖临时 DSH_HOME（默认 /tmp/dsh-advisor-e2e-home）
 *   DSH_E2E_TIMEOUT_MS headless 进程超时（默认 180000）
 */

import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
/** 被测插件的入口（绝对路径，profile patch 以此插入插件行）。 */
const PLUGIN_ENTRY = join(REPO_ROOT, 'lib', 'index.js')
/** mock provider 脚本。 */
const MOCK_SCRIPT = join(HERE, 'mock-provider.mjs')
/** Desktop 版 DSH CLI（可用 DSH_CLI 覆盖）。 */
const CLI = process.env.DSH_CLI ?? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
/** 隔离的 DSH_HOME：每次运行前整个删除重建，绝不碰用户 ~/.dsh。 */
const DSH_HOME = process.env.DSH_E2E_HOME ?? '/tmp/dsh-advisor-e2e-home'

/**
 * 破坏性清理前的路径护栏：本脚本会 `rm -rf` 这个目录，`DSH_E2E_HOME` 误设成
 * `~/.dsh` 之类就会删掉真实 profile / sessions / local.db。只允许临时目录下的路径，
 * 且拒绝 home 本身或其中任何 `.dsh` 目录。
 * @param {string} candidate
 * @returns {string} 规范化后的绝对路径
 */
function assertDisposableHome(candidate) {
  const resolved = resolve(candidate)
  const roots = [tmpdir(), '/tmp', '/private/tmp', '/var/tmp'].map((root) => resolve(root))
  const underTemp = roots.some((root) => resolved === root || resolved.startsWith(root + sep))
  const home = resolve(homedir())
  const insideHome = resolved === home || resolved.startsWith(home + sep)
  const mentionsDsh = /(^|[\\/])\.dsh([\\/]|$)/.test(resolved)
  if (!underTemp || insideHome || mentionsDsh) {
    throw new Error(
      `拒绝在 ${resolved} 上做 rm -rf：E2E 只清理临时目录（DSH_E2E_HOME 必须在 ${tmpdir()} 或 /tmp 之下，且不能位于 home 目录或任何 .dsh 内）`,
    )
  }
  return resolved
}
/** headless 进程超时。 */
const TIMEOUT_MS = Number(process.env.DSH_E2E_TIMEOUT_MS ?? 180_000)
/** mock provider 使用的假 API key（经 apiKeyEnv 注入，只为让 OpenAI SDK 带 Authorization 头）。 */
const MOCK_API_KEY = 'e2e-mock-key'
/** mock provider 里给主模型的最终答复标记（断言 e 用它确认 stdout 拿到最终文本）。 */
const FINAL_MARKER = 'E2E_MOCK_FINAL'
/** 顾问回包内容（与 mock-provider.mjs 的 ADVICE 保持一致，断言 d 用）。 */
const ADVICE_MARKERS = ['ADVISOR_REVIEW', 'revise', '先补测试再改', '数据丢失']
/** 触发顾问模式的任务文本。 */
const TASK = '请评估：我要直接改 lib/index.js 的 transcript 裁剪逻辑，是否应该先补回归测试？'

const WORK_DIR = join(DSH_HOME, 'work')
const ARTIFACTS_DIR = join(DSH_HOME, 'artifacts')
const PROFILE_DIR = join(DSH_HOME, 'profiles', 'headless')
const PATCH_PATH = join(PROFILE_DIR, 'cordis.patch.yml')

/** 逐条断言结果。 */
const checks = []
/** 补充观测（不计入 PASS/FAIL，只写进报告）。 */
const notes = []

/** 记一条断言结果。fn 通过抛错表示失败。 */
function check(id, title, fn) {
  try {
    const detail = fn()
    checks.push({ id, title, pass: true, detail: detail ?? '' })
    return true
  } catch (error) {
    checks.push({ id, title, pass: false, detail: String(error?.message ?? error) })
    return false
  }
}

/** 打印一行日志（带前缀，方便和断言清单区分）。 */
function log(message) {
  process.stdout.write(`[e2e] ${message}\n`)
}

/** 启动子进程并收集输出；超时则 SIGKILL。 */
function runProcess(command, args, options) {
  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolvePromise({ code: null, signal: null, stdout: '', stderr: String(error), timedOut: false, spawnError: error })
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)
    child.stdout.on('data', (data) => { stdout += data })
    child.stderr.on('data', (data) => { stderr += data })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ code: null, signal: null, stdout, stderr, timedOut, spawnError: error })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolvePromise({ code, signal, stdout, stderr, timedOut })
    })
  })
}

/** 启动 mock provider，等它打印就绪行，返回 { child, port }。 */
function startMockProvider(logDir) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [MOCK_SCRIPT, '--port', '0', '--log-dir', logDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buffered = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      rejectPromise(new Error(`mock provider 在 20s 内没有就绪；stderr=${stderr.trim()}`))
    }, 20_000)
    child.stdout.on('data', (data) => {
      buffered += data
      const match = /MOCK_PROVIDER_READY (\{.*\})/u.exec(buffered)
      if (match === null || settled) return
      settled = true
      clearTimeout(timer)
      try {
        const { port } = JSON.parse(match[1])
        resolvePromise({ child, port })
      } catch (error) {
        rejectPromise(error)
      }
    })
    child.stderr.on('data', (data) => { stderr += data })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectPromise(error)
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectPromise(new Error(`mock provider 提前退出（code=${code}）；stderr=${stderr.trim()}`))
    })
  })
}

/** 结束 mock provider（SIGTERM，等 3s 再强杀）。 */
async function stopMockProvider(child) {
  if (child === null || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolvePromise) => child.once('exit', resolvePromise))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 3_000)
  await exited
  clearTimeout(timer)
}

/** 读取 mock 目录下所有请求记录（按文件序号排序）。 */
function readMockRequests(mockDir) {
  if (!existsSync(mockDir)) return []
  const files = readdirSync(mockDir)
    .filter((name) => /^req-\d+-.+\.json$/u.test(name))
    .sort()
  return files.map((file) => {
    const record = JSON.parse(readFileSync(join(mockDir, file), 'utf8'))
    return { file, headers: record.headers ?? {}, body: record.body ?? {} }
  })
}

/** 判断一次请求是否带 consult_advisor 工具（= 主模型的工具目录请求）。 */
function carriesConsultTool(body) {
  const tools = Array.isArray(body.tools) ? body.tools : []
  return tools.some((tool) => tool?.type === 'function' && tool?.function?.name === 'consult_advisor')
}

/** 生成 profile patch（YAML 文本）。外面对齐 DSH 的 patch-layer 语义：
 *  - 带 id 的条目覆盖已有插件的 config（config 整段替换，不深合并）；
 *  - insert 追加新插件行；
 *  - name 必须与既有插件名一致（作断言用途）。 */
function renderProfilePatch(mockPort, options = {}) {
  const { includeAdvisor = true } = options
  // 负向对照用：不插插件行，其余配置完全一致。
  const advisorRow = includeAdvisor
    ? `
- insert:
    - id: advisor-mode
      name: '${PLUGIN_ENTRY}'
      config:
        provider: e2e-mock
        model: mock-advisor
        defaultOn: true
`
    : ''
  return `# 由 tests/e2e/run-e2e.mjs 生成：E2E 验收专用 profile patch 层（不要提交/手改）。
# 作用：把 llm 路由指到本地 mock provider${includeAdvisor ? '，并插入 dsh-advisor-mode 插件' : '（负向对照：故意不插插件）'}。
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      e2e-mock:
        displayName: E2E Mock Provider
        api: openai-completions
        baseURL: http://127.0.0.1:${mockPort}/v1
        apiKeyEnv: DSH_E2E_MOCK_KEY
        models:
          - id: mock-main
            name: Mock Main
            contextWindow: 65536
            maxTokens: 4096
            input: [ text ]
          - id: mock-advisor
            name: Mock Advisor
            contextWindow: 65536
            maxTokens: 4096
            input: [ text ]
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: e2e-mock
    model: mock-main
# 会话标题生成会额外打一次主模型请求，会干扰「第 1/2 次主请求」的断言，关掉。
- id: session-title-llm
  name: '@deepseek-ai/dsh-session-title-first-prompt-llm'
  disabled: true
# 关掉 OTEL 导出，保证整条链路不联网。
- id: otel
  name: '@deepseek-ai/dsh-otel'
  disabled: true
- id: session-telemetry-otel
  name: '@deepseek-ai/dsh-session-telemetry-otel'
  disabled: true${advisorRow}`
}

/**
 * 负向对照：同样的 mock provider、同样的任务，但 profile 里**不插入**插件行。
 * 预期：system 里没有 ADVISOR_MODE、tools 里没有 consult_advisor、顾问模型 0 次请求。
 * 这一步用来证明正向断言 a/b/c 的 PASS 来自插件，而不是 mock 环境的巧合。
 * @returns {Promise<{run: object, requests: object[]}>} 负向对照的运行结果与请求记录。
 */
async function runNegativeControl() {
  const negativeHome = `${DSH_HOME}-negative`
  const negativeWork = join(negativeHome, 'work')
  const negativeMockDir = join(ARTIFACTS_DIR, 'mock-negative')
  assertDisposableHome(negativeHome)
  rmSync(negativeHome, { recursive: true, force: true })
  mkdirSync(negativeWork, { recursive: true })
  mkdirSync(negativeMockDir, { recursive: true })

  log('负向对照：初始化无插件的 headless profile…')
  const init = await runProcess(CLI, ['--profile', 'headless', '--dump-config'], {
    cwd: negativeWork,
    env: { ...process.env, DSH_HOME: negativeHome },
    timeoutMs: 120_000,
  })
  writeFileSync(join(ARTIFACTS_DIR, 'dump-config-initial-negative.yml'), init.stdout + init.stderr)
  if (init.code !== 0) throw new Error(`负向对照 profile 初始化失败（code=${init.code}）：${init.stderr.slice(-1500)}`)

  const negativeMock = await startMockProvider(negativeMockDir)
  try {
    const patchPath = join(negativeHome, 'profiles', 'headless', 'cordis.patch.yml')
    const patchText = renderProfilePatch(negativeMock.port, { includeAdvisor: false })
    writeFileSync(patchPath, patchText)
    writeFileSync(join(ARTIFACTS_DIR, 'profile-patch-negative.yml'), patchText)

    const dump = await runProcess(CLI, ['--profile', 'headless', '--dump-config'], {
      cwd: negativeWork,
      env: { ...process.env, DSH_HOME: negativeHome, DSH_E2E_MOCK_KEY: MOCK_API_KEY },
      timeoutMs: 120_000,
    })
    writeFileSync(join(ARTIFACTS_DIR, 'dump-config-patched-negative.yml'), dump.stdout + dump.stderr)
    if (dump.code !== 0) throw new Error(`负向对照 dump-config 失败（code=${dump.code}）：${dump.stderr.slice(-1500)}`)
    if (dump.stdout.includes('advisor-mode')) throw new Error('负向对照的 composed config 里仍出现了 advisor-mode 行')

    log('负向对照：运行 headless 会话（应当完全没有顾问链路）…')
    const run = await runProcess(CLI, ['--profile', 'headless', TASK], {
      cwd: negativeWork,
      env: {
        ...process.env,
        DSH_HOME: negativeHome,
        DSH_E2E_MOCK_KEY: MOCK_API_KEY,
        DSH_TELEMETRY_MODE: 'off',
      },
      timeoutMs: TIMEOUT_MS,
    })
    writeFileSync(join(ARTIFACTS_DIR, 'headless-negative.stdout.log'), run.stdout)
    writeFileSync(join(ARTIFACTS_DIR, 'headless-negative.stderr.log'), run.stderr)
    return { run, requests: readMockRequests(negativeMockDir) }
  } finally {
    await stopMockProvider(negativeMock.child)
  }
}

/** 主流程。 */
async function main() {
  const startedAt = new Date().toISOString()
  log(`DSH CLI: ${CLI}`)
  log(`DSH_HOME: ${DSH_HOME}`)
  log(`插件入口: ${PLUGIN_ENTRY}`)

  // 0) 先校验 home 可安全清理，再做任何写盘（前置检查、初始化都会写文件）。
  assertDisposableHome(DSH_HOME)

  // 0.1) 前置检查：CLI / 插件 / mock 脚本都在。
  if (!existsSync(CLI)) {
    throw new Error(`找不到 DSH CLI：${CLI}（可用 DSH_CLI 覆盖）`)
  }
  if (!existsSync(PLUGIN_ENTRY)) {
    throw new Error(`找不到插件入口：${PLUGIN_ENTRY}`)
  }
  if (!existsSync(MOCK_SCRIPT)) {
    throw new Error(`找不到 mock provider 脚本：${MOCK_SCRIPT}`)
  }

  // 1) 全新临时 DSH_HOME（绝不碰用户 ~/.dsh）。
  assertDisposableHome(DSH_HOME)
  rmSync(DSH_HOME, { recursive: true, force: true })
  mkdirSync(WORK_DIR, { recursive: true })
  mkdirSync(ARTIFACTS_DIR, { recursive: true })
  const mockDir = join(ARTIFACTS_DIR, 'mock')
  mkdirSync(mockDir, { recursive: true })

  // 2) 初始化 headless profile（dump-config 会按模板生成 profile 目录）。
  log('初始化 headless profile…')
  const init = await runProcess(CLI, ['--profile', 'headless', '--dump-config'], {
    cwd: WORK_DIR,
    env: { ...process.env, DSH_HOME },
    timeoutMs: 120_000,
  })
  writeFileSync(join(ARTIFACTS_DIR, 'dump-config-initial.yml'), init.stdout + init.stderr)
  if (init.code !== 0 || !existsSync(PATCH_PATH)) {
    throw new Error(`headless profile 初始化失败（code=${init.code}）：${(init.stderr || init.stdout).slice(-2000)}`)
  }

  let mock = null
  let headless = null
  try {
    // 3) 启动 mock provider。
    log('启动本地 mock provider…')
    mock = await startMockProvider(mockDir)
    log(`mock provider 就绪：http://127.0.0.1:${mock.port}/v1`)

    // 4) 写 profile patch，并用 dump-config 预检组合结果（插件行/provider 真的进了树）。
    writeFileSync(PATCH_PATH, renderProfilePatch(mock.port))
    writeFileSync(join(ARTIFACTS_DIR, 'profile-patch.yml'), renderProfilePatch(mock.port))
    log('预检组合后的 profile 配置…')
    const dump = await runProcess(CLI, ['--profile', 'headless', '--dump-config'], {
      cwd: WORK_DIR,
      env: { ...process.env, DSH_HOME, DSH_E2E_MOCK_KEY: MOCK_API_KEY },
      timeoutMs: 120_000,
    })
    writeFileSync(join(ARTIFACTS_DIR, 'dump-config-patched.yml'), dump.stdout + dump.stderr)
    check('0', '组合配置预检：patch 后 profile 树里有 e2e-mock provider 与 advisor-mode 插件行', () => {
      if (dump.code !== 0) throw new Error(`dump-config 退出码 ${dump.code}：${dump.stderr.slice(-2000)}`)
      const composed = dump.stdout
      // provider 段：llm-pi-ai 的 providers dict 里有 e2e-mock 与两个 mock 模型。
      for (const needle of ['e2e-mock:', '- id: mock-main', '- id: mock-advisor', 'api: openai-completions']) {
        if (!composed.includes(needle)) throw new Error(`组合后的配置里缺少 "${needle}"`)
      }
      // 默认模型：agent-default-model 走 mock-main。
      const defaultModelIndex = composed.indexOf('- id: agent-default-model')
      if (defaultModelIndex === -1) throw new Error('组合后的配置里没有 agent-default-model 行')
      const defaultModelBlock = composed.slice(defaultModelIndex, defaultModelIndex + 400)
      if (!defaultModelBlock.includes('provider: e2e-mock') || !defaultModelBlock.includes('model: mock-main')) {
        throw new Error(`agent-default-model 没有指到 e2e-mock/mock-main：\n${defaultModelBlock}`)
      }
      // 插件行：插入成功，且顾问路由/开关在 config 里。
      const advisorIndex = composed.indexOf('- id: advisor-mode')
      if (advisorIndex === -1) throw new Error('组合后的配置里没有 advisor-mode 插件行（insert 没生效）')
      const advisorBlock = composed.slice(advisorIndex, advisorIndex + 500)
      for (const needle of ['e2e-mock', 'mock-advisor', 'defaultOn: true']) {
        if (!advisorBlock.includes(needle)) throw new Error(`advisor-mode 行的 config 里缺少 "${needle}"：\n${advisorBlock}`)
      }
      return 'e2e-mock provider / mock-main 默认模型 / advisor-mode 插件行都在 composed config 里'
    })

    // 5) 跑 headless 会话。
    log('运行 headless 会话（mock-main → consult_advisor → mock-advisor → 最终答复）…')
    headless = await runProcess(CLI, ['--profile', 'headless', TASK], {
      cwd: WORK_DIR,
      env: {
        ...process.env,
        DSH_HOME,
        DSH_E2E_MOCK_KEY: MOCK_API_KEY,
        // 明确压住遥测，保证零联网。
        DSH_TELEMETRY_MODE: 'off',
      },
      timeoutMs: TIMEOUT_MS,
    })
    writeFileSync(join(ARTIFACTS_DIR, 'headless.stdout.log'), headless.stdout)
    writeFileSync(join(ARTIFACTS_DIR, 'headless.stderr.log'), headless.stderr)
    writeFileSync(join(ARTIFACTS_DIR, 'headless.meta.json'), `${JSON.stringify({
      cli: CLI,
      task: TASK,
      exitCode: headless.code,
      signal: headless.signal,
      timedOut: headless.timedOut,
      startedAt,
      finishedAt: new Date().toISOString(),
    }, null, 2)}\n`)
    if (headless.spawnError !== undefined) {
      throw new Error(`headless 进程启动失败：${headless.spawnError}`)
    }
  } finally {
    // 6) 先停 mock（让它把 summary 落盘），再读证据。
    await stopMockProvider(mock?.child ?? null)
  }

  // 7) 读 mock 落盘的请求，逐条断言。
  const requests = readMockRequests(mockDir)
  const mainToolRequests = requests.filter((request) => request.body.model === 'mock-main' && carriesConsultTool(request.body))
  const advisorRequests = requests.filter((request) => request.body.model === 'mock-advisor')
  const unknownRequests = requests.filter((request) => request.body.model !== 'mock-main' && request.body.model !== 'mock-advisor')
  const auxiliaryRequests = requests.filter((request) => request.body.model === 'mock-main' && !carriesConsultTool(request.body))

  let summary = {}
  if (existsSync(join(mockDir, 'summary.json'))) {
    summary = JSON.parse(readFileSync(join(mockDir, 'summary.json'), 'utf8'))
  }

  check('a', '主请求的 system 里含 ADVISOR_MODE（模式段生效）', () => {
    if (mainToolRequests.length === 0) throw new Error(`没有收到带 consult_advisor 的主模型请求；已收到：${requests.map((r) => r.file).join(', ') || '（空）'}`)
    const first = mainToolRequests[0]
    const messages = Array.isArray(first.body.messages) ? first.body.messages : []
    const system = messages.find((message) => message?.role === 'system' || message?.role === 'developer')
    if (system === undefined) throw new Error(`主请求里没有 system/developer 消息（roles=${messages.map((m) => m?.role).join(',')}）`)
    const systemText = typeof system.content === 'string' ? system.content : JSON.stringify(system.content)
    if (!systemText.includes('ADVISOR_MODE')) throw new Error('system 里没有 ADVISOR_MODE 标记')
    if (!systemText.includes('Advisor mode is on for this session')) throw new Error('system 里的 ADVISOR_MODE 段落不是插件的默认引导文本')
    return `${first.file}：system ${systemText.length} 字符，含 ADVISOR_MODE 段`
  })

  check('b', '主请求的 tools 目录里有 consult_advisor（工具注册生效）', () => {
    if (mainToolRequests.length === 0) throw new Error('没有主模型工具目录请求')
    const tools = Array.isArray(mainToolRequests[0].body.tools) ? mainToolRequests[0].body.tools : []
    const tool = tools.find((item) => item?.type === 'function' && item?.function?.name === 'consult_advisor')
    if (tool === undefined) throw new Error(`tools 里没有 consult_advisor；实际工具：${tools.map((item) => item?.function?.name ?? '?').join(',')}`)
    const properties = Object.keys(tool.function.parameters?.properties ?? {})
    for (const required of ['purpose', 'question']) {
      if (!properties.includes(required)) throw new Error(`consult_advisor 参数里缺少 ${required}`)
    }
    if (typeof tool.function.description !== 'string' || tool.function.description.length === 0) throw new Error('consult_advisor 没有 description')
    return `tools 共 ${tools.length} 个；consult_advisor 参数 ${properties.join('/')}`
  })

  check('c', '顾问请求：模型= mock-advisor，system 是顾问提示词，user 含完整 transcript + question，且不带 tools', () => {
    if (advisorRequests.length === 0) throw new Error('mock-advisor 一次都没被请求（插件没有发起顾问请求）')
    if (advisorRequests.length !== 1) throw new Error(`顾问请求应恰好 1 次，实际 ${advisorRequests.length} 次（可能重试或重复咨询）`)
    const { body, file } = advisorRequests[0]
    const messages = Array.isArray(body.messages) ? body.messages : []
    const system = messages.find((message) => message?.role === 'system')
    const user = messages.find((message) => message?.role === 'user')
    if (system === undefined) throw new Error('顾问请求里没有 system 消息')
    if (user === undefined) throw new Error('顾问请求里没有 user 消息')
    const systemText = typeof system.content === 'string' ? system.content : JSON.stringify(system.content)
    const userText = typeof user.content === 'string' ? user.content : JSON.stringify(user.content)
    if (!systemText.includes('senior engineering advisor')) throw new Error('顾问 system 不是插件的默认顾问提示词')
    if (!systemText.includes('"verdict":"proceed|revise|stop"')) throw new Error('顾问 system 里缺少 JSON 回包契约')
    for (const needle of ['CONSULTATION', 'Purpose: approach', 'Question:', '--- CONVERSATION ---', '--- END CONVERSATION ---', '### user']) {
      if (!userText.includes(needle)) throw new Error(`顾问 user 文本缺少 "${needle}"`)
    }
    // transcript 里必须能看到主会话的任务文本（说明不是空转）。
    if (!userText.includes(TASK)) throw new Error('顾问 user 文本里没有主会话的任务文本（transcript 不完整）')
    if (Array.isArray(body.tools) && body.tools.length > 0) throw new Error(`顾问请求不应携带 tools；实际 ${body.tools.length} 个（递归防护第一层）`)
    if (body.temperature !== 0.2) throw new Error(`顾问请求 temperature 应为 0.2，实际 ${body.temperature}`)
    const maxTokens = body.max_completion_tokens ?? body.max_tokens
    if (!(Number.isInteger(maxTokens) && maxTokens > 0)) throw new Error(`顾问请求没有传 max tokens；实际 ${String(maxTokens)}`)
    return `${file}：system ${systemText.length} 字符（顾问提示词）、user ${userText.length} 字符（transcript+question）、无 tools、temperature=${body.temperature}、max_tokens=${maxTokens}`
  })

  check('d', '主模型第二次请求收到的 tool 结果含 ADVISOR_REVIEW / revise / 顾问原话，且与 tool_call_id 对齐', () => {
    if (mainToolRequests.length < 2) throw new Error(`主模型工具目录请求应 ≥2 次（发工具调用 + 收顾问结果），实际 ${mainToolRequests.length} 次`)
    const second = mainToolRequests[1]
    const messages = Array.isArray(second.body.messages) ? second.body.messages : []
    const assistantCalls = messages
      .filter((message) => message?.role === 'assistant')
      .flatMap((message) => Array.isArray(message.tool_calls) ? message.tool_calls : [])
      .filter((call) => call?.function?.name === 'consult_advisor')
    if (assistantCalls.length === 0) throw new Error('第二次主请求的 assistant 历史里没有 consult_advisor 工具调用')
    const callId = assistantCalls[assistantCalls.length - 1].id
    const toolMessages = messages.filter((message) => message?.role === 'tool')
    if (toolMessages.length === 0) throw new Error('第二次主请求里没有 tool 结果消息（工具结果没有回到主模型）')
    const toolMessage = toolMessages[toolMessages.length - 1]
    if (toolMessage.tool_call_id !== callId) throw new Error(`tool 结果与工具调用不对齐：tool_call_id=${String(toolMessage.tool_call_id)} vs ${String(callId)}`)
    const content = typeof toolMessage.content === 'string' ? toolMessage.content : JSON.stringify(toolMessage.content)
    for (const needle of ADVICE_MARKERS) {
      if (!content.includes(needle)) throw new Error(`tool 结果里缺少 "${needle}"；实际内容：${content.slice(0, 400)}`)
    }
    if (!content.includes('Verdict:')) throw new Error('tool 结果里缺少 Verdict 行')
    return `${second.file}：tool_call_id=${callId}，tool 结果 ${content.length} 字符，含 ${ADVICE_MARKERS.join(' / ')}`
  })

  check('e', 'headless 进程退出码 0，且 stdout 拿到主模型的最终答复', () => {
    if (headless === null) throw new Error('headless 进程未运行')
    if (headless.timedOut) throw new Error(`headless 超时（${TIMEOUT_MS}ms）被强杀`)
    if (headless.code !== 0) throw new Error(`headless 退出码 ${headless.code}（signal=${String(headless.signal)}）；stderr 末尾：${headless.stderr.slice(-1500)}`)
    if (!headless.stdout.includes(FINAL_MARKER)) throw new Error(`stdout 里没有最终答复标记 ${FINAL_MARKER}；stdout=${headless.stdout.slice(0, 500)}`)
    return `退出码 0，stdout 含 ${FINAL_MARKER}；stderr ${headless.stderr.length} 字符`
  })

  check('f', '没有意外路由：0 个未知模型请求、0 个主模型附属请求，主工具请求恰好 2 次', () => {
    if (unknownRequests.length > 0) throw new Error(`收到未知模型请求：${unknownRequests.map((r) => r.body.model).join(',')}`)
    if (mainToolRequests.length !== 2) throw new Error(`主模型工具目录请求应恰好 2 次，实际 ${mainToolRequests.length} 次`)
    if (advisorRequests.length !== 1) throw new Error(`顾问请求应恰好 1 次，实际 ${advisorRequests.length} 次`)
    if (auxiliaryRequests.length > 0) notes.push(`主模型还收到 ${auxiliaryRequests.length} 次不带 consult_advisor 的附属请求：${auxiliaryRequests.map((r) => r.file).join(', ')}`)
    if (summary.toolResultText !== null && typeof summary.toolResultText === 'string' && summary.toolResultText.includes('ADVISOR_REVIEW')) {
      notes.push('mock 侧记录：主模型最终请求里确实看到了 ADVISOR_REVIEW 工具结果（hasAdvisorReview=true）')
    }
    return `共 ${requests.length} 次请求：主工具请求 ${mainToolRequests.length}、顾问请求 ${advisorRequests.length}、未知模型 ${unknownRequests.length}`
  })

  // 8) 负向对照：去掉插件行后，顾问链路必须整体消失（证明正向断言不是假阳性）。
  let negative = null
  try {
    negative = await runNegativeControl()
  } catch (error) {
    negative = { setupError: error }
  }
  check('g', '负向对照：摘掉插件行后 system 无 ADVISOR_MODE、tools 无 consult_advisor、顾问模型 0 次请求', () => {
    if (negative.setupError !== undefined) throw new Error(`负向对照跑不起来：${String(negative.setupError?.message ?? negative.setupError)}`)
    const { run, requests: negativeRequests } = negative
    if (run.code !== 0) throw new Error(`负向对照 headless 退出码 ${run.code}；stderr：${run.stderr.slice(-1200)}`)
    const systemRequest = negativeRequests.find((request) => {
      const messages = Array.isArray(request.body.messages) ? request.body.messages : []
      return messages.some((message) => message?.role === 'system')
    })
    if (systemRequest === undefined) throw new Error('负向对照没有收到主模型请求')
    const systemMessages = systemRequest.body.messages.filter((message) => message?.role === 'system')
    const systemText = systemMessages.map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content))).join('\n')
    if (systemText.includes('ADVISOR_MODE')) throw new Error('没装插件时 system 里仍有 ADVISOR_MODE —— 正向断言 a 可能是假阳性')
    for (const request of negativeRequests) {
      const names = (Array.isArray(request.body.tools) ? request.body.tools : []).map((tool) => tool?.function?.name)
      if (names.includes('consult_advisor')) throw new Error(`没装插件时 tools 里仍有 consult_advisor（${request.file}）`)
    }
    const advisorCalls = negativeRequests.filter((request) => request.body.model === 'mock-advisor')
    if (advisorCalls.length > 0) throw new Error(`没装插件时仍有 ${advisorCalls.length} 次 mock-advisor 请求`)
    if (!run.stdout.includes('E2E mock auxiliary')) throw new Error(`负向对照 stdout 不是 mock 的普通答复：${run.stdout.slice(0, 300)}`)
    return `无插件：主模型请求 ${negativeRequests.length} 次、system 无 ADVISOR_MODE、tools 无 consult_advisor、mock-advisor 0 次；退出码 0`
  })

  notes.push(`全部请求落盘：${mockDir}`)

  // 9) 打印报告 + 落盘。
  return { startedAt, requests, mainToolRequests, advisorRequests, unknownRequests, auxiliaryRequests, headless, summary }
}

/** 打印中文 PASS/FAIL 清单。 */
function printReport(result, error) {
  const passCount = checks.filter((item) => item.pass).length
  const total = checks.length
  const lines = []
  lines.push('')
  lines.push('=== dsh-advisor-mode E2E 验收（本地 mock provider + headless 会话）===')
  lines.push(`DSH_HOME: ${DSH_HOME}`)
  lines.push(`DSH CLI : ${CLI}`)
  lines.push('')
  for (const item of checks) {
    lines.push(`${item.pass ? 'PASS' : 'FAIL'}  (${item.id}) ${item.title}`)
    if (item.detail !== '') lines.push(`      ${item.detail.replace(/\n/gu, '\n      ')}`)
  }
  lines.push('')
  for (const note of notes) lines.push(`INFO  ${note}`)
  if (error !== undefined) {
    lines.push('')
    lines.push(`ERROR 验收流程本身失败：${String(error?.stack ?? error)}`)
  }
  lines.push('')
  lines.push(`结果：${passCount}/${total} PASS${passCount === total && error === undefined ? ' —— 顾问模式端到端生效' : ''}`)
  lines.push('')
  lines.push('证据文件：')
  lines.push(`  profile patch      ${join(ARTIFACTS_DIR, 'profile-patch.yml')}`)
  lines.push(`  组合后的配置       ${join(ARTIFACTS_DIR, 'dump-config-patched.yml')}`)
  lines.push(`  headless stdout    ${join(ARTIFACTS_DIR, 'headless.stdout.log')}`)
  lines.push(`  headless stderr    ${join(ARTIFACTS_DIR, 'headless.stderr.log')}`)
  lines.push(`  mock 请求体        ${join(ARTIFACTS_DIR, 'mock')}`)
  lines.push(`  负向对照请求体     ${join(ARTIFACTS_DIR, 'mock-negative')}`)
  lines.push(`  报告               ${join(ARTIFACTS_DIR, 'report.txt')}`)
  const text = `${lines.join('\n')}\n`
  try {
    // 报告也只写进可清理的临时 home；home 非法时（例如用户把 DSH_E2E_HOME 指到 ~/.dsh）
    // 宁可只在控制台输出，也绝不往真实目录里新建文件。
    assertDisposableHome(DSH_HOME)
    mkdirSync(ARTIFACTS_DIR, { recursive: true })
    writeFileSync(join(ARTIFACTS_DIR, 'report.txt'), text)
    writeFileSync(join(ARTIFACTS_DIR, 'report.json'), `${JSON.stringify({
      checks,
      notes,
      error: error === undefined ? null : String(error?.stack ?? error),
      requests: result?.requests?.map((request) => request.file) ?? [],
    }, null, 2)}\n`)
  } catch {
    // 报告写盘失败不影响控制台输出。
  }
  process.stdout.write(text)
  return passCount === total && error === undefined
}

let result = null
let failure = null
try {
  result = await main()
} catch (error) {
  failure = error
  process.stderr.write(`\ndsh-advisor-mode E2E: 流程失败：${String(error?.stack ?? error)}\n`)
}
const ok = printReport(result, failure ?? undefined)
process.exit(ok ? 0 : 1)
