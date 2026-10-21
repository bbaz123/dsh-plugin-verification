/**
 * Execution adapters: project detection, execution plans, and report parsing.
 *
 * The point of an adapter is that the plugin never judges success from terminal
 * colour or from an exit code alone. Vitest is asked for structured JSON and
 * pytest for JUnit XML, and the comparison is then made per TEST ITEM — because
 * "both runs say the suite failed" cannot tell an untouched pre-existing failure
 * apart from a newly introduced one (§7.3).
 *
 * Every function here is pure. Filesystem access arrives through the injected
 * `fsx` object, so the whole module is unit-testable without a DSH install and
 * without touching a real project.
 *
 * @module dsh-plugin-verification/adapters
 */

import { sha256Hex } from './store.js'

/** Adapter version participates in the cache key: a parser change invalidates cached evidence. */
export const ADAPTER_VERSION = '1'

/** Statuses a normalized test item may carry. */
export const TEST_STATUS = ['passed', 'failed', 'skipped', 'unknown']

/** How each report status maps onto this plugin's vocabulary. */
const VITEST_STATUS = {
  passed: 'passed',
  failed: 'failed',
  pending: 'skipped',
  skipped: 'skipped',
  todo: 'skipped',
  disabled: 'skipped',
}

/** A relative path with a file extension, as it appears in prose. */
const PATH_TOKEN_SOURCE = '(?:[\\w.@+-]+\\/)+[\\w.@+-]+\\.[A-Za-z0-9]{1,8}'

/** Characters that may precede a real path token without being part of it. */
const PATH_DELIMITERS = new Set([
  ' ', '\t', '\n', '\r', '"', "'", '`', '(', '（', '【', ',', '，', ';', '；', '：', ':', '<', '>', '*', '-', '、', '。',
])

/** Child directories that never carry their own project manifest. */
const NON_PROJECT_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', '__pycache__'])

/**
 * Detect the project toolchain under `projectRoot`.
 *
 * Nothing is guessed: a check exists only when the project declares it (a
 * package.json script, a pytest configuration, a tsconfig). A project V1 does
 * not understand returns `null`, and the gate treats that as `not_applicable`
 * rather than as a pass (§7.1).
 *
 * @param options - `{ projectRoot, fsx }` where `fsx = { exists(path), readText(path) }`.
 * @returns the project description, or null.
 */
