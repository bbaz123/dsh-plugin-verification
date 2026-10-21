/**
 * Comparison contract: the §11 scenarios that decide whether a failure belongs
 * to this task.
 *
 * The whole reason comparison is per test item is that a suite-level bit cannot
 * tell "you broke this" from "this was already broken".
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { compareTestRuns, failureSignature, normalizeTestIdentity, parseJUnitXml, parseVitestJson } from '../lib/adapters.js'

/** One normalized test item. */
const item = (name, status, message = '') => {
  const base = { file: 'src/example.test.ts', name, status, failureMessages: message === '' ? [] : [message] }
  return { ...base, id: normalizeTestIdentity(base), signature: failureSignature(base) }
}

const run = (items) => ({ items, complete: true })

test('a test that passed at baseline and fails now is a new failure', () => {
  const comparison = compareTestRuns({
    baseline: run([item('works', 'passed')]),
    current: run([item('works', 'failed', 'boom')]),
    baselineAvailable: true,
  })
  assert.equal(comparison.verdict, 'new_failures')
  assert.equal(comparison.newFailures.length, 1)
  assert.equal(comparison.unchangedFailures.length, 0)
})

test('the same failure present at baseline is not blamed on this task', () => {
  const comparison = compareTestRuns({
    baseline: run([item('broken', 'failed', 'same message')]),
    current: run([item('broken', 'failed', 'same message')]),
    baselineAvailable: true,
  })
  assert.equal(comparison.verdict, 'pre_existing')
  assert.equal(comparison.newFailures.length, 0)
  assert.equal(comparison.unchangedFailures.length, 1)
})

test('a second, different failure is identified even while an old one persists', () => {
  const comparison = compareTestRuns({
    baseline: run([item('old', 'failed', 'old failure')]),
    current: run([item('old', 'failed', 'old failure'), item('new', 'failed', 'new failure')]),
    baselineAvailable: true,
  })
  assert.equal(comparison.verdict, 'new_failures')
  assert.deepEqual(comparison.newFailures.map((entry) => entry.name), ['new'])
  assert.deepEqual(comparison.unchangedFailures.map((entry) => entry.name), ['old'])
})

test('the same test failing with a different message counts as a new failure', () => {
  const comparison = compareTestRuns({
    baseline: run([item('works', 'failed', 'old reason')]),
    current: run([item('works', 'failed', 'completely different reason')]),
    baselineAvailable: true,
  })
  assert.equal(comparison.newFailures.length, 1)
})

test('a failure with no comparable baseline is attributed to nobody', () => {
  const comparison = compareTestRuns({
    baseline: null,
    current: run([item('works', 'failed', 'boom')]),
    baselineAvailable: false,
  })
  assert.equal(comparison.verdict, 'unknown_attribution')
  assert.match(comparison.reason, /attribution is undetermined/)
})

test('a captured-but-unneeded baseline leaves a clean run clean', () => {
  // The lazy baseline is only executed when the current side fails (§7.4), so
  // "no baseline execution this cycle" is a valid state — but only when a
  // baseline snapshot really exists.
  const comparison = compareTestRuns({
    baseline: null,
    current: run([item('works', 'passed')]),
    baselineAvailable: false,
    baselineEstablished: true,
  })
  assert.equal(comparison.verdict, 'clean')
  assert.equal(comparison.baselineState, 'established')
})

test('a run with no baseline ever captured is never "clean"', () => {
  // 2026-10-12 measured defect: "no baseline" plus "no failures observed" was
  // reported as `clean`, and the gate then reported `technicalAcceptance:
  // verified` with no comparable reference at all. "No reference point" is not
  // "no new failures" (§7.3), so the honest verdict is unproven.
  const comparison = compareTestRuns({
    baseline: null,
    current: run([item('works', 'passed')]),
    baselineAvailable: false,
    baselineEstablished: false,
  })
  assert.equal(comparison.verdict, 'baseline_never_established')
  assert.equal(comparison.baselineState, 'never_established')
  assert.match(comparison.reason, /no baseline was ever established/)
})

