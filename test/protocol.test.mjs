/**
 * Protocol contract: the plugin, not the model, decides who may block.
 *
 * These are the rules §5.3 and §7.5 state in prose; here they are executable.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  authorizeFinding,
  computeGate,
  EVIDENCE_ORIGIN,
  EVIDENCE_VALIDITY,
  FINALIZATION_STATUS,
  GATE,
  makeEvidence,
  makeFinding,
  makeRepairReadTicket,
  partitionFindings,
  ticketAuthorizes,
  validateFinding,
} from '../lib/protocol.js'
import { EvidenceStore } from '../lib/store.js'

/** A store holding one valid current-execution record. */
function storeWith(records) {
  const store = new EvidenceStore()
  for (const record of records) store.add(record)
  return store
}

const currentExecution = (fingerprint = 'sha256:current') => makeEvidence({
  stage: 'regression',
  producer: 'test',
  action: 'ran the suite',
  workspaceFingerprint: fingerprint,
  validity: 'valid',
  origin: 'current_execution',
  summary: 'one test failed',
  raw: '/reports/vitest.json',
  complete: true,
})

const policy = { unknownRequiredCheck: 'block' }

test('makeEvidence refuses an unknown validity or origin', () => {
  assert.throws(() => makeEvidence({ validity: 'maybe', origin: 'current_execution' }), /validity/)
  assert.throws(() => makeEvidence({ validity: 'valid', origin: 'feeling' }), /origin/)
})

test('makeEvidence downgrades a record that is missing its minimum fields', () => {
  const record = makeEvidence({ stage: 'regression', origin: 'current_execution', validity: 'valid', summary: 'x' })
  assert.equal(record.validity, 'unavailable')
  assert.equal(record.complete, false)
  assert.ok(record.missing.includes('producer'))
  assert.ok(record.missing.includes('action'))
})

test('every declared vocabulary is exposed for consumers', () => {
  assert.deepEqual(EVIDENCE_VALIDITY, ['valid', 'stale', 'incomplete', 'unavailable'])
  assert.ok(EVIDENCE_ORIGIN.includes('historical_memory'))
})

test('an advisory finding never blocks, whatever evidence it cites', () => {
  const record = currentExecution()
  const store = storeWith([record])
  const finding = authorizeFinding(makeFinding({ kind: 'advisory', summary: 'maybe', evidenceIds: [record.id] }), {
    evidence: store.resolver(),
    policy,
  })
  assert.equal(finding.blocking, false)
  assert.equal(finding.gateEffect, 'advisory')
  assert.equal(finding.authority, 'none')
})

test('a confirmed defect grounded in valid current-state evidence may block', () => {
  const record = currentExecution()
  const store = storeWith([record])
  const finding = authorizeFinding(makeFinding({ kind: 'confirmed_defect', summary: 'broke it', evidenceIds: [record.id] }), {
    evidence: store.resolver(),
    policy,
  })
  assert.equal(finding.blocking, true)
  assert.equal(finding.authority, 'project_state')
  assert.equal(finding.action, 'repair_code')
})

test('a confirmed defect citing an id that does not exist is downgraded, not trusted', () => {
  const store = storeWith([])
  const finding = authorizeFinding(makeFinding({ kind: 'confirmed_defect', summary: 'broke it', evidenceIds: ['ev_missing'] }), {
    evidence: store.resolver(),
    policy,
  })
  assert.equal(finding.blocking, false)
  assert.match(finding.reason, /do not exist/)
})

test('historical memory alone cannot establish a confirmed defect', () => {
  const record = makeEvidence({
    stage: 'memory',
    producer: 'test',
    action: 'retrieved experience',
    validity: 'valid',
    origin: 'historical_memory',
    summary: 'this happened before',
    raw: 'viking://x',
    complete: true,
  })
  const store = storeWith([record])
  const finding = authorizeFinding(makeFinding({ kind: 'confirmed_defect', summary: 'probably broken', evidenceIds: [record.id] }), {
    evidence: store.resolver(),
    policy,
  })
  assert.equal(finding.blocking, false)
  assert.equal(finding.gateEffect, 'advisory')
})

