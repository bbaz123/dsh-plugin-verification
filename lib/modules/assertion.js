/**
 * Assertion Engine: reuse the regression evidence, then run what is still missing.
 *
 * Regression and Assertion are LOGICAL stages, not two runs. Every `expect`
 * that already executed in the regression stage is converted into an assertion
 * record here; only the checks that still have no evidence are executed (§7.4).
 *
 * The other half of this module is authority. Each assertion source carries a
 * default standing, and the engine never promotes one:
 *
 *   project tests / confirmed specs / snapshots  → authoritative
 *   build, typecheck, explicitly configured rules → machine check
 *   automatically noticed before/after differences → advisory
 *   a hypothesis that came only from experience     → advisory
 *   an expectation the model invented just now      → advisory
 *
 * That is why there is no "confidence > 0.9 therefore BLOCK" rule anywhere in
 * this plugin: a numeric score is not an authority.
 *
 * @module dsh-plugin-verification/modules/assertion
 */

import { ASSERTION_AUTHORITY, makeAssertion } from './assertion-record.js'
import { STAGE } from '../protocol.js'

/** The default authority of each assertion source (§7.4). */
export const SOURCE_AUTHORITY = {
  project_test: ASSERTION_AUTHORITY.AUTHORITATIVE,
  confirmed_spec: ASSERTION_AUTHORITY.AUTHORITATIVE,
  snapshot: ASSERTION_AUTHORITY.AUTHORITATIVE,
  machine_check: ASSERTION_AUTHORITY.MACHINE,
  behaviour_diff: ASSERTION_AUTHORITY.ADVISORY,
  experience: ASSERTION_AUTHORITY.ADVISORY,
  model_expectation: ASSERTION_AUTHORITY.ADVISORY,
}

/** Map one regression test item's status onto an assertion status. */
function assertionStatusOf(itemStatus) {
  if (itemStatus === 'passed') return 'passed'
  if (itemStatus === 'failed') return 'failed'
  if (itemStatus === 'skipped') return 'skipped'
  return 'unknown'
}

/**
 * Evaluate the assertion stage of one cycle.
 *
 * @param options - `{ regression, plan, requiredChecks, memorySuggestions, taskState }`.
 * @returns the assertion stage result.
 */
