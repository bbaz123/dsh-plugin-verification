/**
 * Review Engine: evidence-based, read-only review of the verification products.
 *
 * This stage does not re-run anything and does not modify anything. It turns the
 * facts gathered by the previous stages into proposed findings, then subjects
 * each one to the second validation pass the design requires (§7.5):
 *
 *   - every cited evidence id must exist in the EvidenceStore;
 *   - current-state evidence must belong to the current workspace fingerprint;
 *   - a blocking finding may not rest on historical memory or model inference;
 *   - "missing verification" asks for evidence, and only that.
 *
 * The reviewer's `requirementCoverage` is deliberately reported as
 * `unverified` for semantic requirements in V1 and never derives a blocking
 * finding from it: a deterministic engine cannot decide whether a sentence of
 * user intent was fulfilled, and pretending otherwise would either block every
 * turn or silently rubber-stamp it. Requirement semantics stay with the Agent's
 * own global final-review rules, which the finalization bridge points at — the
 * coverage table is still produced so that hand-off names every requirement.
 *
 * @module dsh-plugin-verification/modules/review
 */

import { makeEvidence, makeFinding, STAGE, authorizeFinding, validateFinding } from '../protocol.js'
import { sha256Hex } from '../store.js'

/** Maximum findings of one kind emitted from a single run. */
const MAX_FINDINGS_PER_KIND = 10

/**
 * Whether a failed check ran without producing anything the plugin can reason
 * about: no structured report at all, or the declared report was missing or
 * unusable. The exit code alone cannot decide anything here, so the result is
 * unproven rather than passing.
 *
 * @param check - one `byCheck` entry from the current side.
 * @returns true when the result cannot support a pass.
 */
function runUnproven(check) {
  if (check.status !== 'failed') return false
  if (check.reportMissing === true) return true
  if (check.reportFormat === null || check.reportFormat === undefined) return true
  return check.complete !== true
}

/** The honest reason a failed check settled without a result. */
function unprovenReason(check) {
  if (check.reportMissing === true) {
    return `the failure could not be attributed: the declared report could not be read (${check.parseError ?? 'unreadable report'})`
  }
  if (check.reportFormat === null || check.reportFormat === undefined) {
    return 'the check declared no structured report, so nothing but the exit code is known'
  }
  return 'the run completed but produced no whole result to compare'
}

/**
 * Whether every failed check failed "instantaneously and silently" — the
 * environment never really ran the command.
 *
 * @param comparison - the regression comparison.
 * @returns true when an environment fault is the honest reading.
 */
function allChecksFailedInstantly(comparison) {
  const failed = comparison?.failedChecks ?? []
  return failed.length > 0 && failed.every((check) => check.instantaneous === true)
}

/** Requirement coverage statuses. */
export const COVERAGE = ['satisfied', 'violated', 'unverified', 'not_applicable']

/**
 * A stable fingerprint of "the same failure" across repair cycles.
 *
 * It is built from the failing identities and their failure signatures only, so
 * re-running the same broken code produces the same fingerprint (no progress),
 * while a genuinely different failure produces a different one.
 *
 * @param comparison - the regression comparison.
 * @returns the fingerprint or null.
 */
export function failureFingerprintOf(comparison) {
  const failures = [
    ...(comparison?.newFailures ?? []),
    ...(comparison?.unchangedFailures ?? []),
    ...(comparison?.disappeared ?? []),
    ...(comparison?.newlySkipped ?? []),
  ]
  if (failures.length === 0) return null
  const parts = failures
    .map((item) => `${item.id}:${item.signature ?? item.status}`)
    .sort()
    .join('|')
  return `sha256:${sha256Hex(parts).slice(0, 24)}`
}

/**
 * Build the review stage of one cycle.
 *
 * @param options - the gathered products.
 * @returns `{ evidence, findings, requirementCoverage, notes, summary }`.
 */
