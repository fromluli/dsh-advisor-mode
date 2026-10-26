#!/usr/bin/env node
/**
 * sync-preset.mjs —— 从当前 DSH 内置的「standard」agent preset 生成顾问模式的 bundle 包层。
 *
 * 为什么需要这个脚本：
 *   DSH 的「模式」在 Web 新任务页上是 agent preset（`@deepseek-ai/dsh-agent-preset` 一行），
 *   它的 `config.plugins` 是**整份** per-agent 插件名单，patch 语义是「整块替换、不深合并」。
 *   所以顾问模式 = 复制 standard 的完整插件树 + 插入我们自己的 `dsh-advisor-mode` 一行。
 *   代价是这份名单会随 DSH 升级漂移 → DSH 升级后重跑本脚本即可对齐。
 *
 * 生成的 `cordis.patch.yml` 做了 4 处改写（其余逐字节保留，含 `!!js` 表达式与缩进）：
 *   1. preset 行 id      preset-standard  → preset-advisor
 *   2. config.id         standard         → advisor
 *   3. config 里补        name: 顾问模式 / description: …（Web 模式选择器与设置页读这两个字段）
 *   4. config.order      1                → 5（standard/ptc/minimal/cordis 占用 1–4）
 *   5. 在 `tool-goal` 行之后、`planning` group 之前插入一行 `advisor-mode`
 *
 * 用法：
 *   node scripts/sync-preset.mjs                       # 默认从已安装的 DSH 应用里读 standard preset
 *   node scripts/sync-preset.mjs --source <文件路径>    # 指定来源（例如 /tmp/dshx 解包产物）
 *   node scripts/sync-preset.mjs --check               # 只校验生成结果是否与磁盘一致（供 CI/测试）
 *   node scripts/sync-preset.mjs --provider acme --model gpt-6.1-sol --default-on false
 *
 * 退出码：0 成功/一致；1 生成失败或 --check 不一致；2 参数错误。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

/** 默认 DSH 桌面应用路径（可用 --app 覆盖）。 */
const DEFAULT_APP = '/Applications/DeepSeek Harness.app'
/** 研究阶段解包出来的 DSH 副本（仅当应用内 asar 读不到时作为回退来源）。 */
const DEFAULT_EXTRACTED = '/tmp/dshx/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml'
/** asar 内相对 Resources 的路径。 */
const PRESET_REL = 'dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml'
const WEBAPP_PKG_REL = 'dsh/node_modules/@deepseek-ai/dsh-web-app/package.json'

/** preset 在 Web UI 里显示的名字与说明。 */
const PRESET_NAME = '顾问模式'
const PRESET_DESCRIPTION = '主模型在关键决策点调用 consult_advisor，由第二个（更强的）模型读完整会话后给出建议。需先在模型设置里配好顾问的 provider / model。'

/**
 * 参数解析。只认 --key value / --flag 两种形式，未知参数直接报错（避免拼错静默失效）。
 * @returns {Record<string, string | boolean>}
 */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const out = {}
  const known = new Set(['source', 'out', 'app', 'provider', 'model', 'default-on', 'check', 'help'])
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) fail(`无法识别的参数：${token}`, 2)
    const key = token.slice(2)
    if (!known.has(key)) fail(`未知参数：--${key}（可用：${[...known].map((k) => `--${k}`).join(' ')}）`, 2)
    if (key === 'check' || key === 'help') {
      out[key] = true
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) fail(`参数 --${key} 缺少取值`, 2)
    out[key] = value
    i += 1
  }
  return out
}

/**
 * 打印错误并以指定退出码结束。
 * @param {string} message
 * @param {number} [code]
 * @returns {never}
 */
function fail(message, code = 1) {
  console.error(`\n[sync-preset] 失败：${message}\n`)
  process.exit(code)
}

/** @param {string} text */
function usage(text) {
  console.log(text)
}

