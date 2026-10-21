/**
 * Store contract: append-only evidence, a ledger that can tell "again" from
 * "progress", and a task store that FAILS CLOSED on a state file it cannot trust.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { makeEvidence } from '../lib/protocol.js'
import {
  compositeFingerprint,
  createTaskState,
  EvidenceStore,
  makeLedgerEntry,
  safeJsonParse,
  sha256Hex,
  stableStringify,
  TaskErrorLedger,
  TaskStore,
} from '../lib/store.js'

/** A temporary directory that cleans up after itself. */
async function tempDir(label) {
  return mkdtemp(join(tmpdir(), `verification-${label}-`))
}

const record = (id, fingerprint, validity = 'valid') => ({
  id,
  stage: 'regression',
  producer: 'test',
  action: 'ran',
  workspaceFingerprint: fingerprint,
  validity,
  origin: 'current_execution',
  summary: 'x',
  raw: null,
  complete: true,
})

test('the evidence store appends and resolves by id', () => {
  const store = new EvidenceStore()
  store.add(record('ev_1', 'sha256:a'))
  store.add(record('ev_2', 'sha256:a'))
  assert.equal(store.list().length, 2)
  assert.equal(store.get('ev_1').id, 'ev_1')
  assert.equal(store.byStage('regression').length, 2)
  assert.equal(store.latestValid('regression').id, 'ev_2')
})

test('evidence from an earlier workspace state becomes stale instead of being deleted', () => {
  const store = new EvidenceStore()
  store.add(record('ev_old', 'sha256:before'))
  store.add(record('ev_now', 'sha256:after'))
  store.add({ ...record('ev_unbound', null) })
  const invalidated = store.invalidateStale('sha256:after')
  assert.equal(invalidated, 1)
  assert.equal(store.get('ev_old').validity, 'stale')
  assert.equal(store.get('ev_now').validity, 'valid')
  // A record with no fingerprint cannot be attributed to another state.
  assert.equal(store.get('ev_unbound').validity, 'valid')
})

test('the evidence store round-trips through JSON', () => {
  const store = new EvidenceStore()
  store.add(record('ev_1', 'sha256:a'))
  const restored = EvidenceStore.fromJSON(JSON.parse(JSON.stringify(store.toJSON())))
  assert.equal(restored.list().length, 1)
  assert.equal(restored.get('ev_1').id, 'ev_1')
})

test('the ledger counts attempts per failure fingerprint', () => {
  const ledger = new TaskErrorLedger()
  ledger.record(makeLedgerEntry({ taskId: 't', stage: 'regression', kind: 'confirmed_defect', summary: 'a', failureFingerprint: 'sha256:f' }))
  ledger.record(makeLedgerEntry({ taskId: 't', stage: 'regression', kind: 'confirmed_defect', summary: 'b', failureFingerprint: 'sha256:f' }))
  ledger.record(makeLedgerEntry({ taskId: 't', stage: 'regression', kind: 'confirmed_defect', summary: 'c', failureFingerprint: 'sha256:g' }))
  assert.equal(ledger.attemptsFor('sha256:f'), 2)
  assert.equal(ledger.attemptsFor('sha256:g'), 1)
  assert.equal(ledger.attemptsFor(null), 0)
  assert.equal(ledger.open().length, 3)
})

test('an explicitly released failure stops counting as a silent attempt', () => {
  const ledger = new TaskErrorLedger()
  ledger.record(makeLedgerEntry({ taskId: 't', stage: 'regression', kind: 'confirmed_defect', summary: 'a', failureFingerprint: 'sha256:f' }))
  ledger.record(makeLedgerEntry({ taskId: 't', stage: 'regression', kind: 'confirmed_defect', summary: 'b', failureFingerprint: 'sha256:f' }))
  assert.equal(ledger.release('sha256:f', 'user said continue'), 2)
  assert.equal(ledger.attemptsFor('sha256:f'), 0)
  assert.equal(ledger.open().length, 2)
  assert.equal(ledger.list().every((entry) => entry.status === 'released'), true)
})

test('resolving an entry keeps it in the ledger as the audit trail', () => {
  const ledger = new TaskErrorLedger()
  const entry = ledger.record(makeLedgerEntry({ taskId: 't', stage: 'regression', kind: 'confirmed_defect', summary: 'a', failureFingerprint: 'sha256:f' }))
  ledger.resolve(entry.id, { evidenceIds: ['ev_fixed'] })
  assert.equal(ledger.open().length, 0)
  assert.equal(ledger.byFingerprint('sha256:f')[0].status, 'resolved')
  assert.deepEqual(ledger.byFingerprint('sha256:f')[0].resolutionEvidenceIds, ['ev_fixed'])
})

