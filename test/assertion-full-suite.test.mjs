import test from 'node:test'
import assert from 'node:assert/strict'

import { evaluateAssertions } from '../lib/modules/assertion.js'
import { createRegressionEngine } from '../lib/modules/regression.js'

/**
 * `full-suite` is a synthetic required check left over from older task state.
 * The assertion stage maps it to the project's declared `test` check, but only
 * when the real folded regression record says the check completed with a
 * complete, present report and a zero exit code.
 *
 * The fixtures below build `outcomes` and pass them through the real
 * `foldSide()` (instead of hand-writing `byCheck`), so a contract change in
 * regression.js makes these tests fail too.
 */
const engine = createRegressionEngine({ executor: {}, config: {}, store: {}, logger: {} })

function byCheckOf(overrides = {}, extra = []) {
  const outcome = {
    check: { id: 'test', kind: 'test', command: 'node --test', adapter: 'node', reportFormat: 'node' },
    report: { status: 'completed', exitCode: 0, complete: true, durationMs: 1, stdout: '', stderr: '', ...(overrides.report || {}) },
    reportMissing: overrides.reportMissing === true,
    parsed: overrides.parsed || { items: [], summary: { total: 1, passed: 1, failed: 0 }, error: null },
    evidence: { id: 'ev1' },
  }
  const folded = engine.foldSide([outcome, ...extra])
  return folded.byCheck
}

function evaluate(byCheck, requiredChecks = [{ id: 'full-suite' }]) {
  return evaluateAssertions({
    regression: { current: { byCheck } },
    plan: { checks: [{ id: 'test' }] },
    requiredChecks,
    memorySuggestions: [],
    taskState: {},
  })
}

test('full-suite is covered by a completed project test check (real foldSide output)', () => {
  const result = evaluate(byCheckOf())
  assert.equal(result.unknownRequired.length, 0)
  assert.equal(result.summary.unknownRequired, 0)
})

test('covering full-suite leaves an assertion with the test evidence id', () => {
  const result = evaluate(byCheckOf())
  const mapped = result.assertions.find((entry) => entry.name.startsWith('full-suite (mapped from test)'))
  assert.ok(mapped, 'mapped assertion should exist')
  assert.equal(mapped.status, 'passed')
  assert.deepEqual(mapped.evidenceIds, ['ev1'])
})

test('a failed project test check does NOT cover full-suite', () => {
  const result = evaluate(byCheckOf({ report: { status: 'failed', exitCode: 2 } }))
  assert.equal(result.unknownRequired.length, 1)
  assert.equal(result.unknownRequired[0].id, 'full-suite')
})

test('one green test cannot mask another failed test check', () => {
  const failed = {
    check: { id: 'test:e2e', kind: 'test', command: 'node --test e2e', adapter: 'node', reportFormat: 'node' },
    report: { status: 'failed', exitCode: 2, complete: true, stdout: '', stderr: '' },
    reportMissing: false,
    parsed: { items: [], summary: { total: 1, passed: 0, failed: 1 }, error: null },
    evidence: { id: 'ev2' },
  }
  const result = evaluate(byCheckOf({}, [failed]))
  assert.equal(result.unknownRequired.length, 1)
})

test('other uncovered required checks are still reported', () => {
  const result = evaluate(byCheckOf(), [{ id: 'full-suite' }, { id: 'lint' }])
  assert.deepEqual(result.unknownRequired.map((entry) => entry.id), ['lint'])
})

for (const [label, overrides] of [
  ['truncated output (complete=false)', { report: { complete: false } }],
  ['missing report (reportMissing=true)', { reportMissing: true }],
  ['nonzero exit (exitCode=2)', { report: { exitCode: 2 } }],
  ['skipped status', { report: { status: 'skipped' } }],
]) {
  test(`incomplete test execution does not cover full-suite: ${label}`, () => {
    const result = evaluate(byCheckOf(overrides))
    assert.equal(result.unknownRequired.length, 1)
  })
}