export async function detectProject({ projectRoot, fsx }) {
  const notes = []
  const pkgPath = joinPath(projectRoot, 'package.json')
  const pyproject = joinPath(projectRoot, 'pyproject.toml')

  if (await safeExists(fsx, pkgPath)) {
    const raw = await safeRead(fsx, pkgPath)
    if (raw === null) return { ok: false, reason: 'package.json exists but could not be read' }
    let manifest
    try {
      manifest = JSON.parse(raw)
    } catch (error) {
      return { ok: false, reason: `package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
    }

    const dependencies = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) }
    const scripts = manifest.scripts ?? {}
    const packageManager = (await detectPackageManager(projectRoot, fsx, manifest.packageManager))
      ?? (await detectPackageManager(projectRoot, fsx, manifest.packageManager))

    const checks = []
    let testAdapter = null

    if (await safeExists(fsx, joinPath(projectRoot, 'vitest.config.ts'))
      || await safeExists(fsx, joinPath(projectRoot, 'vitest.config.js'))
      || await safeExists(fsx, joinPath(projectRoot, 'vitest.config.mts'))
      || await safeExists(fsx, joinPath(projectRoot, 'vitest.config.mjs'))
      || dependencies.vitest !== undefined) {
      testAdapter = 'vitest'
      checks.push({ id: 'test', kind: 'test', adapter: 'vitest', required: true, source: 'vitest dependency or config' })
    } else if (typeof scripts.test === 'string' && scripts.test.trim() !== '') {
      testAdapter = 'script'
      checks.push({ id: 'test', kind: 'test', adapter: 'script', command: scripts.test, required: true, source: 'package.json scripts.test' })
    }

    if (typeof scripts.typecheck === 'string') {
      checks.push({ id: 'typecheck', kind: 'typecheck', adapter: 'script', command: scripts.typecheck, required: true, source: 'package.json scripts.typecheck' })
    } else if (await safeExists(fsx, joinPath(projectRoot, 'tsconfig.json'))) {
      checks.push({ id: 'typecheck', kind: 'typecheck', adapter: 'tsc', required: false, source: 'tsconfig.json present' })
    }
    if (typeof scripts.build === 'string') {
      checks.push({ id: 'build', kind: 'build', adapter: 'script', command: scripts.build, required: false, source: 'package.json scripts.build' })
    }
    if (typeof scripts.lint === 'string') {
      checks.push({ id: 'lint', kind: 'lint', adapter: 'script', command: scripts.lint, required: false, source: 'package.json scripts.lint' })
    }

    if (checks.length === 0) notes.push('package.json declares no test, typecheck, build or lint command')
    if (packageManager === null) notes.push('no lockfile or packageManager field; assuming npm')

    return {
      ok: true,
      kind: 'node',
      projectRoot,
      packageManager: packageManager ?? 'npm',
      testAdapter,
      checks,
      lockfiles: await findLockfiles(projectRoot, fsx),
      notes,
    }
  }

  if (await safeExists(fsx, pyproject) || await safeExists(fsx, joinPath(projectRoot, 'pytest.ini'))
    || await safeExists(fsx, joinPath(projectRoot, 'setup.cfg')) || await safeExists(fsx, joinPath(projectRoot, 'tox.ini'))
    || await safeExists(fsx, joinPath(projectRoot, 'tests'))) {
    return {
      ok: true,
      kind: 'python',
      projectRoot,
      packageManager: 'python',
      testAdapter: 'pytest',
      checks: [{ id: 'test', kind: 'test', adapter: 'pytest', required: true, source: 'python test configuration' }],
      lockfiles: await findLockfiles(projectRoot, fsx),
      notes,
    }
  }

  return null
}

/**
 * Path-like tokens in the user's own words.
 *
 * Deliberately conservative: a token must look like a RELATIVE file path with an
 * extension (`ai/writing/policy.mjs`), must start at a delimiter instead of
 * inside a longer word, and must not be a URL or an absolute path. Nothing here
 * interprets meaning: these tokens are only ever used to TEST, against the real
 * filesystem, which sub-project actually contains the file.
 *
 * @param texts - the requirement texts of the turn.
 * @param limit - maximum retained tokens.
 * @returns the tokens, in order of first appearance.
 */
export function pathTokensOf(texts, limit = 20) {
  const found = []
  const seen = new Set()
  for (const text of Array.isArray(texts) ? texts : []) {
    const source = String(text ?? '')
    const matcher = new RegExp(PATH_TOKEN_SOURCE, 'g')
    let match = matcher.exec(source)
    while (match !== null) {
      const token = match[0]
      const before = match.index === 0 ? '' : source[match.index - 1]
      if (before !== '' && !PATH_DELIMITERS.has(before) && !PATH_DELIMITERS.has(before.toLowerCase())) {
        match = matcher.exec(source)
        continue
      }
      if (!token.includes('://') && !/^[A-Za-z]:/.test(token)) {
        // A harness path reference is written `@a/b.ts`; the token charset must
        // allow `.` and `@` (for `package.json`, `@scope/pkg`), so the LEADING `@`
        // of a reference is stripped here. Without this, `@novel-studio/x.json`
        // scored zero against every candidate — the gate's own notice recommended
        // a spelling its resolver could not read (2026-10-10 实测).
        const clean = token.replace(/^@+/, '').replace(/^\.\//, '')
        if (clean !== '' && !seen.has(clean)) {
          seen.add(clean)
          found.push(clean)
          if (found.length >= limit) return found
        }
      }
      match = matcher.exec(source)
    }
  }
  return found
}

/**
 * Identify the ONE sub-project an AGGREGATE workspace root is about.
 *
 * A workspace may legitimately be a container of projects rather than a project
 * (`C:\work` holding `app/`, `lib/`, `tools/`). The gate's baseline has to be
 * frozen BEFORE the turn mutates anything, so this cannot be decided later from
 * what the turn touched; it is decided from signals that exist up front, in this
 * order:
 *
 *   1. the project this session already worked on (continuity, not a guess);
 *   2. a named path in the user's message that exists under exactly ONE child;
 *   3. a sub-project named as a plain WORD in the message, matching exactly ONE
 *      child (added 2026-10-18: users say "在 dsh-auto-plan-executor 插件里…" far
 *      more often than they type a path; a unique directory-name match is
 *      evidence, not a heuristic);
 *   4. a workspace with exactly one project in it.
 *
 * Steps 2 and 3 both require a UNIQUE match; two named children stay ambiguous.
 *
 * Everything else returns `null`: an ambiguous workspace is reported as "no
 * supported project", never resolved by picking the most likely child. Choosing
 * wrongly would freeze the wrong baseline and then run the wrong project's
 * checks, which is worse than declining.
 *
 * @param options - `{ workspaceRoot, texts, activeProjectRoot, fsx }`.
 * @returns `{ projectRoot, project, via }`, or null.
 */
export async function findSubProject({ workspaceRoot, texts = [], activeProjectRoot = null, fsx, maxChildren = 200, maxTokenChecks = 400 }) {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '') return null
  if (typeof activeProjectRoot === 'string' && activeProjectRoot.trim() !== ''
    && isStrictlyInside(activeProjectRoot, workspaceRoot)) {
    const known = await detectProject({ projectRoot: activeProjectRoot, fsx })
    if (known !== null && known.ok === true) return { projectRoot: activeProjectRoot, project: known, via: 'session' }
  }

  const childNames = await childDirectoryNames(workspaceRoot, fsx, maxChildren)
  const candidates = []
  for (const child of childNames) {
    const childRoot = joinPath(workspaceRoot, child)
    const project = await detectProject({ projectRoot: childRoot, fsx })
    // Fail closed: an unreadable candidate means the workspace cannot be
    // resolved safely, because the file that failed to parse might be the very
    // project this turn is about.
    if (project !== null && project.ok === false) return null
    if (project !== null && project.ok === true) candidates.push({ projectRoot: childRoot, name: child, project })
  }
  if (candidates.length === 0) return null
  if (candidates.length === 1) return { ...candidates[0], via: 'single-child' }

  const tokens = pathTokensOf(texts)
  const scored = []
  let checks = 0
  for (const candidate of candidates) {
    let score = 0
    for (const token of tokens) {
      if (checks >= maxTokenChecks) break
      checks += 1
      // A path is written either relative to the project (`ai/policy.mjs`) or
      // relative to the container that holds it (`novel-studio/ai/policy.mjs`).
      // Both are decided by the filesystem, never by which one "looks right".
      if (await safeExists(fsx, joinPath(candidate.projectRoot, token))) {
        score += 1
      } else if (token.split('/')[0] === candidate.name && await safeExists(fsx, joinPath(workspaceRoot, token))) {
        score += 1
      }
    }
    scored.push({ ...candidate, score })
  }
  const positive = scored.filter((entry) => entry.score > 0)
  if (positive.length > 1) return null
  if (positive.length === 1) return { ...positive[0], via: 'mentioned-paths' }

  // Last resort, and still evidence rather than a guess: the turn names one of
  // the sub-projects as a plain WORD ("在 dsh-auto-plan-executor 插件里…"), which is
  // how a user actually says which project they mean when they type no file path.
  // Only a name matching EXACTLY ONE candidate resolves; naming none or several
  // keeps the answer "not applicable". Measured 2026-10-18: a task whose text was
  // "在 dsh-auto-plan-executor 插件中…验收命令：在 dsh-auto-plan-executor 目录下执行
  // npm run check" carried no path token, so the gate declined instead of
  // verifying the project the user had plainly named.
  const named = scored.filter((entry) => mentionsProjectName(texts, entry.name))
  if (named.length === 1) return { ...named[0], via: 'mentioned-name' }
  return null
}

/**
 * Whether one candidate's directory name is written in the texts as a word.
 *
 * Deliberately not a substring test: `dsh-tools` must not match inside
 * `novel-dsh-tools`, and a name embedded in a longer path belongs to the
 * path-token branch above, not here.
 *
 * @param texts - the turn's own words.
 * @param name - the candidate's directory name.
 * @returns true when the name appears as a standalone token.
 */
function mentionsProjectName(texts, name) {
  if (typeof name !== 'string' || name === '') return false
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(^|[^A-Za-z0-9_./@+-])${escaped}(?![A-Za-z0-9_./@+-])`, 'i')
  return (Array.isArray(texts) ? texts : []).some((text) => pattern.test(String(text)))
}

/** The immediate child directory names of a workspace root. */
async function childDirectoryNames(workspaceRoot, fsx, limit) {
  if (typeof fsx?.readdir !== 'function') return []
  let entries
  try {
    entries = await fsx.readdir(workspaceRoot, { withFileTypes: false })
  } catch {
    return []
  }
  const names = (Array.isArray(entries) ? entries : [])
    .map((entry) => (typeof entry === 'string' ? entry : entry?.name))
    .filter((name) => typeof name === 'string' && name !== '' && !name.startsWith('.') && !NON_PROJECT_DIRS.has(name))
  return [...new Set(names)].sort().slice(0, limit)
}

/** True when `candidate` is a path strictly below `root`. */
function isStrictlyInside(candidate, root) {
  const child = String(candidate).replace(/\\/g, '/').replace(/\/+$/, '')
  const parent = String(root).replace(/\\/g, '/').replace(/\/+$/, '')
  return child !== parent && child.startsWith(`${parent}/`)
}

/** Detect the package manager from a lockfile or the explicit manifest field. */
async function detectPackageManager(projectRoot, fsx, declared) {
  if (typeof declared === 'string' && declared.trim() !== '') return declared.split('@')[0]
  const candidates = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
  ]
  for (const [file, manager] of candidates) {
    if (await safeExists(fsx, joinPath(projectRoot, file))) return manager
  }
  return null
}

/** The dependency lockfiles whose change invalidates a cached baseline (§6.3). */
async function findLockfiles(projectRoot, fsx) {
  const found = []
  for (const file of ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'bun.lockb', 'poetry.lock', 'uv.lock', 'requirements.txt']) {
    if (await safeExists(fsx, joinPath(projectRoot, file))) found.push(file)
  }
  return found
}