const HELP = `顾问模式 preset 同步工具

用法：
  node scripts/sync-preset.mjs [--source <路径>] [--out <路径>] [--app <应用路径>]
                               [--provider <名>] [--model <名>] [--default-on true|false] [--check]

选项：
  --source    standard.patch.yml 来源。省略时依次尝试：DSH 应用内 asar → /tmp/dshx 解包产物
  --out       输出路径，默认 <仓库根>/cordis.patch.yml
  --app       DSH 桌面应用路径，默认 ${DEFAULT_APP}
  --provider  写进 advisor-mode 行的 provider（默认 acme）
  --model     写进 advisor-mode 行的 model（默认 gpt-6.1-sol）
  --default-on  advisor-mode 的 defaultOn（默认 true）
  --check     不写文件，只校验磁盘上的 cordis.patch.yml 是否与本次生成结果一致
  --help      显示本帮助
`

/**
 * 用 Electron 的 node 模式读 asar 内的文本文件。
 * 纯 node 读不了 app.asar（它是归档文件），但 app 自带的 Electron 以 ELECTRON_RUN_AS_NODE=1
 * 启动时支持 asar 路径 —— 和 DSH 桌面 CLI 的 launcher 用的是同一条路。
 * @param {string} appPath
 * @param {string} asarRelPath
 * @returns {string | null}
 */
function readFromAsar(appPath, asarRelPath) {
  const binary = join(appPath, 'Contents', 'MacOS', 'DeepSeek Harness')
  if (!existsSync(binary)) return null
  const asarPath = join(appPath, 'Contents', 'Resources', 'app.asar', asarRelPath)
  // 用数组传参（不经 shell）避免路径里空格/引号带来的转义问题。
  const script = `const fs=require('fs');process.stdout.write(fs.readFileSync(${JSON.stringify(asarPath)},'utf8'))`
  const result = spawnSync(binary, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.status !== 0 || typeof result.stdout !== 'string' || result.stdout.length === 0) return null
  return result.stdout
}

/**
 * 解析 standard.patch.yml 来源。
 * 顺序：--source 显式指定 → DSH 应用 asar（权威，跟实际运行的版本一致） → /tmp 解包副本。
 * @param {{source?: string|boolean, app?: string|boolean}} args
 * @returns {{text: string, origin: string, version: string}}
 */
function resolveSource(args) {
  if (typeof args.source === 'string') {
    const source = resolve(process.cwd(), args.source)
    if (!existsSync(source)) fail(`--source 指向的文件不存在：${source}`)
    const version = readWebAppVersionFromDisk(source)
    return { text: readFileSync(source, 'utf8'), origin: source, version }
  }

  const app = typeof args.app === 'string' ? resolve(process.cwd(), args.app) : DEFAULT_APP
  const asarText = readFromAsar(app, PRESET_REL)
  if (asarText) {
    const version = (() => {
      const pkg = readFromAsar(app, WEBAPP_PKG_REL)
      try {
        return JSON.parse(pkg).version ?? 'unknown'
      } catch {
        return 'unknown'
      }
    })()
    return { text: asarText, origin: `${app}（app.asar 内 ${PRESET_REL}）`, version }
  }

  if (existsSync(DEFAULT_EXTRACTED)) {
    return {
      text: readFileSync(DEFAULT_EXTRACTED, 'utf8'),
      origin: DEFAULT_EXTRACTED,
      version: readWebAppVersionFromDisk(DEFAULT_EXTRACTED),
    }
  }

  fail(
    [
      `读不到 standard preset。已尝试：`,
      `  1) ${app}/Contents/Resources/app.asar/${PRESET_REL}`,
      `  2) ${DEFAULT_EXTRACTED}`,
      ``,
      `如果你把 DSH 装在别处，用 --app 指定；或先把 dsh-web-app 解包到磁盘再用 --source：`,
      `  npx @electron/asar extract "${app}/Contents/Resources/app.asar" /tmp/dsh-asar`,
      `  node scripts/sync-preset.mjs --source /tmp/dsh-asar/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml`,
    ].join('\n'),
  )
}

