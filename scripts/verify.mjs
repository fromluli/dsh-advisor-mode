#!/usr/bin/env node
/**
 * verify.mjs —— 只读体检：确认「顾问模式」是否真的装好、组合得对。
 *
 * 全部检查都不写文件（唯一例外是它自己 spawn 一次 `sync-preset.mjs --check`，那是纯内存比对）。
 * 输出 PASS / WARN / FAIL 清单 + 下一步建议；有任何 FAIL 时退出码 1。
 *
 * 用法：
 *   node scripts/verify.mjs
 *   node scripts/verify.mjs --profile desktop
 *   node scripts/verify.mjs --profile web --home /tmp/advisor-mode-testhome
 *
 * 退出码：0 全部通过（允许 WARN）；1 有 FAIL；2 参数/环境问题。
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  REPO_ROOT,
  dshVersion,
  fail,
  listBackups,
  parseArgs,
  profilePaths,
  readJson,
  readText,
  findDesktopCli,
  resolveHome,
  runCaptured,
} from './_shared.mjs'

const TAG = 'verify'
const HERE = dirname(fileURLToPath(import.meta.url))

const HELP = `只读体检顾问模式是否装好

用法：
  node scripts/verify.mjs [--profile desktop] [--home <DSH_HOME>] [--app <应用路径>] [--cli <CLI 路径>]

选项：
  --profile  要检查的 profile，默认 desktop
  --home     DSH home，默认 $DSH_HOME 或 ~/.dsh
  --app      DSH 桌面应用路径（用来读版本），默认 /Applications/DeepSeek Harness.app
  --cli      直接指定桌面版 CLI 文件
  --help     显示本帮助
`

// ── 结果收集 ──────────────────────────────────────────────────────────
/** @typedef {'PASS'|'WARN'|'FAIL'|'SKIP'} Status */
/** @type {{status: Status, label: string, detail?: string}[]} */
const results = []
/** @param {Status} status @param {string} label @param {string} [detail] */
function record(status, label, detail) {
  results.push({ status, label, detail })
}

/** 极简 semver 比较：够用于 engines.dsh 这种「>=A <B」形态；不支持的写法返回 null 让调用方跳过。 */
function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(text).trim())
  if (!match) return null
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split('.') : [] }
}

/** @returns {number} a<b 返回负数，相等 0，a>b 正数 */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1 // 正式版 > 预发布版
  if (b.pre.length === 0) return -1
  const length = Math.max(a.pre.length, b.pre.length)
  for (let i = 0; i < length; i += 1) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
      continue
    }
    if (xNum) return -1
    if (yNum) return 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/**
 * 判断 version 是否满足用空格分隔的比较器合取（如 ">=0.2.1-rc.3 <0.3.0"）。
 * 支持的运算符：>= <= > < =。其它写法（^、~、||、x 通配）返回 null 表示「无法判断」。
 * @returns {boolean | null}
 */
function satisfiesRange(version, range) {
  const parsed = parseVersion(version)
  if (parsed === null) return null
  for (const token of String(range).trim().split(/\s+/)) {
    const match = /^(>=|<=|>|<|=)?(.+)$/.exec(token)
    if (match === null) return null
    const operator = match[1] ?? '='
    const bound = parseVersion(match[2])
    if (bound === null) return null
    const order = compareVersions(parsed, bound)
    const ok =
      operator === '>=' ? order >= 0
        : operator === '<=' ? order <= 0
          : operator === '>' ? order > 0
            : operator === '<' ? order < 0
              : order === 0
    if (!ok) return false
  }
  return true
}