/**
 * Compose the checks one mode runs.
 *
 * | mode       | scope                                                        |
 * | quick      | directly related test files plus the fast machine checks      |
 * | regression | the project's required checks plus the selected tests         |
 * | full       | every declared check, including build                          |
 *
 * @param options - `{ project, mode, selection, reportDir }`.
 * @returns the plan.
 */
export function buildExecutionPlan({ project, mode = 'regression', selection = {}, reportDir }) {
  const selected = mode === 'quick'
    ? project.checks.filter((check) => check.kind === 'test' || check.kind === 'typecheck')
    : mode === 'full'
      ? project.checks
      : project.checks.filter((check) => check.required || check.kind === 'test' || check.kind === 'typecheck')

  const checks = selected.map((check) => {
    const reportPath = joinPath(reportDir, `${check.id}.report`)
    const plan = commandFor({ project, check, selection, reportPath, mode })
    return { ...check, ...plan, reportPath: plan.reportFormat ? reportPath : null }
  })

  return {
    mode,
    projectKind: project.kind,
    checks,
    selection,
    notes: checks.length === 0 ? ['no applicable check for this project and mode'] : [],
  }
}

/** Compose one check's command line and expected report format. */
function commandFor({ project, check, selection, reportPath, mode }) {
  const run = runPrefix(project.packageManager)

  if (check.kind === 'test' && check.adapter === 'vitest') {
    const files = mode === 'quick' && Array.isArray(selection.files) && selection.files.length > 0
      ? selection.files.map(quote).join(' ')
      : ''
    return {
      // `--reporter=json --outputFile` both ship with Vitest itself, which is why
      // the plugin can rely on a structured report instead of scraping the TTY.
      command: `${execPrefix(project.packageManager)}vitest run --reporter=json --outputFile=${quote(reportPath)} ${files}`.replace(/\s+/g, ' ').trim(),
      reportFormat: 'vitest-json',
    }
  }

  if (check.kind === 'test' && check.adapter === 'pytest') {
    const files = mode === 'quick' && Array.isArray(selection.files) && selection.files.length > 0
      ? selection.files.map(quote).join(' ')
      : ''
    return {
      command: `python -m pytest --junitxml=${quote(reportPath)} ${files}`.replace(/\s+/g, ' ').trim(),
      reportFormat: 'junit-xml',
    }
  }

  if (check.kind === 'test' && check.adapter === 'script') {
    return { command: scriptCommand({ packageManager: project.packageManager, check }), reportFormat: null }
  }

  if (check.adapter === 'tsc') return { command: `${execPrefix(project.packageManager)}tsc --noEmit`, reportFormat: null }
  if (check.adapter === 'script') return { command: scriptCommand({ packageManager: project.packageManager, check }), reportFormat: null }

  return { command: `${run}${check.kind}`, reportFormat: null }
}