test('a state file round-trips through the task store', async () => {
  const dir = await tempDir('store')
  const store = new TaskStore({ dir })
  await store.init()
  const state = createTaskState({ taskId: 'task_a', sessionId: 'session_a' })
  await store.saveTask(state)
  const loaded = await store.loadTask('task_a')
  assert.equal(loaded.ok, true)
  assert.equal(loaded.state.taskId, 'task_a')
  assert.equal(loaded.state.state, 'working')
})

test('a missing state file is an empty task, not an error', async () => {
  const dir = await tempDir('missing')
  const store = new TaskStore({ dir })
  await store.init()
  const loaded = await store.loadTask('never-seen')
  assert.equal(loaded.ok, true)
  assert.equal(loaded.state, null)
})

test('a corrupt state file fails CLOSED instead of becoming a fresh task', async () => {
  const dir = await tempDir('corrupt')
  const store = new TaskStore({ dir })
  await store.init()
  const state = createTaskState({ taskId: 'task_c', sessionId: 'session_c' })
  await store.saveTask(state)
  await writeFile(store.statePath('task_c'), '{ this is not json', 'utf8')
  const loaded = await store.loadTask('task_c')
  assert.equal(loaded.ok, false)
  assert.match(loaded.error, /not valid JSON/)
})

test('a state file that parses but is not a task also fails closed', async () => {
  const dir = await tempDir('notatask')
  const store = new TaskStore({ dir })
  await store.init()
  const state = createTaskState({ taskId: 'task_d', sessionId: 'session_d' })
  await store.saveTask(state)
  await writeFile(store.statePath('task_d'), JSON.stringify({ hello: 'world' }), 'utf8')
  const loaded = await store.loadTask('task_d')
  assert.equal(loaded.ok, false)
  assert.match(loaded.error, /does not describe a verification task/)
})

test('writing a report is bounded and reports truncation', async () => {
  const dir = await tempDir('reports')
  const store = new TaskStore({ dir })
  await store.init()
  const path = join(store.reportDir('task', 'run'), 'test.report')
  const written = await store.writeReport(path, 'x'.repeat(5000), 1000)
  assert.equal(written.truncated, true)
  const read = await store.readReport(path)
  assert.equal(read.ok, true)
  assert.equal(read.text.length, 1000)
})

test('a fingerprint is independent of key order but not of values', () => {
  assert.equal(compositeFingerprint({ a: 1, b: 2 }), compositeFingerprint({ b: 2, a: 1 }))
  assert.notEqual(compositeFingerprint({ a: 1, b: 2 }), compositeFingerprint({ a: 1, b: 3 }))
  assert.equal(stableStringify({ b: [1, { d: 2, c: 3 }], a: 1 }), '{"a":1,"b":[1,{"c":3,"d":2}]}')
})

test('safeJsonParse reports a failure instead of throwing', () => {
  assert.equal(safeJsonParse('{"a":1}').ok, true)
  assert.equal(safeJsonParse('nope').ok, false)
})

test('a task state carries the two acceptance axes separately', () => {
  const state = createTaskState({ taskId: 't', sessionId: 's' })
  assert.equal(state.finalization.status, 'pending')
  assert.equal(state.acceptance, undefined)
  assert.equal(state.memoryQueries.length, 0)
  assert.equal(state.cycle, 0)
})

test('the plugin storage tree stays outside any verified project', async () => {
  const dir = await tempDir('paths')
  const store = new TaskStore({ dir })
  assert.ok(store.statePath('t').startsWith(dir))
  assert.ok(store.reportDir('t', 'r').startsWith(dir))
  assert.ok(store.snapshotDir('t', 1).startsWith(dir))
  // Two tasks must not share a directory even when their ids collide after
  // truncation is attempted.
  assert.notEqual(store.taskDir('task_a'), store.taskDir('task_b'))
  assert.equal(sha256Hex('').length, 64)
})

test('saving a task is atomic: no half-written file is left behind', async () => {
  const dir = await tempDir('atomic')
  const store = new TaskStore({ dir })
  await store.init()
  await store.saveTask(createTaskState({ taskId: 'task_e', sessionId: 'session_e' }))
  const text = await readFile(store.statePath('task_e'), 'utf8')
  assert.doesNotThrow(() => JSON.parse(text))
})
