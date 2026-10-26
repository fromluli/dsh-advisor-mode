#!/usr/bin/env node
/**
 * install.mjs —— 安装「顾问模式」bundle 到某个 DSH profile。
 *
 * 它做的事情只有 4 步，全部可预演（--dry-run）：
 *   1. 定位 DSH 桌面版自带的 CLI（普通 PATH 上的 dsh 会拒绝 desktop profile）
 *   2. 把 profile 的 package.json / cordis.patch.yml / pnpm-lock.yaml 备份到
 *      `<profile>/backups/advisor-mode-<时间戳>/`
 *   3. 执行 `<cli> plugin --profile <profile> add <本包绝对路径>`
 *      —— DSH 会跑 pnpm 装包，读包里的 dsh.bundle.patch，把这个 bundle 追加进
 *      profile package.json 的 dsh.profile.bundles
 *   4. 回读 profile package.json，确认 bundles 里真的出现了 dsh-advisor-mode
 *
 * 用法：
 *   node scripts/install.mjs --dry-run                  # 先看计划，不动任何文件
 *   node scripts/install.mjs --yes                      # 装到 ~/.dsh/profiles/desktop
 *   node scripts/install.mjs --profile desktop --yes
 *   node scripts/install.mjs --home /tmp/dsh-test --profile web --yes   # 测试用临时 home
 *
 * 退出码：0 成功；1 安装失败或未生效；2 参数/环境问题。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  REPO_ROOT,
  backupProfile,
  confirm,
  dshVersion,
  fail,
  log,
  parseArgs,
  profilePaths,
  readJson,
  readText,
  resolveDesktopCli,
  resolveHome,
  runCaptured,
} from './_shared.mjs'

const TAG = 'install'

const HELP = `安装顾问模式 bundle 到 DSH profile

用法：
  node scripts/install.mjs [--profile desktop] [--home <DSH_HOME>] [--app <应用路径>]
                           [--cli <CLI 路径>] [--dry-run] [--yes]

选项：
  --profile   目标 profile，默认 desktop（DSH 桌面应用用的那个）
  --home      DSH home，默认 $DSH_HOME 或 ~/.dsh；测试时可指向 /tmp 下的临时目录
  --app       DSH 桌面应用路径，默认 /Applications/DeepSeek Harness.app
  --cli       直接指定桌面版 CLI 文件（优先级最高）
  --dry-run   只打印将执行的命令与目标路径，不备份、不安装
  --yes       跳过交互确认（非交互式终端必须加）
  --help      显示本帮助

装完之后：重启 DSH 桌面应用 → 新建任务 → 在模式选择器里选「顾问模式」。
`

/** 安装前对包本身做只读体检，返回问题列表（warn）与致命问题（fatal）。 */
function preflight() {
  /** @type {string[]} */
  const warnings = []
  const manifestPath = join(REPO_ROOT, 'package.json')
  if (!existsSync(manifestPath)) fail(TAG, `本目录不像 bundle 包：找不到 ${manifestPath}`)
  const manifest = readJson(manifestPath)
  if (!manifest?.name) fail(TAG, `${manifestPath} 里没有 name`)
  const patchRel = manifest?.dsh?.bundle?.patch
  if (!patchRel) {
    fail(TAG, 'package.json 缺少 dsh.bundle.patch —— 没有这一项的包会被 DSH 插件管理器直接拒绝安装。')
  }
  const patchFiles = Array.isArray(patchRel) ? patchRel : [patchRel]
  for (const rel of patchFiles) {
    const file = join(REPO_ROOT, rel)
    if (!existsSync(file)) fail(TAG, `package.json 声明的 patch 文件不存在：${file}`)
    const text = readText(file) ?? ''
    if (!text.includes('preset-advisor')) {
      warnings.push(`${rel} 里没有 preset-advisor：先跑 node scripts/sync-preset.mjs 重新生成`)
    }
    if (!text.includes('- id: advisor-mode')) {
      warnings.push(`${rel} 里没有 advisor-mode 行：先跑 node scripts/sync-preset.mjs 重新生成`)
    }
  }
  const mainRel = manifest.main ?? 'lib/index.js'
  if (!existsSync(join(REPO_ROOT, mainRel))) {
    warnings.push(`${mainRel} 还不存在：包会被装进 profile，但 DSH 启动时这一行会加载失败`)
  }
  return { manifest, warnings }
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    tag: TAG,
    values: { profile: 'desktop', app: '', home: '', cli: '' },
    booleans: ['dry-run', 'yes'],
  })
  if (args.help) {
    console.log(HELP)
    return
  }

  const dryRun = args['dry-run'] === true
  const yes = args.yes === true
  const profile = String(args.profile)
  const home = resolveHome(args)
  // 提示里带的 --home：只有显式指定过才写，避免把临时 home 的命令样式带到真实安装上。
  const homeFlag = typeof args.home === 'string' && args.home.trim() !== '' ? ` --home ${home}` : ''
  const paths = profilePaths(home, profile)
  const cli = resolveDesktopCli(args, TAG)
  const env = { ...process.env, DSH_HOME: home }

  // ── ① 包体检（只读） ─────────────────────────────────────────────
  const { manifest, warnings } = preflight()
  const packageName = manifest.name
  const repoRoot = REPO_ROOT

  log(TAG, `本包：${packageName}@${manifest.version ?? '0.0.0'}（${repoRoot}）`)
  log(TAG, `DSH CLI：${cli}`)
  const version = await dshVersion(cli, env)
  log(TAG, `DSH 版本：${version ?? '读取失败（--version 非 0，继续）'}`)
  log(TAG, `DSH home：${home}`)
  const missingHint = profile === 'desktop' ? '（尚未由应用初始化）' : '（尚不存在，DSH 会初始化）'
  log(TAG, `目标 profile：${paths.dir}${existsSync(paths.dir) ? '' : missingHint}`)

  // desktop 是桌面应用的保留 profile：DSH 只允许 CLI 管理「应用已经初始化过」的那一个，
  // 没初始化就只给一句 "Open DeepSeek Harness Desktop once…" 然后失败。提前拦下，省得白跑 pnpm。
  if (profile === 'desktop' && !existsSync(paths.manifest)) {
    fail(
      TAG,
      [
        `desktop profile 还没被应用初始化：${paths.manifest} 不存在`,
        'DSH 桌面版只允许 CLI 管理「已经由应用创建过」的 desktop profile。',
        '请先打开一次 DSH 桌面应用（它会创建 ~/.dsh/profiles/desktop），完全退出应用，再运行本脚本。',
      ].join('\n'),
    )
  }

  const before = existsSync(paths.manifest) ? readJson(paths.manifest) : undefined
  const installedVersion = before?.dependencies?.[packageName]
  if (installedVersion) log(TAG, `检测到已安装：dependencies["${packageName}"] = ${installedVersion}（本次是重装/覆盖）`)

  for (const warning of warnings) log('warn', warning)
  if (warnings.length > 0) console.log('')

  // ── ② 计划 ───────────────────────────────────────────────────────
  console.log('计划：')
  console.log(`  1. 备份 ${paths.dir} 下的 package.json / cordis.patch.yml / pnpm-lock.yaml`)
  console.log(`     备份到 ${paths.backups}/advisor-mode-<时间戳>/`)
  console.log(`  2. 执行：DSH_HOME=${home} ${cli} \\`)
  console.log(`       plugin --profile ${profile} add ${repoRoot}`)
  console.log(`  3. 回读 ${paths.manifest}，确认 dsh.profile.bundles 含 ${packageName}`)
  console.log('')

  if (dryRun) {
    log(TAG, '--dry-run：以上为计划，未做任何修改。去掉 --dry-run 即执行。')
    return
  }

  await confirm(`确认把「顾问模式」装进 profile「${profile}」？`, yes, TAG)

  // ── ③ 备份 ───────────────────────────────────────────────────────
  const backup = backupProfile(paths, TAG)
  if (backup.dir === null) log(TAG, 'profile 还没有可备份的文件（首次安装）。')

  // ── ④ 安装 ───────────────────────────────────────────────────────
  log(TAG, '开始安装，下面是 DSH 的原始输出：')
  console.log(''.padEnd(60, '─'))
  const result = await runCaptured(cli, ['plugin', '--profile', profile, 'add', repoRoot], { env })
  console.log(''.padEnd(60, '─'))

  if (result.code !== 0) {
    console.error(`[${TAG}] DSH CLI 退出码：${result.code}`)
    if (result.stderr.trim()) {
      console.error(`[${TAG}] 原始 stderr：`)
      console.error(result.stderr.trimEnd())
    }
    const hints = ['', '回滚提示：']
    let step = 1
    if (backup.dir) {
      hints.push(`  ${step++}) 从本次备份还原：node scripts/rollback.mjs --profile ${profile}${homeFlag} --restore-last --yes`)
      hints.push(`     备份目录：${backup.dir}`)
    } else {
      hints.push('  （安装前 profile 是空的，没有产生备份）')
    }
    hints.push(`  ${step++}) 若 profile 的 package.json 已经出现 ${packageName} 依赖但安装报错，单独移除它：`)
    hints.push(`     ${cli} plugin --profile ${profile} remove ${packageName}`)
    console.error(hints.join('\n'))
    process.exit(1)
  }

  // ── ⑤ 回读确认 ───────────────────────────────────────────────────
  const after = readJson(paths.manifest)
  const bundles = after?.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || !bundles.includes(packageName)) {
    console.error(`[${TAG}] 安装命令成功了，但 ${paths.manifest} 的 dsh.profile.bundles 里没有 ${packageName}。`)
    console.error(`[${TAG}] 当前 bundles：${JSON.stringify(bundles ?? null)}`)
    console.error(
      [
        '',
        '这通常意味着 DSH 没有把这个包当成「profile 层」：',
        '  · 检查 package.json 是否有 "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }',
        '  · 检查 patch 文件是否真的是 YAML（能解析、非空）',
        '  · 手动兜底：把包名加进 package.json 的 dsh.profile.bundles 末尾，再重启 DSH',
      ].join('\n'),
    )
    process.exit(1)
  }

  const dependencySpec = after?.dependencies?.[packageName]
  log(TAG, `完成：bundles 已包含 ${packageName}（依赖形态 ${dependencySpec ?? '未知'}）`)
  if (typeof dependencySpec === 'string' && dependencySpec.startsWith('link:')) {
    log(TAG, '依赖是 link: 形态：装的是本目录的软链，改代码后重启即生效（删掉本目录会让这一行加载失败）。')
  }

  console.log('')
  console.log('下一步：')
  console.log('  1. 重启 DSH 桌面应用（profile 组合只在启动时读取）')
  console.log('  2. 新建任务 → 模式选择器里选「顾问模式」')
  console.log(`  3. 装完想复查：node scripts/verify.mjs --profile ${profile}${homeFlag}`)
  console.log('')
}

await main()
