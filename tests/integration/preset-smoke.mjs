#!/usr/bin/env node
/**
 * 集成冒烟：把本包真的装进一个**临时 DSH home** 的 web profile，启动 web 应用，
 * 用真实的 agentPresets RPC 确认「顾问模式」这个 preset 被注册且没有 broken。
 *
 * 为什么不碰 ~/.dsh/profiles/desktop：
 *   desktop profile 归 Electron 应用独占，普通 CLI 会拒绝；这里用 DSH_HOME 指向
 *   mkdtemp 出来的临时目录，初始化一个一次性 web profile，装完即毁。
 *
 * 用法：
 *   node tests/integration/preset-smoke.mjs             # 正常跑，结束清理
 *   node tests/integration/preset-smoke.mjs --keep      # 保留临时 home 与日志方便排障
 *   node tests/integration/preset-smoke.mjs --cli /path/to/dsh
 *
 * 退出码 0 = 全部 PASS；1 = 有 FAIL（打印每项与证据路径）。
 */

import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = resolve(HERE, '..', '..')
const DEFAULT_CLI = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'

const args = process.argv.slice(2)
const keep = args.includes('--keep')
const cliIndex = args.indexOf('--cli')
const cli = cliIndex === -1 ? DEFAULT_CLI : args[cliIndex + 1]

/** 断言收集器。 */
const results = []
function check(name, passed, detail = '') {
  results.push({ name, passed, detail })
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

/** 同步跑一条 CLI 命令（初始化/安装），失败直接抛。 */
function runCli(home, cliArgs, label) {
  const result = spawnSync(cli, cliArgs, {
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
    timeout: 240_000,
  })
  if (result.status !== 0) {
    throw new Error(`${label} 失败（exit ${String(result.status)}）\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
  return result
}

/** 轮询等待 web 应用就绪，返回 { child, baseURL, token, logs }。 */
async function bootWeb(home, port, logPath) {
  writeFileSync(logPath, '')
  const child = spawn(cli, ['web', '--port', String(port), '--no-open'], {
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const record = (chunk) => {
    const text = String(chunk)
    output += text
    appendFileSync(logPath, text)
  }
  child.stdout.on('data', record)
  child.stderr.on('data', record)
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const match = /dsh web: (http:\/\/[^\s]+)/.exec(output)
    if (match !== null) {
      const url = new URL(match[1])
      return { child, baseURL: url.origin, token: url.searchParams.get('token') ?? '', logPath, output }
    }
    if (child.exitCode !== null) throw new Error(`web 进程提前退出（code ${String(child.exitCode)}）\n${output}`)
    await new Promise((done) => setTimeout(done, 500))
  }
  child.kill('SIGTERM')
  throw new Error(`web 应用 90s 内没有打印监听地址\n${output}`)
}

/** 带会话 cookie 的 RPC 调用。 */
async function rpc(baseURL, token, cookieJar, method, argsObject = {}) {
  const auth = await fetch(`${baseURL}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  const setCookie = auth.headers.get('set-cookie')
  if (setCookie !== null) cookieJar.cookie = setCookie.split(';', 1)[0]
  const rpcId = randomUUID()
  const response = await fetch(`${baseURL}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookieJar.cookie === undefined ? {} : { cookie: cookieJar.cookie }) },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: argsObject } }),
  })
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`)
  const envelope = await response.json()
  const result = envelope?.result
  if (result?.ok !== true) throw new Error(`${method}: ${JSON.stringify(result?.error ?? envelope).slice(0, 500)}`)
  return result.value
}

const home = mkdtempSync(join(tmpdir(), 'dsh-advisor-smoke-'))
const port = 62000 + Math.floor(Math.random() * 500)
let child
let failed

try {
  console.log(`临时 DSH_HOME: ${home}`)
  console.log(`CLI: ${cli}`)
  check('desktop CLI 存在', existsSync(cli), cli)
  check('本包 package.json 声明了 bundle patch', JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')).dsh?.bundle?.patch === './cordis.patch.yml')

  // 1) 初始化一次性 web profile（--dump-config 会自动从模板初始化）
  runCli(home, ['--profile', 'web', '--dump-config'], '初始化 web profile')
  const profileDir = join(home, 'profiles', 'web')
  check('临时 profile 已初始化', existsSync(join(profileDir, 'package.json')), profileDir)

  // 2) 安装本包
  runCli(home, ['plugin', '--profile', 'web', 'add', PACKAGE_DIR], '安装 dsh-advisor-mode')
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  check(
    'profile 依赖里出现 dsh-advisor-mode',
    typeof manifest.dependencies?.['dsh-advisor-mode'] === 'string',
    String(manifest.dependencies?.['dsh-advisor-mode']),
  )
  check(
    'profile bundles 末尾追加了 dsh-advisor-mode',
    Array.isArray(manifest.dsh?.profile?.bundles) && manifest.dsh.profile.bundles.at(-1) === 'dsh-advisor-mode',
    JSON.stringify(manifest.dsh?.profile?.bundles),
  )

  // 3) 组合后的配置树里能看到 preset 与我们的插件行
  const dump = runCli(home, ['--profile', 'web', '--dump-config'], 'dump 组合配置').stdout
  check('组合树含 preset-advisor', /id: preset-advisor/.test(dump))
  check('组合树含 advisor-mode 行', /id: advisor-mode/.test(dump))
  check('组合树含 config.id advisor', /config:\s*\n\s*id: advisor\b/.test(dump), '')

  // 4) 启动 web 应用，用真实 RPC 看 preset 列表
  const logs = join(home, 'web.stdout.log')
  let token
  ;({ child, token } = await bootWeb(home, port, logs))
  check('web 应用已监听', token !== '', `http://127.0.0.1:${port}`)

  const cookieJar = {}
  const listed = await rpc(`http://127.0.0.1:${port}`, token, cookieJar, 'agentPresets/list')
  const presets = Array.isArray(listed?.presets) ? listed.presets : []
  const advisor = presets.find((preset) => preset.id === 'advisor')
  check('agentPresets/list 里有 advisor', advisor !== undefined, JSON.stringify(presets.map((preset) => preset.id)))
  check('advisor 显示名为「顾问模式」', advisor?.name === '顾问模式', String(advisor?.name))
  check('advisor 没有被标记 broken（插件已在 preset 树里真正启动）', advisor !== undefined && advisor.broken === undefined, String(advisor?.broken ?? ''))

  const read = await rpc(`http://127.0.0.1:${port}`, token, cookieJar, 'agentPresets/read', { agentPreset: 'advisor' })
  const yaml = typeof read === 'string' ? read : JSON.stringify(read)
  check('agentPresets/read 能读出顾问模式插件名', /dsh-advisor-mode/.test(yaml))
  check('agentPresets/read 保留 consult_advisor 所属插件行', /id: advisor-mode/.test(yaml))
} catch (error) {
  failed = error
  console.error(`\nERROR: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  if (child !== undefined && child.exitCode === null) {
    child.kill('SIGTERM')
    await new Promise((done) => setTimeout(done, 1_000))
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  const failures = results.filter((item) => !item.passed)
  if (keep) console.log(`\n保留了临时 DSH_HOME：${home}`)
  else rmSync(home, { recursive: true, force: true })
  console.log(`\n${results.length - failures.length}/${results.length} 项通过`)
  if (failed !== undefined || failures.length > 0) process.exitCode = 1
}
