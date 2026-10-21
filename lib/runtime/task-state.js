/**
 * Task state: identity, persistence and rehydration of one verification task.
 *
 * The state file is the durable half of the plugin's memory. Because it is
 * durable, reading it must be able to FAIL: `loadOrCreateTask` returns
 * `ok: false` when a state file exists but cannot be trusted, and the caller is
 * required to fail closed (stop the task and report) instead of starting a fresh
 * task over the top of it. Treating an unreadable state as "no state" would let a
 * corrupt file silently release a blocked task, which is exactly the fail-open
 * shape recorded in OpenViking's
 * `experiences/安全状态读取失败被当成空导致fail-open.md`.
 *
 * @module dsh-plugin-verification/runtime/task-state
 */

import { ACCEPTANCE, computeGate, FINALIZATION_STATUS, GATE, makeRequirementsRevision, SCHEMA_VERSION, TASK_STATE } from '../protocol.js'
import { createTaskState, EvidenceStore, sha256Hex, stableStringify, TaskErrorLedger } from '../store.js'

/** The identity of the acceptance policy in force, part of the context. */
export function policyFingerprint(config) {
  return `sha256:${sha256Hex(stableStringify({
    mode: config.mode,
    defaultMode: config.defaultMode,
    maxRepairCycles: config.maxRepairCycles,
    failFast: config.failFast,
    unknownRequiredCheck: config.unknownRequiredCheck,
    baselinePolicy: config.baselinePolicy,
    memoryOnReadFailure: config.memoryOnReadFailure,
    reviewRequireCurrentEvidence: config.reviewRequireCurrentEvidence,
  }))}`
}

/** Rebuild the in-memory stores from a persisted state. */
export function hydrate(state) {
  return {
    taskState: state,
    evidenceStore: EvidenceStore.fromJSON({ records: state.evidence ?? [] }),
    ledger: TaskErrorLedger.fromJSON({ entries: state.ledger ?? [] }),
  }
}

/** Fold the in-memory stores back into the persisted shape. */
export function dehydrate(taskState, evidenceStore, ledger) {
  return {
    ...taskState,
    evidence: evidenceStore.toJSON().records,
    ledger: ledger.toJSON().entries,
    updatedAt: Date.now(),
  }
}

/**
 * Load one task, or create it.
 *
 * @param options - `{ taskStore, sessionId, taskId, config, requirements }`.
 * @returns `{ ok, taskState, evidenceStore, ledger, created, error }`.
 */
export async function loadOrCreateTask({ taskStore, sessionId, taskId, config, requirements = [], baselineFingerprint = null }) {
  const loaded = await taskStore.loadTask(taskId)
  if (loaded.ok === false) {
    return { ok: false, error: loaded.error, taskState: null, evidenceStore: null, ledger: null, created: false }
  }

  if (loaded.state !== null) {
    const taskState = normalizeLoadedState(loaded.state, config)
    const { evidenceStore, ledger } = hydrate(taskState)
    return { ok: true, taskState, evidenceStore, ledger, created: false, error: null }
  }

  const taskState = createTaskState({
    schemaVersion: SCHEMA_VERSION,
    taskId,
    sessionId,
    requirementsRevision: 1,
    requirements,
    baselineFingerprint,
    maxRepairCycles: config.maxRepairCycles,
    policyFingerprint: policyFingerprint(config),
  })
  return { ok: true, taskState, evidenceStore: new EvidenceStore(), ledger: new TaskErrorLedger(), created: true, error: null }
}

/** Bring a loaded state up to the current shape without inventing data. */
function normalizeLoadedState(state, config) {
  return {
    ...state,
    requirements: Array.isArray(state.requirements) ? state.requirements : [],
    requirementsRevision: typeof state.requirementsRevision === 'number' ? state.requirementsRevision : 1,
    memoryQueries: Array.isArray(state.memoryQueries) ? state.memoryQueries : [],
    regression: Array.isArray(state.regression) ? state.regression : [],
    assertions: Array.isArray(state.assertions) ? state.assertions : [],
    ledger: Array.isArray(state.ledger) ? state.ledger : [],
    evidence: Array.isArray(state.evidence) ? state.evidence : [],
    observedToolResults: Array.isArray(state.observedToolResults) ? state.observedToolResults : [],
    activeProjectRoot: typeof state.activeProjectRoot === 'string' && state.activeProjectRoot !== '' ? state.activeProjectRoot : null,
    projectResolution: state.projectResolution ?? null,
    declineNoticeIssued: state.declineNoticeIssued === true,
    finalization: state.finalization ?? { status: 'pending', attempts: 0, readback: null, notes: '' },
    maxRepairCycles: config.maxRepairCycles,
    policyFingerprint: policyFingerprint(config),
  }
}