test('a deleted test is not a fixed test', () => {
  const comparison = compareTestRuns({
    baseline: run([item('works', 'passed'), item('gone', 'passed')]),
    current: run([item('works', 'passed')]),
    baselineAvailable: true,
  })
  assert.equal(comparison.verdict, 'integrity_violation')
  assert.deepEqual(comparison.disappeared.map((entry) => entry.name), ['gone'])
})

test('a newly skipped test is not a fixed test', () => {
  const comparison = compareTestRuns({
    baseline: run([item('works', 'failed', 'boom')]),
    current: run([item('works', 'skipped')]),
    baselineAvailable: true,
  })
  assert.equal(comparison.verdict, 'integrity_violation')
  assert.equal(comparison.newlySkipped.length, 1)
  // It must not be reported as fixed either: §7.3 forbids counting a skip as a fix.
  assert.equal(comparison.fixedFailures.length, 0)
})

test('a changed oracle invalidates the baseline comparison', () => {
  const comparison = compareTestRuns({
    baseline: run([item('works', 'passed')]),
    current: run([item('works', 'passed')]),
    baselineAvailable: true,
    oracleChanged: true,
  })
  assert.equal(comparison.verdict, 'oracle_changed')
})

test('a genuinely fixed failure is reported as fixed', () => {
  const comparison = compareTestRuns({
    baseline: run([item('works', 'failed', 'boom')]),
    current: run([item('works', 'passed')]),
    baselineAvailable: true,
  })
  assert.equal(comparison.verdict, 'clean')
  assert.equal(comparison.fixedFailures.length, 1)
})

test('a Vitest JSON report is parsed into normalized items', () => {
  const parsed = parseVitestJson(JSON.stringify({
    numTotalTests: 2,
    numPassedTests: 1,
    numFailedTests: 1,
    success: false,
    testResults: [{ name: 'src/a.test.ts', assertionResults: [
      { fullName: 'a works', status: 'passed' },
      { fullName: 'a breaks', status: 'failed', failureMessages: ['expected 1 to be 2'] },
    ] }],
  }))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.items.length, 2)
  assert.equal(parsed.items[1].status, 'failed')
  assert.equal(parsed.items[1].file, 'src/a.test.ts')
  assert.match(parsed.items[1].id, /src\/a\.test\.ts::a breaks/)
  assert.equal(parsed.summary.failed, 1)
})

test('an unparsable Vitest report fails instead of reporting zero tests', () => {
  const parsed = parseVitestJson('not json')
  assert.equal(parsed.ok, false)
  assert.match(parsed.error, /not valid JSON/)
})

test('a JUnit XML report is parsed, with failure text preserved', () => {
  const parsed = parseJUnitXml([
    '<testsuite name="pytest" tests="2" failures="1" errors="0" skipped="0">',
    '  <testcase classname="tests.test_a" name="test_ok" file="tests/test_a.py" time="0.01"/>',
    '  <testcase classname="tests.test_a" name="test_bad" file="tests/test_a.py" time="0.02"><failure message="assert 1 == 2">trace</failure></testcase>',
    '</testsuite>',
  ].join('\n'))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.items.length, 2)
  assert.equal(parsed.items[1].status, 'failed')
  assert.match(parsed.items[1].failureMessages.join(' '), /assert 1 == 2/)
})

test('an XML report without test cases is not treated as a passing run', () => {
  const parsed = parseJUnitXml('<html><body>404</body></html>')
  assert.equal(parsed.ok, false)
})

test('a failure signature is stable across whitespace and unstable across content', () => {
  const first = failureSignature({ status: 'failed', file: 'a', name: 'x', failureMessages: ['expected   1 to be 2'] })
  const second = failureSignature({ status: 'failed', file: 'a', name: 'x', failureMessages: ['expected 1 to be 2'] })
  const third = failureSignature({ status: 'failed', file: 'a', name: 'x', failureMessages: ['expected 1 to be 3'] })
  assert.equal(first, second)
  assert.notEqual(first, third)
})