test('an incomplete evidence record cannot ground a defect', () => {
  const record = makeEvidence({
    stage: 'regression',
    producer: 'test',
    action: 'ran the suite',
    validity: 'incomplete',
    origin: 'current_execution',
    summary: 'report missing',
    raw: '/reports/missing.json',
    complete: false,
  })
  const store = storeWith([record])
  const finding = authorizeFinding(makeFinding({ kind: 'confirmed_defect', summary: 'x', evidenceIds: [record.id] }), {
    evidence: store.resolver(),
    policy,
  })
  assert.equal(finding.blocking, false)
})

test('a verification gap blocks only when the policy blocks unknown required checks', () => {
  const store = storeWith([])
  const proposed = makeFinding({ kind: 'verification_gap', summary: 'no evidence for the required check' })
  const blocking = authorizeFinding(proposed, { evidence: store.resolver(), policy: { unknownRequiredCheck: 'block' } })
  const warning = authorizeFinding(proposed, { evidence: store.resolver(), policy: { unknownRequiredCheck: 'warn' } })
  assert.equal(blocking.blocking, true)
  assert.equal(blocking.action, 'provide_evidence')
  assert.equal(warning.blocking, false)
})

test('an environment problem needs evidence that the environment really failed', () => {
  const record = makeEvidence({
    stage: 'assertion',
    producer: 'test',
    action: 'ran typecheck',
    validity: 'unavailable',
    origin: 'current_execution',
    summary: 'the command timed out',
    raw: null,
    complete: false,
  })
  const store = storeWith([record])
  const grounded = authorizeFinding(makeFinding({ kind: 'environment_problem', summary: 'timed out', evidenceIds: [record.id] }), {
    evidence: store.resolver(),
    policy,
  })
  const ungrounded = authorizeFinding(makeFinding({ kind: 'environment_problem', summary: 'timed out', evidenceIds: [] }), {
    evidence: store.resolver(),
    policy,
  })
  assert.equal(grounded.blocking, true)
  assert.equal(grounded.action, 'fix_environment')
  assert.equal(ungrounded.blocking, false)
})

test('validateFinding rejects a finding whose evidence id is not in the store', () => {
  const store = storeWith([])
  const finding = makeFinding({ kind: 'confirmed_defect', summary: 'x', evidenceIds: ['ev_nope'] })
  const verdict = validateFinding({ ...finding, blocking: true }, store)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, 'EVIDENCE_NOT_FOUND')
})

test('validateFinding rejects a blocking finding argued only from historical memory', () => {
  const record = makeEvidence({
    stage: 'memory',
    producer: 'test',
    action: 'retrieved',
    validity: 'valid',
    origin: 'historical_memory',
    summary: 'seen before',
    raw: 'viking://x',
    complete: true,
  })
  const store = storeWith([record])
  const verdict = validateFinding({ ...makeFinding({ kind: 'advisory', summary: 'x', evidenceIds: [record.id] }), blocking: true }, store)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, 'ORIGIN_INSUFFICIENT')
})

test('validateFinding rejects evidence that belongs to an earlier workspace state', () => {
  const stale = makeEvidence({
    stage: 'regression',
    producer: 'test',
    action: 'ran the suite',
    workspaceFingerprint: 'sha256:old',
    validity: 'stale',
    origin: 'current_execution',
    summary: 'failed before an edit',
    raw: '/reports/old.json',
    complete: true,
  })
  const store = storeWith([stale])
  const finding = { ...makeFinding({ kind: 'confirmed_defect', summary: 'x', evidenceIds: [stale.id] }), blocking: true }
  const staleVerdict = validateFinding(finding, store, { requireCurrentEvidence: true })
  assert.equal(staleVerdict.ok, false)
  assert.equal(staleVerdict.code, 'EVIDENCE_STALE')
})

test('validateFinding rejects current evidence produced for a different fingerprint', () => {
  const record = currentExecution('sha256:other')
  const store = storeWith([record])
  const finding = { ...makeFinding({ kind: 'confirmed_defect', summary: 'x', evidenceIds: [record.id] }), blocking: true }
  const verdict = validateFinding(finding, store, { requireCurrentEvidence: true, currentFingerprint: 'sha256:mine' })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, 'EVIDENCE_WRONG_STATE')
})

