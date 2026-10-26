#!/usr/bin/env node
/**
 * rollback.mjs —— 卸载 / 还原「顾问模式」bundle。
 *
 * 两种模式：
 *   默认          备份后执行 `<cli> plugin --profile <p> remove dsh-advisor-mode`
 *                 （DSH 会把它从 dsh.profile.bundles 去掉，再跑 pnpm 卸载）
 *   --restore-last 不动 pnpm，直接把最近一次备份里的 package.json / cordis.patch.yml /
 *                 pnpm-lock.yaml 覆盖回 profile —— 用于「安装过程中断」「pnpm 卸不干净」
 *                 「想整档退回安装前」的兜底。
 *
 * 用法：
 *   node scripts/rollback.mjs --dry-run
 *   node scripts/rollback.mjs --profile desktop --yes
 *   node scripts/rollback.mjs --profile desktop --restore-last --yes
 *
 * 退出码：0 成功；1 卸载失败；2 参数/环境问题。
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  REPO_ROOT,
  backupProfile,
  confirm,
  dshVersion,
  fail,
  listBackups,
  log,
  parseArgs,
  profilePaths,
  readJson,
  resolveDesktopCli,
  resolveHome,
  runCaptured,
} from './_shared.mjs'

const TAG = 'rollback'
/** 备份里可能出现的文件名，还原时按存在与否拷贝。 */
const RESTORE_FILES = ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml']

const HELP = `卸载 / 还原顾问模式 bundle

用法：
  node scripts/rollback.mjs [--profile desktop] [--home <DSH_HOME>] [--app <应用路径>]
                            [--restore-last] [--dry-run] [--yes]

选项：
  --profile       目标 profile，默认 desktop
  --home          DSH home，默认 $DSH_HOME 或 ~/.dsh
  --app           DSH 桌面应用路径，默认 /Applications/DeepSeek Harness.app
  --cli           直接指定桌面版 CLI 文件
  --restore-last  不跑 pnpm，直接把最近一次 backups/advisor-mode-* 还原回 profile
                  （还原前会自动留一份 advisor-mode-*-pre-restore 快照，但不会再被选中）
  --dry-run       只打印计划，不动文件
  --yes           跳过交互确认（非交互式终端必须加）
  --help          显示本帮助

注意：卸载走 CLI 时仍会先备份 package.json，出问题可用 --restore-last 退回。
`

/** 还原最近一次「真实快照」备份（排除还原动作自己留下的 -pre-restore 备份）。 */
async function restoreLast(args, paths) {
  const backups = listBackups(paths.backups).filter((dir) => !dir.includes('-pre-restore'))
  if (backups.length === 0) {
    fail(TAG, `没有找到任何备份：${paths.backups}\n（--restore-last 只能还原本脚本自己产生的备份）`)
  }
  const latest = backups[0]
  const available = RESTORE_FILES.filter((name) => existsSync(join(latest, name)))
  if (available.length === 0) fail(TAG, `最近一次备份里没有可还原的文件：${latest}`)

  log(TAG, `最近一次备份：${latest}`)
  log(TAG, `将还原：${available.join(', ')}`)

  if (args['dry-run'] === true) {
    for (const name of available) console.log(`  cp "${join(latest, name)}" "${join(paths.dir, name)}"`)
    log(TAG, '--dry-run：未做任何修改。')
    return
  }

  await confirm(`确认用备份「${latest}」覆盖 profile「${paths.profile}」的 ${available.join(' / ')}？`, args.yes === true, TAG)

  // 还原本身也可能覆盖用户手工改动，所以先备份当前状态；标记 -pre-restore，
  // 让下一次 --restore-last 不会选中它（否则会反向还原、撤销这次还原）。
  backupProfile(paths, TAG, '-pre-restore')
  mkdirSync(paths.dir, { recursive: true })
  for (const name of available) copyFileSync(join(latest, name), join(paths.dir, name))
  log(TAG, '已还原。')
  console.log('')
  console.log('下一步：')
  console.log('  1. 重启 DSH 桌面应用')
  console.log(`  2. 若 package.json 已还原但 node_modules 仍有残留，跑一次：`)
  console.log(`       DSH_HOME="${paths.home}" "<桌面 CLI>" plugin --profile ${paths.profile} install`)
}