export function reviewEvidence({
  taskState,
  change,
  regression,
  assertion,
  requiredChecks = [],
  config,
}) {
  const findings = []
  const evidence = []
  const notes = []
  const comparison = regression?.comparison
  const currentChecks = regression?.current?.byCheck ?? []
  const testCheck = currentChecks.find((check) => check.kind === 'test')
  const baselineTestCheck = (regression?.baseline?.byCheck ?? []).find((check) => check.kind === 'test')

  const currentEvidenceIds = currentChecks.map((check) => check.evidenceId).filter(Boolean)
  const newFailuresReported = comparison !== undefined
    && (comparison.verdict === 'new_failures' || comparison.verdict === 'any_failure')

  // One record that states what the comparison itself established, so a finding
  // about attribution cites a real observation rather than a summary sentence.
  const comparisonEvidence = makeEvidence({
    stage: STAGE.REVIEW,
    producer: 'review-engine',
    action: 'compared the current run against the isolated baseline run',
    workspaceFingerprint: taskState.workspaceFingerprint,
    environmentFingerprint: taskState.environmentFingerprint,
    validity: regression?.baselineAvailable === true && regression?.current?.complete === true ? 'valid' : 'incomplete',
    origin: 'current_execution',
    summary: comparison
      ? `verdict=${comparison.verdict}: ${comparison.reason}`
      : 'no regression comparison was produced',
    raw: null,
    complete: comparison !== undefined && regression?.current?.complete === true,
    detail: {
      baselineAvailable: regression?.baselineAvailable === true,
      newFailures: (comparison?.newFailures ?? []).map((item) => item.id).slice(0, 50),
      preExisting: (comparison?.unchangedFailures ?? []).map((item) => item.id).slice(0, 50),
      disappeared: (comparison?.disappeared ?? []).map((item) => item.id).slice(0, 50),
      newlySkipped: (comparison?.newlySkipped ?? []).map((item) => item.id).slice(0, 50),
      unstable: (comparison?.unstable ?? []).map((item) => item.id).slice(0, 50),
      reason: comparison?.reason ?? null,
    },
  })
  evidence.push(comparisonEvidence)

  // ── new failures: a confirmed defect, grounded in current execution ────────
  if (newFailuresReported) {
    const failures = comparison.newFailures.slice(0, MAX_FINDINGS_PER_KIND)
    for (const failure of failures) {
      findings.push(makeFinding({
        kind: 'confirmed_defect',
        stage: STAGE.REGRESSION,
        summary: `${failure.id} fails now and did not fail at the baseline: ${(failure.failureMessages ?? []).join(' ').slice(0, 400)}`,
        evidenceIds: [testCheck?.evidenceId, baselineTestCheck?.evidenceId, comparisonEvidence.id].filter(Boolean),
        proposedBy: 'regression-engine',
      }))
    }
    if (comparison.newFailures.length > failures.length) {
      notes.push(`${comparison.newFailures.length - failures.length} further new failure(s) were folded into the same repair request`)
    }
  }

  // ── attribution undetermined: ask for evidence, do not blame the code ──────
  if (comparison?.verdict === 'unknown_attribution') {
    findings.push(makeFinding({
      kind: 'verification_gap',
      stage: STAGE.REGRESSION,
      summary: `${(comparison.newFailures ?? []).length || regression?.current?.summary?.failedItems || 'some'} test failure(s) were observed but could not be attributed: ${comparison.reason}`,
      evidenceIds: [comparisonEvidence.id],
      proposedBy: 'regression-engine',
    }))
  }

  if (comparison?.verdict === 'oracle_changed') {
    findings.push(makeFinding({
      kind: 'verification_gap',
      stage: STAGE.REGRESSION,
      summary: 'test files or snapshots changed in this task, so the baseline does not describe the same assertions; the change must be justified against the current requirement',
      evidenceIds: [comparisonEvidence.id],
      proposedBy: 'regression-engine',
    }))
  }

  if (comparison?.verdict === 'unstable') {
    findings.push(makeFinding({
      kind: 'verification_gap',
      stage: STAGE.REGRESSION,
      summary: `unstable result: ${comparison.reason}`,
      evidenceIds: [comparisonEvidence.id, ...currentEvidenceIds.slice(0, 2)].filter(Boolean),
      proposedBy: 'regression-engine',
    }))
  }

  // ── integrity: a test that disappeared or was skipped is not a fix ─────────
  if (comparison?.verdict === 'integrity_violation') {
    findings.push(makeFinding({
      kind: 'policy_violation',
      stage: STAGE.REGRESSION,
      summary: `${comparison.disappeared.length} test(s) no longer run and ${comparison.newlySkipped.length} were newly skipped: ${comparison.reason}`,
      evidenceIds: [comparisonEvidence.id, ...currentEvidenceIds.slice(0, 2)].filter(Boolean),
      proposedBy: 'regression-engine',
    }))
  }

  // ── no reference point: the run proves nothing, so it cannot be accepted ───
  // 2026-10-12 measured defect: with no baseline ever captured, a run that
  // observed no failing ITEM was reported `clean` and the gate reported
  // `technicalAcceptance: verified` without a single comparable observation. A
  // check that only "passed" because nothing was proven is a verification gap.
  if (comparison?.verdict === 'baseline_never_established') {
    findings.push(makeFinding({
      kind: 'verification_gap',
      stage: STAGE.REGRESSION,
      summary: `no baseline was ever established for this task, so the current run cannot be accepted on its own: ${comparison.reason}`,
      evidenceIds: [comparisonEvidence.id],
      proposedBy: 'regression-engine',
    }))
  }

  // ── a failed run that produced nothing usable is unproven, not passing ─────
  if (comparison !== undefined && !newFailuresReported) {
    for (const check of currentChecks) {
      if (!runUnproven(check)) continue
      findings.push(makeFinding({
        kind: 'verification_gap',
        stage: STAGE.ASSERTION,
        summary: `check "${check.id}" settled as failed (exit ${String(check.exitCode)}) and ${unprovenReason(check)}; it produced no passing result, so this run cannot establish acceptance`,
        evidenceIds: [check.evidenceId].filter(Boolean),
        proposedBy: 'assertion-engine',
      }))
    }
  }

  // ── the execution environment itself failed to run the checks ─────────────
  // "Every check failed in milliseconds with no output" is a harness fact, not a
  // test result: the command never produced a process result.
  if (comparison?.executionEnvironmentFailed === true || allChecksFailedInstantly(comparison)) {
    const failed = comparison?.failedChecks ?? []
    const instantEvidence = currentChecks
      .filter((check) => (comparison?.failedChecks ?? []).some(
        (failedCheck) => failedCheck.id === check.id && failedCheck.instantaneous === true,
      ))
      .map((check) => check.evidenceId)
      .filter(Boolean)
    findings.push(makeFinding({
      kind: 'environment_problem',
      stage: STAGE.ASSERTION,
      summary: `all ${failed.length} failed check(s) settled instantly (<= 3000 ms) with no output: the command never really ran, so this is an execution-environment fault rather than a test result`,
      evidenceIds: (instantEvidence.length > 0 ? instantEvidence : currentEvidenceIds).slice(0, MAX_FINDINGS_PER_KIND),
      proposedBy: 'assertion-engine',
    }))
  }

  // ── pre-existing failures are facts, not accusations ──────────────────────
  if (comparison?.verdict === 'pre_existing' && comparison.unchangedFailures.length > 0) {
    findings.push(makeFinding({
      kind: 'advisory',
      stage: STAGE.REGRESSION,
      summary: `${comparison.unchangedFailures.length} failure(s) are identical to the baseline and are not attributed to this task: `
        + comparison.unchangedFailures.slice(0, 5).map((item) => item.id).join(', '),
      evidenceIds: [comparisonEvidence.id, baselineTestCheck?.evidenceId].filter(Boolean),
      proposedBy: 'regression-engine',
    }))
  }

  // ── the environment, not the code, is the problem ─────────────────────────
  for (const check of currentChecks) {
    if (check.status === 'timed_out' || check.status === 'refused' || check.status === 'incomplete' || check.reportMissing === true) {
      findings.push(makeFinding({
        kind: 'environment_problem',
        stage: STAGE.ASSERTION,
        summary: `check "${check.id}" did not produce a usable result (status ${check.status}${check.reportMissing ? ', report missing' : ''}); this is an environment or harness problem, not evidence about the code`,
        evidenceIds: [check.evidenceId].filter(Boolean),
        proposedBy: 'assertion-engine',
      }))
    }
  }

  // ── required checks with no evidence at all ───────────────────────────────
  for (const missing of assertion?.unknownRequired ?? []) {
    findings.push(makeFinding({
      kind: 'verification_gap',
      stage: STAGE.ASSERTION,
      summary: `required check "${missing.id}" has no execution evidence for this cycle (${missing.source})`,
      evidenceIds: [comparisonEvidence.id],
      proposedBy: 'assertion-engine',
    }))
  }

  // ── experience-only leads stay advisory (§7.4) ────────────────────────────
  const leads = (assertion?.assertions ?? []).filter((entry) => entry.source === 'experience').slice(0, 3)
  for (const lead of leads) {
    findings.push(makeFinding({
      kind: 'advisory',
      stage: STAGE.ASSERTION,
      summary: `experience suggests checking: ${lead.name}`,
      evidenceIds: [],
      proposedBy: 'memory-resolver',
    }))
  }

  // ── requirement coverage ─────────────────────────────────────────────────
  const requirementCoverage = (taskState?.requirements ?? []).map((text, index) => ({
    requirement: text,
    index,
    revision: taskState?.requirementsRevision ?? 1,
    status: 'unverified',
    evidenceIds: [],
    note: 'V1 does not decide requirement semantics; the Agent\'s own final review owns this judgement',
  }))
  if (requirementCoverage.length === 0) {
    notes.push('no user requirement text was captured for this task; requirement coverage is empty')
  }

  return {
    stage: STAGE.REVIEW,
    evidence,
    findings,
    requirementCoverage,
    summary: {
      findings: findings.length,
      confirmedDefects: findings.filter((finding) => finding.kind === 'confirmed_defect').length,
      verificationGaps: findings.filter((finding) => finding.kind === 'verification_gap').length,
      environmentProblems: findings.filter((finding) => finding.kind === 'environment_problem').length,
      policyViolations: findings.filter((finding) => finding.kind === 'policy_violation').length,
      advisory: findings.filter((finding) => finding.kind === 'advisory').length,
      requirements: requirementCoverage.length,
      requirementsUnverified: requirementCoverage.length,
    },
    notes,
    reviewedAt: Date.now(),
    changeSummary: change?.facts ?? null,
  }
}

/**
 * Authorise and validate every proposed finding.
 *
 * Authorisation decides whether a finding MAY block; validation decides whether
 * it was argued correctly. A finding that fails validation is dropped from the
 * blocking set and kept as a rejected record, so the decision stays auditable.
 *
 * @param options - `{ findings, store, config, currentFingerprint }`.
 * @returns `{ accepted, rejected, blocking }`.
 */
export function finalizeFindings({ findings, store, config, currentFingerprint }) {
  const accepted = []
  const rejected = []

  for (const proposed of findings) {
    const authorized = authorizeFinding(proposed, { evidence: store.resolver(), policy: config })
    const validation = validateFinding(authorized, store, {
      requireCurrentEvidence: config.reviewRequireCurrentEvidence === true,
      currentFingerprint,
    })
    if (!validation.ok) {
      rejected.push({ ...authorized, blocking: false, gateEffect: 'advisory', reason: `${validation.code}: ${validation.reason}` })
      continue
    }
    accepted.push({ ...authorized, validation })
  }

  return {
    accepted,
    rejected,
    blocking: accepted.filter((finding) => finding.blocking === true),
    advisory: accepted.filter((finding) => finding.blocking !== true),
  }
}