/** 把一个路径解析成真实路径；失败时返回 undefined（例如 link 目标已被删）。 */
function realpathOrUndefined(path) {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    tag: TAG,
    values: { profile: 'desktop', app: '', home: '', cli: '' },
    booleans: [],
  })
  if (args.help) {
    console.log(HELP)
    return
  }

  const profile = String(args.profile)
  const home = resolveHome(args)
  const paths = profilePaths(home, profile)
  const ownManifest = readJson(join(REPO_ROOT, 'package.json'))
  const packageName = ownManifest?.name ?? 'dsh-advisor-mode'

  console.log(`检查 profile「${profile}」（${paths.dir}）\n`)

  // ── profile 本体 ─────────────────────────────────────────────────
  if (!existsSync(paths.dir)) {
    record('FAIL', 'profile 目录存在', `${paths.dir} 不存在：还没装过，或 profile 名字写错`)
    // 目录都没有，后面的检查没有意义，直接汇总。
    return summarize(args, home, profile, undefined)
  }
  record('PASS', 'profile 目录存在', paths.dir)

  const manifest = readJson(paths.manifest)
  if (manifest === undefined) {
    record('FAIL', 'profile package.json 可解析', `${paths.manifest} 不存在或不是合法 JSON`)
    return summarize(args, home, profile, undefined)
  }
  record('PASS', 'profile package.json 可解析', paths.manifest)

  // ── 依赖与 bundle 层 ─────────────────────────────────────────────
  const dependency = manifest.dependencies?.[packageName]
  if (dependency === undefined) {
    record('FAIL', `dependencies 里有 ${packageName}`, `当前依赖：${JSON.stringify(manifest.dependencies ?? {})}`)
  } else {
    record('PASS', `dependencies 里有 ${packageName}`, String(dependency))
  }

  const bundles = manifest.dsh?.profile?.bundles
  const bundleList = Array.isArray(bundles) ? bundles : []
  if (!bundleList.includes(packageName)) {
    record('FAIL', `dsh.profile.bundles 含 ${packageName}`, `当前 bundles：${JSON.stringify(bundles ?? null)}`)
  } else {
    record('PASS', `dsh.profile.bundles 含 ${packageName}`, `bundles 顺序：${bundleList.join(' → ')}`)
  }

  // 我们的 patch 必须排在 dsh-web-app 之后：preset 行是顶层 insert，靠「后应用」覆盖不到，
  // 但 agent-preset 的注册表/客户端 UI 都在 web-app 里，顺序反了会少 UI 或注册失败。
  const webIndex = bundleList.indexOf('@deepseek-ai/dsh-web-app')
  const ownIndex = bundleList.indexOf(packageName)
  if (webIndex < 0 || ownIndex < 0) {
    record('SKIP', 'bundle 顺序晚于 @deepseek-ai/dsh-web-app', 'web-app 或本包不在 bundles 里，无法判断顺序')
  } else if (ownIndex > webIndex) {
    record('PASS', 'bundle 顺序晚于 @deepseek-ai/dsh-web-app', `${webIndex} < ${ownIndex}`)
  } else {
    record('FAIL', 'bundle 顺序晚于 @deepseek-ai/dsh-web-app', '本包排在 web-app 之前，preset 可能注册不上')
  }

  // ── 安装目录 ─────────────────────────────────────────────────────
  // 依赖和 bundles 都没有它 = profile 里其实没装；此时 node_modules 里若还有残留软链
  // （pnpm remove link: 依赖后不一定清目录）不算「装好了」，别让 PASS 误导人。
  if (dependency === undefined && !bundleList.includes(packageName)) {
    record('SKIP', `node_modules/${packageName} 与安装内容`, '依赖和 bundles 里都没有它：profile 里未安装（node_modules 里的软链残留可忽略）')
  } else {
    const installedDir = join(paths.modules, packageName)
    const realDir = realpathOrUndefined(installedDir)
    if (realDir === undefined) {
      record('FAIL', `node_modules/${packageName} 存在`, `${installedDir} 不存在（pnpm 没装成功，或 link 目标已被删）`)
    } else {
      record('PASS', `node_modules/${packageName} 存在`, realDir === installedDir ? installedDir : `→ ${realDir}`)
      const installedManifest = readJson(join(realDir, 'package.json'))
      if (installedManifest === undefined) {
        record('FAIL', '安装后的 package.json 可解析', join(realDir, 'package.json'))
      } else {
        record('PASS', `安装版本 ${installedManifest.version ?? '未知'}`, realDir)
        const patchRel = installedManifest.dsh?.bundle?.patch
        if (patchRel === undefined) {
          record('FAIL', '安装包声明了 dsh.bundle.patch', '缺这项就不是 profile 层')
        } else {
          record('PASS', '安装包声明了 dsh.bundle.patch', JSON.stringify(patchRel))
        }
        // 主模块在不在：装了但主模块缺失，DSH 启动时这一行会加载失败。
        const mainRel = installedManifest.main ?? 'lib/index.js'
        if (existsSync(join(realDir, mainRel))) {
          record('PASS', `主模块存在 ${mainRel}`, join(realDir, mainRel))
        } else {
          record('FAIL', `主模块存在 ${mainRel}`, `${join(realDir, mainRel)} 不存在：DSH 启动时会加载失败`)
        }
        // 安装包里的 patch 内容
        const patchFiles = patchRel === undefined ? [] : Array.isArray(patchRel) ? patchRel : [patchRel]
        const texts = patchFiles.map((rel) => readText(join(realDir, rel)) ?? '')
        const joined = texts.join('\n')
        if (patchFiles.length === 0) {
          record('SKIP', '安装包 patch 内容含 preset-advisor', '没有声明 patch 文件')
        } else if (joined.includes('preset-advisor') && joined.includes('- id: advisor-mode')) {
          record('PASS', '安装包 patch 内容含 preset-advisor 与 advisor-mode', patchFiles.join(', '))
        } else {
          record('FAIL', '安装包 patch 内容含 preset-advisor 与 advisor-mode', 'patch 里没有 preset 定义或顾问行')
        }
      }
    }
  }
  // ── 双挂载检测 ───────────────────────────────────────────────────
  const profilePatch = readText(paths.patch)
  if (profilePatch === undefined) {
    record('WARN', 'profile 有 cordis.patch.yml', `${paths.patch} 不存在（DSH 首次启动会补上）`)
  } else if (/^\s*-\s*id:\s*advisor-mode\s*$/m.test(profilePatch)) {
    record('WARN', 'profile patch 没有重复挂载 advisor-mode', 'profile 的 cordis.patch.yml 里也有一行 advisor-mode —— 会与 bundle 双挂载，导致工具重复注册')
  } else {
    record('PASS', 'profile patch 没有重复挂载 advisor-mode', '没有手工行，只走 bundle 层')
  }

  // ── 生成物是否跟当前 DSH 一致 ────────────────────────────────────
  const syncScript = join(HERE, 'sync-preset.mjs')
  if (!existsSync(syncScript)) {
    record('SKIP', '本地 cordis.patch.yml 与当前 DSH 的 standard preset 一致', '找不到 scripts/sync-preset.mjs')
  } else {
    const check = await runCaptured(process.execPath, [syncScript, '--check'], { quiet: true })
    if (check.code === 0) {
      record('PASS', '本地 cordis.patch.yml 与当前 DSH 的 standard preset 一致')
    } else {
      const reason = (check.stderr || check.stdout).split('\n').find((line) => line.includes('失败'))?.trim()
      record('FAIL', '本地 cordis.patch.yml 与当前 DSH 的 standard preset 一致', reason ?? '不一致：DSH 升级后需要重跑 sync-preset')
    }
  }

  // ── 版本兼容闸门 ─────────────────────────────────────────────────
  const cli = findDesktopCli(args)
  const dshVer = cli === undefined ? undefined : await dshVersion(cli, { ...process.env, DSH_HOME: home })
  const enginesDsh = ownManifest?.engines?.dsh
  if (dshVer === undefined) {
    record('SKIP', 'DSH 版本与 engines.dsh 兼容', '读不到 DSH 版本（CLI 不在预期位置，可用 --app/--cli 指定）')
  } else if (typeof enginesDsh !== 'string') {
    record('WARN', 'DSH 版本与 engines.dsh 兼容', `本包没有声明 engines.dsh，DSH ${dshVer} 会退回 peer 版本检查`)
  } else {
    const ok = satisfiesRange(dshVer, enginesDsh)
    if (ok === true) record('PASS', `DSH ${dshVer} 满足 engines.dsh「${enginesDsh}」`)
    else if (ok === false) record('FAIL', `DSH ${dshVer} 不满足 engines.dsh「${enginesDsh}」`, '这个组合下 bundle 会被拒绝加载；要么升级本包，要么用 dsh plugin allow-version 接受风险')
    else record('SKIP', `DSH ${dshVer} 与 engines.dsh「${enginesDsh}」`, '版本区间写法超出本脚本的比较器，请人工确认')
  }

  // ── 备份 ─────────────────────────────────────────────────────────
  const backups = listBackups(paths.backups)
  if (backups.length === 0) {
    record('SKIP', '有可回滚的备份', `${paths.backups} 下没有 advisor-mode-* 备份`)
  } else {
    record('PASS', `有可回滚的备份（${backups.length} 个）`, `最近一次：${backups[0]}`)
  }

  summarize(args, home, profile, dshVer)
}

