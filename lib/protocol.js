/**
 * Verification protocol: the shared vocabulary of one verification task.
 *
 * This module is the single source of truth for the shapes the rest of the
 * plugin exchanges — {@link VerificationContext}, `Evidence`, `Finding`,
 * `RepairPacket` and the derived gate decision. It holds no I/O, no service
 * access and no timers, so every rule in it is directly unit-testable.
 *
 * Two invariants are enforced here rather than trusted from a caller:
 *
 *  1. `blocking` and `authority` are COMPUTED by this module's policy engine
 *     from the finding's kind plus the evidence it cites. A model (or an
 *     engine) may propose a finding; it cannot promote it to blocking, and a
 *     finding whose evidence is absent, stale, or only `model_inference` is
 *     downgraded to `advisory`.
 *  2. An `advisory` finding is never blocking on its own — historical
 *     experience is a lead, not a verdict.
 *
 * @module dsh-plugin-verification/protocol
 */

/** Protocol version carried by every persisted context. Bump on shape changes. */
export const SCHEMA_VERSION = 1

/** Pipeline stages. Each stage appends its product; nothing is overwritten. */
export const STAGE = {
  CHANGE: 'change',
  MEMORY: 'memory',
  REGRESSION: 'regression',
  ASSERTION: 'assertion',
  REVIEW: 'review',
  REPAIR: 'repair',
  FINALIZATION: 'finalization',
}

/** Lifecycle of one verification task. `completed` is derived, never submitted. */
export const TASK_STATE = {
  WORKING: 'working',
  ANALYZING: 'analyzing',
  REGRESSION: 'regression',
  ASSERTION: 'assertion',
  REVIEWING: 'reviewing',
  RETRIEVING_FOR_REPAIR: 'retrieving_for_repair',
  REPAIRING: 'repairing',
  FINALIZING: 'finalizing',
  COMPLETED: 'completed',
  BLOCKED: 'blocked',
  CANCELLED: 'cancelled',
}

/** Terminal states: nothing further is scheduled for the task. */
export const TERMINAL_STATES = [TASK_STATE.COMPLETED, TASK_STATE.BLOCKED, TASK_STATE.CANCELLED]

/**
 * How a piece of evidence relates to the state it describes.
 * `stale` means it was valid for an earlier workspace fingerprint.
 */
export const EVIDENCE_VALIDITY = ['valid', 'stale', 'incomplete', 'unavailable']

/** Who produced the evidence. Only the first three can establish a fact. */
export const EVIDENCE_ORIGIN = [
  'current_execution',
  'baseline_execution',
  'current_file',
  'user_requirement',
  'historical_memory',
  'model_inference',
]

/** Origins that may ground a `confirmed_defect` on current code. */
export const EXECUTION_ORIGINS = ['current_execution', 'current_file']

/** What kind of problem a finding reports (§5.3). */
export const FINDING_KIND = ['confirmed_defect', 'verification_gap', 'environment_problem', 'policy_violation', 'advisory']

/** Outcome of one OpenViking retrieval attempt. `empty` ≠ `failed`. */
export const MEMORY_QUERY_STATUS = ['success', 'empty', 'failed', 'denied', 'unavailable']

/** Technical acceptance is separate from finalization (§2.2). */
export const ACCEPTANCE = ['verified', 'not_verified', 'not_applicable']
export const FINALIZATION_STATUS = ['complete', 'partial', 'pending', 'not_required']

/** What the gate tells the controller to do next. */
export const GATE = {
  VERIFIED: 'verified',
  FINALIZE: 'finalize',
  REPAIR: 'repair',
  NEEDS_EVIDENCE: 'needs_evidence',
  BLOCKED: 'blocked',
  NOT_APPLICABLE: 'not_applicable',
}

/**
 * What a finding asks the Agent to do. The action is derived from the kind so a
 * "missing verification" never turns into "rewrite the code".
 */
export const FINDING_ACTION = {
  confirmed_defect: 'repair_code',
  verification_gap: 'provide_evidence',
  environment_problem: 'fix_environment',
  policy_violation: 'explain_or_restore',
  advisory: 'consider',
}

/** Deterministic fallback when `crypto.randomUUID` is unavailable in a test double. */
let counter = 0