test('validateFinding accepts a properly argued blocking finding', () => {
  const record = currentExecution('sha256:mine')
  const store = storeWith([record])
  const finding = { ...makeFinding({ kind: 'confirmed_defect', summary: 'x', evidenceIds: [record.id] }), blocking: true }
  const verdict = validateFinding(finding, store, { requireCurrentEvidence: true, currentFingerprint: 'sha256:mine' })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.code, 'OK')
})

test('the gate sends a blocking defect to repair and a missing check to evidence collection', () => {
  const store = storeWith([currentExecution('sha256:mine')])
  const record = store.list()[0]
  const defect = authorizeFinding(makeFinding({ kind: 'confirmed_defect', summary: 'x', evidenceIds: [record.id] }), { evidence: store.resolver(), policy })
  const gap = authorizeFinding(makeFinding({ kind: 'verification_gap', summary: 'y' }), { evidence: store.resolver(), policy })

  assert.equal(computeGate({ findings: [defect], acceptance: 'not_verified', requiredChecks: { total: 1, verified: 1, unknown: 0 } }).gate, GATE.REPAIR)
  assert.equal(computeGate({ findings: [gap], acceptance: 'not_verified', requiredChecks: { total: 1, verified: 0, unknown: 1 } }).gate, GATE.NEEDS_EVIDENCE)
  assert.equal(partitionFindings([defect, gap]).blocking.length, 2)
})

test('the gate cannot produce a verified completion while a required check is unknown', () => {
  const decision = computeGate({
    findings: [],
    acceptance: 'verified',
    requiredChecks: { total: 3, verified: 2, unknown: 1 },
    finalization: { status: 'pending' },
  })
  assert.equal(decision.gate, GATE.NEEDS_EVIDENCE)
  assert.equal(decision.technicalAcceptance, 'not_verified')
})

test('verified code with unfinished finalization asks for finalization, not repair', () => {
  const decision = computeGate({
    findings: [],
    acceptance: 'verified',
    requiredChecks: { total: 1, verified: 1, unknown: 0 },
    finalization: { status: FINALIZATION_STATUS[2] },
  })
  assert.equal(decision.gate, GATE.FINALIZE)
  assert.equal(decision.technicalAcceptance, 'verified')
})

test('a task counts as verified only when every condition holds', () => {
  const decision = computeGate({
    findings: [],
    acceptance: 'verified',
    requiredChecks: { total: 1, verified: 1, unknown: 0 },
    finalization: { status: FINALIZATION_STATUS[0] },
  })
  assert.equal(decision.gate, GATE.VERIFIED)
})

test('a blocked task reports blocked regardless of the other inputs', () => {
  const decision = computeGate({
    findings: [],
    acceptance: 'verified',
    requiredChecks: { total: 1, verified: 1, unknown: 0 },
    finalization: { status: FINALIZATION_STATUS[0] },
    blocked: true,
    blockedReason: 'NO_PROGRESS',
  })
  assert.equal(decision.gate, GATE.BLOCKED)
  assert.match(decision.reason, /NO_PROGRESS/)
})

test('a repair ticket authorises a repair only for the same failure and workspace', () => {
  const ticket = makeRepairReadTicket({
    taskId: 't1',
    workspaceFingerprint: 'sha256:ws',
    failureFingerprint: 'sha256:fail',
    memoryQueryId: 'q1',
    queryStatus: 'success',
  })
  assert.equal(ticketAuthorizes(ticket, { workspaceFingerprint: 'sha256:ws', failureFingerprint: 'sha256:fail' }).ok, true)
  assert.equal(ticketAuthorizes(ticket, { workspaceFingerprint: 'sha256:other', failureFingerprint: 'sha256:fail' }).code, 'WORKSPACE_MOVED')
  assert.equal(ticketAuthorizes(ticket, { workspaceFingerprint: 'sha256:ws', failureFingerprint: 'sha256:other' }).code, 'FAILURE_CHANGED')
  const failed = makeRepairReadTicket({
    taskId: 't1',
    workspaceFingerprint: 'sha256:ws',
    failureFingerprint: 'sha256:fail',
    memoryQueryId: null,
    queryStatus: 'failed',
  })
  assert.equal(ticketAuthorizes(failed, { workspaceFingerprint: 'sha256:ws', failureFingerprint: 'sha256:fail' }).code, 'RETRIEVAL_NOT_COMPLETE')
})