/** 输出清单与下一步建议。 */
function summarize(args, home, profile, dshVer) {
  const width = Math.max(...results.map((item) => item.label.length), 4)
  console.log('检查结果：')
  for (const item of results) {
    const line = `  ${item.status.padEnd(4)}  ${item.label.padEnd(width)}  ${item.detail ?? ''}`
    console.log(line.trimEnd())
  }
  const failed = results.filter((item) => item.status === 'FAIL')
  const warned = results.filter((item) => item.status === 'WARN')
  const passed = results.filter((item) => item.status === 'PASS')
  console.log('')
  console.log(`汇总：PASS ${passed.length} / WARN ${warned.length} / FAIL ${failed.length}`)

  const homeFlag = args.home ? ` --home ${home}` : ''
  const suggestions = []
  if (failed.length > 0) {
    suggestions.push(`  · 重新安装：node scripts/install.mjs --profile ${profile}${homeFlag}`)
    suggestions.push(`  · 退回安装前：node scripts/rollback.mjs --profile ${profile}${homeFlag} --restore-last`)
  }
  if (results.some((item) => item.status === 'FAIL' && item.label.includes('standard preset'))) {
    suggestions.push('  · 生成物过期：node scripts/sync-preset.mjs  然后重装一次')
  }
  if (warned.length > 0) {
    suggestions.push('  · WARN 项通常不影响启动，但值得看一眼再重启 DSH')
  }
  if (failed.length === 0 && warned.length === 0) {
    suggestions.push('  · 看起来都对。重启 DSH 桌面应用 → 新建任务 → 模式选择器里选「顾问模式」')
  }
  console.log('')
  console.log('下一步建议：')
  for (const line of suggestions) console.log(line)
  console.log('')
  if (failed.length > 0) process.exit(1)
}

await main()