/** A short, sortable, collision-resistant identifier for protocol entities. */
export function makeId(prefix) {
  counter += 1
  const random = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${random}`
}

/**
 * Compose the stable task identity of one user task inside a session (§4.2).
 *
 * A session may hold several tasks, so the identity is the session plus the
 * identity of the first user message that opened the task. Every repair,
 * evidence request and finalization within that task reuses it, which keeps one
 * baseline and one ledger for the whole task.
 *
 * @param sessionId - live session identity.
 * @param firstMessageId - identity of the message that opened the task.
 * @returns the task id.
 */
export function makeTaskId(sessionId, firstMessageId) {
  return `${sessionId}::${firstMessageId ?? 'session'}`
}

/** One requirement revision: the user's ask as recorded at a point in time. */
export function makeRequirementsRevision({ revision = 1, texts = [], capturedAt = Date.now() } = {}) {
  return { revision, texts: texts.map((text) => String(text).slice(0, 4000)), capturedAt }
}

/**
 * Create one evidence record.
 *
 * §5.2 requires every record to answer who produced it, what ran or was
 * observed, which project state it belongs to, whether the result is complete,
 * and where the raw material lives. A record missing any of those is created as
 * `unavailable` rather than being silently accepted as a fact.
 *
 * @param input - the evidence fields.
 * @returns a frozen evidence record.
 */
export function makeEvidence(input) {
  const {
    stage,
    producer,
    action,
    workspaceFingerprint = null,
    environmentFingerprint = null,
    validity,
    origin,
    summary,
    raw = null,
    complete,
    detail = null,
  } = input ?? {}

  if (!EVIDENCE_VALIDITY.includes(validity)) {
    throw new Error(`evidence validity must be one of ${EVIDENCE_VALIDITY.join('|')}, got ${String(validity)}`)
  }
  if (!EVIDENCE_ORIGIN.includes(origin)) {
    throw new Error(`evidence origin must be one of ${EVIDENCE_ORIGIN.join('|')}, got ${String(origin)}`)
  }

  const missing = []
  if (!producer) missing.push('producer')
  if (!action) missing.push('action')
  if (complete === undefined) missing.push('complete')
  if (raw === null && summary === undefined) missing.push('raw|summary')

  return Object.freeze({
    id: input?.id ?? makeId('ev'),
    stage: stage ?? STAGE.CHANGE,
    producer: producer ?? 'unknown',
    action: action ?? 'unknown',
    workspaceFingerprint,
    environmentFingerprint,
    validity: missing.length > 0 ? 'unavailable' : validity,
    origin,
    summary: summary ?? '',
    raw,
    complete: complete === true && missing.length === 0,
    detail,
    missing,
    createdAt: Date.now(),
  })
}

/**
 * Create one proposed finding.
 *
 * This only shapes and identifies; authorisation happens in
 * {@link authorizeFinding}, which is the only place `blocking` is decided.
 */
export function makeFinding(input) {
  const kind = input?.kind
  if (!FINDING_KIND.includes(kind)) {
    throw new Error(`finding kind must be one of ${FINDING_KIND.join('|')}, got ${String(kind)}`)
  }
  return {
    id: input?.id ?? makeId('finding'),
    kind,
    stage: input?.stage ?? STAGE.REVIEW,
    summary: String(input?.summary ?? ''),
    evidenceIds: Array.isArray(input?.evidenceIds) ? input.evidenceIds.filter((id) => typeof id === 'string') : [],
    requirementRefs: Array.isArray(input?.requirementRefs) ? input.requirementRefs : [],
    proposedBy: input?.proposedBy ?? 'engine',
    blocking: false,
    authority: 'none',
    action: FINDING_ACTION[kind],
    gateEffect: 'none',
    reason: 'not authorised yet',
    createdAt: Date.now(),
  }
}

/**
 * Decide whether a proposed finding may block, and on what authority.
 *
 * Kind and evidence both matter:
 *   - `advisory` can never block, whatever it cites;
 *   - a fact-bearing kind (`confirmed_defect`, `policy_violation`) must cite at
 *     least one VALID evidence record whose origin can establish a fact about
 *     the CURRENT project state. `historical_memory` alone cannot.
 *   - `verification_gap` blocks only when the policy says an unknown required
 *     check blocks; otherwise it stays a warning.
 *
 * @param finding - a finding from {@link makeFinding}.
 * @param context - `{ evidence, policy }` where `evidence` resolves ids.
 * @returns a new finding carrying the computed authorisation.
 */
export function authorizeFinding(finding, { evidence, policy } = {}) {
  const resolve = typeof evidence === 'function' ? evidence : (id) => (evidence instanceof Map ? evidence.get(id) : undefined)
  const cited = finding.evidenceIds.map((id) => resolve(id)).filter(Boolean)
  const unknownIds = finding.evidenceIds.filter((id) => resolve(id) === undefined)
  const valid = cited.filter((record) => record.validity === 'valid' && record.complete === true)
  const grounding = valid.filter((record) => EXECUTION_ORIGINS.includes(record.origin))

  const blockingForUnknown = (policy?.unknownRequiredCheck ?? 'block') === 'block'

  let authority = 'none'
  let gateEffect = 'none'
  let reason = ''

  switch (finding.kind) {
    case 'confirmed_defect': {
      if (grounding.length > 0) {
        authority = 'project_state'
        gateEffect = 'repair'
        reason = `grounded in ${grounding.length} valid current-state evidence record(s)`
      } else if (valid.some((record) => record.origin === 'baseline_execution')) {
        authority = 'baseline_state'
        gateEffect = 'repair'
        reason = 'grounded in baseline execution evidence'
      } else {
        authority = 'none'
        gateEffect = 'advisory'
        reason = unknownIds.length > 0
          ? `cites ${unknownIds.length} evidence id(s) that do not exist in the EvidenceStore`
          : 'no valid current-state or baseline evidence supports a confirmed defect'
      }
      break
    }
    case 'verification_gap': {
      authority = 'policy'
      gateEffect = blockingForUnknown ? 'needs_evidence' : 'advisory'
      reason = blockingForUnknown
        ? 'a required check has no execution evidence and the policy blocks unknown required checks'
        : 'a required check has no execution evidence; policy downgrades this to a warning'
      break
    }
    case 'environment_problem': {
      // An environmental claim needs evidence that the environment actually
      // failed: a timed-out, aborted, refused or incomplete execution. A
      // "valid" execution record would be evidence that it worked.
      const environmentEvidence = cited.filter(
        (record) => record.validity === 'unavailable' || record.validity === 'incomplete',
      )
      if (environmentEvidence.length > 0) {
        authority = 'environment'
        gateEffect = 'repair'
        reason = 'the check could not run in this environment; the fix is environmental, not a code change'
      } else {
        authority = 'none'
        gateEffect = 'advisory'
        reason = 'an environment problem must cite an execution that timed out, was aborted, or produced no usable result'
      }
      break
    }
    case 'policy_violation': {
      if (valid.length > 0) {
        authority = 'policy'
        gateEffect = 'repair'
        reason = 'grounded in valid current-state evidence'
      } else {
        authority = 'none'
        gateEffect = 'advisory'
        reason = 'a policy violation must cite valid current-state evidence'
      }
      break
    }
    case 'advisory':
    default: {
      authority = 'none'
      gateEffect = 'advisory'
      reason = 'advisory findings never block'
      break
    }
  }

  const blocking = gateEffect === 'repair' || gateEffect === 'needs_evidence'

  return {
    ...finding,
    blocking,
    authority,
    gateEffect,
    evidenceIds: finding.evidenceIds,
    validEvidenceIds: valid.map((record) => record.id),
    action: FINDING_ACTION[finding.kind],
    reason,
  }
}

/**
 * Second-guess one finding against the store (§7.5).
 *
 * This is deliberately separate from {@link authorizeFinding}: authorisation
 * decides whether a finding *may* block, validation decides whether the
 * finding was argued correctly at all. A finding that fails validation is
 * removed from the blocking set, never executed.
 *
 * @param finding - an authorised finding.
 * @param store - the EvidenceStore (or any object with `get(id)`).
 * @param options - `{ requireCurrentEvidence, currentFingerprint }`.
 * @returns `{ ok, code, reason }`.
 */
export function validateFinding(finding, store, options = {}) {
  const { requireCurrentEvidence = true, currentFingerprint = null } = options
  const get = (id) => (typeof store?.get === 'function' ? store.get(id) : undefined)

  for (const id of finding.evidenceIds) {
    if (get(id) === undefined) {
      return { ok: false, code: 'EVIDENCE_NOT_FOUND', reason: `evidence ${id} is not in the EvidenceStore` }
    }
  }

  const cited = finding.evidenceIds.map(get).filter(Boolean)

  if (finding.blocking) {
    const usable = cited.filter((record) => record.origin !== 'historical_memory' && record.origin !== 'model_inference')
    if (usable.length === 0) {
      return {
        ok: false,
        code: 'ORIGIN_INSUFFICIENT',
        reason: 'a blocking finding cannot rest on historical memory or model inference alone',
      }
    }
  }

  if (requireCurrentEvidence && finding.blocking) {
    const stale = cited.filter((record) => record.validity === 'stale')
    const current = cited.filter((record) => record.validity === 'valid')
    if (current.length === 0 && stale.length > 0) {
      return {
        ok: false,
        code: 'EVIDENCE_STALE',
        reason: `every cited record belongs to an earlier workspace state (${stale.map((record) => record.id).join(', ')})`,
      }
    }
    if (currentFingerprint !== null) {
      const mismatched = current.filter(
        (record) => record.workspaceFingerprint !== null && record.workspaceFingerprint !== currentFingerprint,
      )
      if (current.length > 0 && mismatched.length === current.length) {
        return {
          ok: false,
          code: 'EVIDENCE_WRONG_STATE',
          reason: 'cited evidence was produced for a different workspace fingerprint',
        }
      }
    }
  }

  if (finding.action === 'provide_evidence' && finding.kind !== 'verification_gap') {
    return {
      ok: false,
      code: 'ACTION_MISMATCH',
      reason: 'only a verification_gap may be answered by providing evidence',
    }
  }

  return { ok: true, code: 'OK', reason: finding.reason }
}

/**
 * Split the findings into the sets the controller acts on.
 *
 * @param findings - authorised findings.
 * @returns `{ blocking, advisory, repair, evidence, environment, policy }`.
 */
export function partitionFindings(findings = []) {
  const blocking = findings.filter((finding) => finding.blocking === true)
  return {
    all: findings,
    blocking,
    advisory: findings.filter((finding) => finding.blocking !== true),
    repair: blocking.filter((finding) => finding.gateEffect === 'repair' && finding.action === 'repair_code'),
    evidence: blocking.filter((finding) => finding.gateEffect === 'needs_evidence'),
    environment: blocking.filter((finding) => finding.kind === 'environment_problem'),
    policy: blocking.filter((finding) => finding.kind === 'policy_violation'),
  }
}

/**
 * Compute the gate decision from a task context.
 *
 * `completed` is produced here and only here: a caller cannot submit it. The
 * two acceptance axes are returned separately so "the code is verified but the
 * memory readback failed" cannot be reported as "the code is broken" (§2.2).
 *
 * @param context - the task context.
 * @returns the gate decision.
 */
export function computeGate(context) {
  const findings = context?.findings ?? []
  const parts = partitionFindings(findings)
  const requiredChecks = context?.requiredChecks ?? { total: 0, verified: 0, unknown: 0 }
  const finalizationStatus = context?.finalization?.status ?? 'pending'
  const acceptance = context?.acceptance ?? 'not_verified'

  if (context?.blocked === true) {
    return {
      gate: GATE.BLOCKED,
      technicalAcceptance: acceptance,
      finalizationStatus,
      reason: context.blockedReason ?? 'blocked by policy',
      blockingFindingIds: parts.blocking.map((finding) => finding.id),
    }
  }

  if (parts.blocking.length > 0) {
    const onlyEvidenceGaps = parts.repair.length === 0 && parts.environment.length === 0 && parts.policy.length === 0
    return {
      gate: onlyEvidenceGaps ? GATE.NEEDS_EVIDENCE : GATE.REPAIR,
      technicalAcceptance: 'not_verified',
      finalizationStatus,
      reason: `${parts.blocking.length} blocking finding(s)`,
      blockingFindingIds: parts.blocking.map((finding) => finding.id),
    }
  }

  if (requiredChecks.unknown > 0) {
    return {
      gate: GATE.NEEDS_EVIDENCE,
      technicalAcceptance: 'not_verified',
      finalizationStatus,
      reason: `${requiredChecks.unknown} required check(s) have no execution evidence`,
      blockingFindingIds: [],
    }
  }

  if (acceptance !== 'verified') {
    return {
      gate: GATE.NEEDS_EVIDENCE,
      technicalAcceptance: acceptance,
      finalizationStatus,
      reason: 'technical acceptance is not verified',
      blockingFindingIds: [],
    }
  }

  if (finalizationStatus !== 'complete' && finalizationStatus !== 'not_required') {
    return {
      gate: GATE.FINALIZE,
      technicalAcceptance: 'verified',
      finalizationStatus,
      reason: `technical verification passed; finalization is ${finalizationStatus}`,
      blockingFindingIds: [],
    }
  }

  return {
    gate: GATE.VERIFIED,
    technicalAcceptance: 'verified',
    finalizationStatus,
    reason: 'every required check has valid current-state evidence and finalization is settled',
    blockingFindingIds: [],
  }
}

/**
 * Build one retrieval receipt for a memory query (§7.2).
 *
 * @param input - query identity and outcome.
 * @returns the receipt.
 */
export function makeRetrievalReceipt(input) {
  return {
    queryId: input.queryId ?? makeId('memory_query'),
    checkpoint: input.checkpoint,
    purpose: input.purpose,
    query: input.query,
    status: input.status,
    memoryIds: input.memoryIds ?? [],
    source: input.source ?? 'unknown',
    toolName: input.toolName ?? null,
    error: input.error ?? null,
    attemptedAt: input.attemptedAt ?? Date.now(),
    elapsedMs: input.elapsedMs ?? 0,
  }
}

/**
 * Build the repair read ticket that gates automatic repair (§7.6).
 *
 * Only a `success` or `empty` retrieval whose ticket still matches the current
 * workspace and failure fingerprint authorises a normal automatic repair.
 *
 * @param input - ticket components.
 * @returns the ticket.
 */
export function makeRepairReadTicket(input) {
  return {
    ticketId: input.ticketId ?? makeId('repair_ticket'),
    taskId: input.taskId,
    workspaceFingerprint: input.workspaceFingerprint,
    failureFingerprint: input.failureFingerprint,
    memoryQueryId: input.memoryQueryId ?? null,
    queryStatus: input.queryStatus,
    repairPacketHash: input.repairPacketHash ?? null,
    issuedAt: Date.now(),
  }
}

/**
 * Decide whether a repair ticket still authorises automatic repair.
 *
 * @param ticket - the issued ticket.
 * @param current - `{ workspaceFingerprint, failureFingerprint }` now.
 * @returns `{ ok, code, reason }`.
 */
export function ticketAuthorizes(ticket, current) {
  if (!ticket) return { ok: false, code: 'NO_TICKET', reason: 'no retrieval receipt was issued' }
  if (!['success', 'empty'].includes(ticket.queryStatus)) {
    return { ok: false, code: 'RETRIEVAL_NOT_COMPLETE', reason: `mandatory pre-repair retrieval was ${ticket.queryStatus}` }
  }
  if (ticket.workspaceFingerprint !== current.workspaceFingerprint) {
    return { ok: false, code: 'WORKSPACE_MOVED', reason: 'the workspace changed after the retrieval' }
  }
  if (ticket.failureFingerprint !== current.failureFingerprint) {
    return { ok: false, code: 'FAILURE_CHANGED', reason: 'the observed failure changed after the retrieval' }
  }
  return { ok: true, code: 'OK', reason: 'retrieval receipt matches the current failure and workspace' }
}

/**
 * Build the repair packet injected into the Agent (§7.6).
 *
 * @param input - packet components.
 * @returns the packet.
 */
export function makeRepairPacket(input) {
  return {
    repairId: input.repairId ?? makeId('repair'),
    taskId: input.taskId,
    workspaceFingerprint: input.workspaceFingerprint,
    trigger: { stage: input.stage, findingIds: input.findingIds ?? [] },
    currentProblem: { summary: input.summary ?? '', evidenceIds: input.evidenceIds ?? [] },
    memoryRetrieval: {
      queryId: input.memoryQueryId ?? null,
      status: input.queryStatus,
      memoryIds: input.memoryIds ?? [],
    },
    taskHistoryIds: input.taskHistoryIds ?? [],
    requiredChecks: input.requiredChecks ?? [],
    constraints: input.constraints ?? [
      'Use current evidence to identify the cause.',
      'Treat historical experience as a hypothesis.',
      'Do not weaken tests merely to obtain a passing result.',
    ],
    restartFrom: input.restartFrom ?? STAGE.REGRESSION,
    cycle: input.cycle ?? 1,
    createdAt: Date.now(),
  }
}

/** Stable, order-independent hash input for one repair packet. */
export function repairPacketHash(packet) {
  return JSON.stringify({
    id: packet.repairId,
    taskId: packet.taskId,
    fingerprint: packet.workspaceFingerprint,
    findings: [...packet.trigger.findingIds].sort(),
    queryId: packet.memoryRetrieval.queryId,
    status: packet.memoryRetrieval.status,
  })
}
