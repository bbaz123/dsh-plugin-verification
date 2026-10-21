/**
 * Change Analyzer: establish WHAT changed, before judging whether anything is
 * wrong.
 *
 * The order is deliberate and matters (§7.1): deterministic file comparison
 * first, then component mapping, and only then any bounded semantic summary. A
 * file's new content is a fact; "the intent of this edit was to unify the
 * expiry" is an inference, and the two are reported in different fields so
 * nothing downstream can quietly treat the second as the first.
 *
 * The module also decides how wide the test net has to be cast. A change to a
 * dependency manifest, a lockfile, shared configuration or the test toolchain
 * widens the scope to the whole project rather than the touched modules,
 * because those files change behaviour everywhere.
 *
 * @module dsh-plugin-verification/modules/change
 */

import { STAGE } from '../protocol.js'

/** Paths whose change widens verification to the whole project. */
const GLOBAL_PATTERNS = [
  /(^|\/)package\.json$/,
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb|poetry\.lock|uv\.lock|requirements\.txt)$/,
  /(^|\/)(tsconfig[^/]*\.json|pyproject\.toml|setup\.cfg|pytest\.ini|tox\.ini)$/,
  /(^|\/)vitest\.config\.[cm]?[jt]s$/,
  /(^|\/)(jest\.config\.[cm]?[jt]s|playwright\.config\.[cm]?[jt]s)$/,
  /(^|\/)\.github\/workflows\//,
]

/** Paths that are test material: touching them changes the oracle. */
const TEST_PATTERNS = [
  /(^|\/)tests?\//,
  /(^|\/)__tests__\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.py$/,
  /(^|\/)__snapshots__\//,
  /\.snap$/,
]