/**
 * Create the requirements revision for one task.
 *
 * A user who adds a requirement mid-task opens a NEW revision. The baseline is
 * deliberately NOT re-captured: §4.2 forbids silently swapping the original
 * baseline, which is exactly what re-snapshotting mid-task would do.
 *
 * @param taskState - the task state to update.
 * @param texts - the requirement texts of the new revision.
 * @returns the new revision number.
 */
export function openRequirementsRevision(taskState, texts) {
  taskState.requirementsRevision += 1
  taskState.requirements = texts.map((text) => String(text).slice(0, 4000))
  taskState.review = null
  taskState.assertions = []
  taskState.requirementsRevisionNote = makeRequirementsRevision({
    revision: taskState.requirementsRevision,
    texts: taskState.requirements,
  })
  return taskState.requirementsRevision
}

/**
 * The public summary of one task, as `verification_status` reports it.
 *
 * A task the gate never ran (no supported project toolchain, or a session that
 * began before the plugin was mounted) must NOT be summarised as "technical
 * acceptance is not verified": that reads like a demand for evidence the task
 * never owed. It is reported as `not_applicable` together with the reason.
 *
 * @param options - `{ taskState, evidenceStore, ledger, applicable }`.
 * @returns the summary object.
 */
export function taskSummary({ taskState, evidenceStore, ledger, applicable }) {
  const notApplicable = taskState.acceptance === ACCEPTANCE[2]
    || taskState.gate?.gate === GATE.NOT_APPLICABLE
    || (applicable === false && taskState.cycle === 0)

  const gate = notApplicable
    ? {
        gate: GATE.NOT_APPLICABLE,
        technicalAcceptance: ACCEPTANCE[2],
        finalizationStatus: FINALIZATION_STATUS[3],
        reason: taskState.skipReason
          ?? taskState.notes?.at?.(-1)
          ?? 'this task was never given a verification scope (no supported project toolchain under the workspace root)',
        blockingFindingIds: [],
      }
    : computeGate({
        findings: taskState.findings ?? [],
        requiredChecks: taskState.requiredChecks ?? { total: 0, verified: 0, unknown: 0 },
        acceptance: taskState.acceptance ?? ACCEPTANCE[1],
        finalization: taskState.finalization ?? { status: FINALIZATION_STATUS[2] },
        blocked: taskState.state === TASK_STATE.BLOCKED,
        blockedReason: taskState.blockedReason,
      })

  return {
    taskId: taskState.taskId,
    sessionId: taskState.sessionId,
    state: taskState.state,
    applicable: notApplicable ? false : (applicable ?? true),
    cycle: taskState.cycle,
    maxRepairCycles: taskState.maxRepairCycles,
    requirementsRevision: taskState.requirementsRevision,
    requirements: taskState.requirements,
    baselineFingerprint: taskState.baselineFingerprint,
    workspaceFingerprint: taskState.workspaceFingerprint,
    acceptance: taskState.acceptance ?? null,
    finalization: taskState.finalization ?? null,
    gate,
    blockedReason: taskState.blockedReason ?? null,
    // The root the gate actually verified, and why it chose it. Without this a
    // container workspace looks like "the gate declined" when it actually
    // verified one of its sub-projects.
    resolvedProjectRoot: taskState.activeProjectRoot ?? null,
    projectResolution: taskState.projectResolution ?? null,
    project: taskState.project
      ? { kind: taskState.project.kind, packageManager: taskState.project.packageManager, checks: taskState.project.checks.map((check) => check.id) }
      : null,
    change: taskState.change
      ? { files: taskState.change.files.length, components: taskState.change.components, riskSignals: taskState.change.riskSignals.map((signal) => signal.kind) }
      : null,
    regression: taskState.regression.at(-1) ?? null,
    assertion: taskState.assertions.at(-1) ?? null,
    findings: taskState.findings ?? [],
    evidenceCount: evidenceStore.list().length,
    evidence: evidenceStore.list().map((record) => ({
      id: record.id,
      stage: record.stage,
      origin: record.origin,
      validity: record.validity,
      complete: record.complete,
      summary: record.summary,
    })),
    memoryQueries: taskState.memoryQueries,
    ledger: ledger.list(),
    lastError: taskState.lastError ?? null,
  }
}