/**
 * 从 standard.patch.yml 的同级目录往上找 dsh-web-app 的 package.json，读版本号。
 * @param {string} presetFile
 * @returns {string}
 */
function readWebAppVersionFromDisk(presetFile) {
  // standard.patch.yml 在 .../dsh-web-app/presets/ 下，package.json 在上一级。
  const pkgPath = join(dirname(dirname(presetFile)), 'package.json')
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * 在行数组里找第一处匹配的行号。
 * @param {string[]} lines
 * @param {RegExp} re
 * @param {string} label 用于报错的锚点说明
 * @returns {number}
 */
function findAnchor(lines, re, label) {
  const index = lines.findIndex((line) => re.test(line))
  if (index < 0) {
    fail(
      [
        `standard preset 的结构变了：找不到锚点「${label}」。`,
        `请打开当前的 standard.patch.yml（见上面的来源），核对后更新 scripts/sync-preset.mjs 里的改写规则，`,
        `不要直接改 cordis.patch.yml（它是生成物）。`,
      ].join('\n'),
    )
  }
  return index
}

/**
 * 核心改写：输入 standard.patch.yml 全文，输出顾问模式的 cordis.patch.yml 全文。
 * @param {string} sourceText
 * @param {{provider: string, model: string, defaultOn: boolean, origin: string, version: string}} options
 * @returns {string}
 */
function transformStandard(sourceText, options) {
  // 统一换行，避免 Windows 检出时行尾混用。
  const lines = sourceText.replace(/\r\n/g, '\n').split('\n')
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  // ① 拆出上游文件头注释：空行与 `#` 开头的行。
  let bodyStart = 0
  while (bodyStart < lines.length && (lines[bodyStart].trim() === '' || lines[bodyStart].startsWith('#'))) {
    bodyStart += 1
  }
  const upstreamComments = lines.slice(0, bodyStart).filter((line) => line.startsWith('#'))
  if (bodyStart >= lines.length) fail('来源文件里只有注释，没有 patch 内容。')
  const body = lines.slice(bodyStart)

  // ② 结构断言：锚点全在的话后续改写才是安全的。
  if (!/^- insert:$/.test(body[0])) {
    fail(`standard preset 第一行不是顶层的「- insert:」，而是：${body[0]}`)
  }
  const presetRowIdx = findAnchor(body, /^ {4}- id: preset-standard$/, '    - id: preset-standard')
  const configIdIdx = findAnchor(body, /^ {8}id: standard$/, '        id: standard')
  const orderIdx = findAnchor(body, /^ {8}order: 1$/, '        order: 1')
  const pluginsIdx = findAnchor(body, /^ {8}plugins:$/, '        plugins:')
  const toolGoalIdx = findAnchor(body, /^ {10}- id: tool-goal$/, '          - id: tool-goal')
  const planningIdx = findAnchor(body, /^ {10}- id: planning$/, '          - id: planning')
  if (toolGoalIdx > planningIdx) {
    fail('standard preset 里 tool-goal 出现在 planning 之后，插入位置假设失效，请人工核对。')
  }
  if (presetRowIdx > configIdIdx || configIdIdx > pluginsIdx) {
    fail('standard preset 的 preset 行 / config.id / plugins 顺序异常，请人工核对。')
  }

  // ③ 逐处改写（用 id 覆盖，避免同一行重复出现时改错位置）。
  const presetConfig = { provider: options.provider, model: options.model, defaultOn: options.defaultOn }
  body[presetRowIdx] = '    - id: preset-advisor'
  body[configIdIdx] = '        id: advisor'
  body[orderIdx] = '        order: 5'
  // 在 config.id 之后补 name / description（Web 选择器与设置页读这两个字段）。
  const presetMeta = [
    // 前置一行空注释分隔，避免和 upstream 的说明混在一起读。
    `        name: ${yamlString(PRESET_NAME)}`,
    `        description: ${yamlString(PRESET_DESCRIPTION)}`,
  ]
  // config.order 已经在上面改成 5，这里把 name/description 插到 id 与 order 之间。
  const insertMetaAt = configIdIdx + 1
  body.splice(insertMetaAt, 0, ...presetMeta)
  // splice 之后 planning / tool-goal 的下标要一起右移。
  const shift = presetMeta.length
  const toolGoalIdx2 = toolGoalIdx + shift
  const planningIdx2 = planningIdx + shift

  // ④ 在 tool-goal 之后、planning 之前插入顾问模式那一行（10 空格缩进，和兄弟行对齐）。
  const advisorRow = [
    '          # ↓ 顾问模式：主模型通过 consult_advisor 向第二个模型要建议',
    '          - id: advisor-mode',
    "            name: 'dsh-advisor-mode'",
    '            config:',
    `              provider: ${yamlScalar(presetConfig.provider)}`,
    `              model: ${yamlScalar(presetConfig.model)}`,
    `              defaultOn: ${presetConfig.defaultOn === true}`,
  ]
  // 断言：tool-goal 与 planning 之间没有夹着别的行，否则我们插进去的语义位置就不确定。
  if (planningIdx2 - toolGoalIdx2 < 2) {
    fail('tool-goal 与 planning 相邻关系异常，无法确定插入点，请人工核对。')
  }
  body.splice(planningIdx2, 0, ...advisorRow)

  // ⑤ 生成文件头。注意：不写时间戳，保证同一份输入生成同一份输出（幂等）。
  const header = [
    '# ⚠️ 本文件由 scripts/sync-preset.mjs 生成，请勿手改；DSH 升级后重跑 `node scripts/sync-preset.mjs`。',
    '#',
    `# 内容 = DSH ${options.version} 内置 standard agent preset 的完整插件树，改写为「${PRESET_NAME}」：`,
    '#   preset 行 id: preset-advisor，config.id: advisor，order: 5（standard/ptc/minimal/cordis 占 1–4）',
    '#   插件树在 tool-goal 之后、planning 之前插入一行 dsh-advisor-mode',
    '#   其余插件行与上游逐字节一致（含 !!js 表达式），所以上游改了名单必须重跑本脚本',
    '#',
    `# 来源：${options.origin}`,
    '#',
    '# —— 以下为上游 standard.patch.yml 的原注释 ——',
    ...upstreamComments,
  ]
  const output = [...header, ...body].join('\n')

  // ⑥ 生成物自检：断言关键行各出现一次且相对位置正确（防止改写规则写错却静默产出垃圾）。
  selfCheck(output, presetConfig)
  return `${output}\n`
}

/**
 * 生成后的结构自检。失败直接退出，不写文件。
 * @param {string} output
 * @param {{provider: string, model: string, defaultOn: boolean}} config
 */
function selfCheck(output, config) {
  const lines = output.split('\n')
  const count = (re) => lines.filter((line) => re.test(line)).length
  const expectOnce = (re, label) => {
    const n = count(re)
    if (n !== 1) fail(`生成结果自检失败：期望「${label}」出现 1 次，实际 ${n} 次。`)
  }
  expectOnce(/^ {4}- id: preset-advisor$/, 'preset-advisor 行')
  expectOnce(/^ {8}id: advisor$/, 'config.id: advisor')
  expectOnce(/^ {8}name: .*$/, 'preset 的 name')
  expectOnce(/^ {8}description: .*$/, 'preset 的 description')
  expectOnce(/^ {8}order: 5$/, 'config.order: 5')
  expectOnce(/^ {10}- id: advisor-mode$/, 'advisor-mode 行')
  expectOnce(/^ {12}name: 'dsh-advisor-mode'$/, "advisor-mode 的 name")
  expectOnce(new RegExp(`^ {14}provider: ${escapeRegExp(yamlScalar(config.provider))}$`), 'advisor-mode 的 provider')
  expectOnce(new RegExp(`^ {14}model: ${escapeRegExp(yamlScalar(config.model))}$`), 'advisor-mode 的 model')
  expectOnce(new RegExp(`^ {14}defaultOn: ${config.defaultOn === true}$`), 'advisor-mode 的 defaultOn')
  expectOnce(/^ {10}- id: tool-goal$/, 'tool-goal 行')
  expectOnce(/^ {10}- id: planning$/, 'planning 行')

  // 残留检查：改写后的文件里不应再有 standard 的 preset 身份。
  if (/preset-standard/.test(output)) fail('生成结果自检失败：仍残留 preset-standard。')
  if (/^ {8}id: standard$/m.test(output)) fail('生成结果自检失败：仍残留 config.id: standard。')

  // 位置检查：tool-goal < advisor-mode < planning。
  const indexOf = (re) => lines.findIndex((line) => re.test(line))
  const toolGoal = indexOf(/^ {10}- id: tool-goal$/)
  const advisor = indexOf(/^ {10}- id: advisor-mode$/)
  const planning = indexOf(/^ {10}- id: planning$/)
  if (!(toolGoal < advisor && advisor < planning)) {
    fail('生成结果自检失败：advisor-mode 不在 tool-goal 与 planning 之间。')
  }
}

/** @param {string} text */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 输出一个标量：只含安全字符时用裸标量（更接近官方 standard.patch.yml 的写法），
 * 否则退回单引号。provider/model 常见形如 `acme`、`gpt-6.1-sol`、`google-ai-pro/gemini-3.1-pro`。
 * @param {string} value
 */
function yamlScalar(value) {
  const text = String(value)
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(text) ? text : yamlString(text)
}

/**
 * 按 YAML 单引号标量输出（最保守：只转义单引号本身），避免中文/冒号/括号被误解析。
 * @param {string} value
 */
function yamlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * 把 --default-on 的取值转成布尔。
 * @param {string | boolean | undefined} raw
 * @param {boolean} fallback
 */
function toBool(raw, fallback) {
  if (raw === undefined) return fallback
  if (raw === true) return true
  const value = String(raw).toLowerCase()
  if (value === 'true' || value === '1' || value === 'yes') return true
  if (value === 'false' || value === '0' || value === 'no') return false
  fail(`--default-on 只接受 true/false，收到：${raw}`, 2)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    usage(HELP)
    return
  }

  const outPath = typeof args.out === 'string' ? resolve(process.cwd(), args.out) : join(ROOT, 'cordis.patch.yml')
  const provider = typeof args.provider === 'string' ? args.provider : 'acme'
  const model = typeof args.model === 'string' ? args.model : 'gpt-6.1-sol'
  const defaultOn = toBool(args['default-on'], true)

  const source = resolveSource(args)
  console.log(`[sync-preset] 来源：${source.origin}`)
  console.log(`[sync-preset] dsh-web-app 版本：${source.version}`)

  const output = transformStandard(source.text, {
    provider,
    model,
    defaultOn,
    origin: source.origin,
    version: source.version,
  })

  const lineCount = output.split('\n').length - 1
  if (args.check) {
    if (!existsSync(outPath)) fail(`--check：目标文件不存在：${outPath}`)
    const current = readFileSync(outPath, 'utf8')
    if (current !== output) {
      fail(`--check：${outPath} 与当前 DSH 的 standard preset 不一致，请重跑 node scripts/sync-preset.mjs`)
    }
    console.log(`[sync-preset] --check 通过：${outPath}（${lineCount} 行）与当前 DSH 一致。`)
    return
  }

  writeFileSync(outPath, output, 'utf8')
  console.log(`[sync-preset] 已写入 ${outPath}`)
  console.log(`[sync-preset] 共 ${lineCount} 行；preset 行 id: preset-advisor，config.id: advisor，order: 5`)
  console.log('[sync-preset] 插件行 advisor-mode 插在 tool-goal 之后、planning 之前（顾问模式下 plan 模式仍可用）')
}

main()
