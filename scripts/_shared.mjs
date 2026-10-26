/**
 * _shared.mjs —— install / rollback / verify 三个脚本共用的小工具。
 *
 * 这里刻意只放「找路径、跑命令、备份、解析参数」这类薄逻辑，不带业务判断：
 * 每个脚本自己保留完整的检查流程，读脚本的人不必来回跳文件。
 *
 * 注意：本包声明零 dependencies，所以这里只用 node 内置模块。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, copyFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

/** 本仓库根目录（scripts/ 的上一级）。 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** DSH 桌面应用默认路径。 */
export const DEFAULT_APP = '/Applications/DeepSeek Harness.app'
/** 桌面 CLI 在应用内的相对路径。 */
const CLI_REL = 'Contents/Resources/runtime/cli/bin/dsh'
/** profile 里值得一起备份的文件（按需存在才备份）。 */
const BACKUP_FILES = ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml']
/** 备份目录名前缀。 */
export const BACKUP_PREFIX = 'advisor-mode-'

/**
 * 打印带标签的说明行。
 * @param {string} tag
 * @param {string} message
 */
export function log(tag, message) {
  console.log(`[${tag}] ${message}`)
}

/**
 * 打印错误并退出。
 * @param {string} tag
 * @param {string} message
 * @param {number} [code]
 * @returns {never}
 */
export function fail(tag, message, code = 1) {
  console.error(`\n[${tag}] 失败：${message}\n`)
  process.exit(code)
}

/**
 * 极简参数解析：`--key value` 与 `--flag`，未知参数/缺值都直接报错（避免拼错后静默按默认值跑）。
 * @param {string[]} argv
 * @param {{values?: Record<string, string>, booleans?: string[], tag: string}} spec
 *   values 里同时提供默认值；booleans 是纯开关。
 * @returns {Record<string, string | boolean>}
 */
export function parseArgs(argv, spec) {
  const values = spec.values ?? {}
  const booleans = new Set(['help', ...(spec.booleans ?? [])])
  // 先铺上默认值：调用方拿到的一定是「默认值 + 命令行覆盖」的完整对象。
  /** @type {Record<string, string | boolean>} */
  const out = { ...values }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) fail(spec.tag, `无法识别的参数：${token}（参数都以 -- 开头）`, 2)
    const key = token.slice(2)
    if (booleans.has(key)) {
      out[key] = true
      continue
    }
    if (!(key in values)) {
      const known = [...Object.keys(values), ...booleans].map((name) => `--${name}`).join(' ')
      fail(spec.tag, `未知参数：--${key}\n可用参数：${known}`, 2)
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) fail(spec.tag, `参数 --${key} 缺少取值`, 2)
    out[key] = value
    i += 1
  }
  return out
}

/**
 * 解析 DSH home。优先级：--home → $DSH_HOME → ~/.dsh（与 dsh 自身一致）。
 * @param {Record<string, string | boolean>} args
 * @returns {string}
 */
export function resolveHome(args) {
  if (typeof args.home === 'string' && args.home.trim() !== '') return resolve(process.cwd(), args.home)
  if (process.env.DSH_HOME) return resolve(process.env.DSH_HOME)
  return join(homedir(), '.dsh')
}

/**
 * profile 里的文件名（提到大括号里方便统一改）。
 * @param {string} home
 * @param {string} profile
 */
export function profilePaths(home, profile) {
  const dir = join(home, 'profiles', profile)
  return {
    home,
    profile,
    dir,
    manifest: join(dir, 'package.json'),
    patch: join(dir, 'cordis.patch.yml'),
    modules: join(dir, 'node_modules'),
    backups: join(dir, 'backups'),
  }
}

/**
 * 找 DSH 桌面 CLI，找不到返回 undefined（给 verify 这种「不该因为缺 CLI 就退出」的场景用）。
 * 顺序：--cli → $DSH_DESKTOP_CLI → <app>/Contents/Resources/runtime/cli/bin/dsh
 * @param {Record<string, string | boolean>} args
 * @returns {string | undefined}
 */
export function findDesktopCli(args) {
  if (typeof args.cli === 'string' && args.cli.trim() !== '') {
    const cli = resolve(process.cwd(), args.cli)
    return existsSync(cli) ? cli : undefined
  }
  if (process.env.DSH_DESKTOP_CLI) {
    const cli = resolve(process.env.DSH_DESKTOP_CLI)
    return existsSync(cli) ? cli : undefined
  }
  const app = typeof args.app === 'string' && args.app.trim() !== '' ? resolve(process.cwd(), args.app) : DEFAULT_APP
  const cli = join(app, CLI_REL)
  return existsSync(cli) ? cli : undefined
}

/**
 * 定位 DSH 桌面 CLI（普通 PATH 上的 dsh 会拒绝 desktop profile，必须用应用自带的这个）。
 * @param {Record<string, string | boolean>} args
 * @param {string} tag
 * @returns {string}
 */