/**
 * The command line for a check declared as a package.json script.
 *
 * `npm run` takes a SCRIPT NAME, never the script body: composing
 * `npm run ${scripts.test}` produced `npm run node --import ./test/host-hooks.mjs
 * --test …`, which npm rejects with `Missing script: "node"` — the gate then
 * reported a red check for a project whose own `npm test` is green (measured
 * 2026-10-18 on dsh-auto-plan-executor). The other package managers accept a
 * command directly (`pnpm node …` is valid), so only npm needs the name form.
 *
 * @param options - `{ packageManager, check }`.
 * @returns the command line.
 */
function scriptCommand({ packageManager, check }) {
  const fromManifest = typeof check?.source === 'string' && check.source.startsWith('package.json scripts.')
  const name = typeof check?.id === 'string' ? check.id.trim() : ''
  if (fromManifest && name !== '' && packageManager === 'npm') return `npm run ${name}`
  if (fromManifest) return `${runPrefix(packageManager)}${check.command}`
  // Not a manifest script: it is already a command line, so run it verbatim
  // rather than prefixing it with a package manager that expects a script name.
  return String(check?.command ?? '')
}

/** The package-manager run prefix. */
function runPrefix(packageManager) {
  if (packageManager === 'pnpm') return 'pnpm '
  if (packageManager === 'yarn') return 'yarn '
  if (packageManager === 'bun') return 'bun '
  if (packageManager === 'npm') return 'npm run '
  return ''
}