/** Paths where a change is expected to be low risk. */
const DOC_PATTERNS = [/\.(md|txt|rst)$/i, /(^|\/)docs?\//i, /(^|\/)LICENSE$/i]

/** File extension to a coarse component name, used when nothing better exists. */
function componentOf(path) {
  const parts = String(path).split('/')
  if (parts.length === 1) return 'root'
  if (parts[0] === 'src' && parts.length > 2) return parts[1]
  return parts[0]
}

/** The coarse change type of one path. */
function changeTypeOf(entry) {
  if (entry.status === 'untracked' || entry.status === 'added') return 'added'
  if (entry.status === 'deleted') return 'removed'
  if (entry.status === 'renamed') return 'renamed'
  return 'modified'
}

/**
 * Diff the baseline snapshot against the current tree, path by path.
 *
 * @param baseline - the captured snapshot.
 * @param current - `currentFacts()` output.
 * @returns `{ added, modified, removed, unchanged, renamed }`.
 */
export function diffAgainstBaseline(baseline, current) {
  const before = new Map((baseline?.entries ?? []).map((entry) => [entry.path, entry]))
  const after = new Map((current?.entries ?? []).map((entry) => [entry.path, entry]))

  const added = []
  const modified = []
  const removed = []
  const renamed = []
  const unchanged = []

  for (const [path, entry] of after) {
    const previous = before.get(path)
    if (previous === undefined) {
      added.push(entry)
      continue
    }
    if (previous.sha256 !== entry.sha256 || previous.status !== entry.status) modified.push(entry)
    else unchanged.push(entry)
  }
  for (const [path, entry] of before) {
    if (!after.has(path)) {
      if (baseline?.entries?.some((candidate) => candidate.status === 'renamed' && candidate.previousPath === path)) continue
      removed.push(entry)
    }
  }
  for (const entry of after.values()) {
    if (entry.status === 'renamed' && entry.previousPath !== null) renamed.push(entry)
  }

  return { added, modified, removed, renamed, unchanged }
}

/**
 * Analyze the change set of one verification cycle.
 *
 * @param options - `{ taskId, baseline, current, requirements, previous }`.
 * @returns the ChangeAnalysis product (stage product, appended per cycle).
 */
export function analyzeChange({ taskId, baseline, current, requirements = [], previous = null }) {
  const diff = diffAgainstBaseline(baseline, current)
  const touched = [...diff.added, ...diff.modified, ...diff.removed, ...diff.renamed]
  const paths = touched.map((entry) => entry.path).sort()

  const riskSignals = []
  const globalFiles = paths.filter((path) => GLOBAL_PATTERNS.some((pattern) => pattern.test(path)))
  const testFiles = paths.filter((path) => TEST_PATTERNS.some((pattern) => pattern.test(path)))
  const docsOnly = paths.length > 0 && paths.every((path) => DOC_PATTERNS.some((pattern) => pattern.test(path)))

  if (globalFiles.length > 0) {
    riskSignals.push({
      kind: 'dependency_or_config_changed',
      origin: 'current_file',
      paths: globalFiles,
      effect: 'verification scope widens to the whole project',
    })
  }
  if (testFiles.length > 0) {
    riskSignals.push({
      kind: 'oracle_changed',
      origin: 'current_file',
      paths: testFiles,
      effect: 'baseline results no longer describe the same assertions',
    })
  }
  if (diff.removed.length > 0) {
    riskSignals.push({
      kind: 'files_removed',
      origin: 'current_file',
      paths: diff.removed.map((entry) => entry.path),
      effect: 'removed inputs may still be referenced',
    })
  }
  if (docsOnly) {
    riskSignals.push({ kind: 'documentation_only', origin: 'current_file', paths, effect: 'no executable behaviour changed' })
  }

  const components = [...new Set(paths.map(componentOf))].sort()
  const analysis = {
    stage: STAGE.CHANGE,
    taskId,
    cycle: (previous?.cycle ?? 0) + 1,
    files: touched.map((entry) => ({
      path: entry.path,
      status: entry.status,
      changeType: changeTypeOf(entry),
      sha256: entry.sha256 ?? null,
    })),
    symbols: [],
    components,
    changeTypes: [...new Set(touched.map(changeTypeOf))].sort(),
    directions: globalFiles.length > 0 ? ['project-wide'] : components.map((component) => `component:${component}`),
    riskSignals,
    candidateImpacts: candidateImpacts({ paths, globalFiles, testFiles, components }),
    // Facts and inferences are separated fields on purpose (§7.1).
    facts: {
      origin: 'current_file',
      pathCount: paths.length,
      added: diff.added.length,
      modified: diff.modified.length,
      removed: diff.removed.length,
      renamed: diff.renamed.length,
    },
    inferences: [],
    requiresProjectWideScope: globalFiles.length > 0,
    oracleChanged: testFiles.length > 0,
    noSourceChange: paths.length === 0,
    documentationOnly: docsOnly,
    requirementsRevision: requirements.revision ?? 1,
    analyzedAt: Date.now(),
  }

  return analysis
}

/** Derive the areas a conservative test selection should cover. */
function candidateImpacts({ paths, globalFiles, testFiles, components }) {
  const impacts = []
  if (globalFiles.length > 0) {
    impacts.push({ scope: 'project', reason: 'dependency, lockfile or shared configuration changed', paths: globalFiles })
  }
  for (const component of components) {
    const inComponent = paths.filter((path) => componentOf(path) === component)
    impacts.push({ scope: `component:${component}`, reason: 'files under this component changed', paths: inComponent })
  }
  for (const path of testFiles) {
    impacts.push({ scope: 'test-oracle', reason: 'a test file or snapshot changed', paths: [path] })
  }
  return impacts
}

/**
 * Whether anything in this cycle warrants running the project's checks at all.
 *
 * §7.1 and §11 both require this: a task that changed no source must not trigger
 * a pointless project-wide test run. The caller still performs the assertion and
 * review stages, because a configuration change or an external state operation
 * without a source diff still needs its own evidence.
 *
 * @param analysis - a ChangeAnalysis.
 * @param extra - `{ executedCommands }` from this cycle.
 * @returns `{ applicable, reason }`.
 */
export function changeIsVerifiable(analysis, extra = {}) {
  if (analysis?.noSourceChange === true && (extra?.executedCommands ?? 0) === 0) {
    return { applicable: false, reason: 'the task produced no file changes and ran no state-changing command' }
  }
  return { applicable: true, reason: 'the task changed files or executed commands' }
}