async function removeBundle(args, paths, cli) {
  const manifestPath = join(REPO_ROOT, 'package.json')
  const manifest = readJson(manifestPath)
  const packageName = manifest?.name ?? 'dsh-advisor-mode'
  const home = paths.home
  const env = { ...process.env, DSH_HOME: home }

  log(TAG, `目标 profile：${paths.dir}`)
  const version = await dshVersion(cli, env)
  log(TAG, `DSH 版本：${version ?? '读取失败'}`)

  const before = existsSync(paths.manifest) ? readJson(paths.manifest) : undefined
  const dependency = before?.dependencies?.[packageName]
  const bundles = before?.dsh?.profile?.bundles ?? []
  log(TAG, `当前依赖：${dependency ?? '（没有）'}`)
  log(TAG, `当前 bundles：${bundles.length > 0 ? bundles.join(', ') : '（空）'}`)

  if (dependency === undefined && !bundles.includes(packageName)) {
    log(TAG, `${packageName} 看起来没装在这个 profile 里，无需卸载。`)
    return
  }

  console.log('')
  console.log('计划：')
  console.log(`  1. 备份 ${paths.dir} 下的 package.json / cordis.patch.yml / pnpm-lock.yaml`)
  console.log(`  2. 执行：DSH_HOME=${home} ${cli} \\`)
  console.log(`       plugin --profile ${paths.profile} remove ${packageName}`)

  if (args['dry-run'] === true) {
    log(TAG, '--dry-run：以上为计划，未做任何修改。')
    return
  }

  await confirm(`确认从 profile「${paths.profile}」卸载 ${packageName}？`, args.yes === true, TAG)

  const backup = backupProfile(paths, TAG)
  log(TAG, '开始卸载，下面是 DSH 的原始输出：')
  console.log(''.padEnd(60, '─'))
  const result = await runCaptured(cli, ['plugin', '--profile', paths.profile, 'remove', packageName], { env })
  console.log(''.padEnd(60, '─'))

  if (result.code !== 0) {
    console.error(`[${TAG}] DSH CLI 退出码：${result.code}`)
    if (result.stderr.trim()) {
      console.error(`[${TAG}] 原始 stderr：`)
      console.error(result.stderr.trimEnd())
    }
    console.error(
      [
        '',
        '回滚提示：',
        backup.dir
          ? `  1) node scripts/rollback.mjs --profile ${paths.profile} ${args.home ? `--home ${paths.home} ` : ''}--restore-last --yes`
          : '  （本次没有备份）',
        `  2) 手动兜底：从 ${paths.manifest} 的 dependencies 和 dsh.profile.bundles 里删掉 ${packageName}，再重启 DSH`,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    process.exit(1)
  }

  const after = readJson(paths.manifest)
  const stillBundled = (after?.dsh?.profile?.bundles ?? []).includes(packageName)
  const stillDepended = after?.dependencies?.[packageName] !== undefined
  if (stillBundled || stillDepended) {
    log(TAG, `警告：卸载命令成功，但 profile 里仍有残留（bundles=${stillBundled}, dependencies=${stillDepended}）。`)
    log(TAG, `可手动清理后重启，或用 --restore-last 退回安装前状态。`)
    process.exit(1)
  }

  log(TAG, `完成：${packageName} 已从 profile「${paths.profile}」移除。`)
  console.log('')
  console.log('下一步：')
  console.log('  1. 重启 DSH 桌面应用（新任务页不再出现「顾问模式」）')
  if (backup.dir) console.log(`  2. 想恢复：node scripts/rollback.mjs --restore-last（备份在 ${backup.dir}）`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    tag: TAG,
    values: { profile: 'desktop', app: '', home: '', cli: '' },
    booleans: ['restore-last', 'dry-run', 'yes'],
  })
  if (args.help) {
    console.log(HELP)
    return
  }

  const paths = profilePaths(resolveHome(args), String(args.profile))
  if (!existsSync(paths.dir)) fail(TAG, `profile 不存在：${paths.dir}`, 2)

  if (args['restore-last'] === true) {
    await restoreLast(args, paths)
    return
  }
  const cli = resolveDesktopCli(args, TAG)
  await removeBundle(args, paths, cli)
}

await main()