/**
 * The prefix that runs a locally installed BINARY.
 *
 * `npm run exec <bin>` is not a command npx has: npm's `run` takes a script name,
 * so `npm run exec vitest run …` died the same way `npm run node …` did
 * (2026-10-18). npm's binary runner is `npx`; the other managers keep their
 * existing `exec` form so their behaviour does not change.
 */
function execPrefix(packageManager) {
  if (packageManager === 'npm') return 'npx '
  return `${runPrefix(packageManager)}exec `
}

/** Quote a path for a shell command line. */
function quote(value) {
  const text = String(value)
  return /\s/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text
}

/** Join path segments with a forward slash, keeping the module platform-neutral. */
function joinPath(...parts) {
  return parts
    .filter((part) => part !== undefined && part !== null && part !== '')
    .map((part, index) => (index === 0 ? String(part).replace(/[\\/]+$/, '') : String(part).replace(/^[\\/]+/, '')))
    .join('/')
    .replace(/\/{2,}/g, '/')
}

/** Existence probe that never throws. */
async function safeExists(fsx, path) {
  try {
    return (await fsx.exists(path)) === true
  } catch {
    return false
  }
}

/** Text read that never throws. */
async function safeRead(fsx, path) {
  try {
    const value = await fsx.readText(path)
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

/** A stable identity for one test item: file plus qualified name. */
export function normalizeTestIdentity(item) {
  const file = item.file ?? ''
  const name = item.name ?? ''
  return file === '' ? name : `${file}::${name}`
}

/** Hash the failure text so "the same failure" is comparable across runs. */
export function failureSignature(item) {
  const text = (item.failureMessages ?? []).join('\n').trim()
  if (text === '') return `${item.status}:${normalizeTestIdentity(item)}`
  return sha256Hex(text.replace(/\s+/g, ' ').slice(0, 4000)).slice(0, 16)
}

/**
 * Parse a Vitest JSON report.
 *
 * @param text - the report body.
 * @returns `{ ok, items, summary, error }`.
 */
export function parseVitestJson(text) {
  let report
  try {
    report = JSON.parse(String(text))
  } catch (error) {
    return { ok: false, items: [], summary: null, error: `vitest report is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }

  const items = []
  const results = Array.isArray(report.testResults) ? report.testResults : []
  for (const suite of results) {
    const file = suite.name ?? suite.file ?? ''
    const assertions = Array.isArray(suite.assertionResults) ? suite.assertionResults : []
    for (const assertion of assertions) {
      items.push({
        file,
        name: assertion.fullName ?? assertion.title ?? 'unknown',
        status: VITEST_STATUS[assertion.status] ?? 'unknown',
        failureMessages: Array.isArray(assertion.failureMessages) ? assertion.failureMessages : [],
        durationMs: typeof assertion.duration === 'number' ? assertion.duration : null,
      })
    }
  }

  return {
    ok: true,
    items: items.map((item) => ({ ...item, id: normalizeTestIdentity(item), signature: failureSignature(item) })),
    summary: {
      total: typeof report.numTotalTests === 'number' ? report.numTotalTests : items.length,
      passed: typeof report.numPassedTests === 'number' ? report.numPassedTests : items.filter((item) => item.status === 'passed').length,
      failed: typeof report.numFailedTests === 'number' ? report.numFailedTests : items.filter((item) => item.status === 'failed').length,
      skipped: items.filter((item) => item.status === 'skipped').length,
      success: report.success === true,
    },
    error: null,
  }
}

/**
 * Parse a JUnit XML report (pytest's `--junitxml`).
 *
 * Deliberately tag-oriented rather than a general XML parser: the file is
 * machine-generated by pytest, and a bounded, dependency-free reader that
 * reports what it could not understand is better here than a parser that might
 * silently drop a `<testcase>`.
 *
 * @param text - the report body.
 * @returns `{ ok, items, summary, error }`.
 */
export function parseJUnitXml(text) {
  const body = String(text)
  if (!/<testsuite|<testcase/.test(body)) {
    return { ok: false, items: [], summary: null, error: 'the report contains no <testsuite> or <testcase> element' }
  }

  const items = []
  const casePattern = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g
  let match
  while ((match = casePattern.exec(body)) !== null) {
    const attributes = parseAttributes(match[1] ?? '')
    const inner = match[3] ?? ''
    let status = 'passed'
    if (/<failure\b/.test(inner) || /<error\b/.test(inner)) status = 'failed'
    else if (/<skipped\b/.test(inner)) status = 'skipped'

    const message = firstTagText(inner, 'failure') || firstTagText(inner, 'error') || ''
    items.push({
      file: attributes.file ?? attributes.classname ?? '',
      name: attributes.name ?? 'unknown',
      classname: attributes.classname ?? '',
      status,
      failureMessages: message === '' ? [] : [message],
      durationMs: attributes.time === undefined ? null : Math.round(Number(attributes.time) * 1000),
    })
  }

  const suiteMatch = /<testsuite\b([^>]*)>/.exec(body)
  const suiteAttributes = parseAttributes(suiteMatch?.[1] ?? '')

  return {
    ok: true,
    items: items.map((item) => ({ ...item, id: normalizeTestIdentity(item), signature: failureSignature(item) })),
    summary: {
      total: suiteAttributes.tests === undefined ? items.length : Number(suiteAttributes.tests),
      passed: items.filter((item) => item.status === 'passed').length,
      failed: suiteAttributes.failures === undefined
        ? items.filter((item) => item.status === 'failed').length
        : Number(suiteAttributes.failures) + Number(suiteAttributes.errors ?? 0),
      skipped: suiteAttributes.skipped === undefined
        ? items.filter((item) => item.status === 'skipped').length
        : Number(suiteAttributes.skipped),
      success: items.every((item) => item.status !== 'failed') && items.length > 0,
    },
    error: null,
  }
}

/** Parse the attribute pairs of one tag. */
function parseAttributes(source) {
  const attributes = {}
  const pattern = /([\w:.-]+)\s*=\s*"([^"]*)"/g
  let match
  while ((match = pattern.exec(source)) !== null) {
    attributes[match[1]] = decodeXml(match[2])
  }
  return attributes
}

/** The concatenated text of the first `<tag>` element. */
function firstTagText(source, tag) {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`)
  const match = pattern.exec(source)
  if (match === null) {
    const selfClosing = new RegExp(`<${tag}\\b([^>]*?)/>`).exec(source)
    if (selfClosing === null) return ''
    return parseAttributes(selfClosing[1]).message ?? ''
  }
  return `${parseAttributes(match[0].slice(1, match[0].indexOf('>'))).message ?? ''}\n${decodeXml(match[1])}`.trim()
}

/** Decode the five predefined XML entities. */
function decodeXml(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * Parse a report according to its declared format.
 *
 * @param format - `vitest-json` | `junit-xml` | null.
 * @param text - the report body.
 * @returns the parse outcome.
 */
export function parseReport(format, text) {
  if (format === 'vitest-json') return parseVitestJson(text)
  if (format === 'junit-xml') return parseJUnitXml(text)
  return { ok: false, items: [], summary: null, error: `no structured report for format ${String(format)}` }
}

/**
 * Compare two test runs item by item (§7.3).
 *
 * The verdict vocabulary is the contract the review stage keys off:
 * `clean` (a real two-sided comparison, or a lazy baseline that was not needed,
 * found nothing new), `pre_existing`, `new_failures`, `integrity_violation`,
 * `oracle_changed`, `unstable`, `unknown_attribution` (the run failed and nothing
 * can attribute it), and `baseline_never_established` (no reference point was
 * ever captured, so a failure-free run is unproven rather than accepted).
 *
 * @param options - `{ baseline, current, baselineAvailable, oracleChanged,
 *   baselineEstablished }` where each run is `{ items, summary, complete }` and
 *   `baselineEstablished` says whether a baseline snapshot was captured at all
 *   (as opposed to merely not executed this cycle).
 * @returns the comparison.
 */
export function compareTestRuns({ baseline, current, baselineAvailable, oracleChanged = false, baselineEstablished = null }) {
  const currentItems = new Map((current?.items ?? []).map((item) => [item.id, item]))
  const baselineItems = new Map((baseline?.items ?? []).map((item) => [item.id, item]))

  const currentFailures = [...currentItems.values()].filter((item) => item.status === 'failed')
  const baselineFailures = [...baselineItems.values()].filter((item) => item.status === 'failed')
  const baselineFailuresById = new Map(baselineFailures.map((item) => [item.id, item]))
  const baselineFailuresBySignature = new Map(baselineFailures.map((item) => [item.signature, item]))

  const newFailures = []
  const unchangedFailures = []
  for (const item of currentFailures) {
    const sameId = baselineFailuresById.get(item.id)
    if (sameId !== undefined && sameId.signature === item.signature) {
      unchangedFailures.push(item)
      continue
    }
    // A different test can surface the same root failure; §7.3 compares failure
    // IDENTITIES, so a matching signature alone does not excuse the item.
    if (sameId === undefined && baselineFailuresBySignature.has(item.signature)) {
      unchangedFailures.push(item)
      continue
    }
    newFailures.push(item)
  }

  // Only a PASS disproves an earlier failure. A test that was skipped, renamed
  // or removed did not get fixed (§7.3).
  const fixedFailures = baselineFailures.filter((item) => currentItems.get(item.id)?.status === 'passed')

  // A test that used to run and now does not appear (or was skipped) must not be
  // counted as a fix: §11 says "必测测试被删除或跳过 → 不得按通过处理".
  const disappeared = [...baselineItems.values()].filter((item) => !currentItems.has(item.id) && item.status !== 'skipped')
  const newlySkipped = [...baselineItems.values()].filter((item) => {
    const now = currentItems.get(item.id)
    return now !== undefined && now.status === 'skipped' && item.status !== 'skipped'
  })
  const recoveredFromSkip = [...currentItems.values()].filter((item) => {
    const before = baselineItems.get(item.id)
    return before !== undefined && before.status === 'skipped' && item.status !== 'skipped'
  })

  let verdict
  let reason
  if (baselineAvailable !== true) {
    if (currentFailures.length > 0) {
      // "No reference point" is not "no new failures" (§7.3): a failure with
      // nothing to attribute it against must never be excused.
      verdict = 'unknown_attribution'
      reason = 'the current run failed but no comparable baseline exists, so attribution is undetermined'
    } else if (baselineEstablished === true) {
      // The baseline snapshot exists and simply was not needed: the lazy
      // baseline is only executed when the current side fails (§7.4), so a clean
      // current run really is clean on its own terms.
      verdict = 'clean'
      reason = 'no failures were observed and no comparison was required'
    } else {
      // 2026-10-12 measured defect: with no baseline ever captured, a run that
      // observed no failing item was reported `clean`, and the gate answered
      // `technicalAcceptance: verified` without one comparable observation. A
      // clean run with no reference point is unproven, not accepted.
      verdict = 'baseline_never_established'
      reason = 'no baseline was ever established for this task, so this run cannot be accepted as proof: no new-failure claim can be grounded'
    }
  } else if (newFailures.length > 0) {
    verdict = 'new_failures'
    reason = `${newFailures.length} test(s) fail now that passed (or did not run) at baseline`
  } else if (disappeared.length > 0 || newlySkipped.length > 0) {
    verdict = 'integrity_violation'
    reason = `${disappeared.length} test(s) disappeared and ${newlySkipped.length} were newly skipped`
  } else if (oracleChanged) {
    verdict = 'oracle_changed'
    reason = 'test or snapshot definitions changed in this task, so baseline results do not describe the same assertions'
  } else if (unchangedFailures.length > 0) {
    verdict = 'pre_existing'
    reason = `${unchangedFailures.length} failure(s) are identical to baseline and are not attributed to this task`
  } else {
    verdict = 'clean'
    reason = 'no new failures, no disappearing tests, no oracle change'
  }

  return {
    verdict,
    reason,
    newFailures,
    unchangedFailures,
    fixedFailures,
    disappeared,
    newlySkipped,
    recoveredFromSkip,
    oracleChanged,
    baselineAvailable: baselineAvailable === true,
    baselineState: baselineEstablished === true ? 'established' : 'never_established',
  }
}