export function resolveDesktopCli(args, tag) {
  const cli = findDesktopCli(args)
  if (cli === undefined) {
    const app = typeof args.app === 'string' && args.app.trim() !== '' ? resolve(process.cwd(), args.app) : DEFAULT_APP
    fail(
      tag,
      [
        `找不到 DSH 桌面版 CLI：${join(app, CLI_REL)}`,
        '普通 PATH 上的 dsh 会拒绝 desktop profile，必须用应用自带的这个入口。',
        '如果 DSH 装在别处：用 --app 指定 .app 路径，或用 --cli 直接指定 CLI 文件。',
      ].join('\n'),
    )
  }
  return cli
}

/**
 * 执行子进程并边跑边转发输出（同时留一份完整文本，便于失败时报告原始 stderr）。
 * @param {string} command
 * @param {string[]} args
 * @param {{env?: NodeJS.ProcessEnv, cwd?: string, quiet?: boolean}} [options]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
export function runCaptured(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    /** @type {import('node:child_process').ChildProcess} */
    let child
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolvePromise({ code: -1, stdout: '', stderr: String(error) })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
      if (!options.quiet) process.stdout.write(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
      if (!options.quiet) process.stderr.write(chunk)
    })
    child.on('error', (error) => {
      resolvePromise({ code: -1, stdout, stderr: `${stderr}\n[spawn error] ${error.message}` })
    })
    child.on('close', (code) => {
      resolvePromise({ code: code ?? -1, stdout, stderr })
    })
  })
}

/**
 * 读 JSON；不存在或解析失败返回 undefined。
 * @param {string} path
 * @returns {any | undefined}
 */
export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 读文本；不存在返回 undefined。
 * @param {string} path
 * @returns {string | undefined}
 */
export function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** 形如 20261026-190333 的本地时间戳，用于备份目录名。 */
export function timestamp() {
  const now = new Date()
  const p2 = (value) => String(value).padStart(2, '0')
  return (
    `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}` +
    `-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`
  )
}

/**
 * 把 profile 的 package.json / cordis.patch.yml / pnpm-lock.yaml 备份到
 * `<profile>/backups/advisor-mode-<时间戳><label>/`。
 *
 * `label` 用于区分「还原前自动留的那一份」（`-pre-restore`）：它绝不能参与
 * `--restore-last` 的「最近一次」选择，否则第二次还原会把它选中、把第一次还原撤销。
 * @param {{dir: string, manifest: string, patch: string, backups: string}} paths
 * @param {string} tag
 * @param {string} [label] 备份目录名后缀（如 '-pre-restore'）
 * @returns {{dir: string | null, files: string[]}}
 */
export function backupProfile(paths, tag, label = '') {
  if (!existsSync(paths.dir)) return { dir: null, files: [] }
  const present = BACKUP_FILES.map((name) => join(paths.dir, name)).filter((file) => existsSync(file))
  if (present.length === 0) return { dir: null, files: [] }
  const dir = join(paths.backups, `${BACKUP_PREFIX}${timestamp()}${label}`)
  mkdirSync(dir, { recursive: true })
  for (const file of present) copyFileSync(file, join(dir, baseName(file)))
  log(tag, `已备份 ${present.length} 个文件到 ${dir}`)
  return { dir, files: present.map((file) => baseName(file)) }
}

/** @param {string} path */
function baseName(path) {
  return path.slice(path.lastIndexOf('/') + 1)
}

/**
 * 列出 profile 下的顾问模式备份，按时间从新到旧。
 * @param {string} backupsDir
 * @returns {string[]} 备份目录的绝对路径
 */
export function listBackups(backupsDir) {
  if (!existsSync(backupsDir)) return []
  return readdirSync(backupsDir)
    .filter((name) => name.startsWith(BACKUP_PREFIX))
    .filter((name) => {
      try {
        return statSync(join(backupsDir, name)).isDirectory()
      } catch {
        return false
      }
    })
    .sort()
    .reverse()
    .map((name) => join(backupsDir, name))
}

/**
 * 交互确认。非 TTY（CI/管道）且没传 --yes 时直接报错，避免脚本卡住等输入。
 * @param {string} question
 * @param {boolean} yes
 * @param {string} tag
 * @returns {Promise<void>}
 */
export async function confirm(question, yes, tag) {
  if (yes) return
  if (!process.stdin.isTTY) {
    fail(tag, '当前不是交互式终端：请加 --yes 明确授权，或先用 --dry-run 看计划。', 2)
  }
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase()
    if (answer !== 'y' && answer !== 'yes') {
      log(tag, '已取消，未做任何修改。')
      process.exit(0)
    }
  } finally {
    rl.close()
  }
}

/**
 * 跑一次桌面 CLI 的 --version（安静模式），失败返回 undefined。
 * @param {string} cli
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<string | undefined>}
 */
export async function dshVersion(cli, env) {
  const result = await runCaptured(cli, ['--version'], { env, quiet: true })
  if (result.code !== 0) return undefined
  return result.stdout.trim().split('\n').pop()?.trim()
}