export function evaluateAssertions({ regression, plan, requiredChecks = [], memorySuggestions = [], taskState }) {
  const assertions = []

  // 1. Every executed test item becomes an assertion record: it is evidence that
  //    already exists, so re-running it would only waste the same information.
  const evidenceIdByCheck = new Map((regression?.current?.byCheck ?? []).map((check) => [check.id, check.evidenceId]))
  for (const item of regression?.current?.items ?? []) {
    const evidenceId = evidenceIdByCheck.get(item.checkId)
    assertions.push(makeAssertion({
      source: 'project_test',
      authority: SOURCE_AUTHORITY.project_test,
      status: assertionStatusOf(item.status),
      name: item.id,
      detail: item.status === 'failed' ? (item.failureMessages ?? []).join('\n').slice(0, 2000) : '',
      evidenceIds: evidenceId ? [evidenceId] : [],
      scope: 'test item as written by the project',
    }))
  }

  // 2. A check that reported a machine-level problem becomes a machine assertion.
  const verifiableKinds = { build: 'build', typecheck: 'typecheck', lint: 'lint', test: 'test' }
  for (const check of regression?.current?.byCheck ?? []) {
    if (check.kind === 'test') continue
    if (verifiableKinds[check.kind] === undefined) continue
    assertions.push(makeAssertion({
      source: 'machine_check',
      authority: SOURCE_AUTHORITY.machine_check,
      status: check.status === 'completed' && check.reportMissing !== true ? 'passed' : check.status === 'failed' ? 'failed' : 'unknown',
      name: `${check.id} (${check.command})`,
      detail: (check.stderrTail ?? '').slice(-1200) || check.parseError || '',
      evidenceIds: check.evidenceId ? [check.evidenceId] : [],
      scope: 'declared project check',
    }))
  }

  // 3. Checks that a declared plan never produced evidence for.
  const unknownRequired = []
  const coveredIds = new Set()
  for (const check of regression?.current?.byCheck ?? []) coveredIds.add(check.id)
  // `full-suite` 是 change 阶段对"项目级范围"派生出的要求，但 detectProject 只会产出
  // test/typecheck/build/lint 四种 check id，永远不会有 id=full-suite 的执行记录。
  // 语义上"项目级整套测试"就是项目声明的 test 检查。必须**所有** test 检查都 completed
  // 才算覆盖：任一 test 失败/超时/未跑都不能用另一个 green 的 test 冒充整套通过。
  // 只映射这一条合成 id，不改动任何项目测试断言。
  const testChecks = (regression?.current?.byCheck ?? []).filter((check) => check.kind === 'test')
  // 与同一文件其它检查的规则对齐：completed 还不够，必须报告完整（complete!==false）、
  // 未缺失报告（reportMissing!==true）且退出码为 0。被截断的执行不能冒充整套通过。
  const testCheckComplete = (check) => check.status === 'completed'
    && check.complete !== false
    && check.reportMissing !== true
    && (check.exitCode === undefined || check.exitCode === 0)
  const suiteCovered = testChecks.length > 0 && testChecks.every(testCheckComplete)
  const needsFullSuite = requiredChecks.some((entry) => (typeof entry === 'string' ? entry : entry?.id) === 'full-suite')
  if (suiteCovered) {
    coveredIds.add('full-suite')
    // 留痕：让事后审计能看到 full-suite 是由哪些 test 证据覆盖的，而不是"凭空 verified"。
    if (needsFullSuite) {
      assertions.push(makeAssertion({
        source: 'project_test',
        authority: SOURCE_AUTHORITY.project_test,
        status: 'passed',
        name: `full-suite (mapped from ${testChecks.map((check) => check.id).join(',')})`,
        detail: 'synthetic project-wide requirement covered by completed declared test check(s)',
        evidenceIds: testChecks.map((check) => check.evidenceId).filter(Boolean),
        scope: 'synthetic requirement mapped to declared test checks',
      }))
    }
  }

  for (const entry of requiredChecks) {
    const id = typeof entry === 'string' ? entry : entry.id
    if (id === undefined) continue
    if (coveredIds.has(id)) continue
    if (String(id).startsWith('experience:')) {
      assertions.push(makeAssertion({
        source: 'experience',
        authority: SOURCE_AUTHORITY.experience,
        status: 'unknown',
        name: entry.text ?? id,
        detail: 'retrieved experience suggested this check; no project rule or execution evidence backs it yet',
        evidenceIds: [],
        scope: 'suggested by historical experience',
      }))
      continue
    }
    unknownRequired.push({ id, text: typeof entry === 'string' ? entry : entry.text ?? '', source: entry.source ?? 'project' })
  }

  // 4. Experience-only assumptions are recorded as advisory leads.
  for (const suggestion of memorySuggestions) {
    assertions.push(makeAssertion({
      source: 'experience',
      authority: SOURCE_AUTHORITY.experience,
      status: 'unknown',
      name: suggestion.text.slice(0, 160),
      detail: `from ${suggestion.memoryId ?? 'retrieved experience'}`,
      evidenceIds: [],
      scope: 'hypothesis from historical experience',
    }))
  }

  // 5. Behaviour differences noticed between baseline and current that are not
  //    backed by a project assertion stay advisory, whatever they look like.
  const behaviourNotes = []
  if (regression?.comparison?.verdict === 'pre_existing') {
    behaviourNotes.push(makeAssertion({
      source: 'behaviour_diff',
      authority: SOURCE_AUTHORITY.behaviour_diff,
      status: 'unknown',
      name: `${regression.comparison.unchangedFailures.length} failure(s) identical to the baseline`,
      detail: 'observed before/after difference only; it does not establish that this task caused it',
      evidenceIds: (regression?.current?.byCheck ?? []).map((check) => check.evidenceId).filter(Boolean),
      scope: 'baseline/current difference',
    }))
  }
  assertions.push(...behaviourNotes)

  const failed = assertions.filter((assertion) => assertion.status === 'failed' && assertion.authority !== ASSERTION_AUTHORITY.ADVISORY)
  const advisoryFailed = assertions.filter((assertion) => assertion.status === 'failed' && assertion.authority === ASSERTION_AUTHORITY.ADVISORY)

  return {
    stage: STAGE.ASSERTION,
    assertions,
    unknownRequired,
    summary: {
      total: assertions.length,
      passed: assertions.filter((assertion) => assertion.status === 'passed').length,
      failed: failed.length,
      advisoryFailed: advisoryFailed.length,
      unknown: assertions.filter((assertion) => assertion.status === 'unknown').length,
      requiredChecks: requiredChecks.length,
      unknownRequired: unknownRequired.length,
      rerunFree: true,
    },
    notes: [
      'assertions reuse regression evidence; only uncovered checks are added',
      unknownRequired.length > 0
        ? `${unknownRequired.length} required check(s) have no evidence and are reported as verification gaps`
        : 'every required check has execution evidence',
    ],
    evaluatedAt: Date.now(),
  }
}

/**
 * Whether an assertion failure may block.
 *
 * Only authoritative and machine assertions can. An advisory failure is a lead
 * for the review stage, never a gate (§7.4).
 *
 * @param assertion - one assertion record.
 * @returns true when it may block.
 */
export function assertionCanBlock(assertion) {
  return assertion?.status === 'failed'
    && (assertion.authority === ASSERTION_AUTHORITY.AUTHORITATIVE || assertion.authority === ASSERTION_AUTHORITY.MACHINE)
}
