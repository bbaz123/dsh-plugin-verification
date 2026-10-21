/**
 * Tool-result contract: what a tool RETURNS must satisfy what that tool DECLARED.
 *
 * The host validates every tool result against `output.schema`, and the schemas
 * are `additionalProperties: false`. The first revision only ever exercised the
 * happy paths in tests, so two violating shapes shipped and both were reported by
 * the host at runtime instead:
 *
 *   - `verification_run` returned `gate: null`, `acceptance: null`, `detail: null`
 *     where the schema says `type: 'string'` →
 *     `tool "verification_run" returned invalid output: "value.gate" must be a string;
 *      "value.detail" must be a string`
 *     on exactly the `not_applicable` branch (the task where the gate does not run);
 *   - the "no live agent" payload carried `gate` / `detail`, which
 *     `verification_status` and `verification_finalize` never declare.
 *
 * This file therefore checks the SHAPE, per declared property, for every branch:
 * a `null` is never an acceptable stand-in for an absent optional field.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createTools } from '../lib/tools.js'

/**
 * Validate one value against one declared JSON-schema-ish shape.
 *
 * Only the keywords these three tools actually declare are implemented, so the
 * check stays readable and cannot silently pass an unknown construct.
 *
 * @returns an array of human-readable problems (empty means conforming).
 */
function problemsOf(schema, value, path = 'value') {
  const problems = []
  const type = schema?.type
  if (type === 'string') {
    if (typeof value !== 'string') problems.push(`${path} must be a string (got ${JSON.stringify(value)})`)
  } else if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) problems.push(`${path} must be a number (got ${JSON.stringify(value)})`)
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') problems.push(`${path} must be a boolean (got ${JSON.stringify(value)})`)
  } else if (type === 'array') {
    if (!Array.isArray(value)) problems.push(`${path} must be an array`)
  } else if (type === 'object') {
    const isObject = value !== null && typeof value === 'object' && !Array.isArray(value)
    if (!isObject) {
      problems.push(`${path} must be an object (got ${JSON.stringify(value)})`)
    } else {
      const properties = schema.properties ?? {}
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(key in properties)) problems.push(`${path}.${key} is not declared by the tool schema`)
        }
      }
      for (const [key, sub] of Object.entries(properties)) {
        if (key in value) problems.push(...problemsOf(sub, value[key], `${path}.${key}`))
      }
    }
  } else if (type !== undefined && type !== 'json') {
    // A declared property without `type` (the host normalises `type: 'json'` to
    // `{}`) constrains nothing; only an unknown KEYWORD is a problem.
    problems.push(`${path} declares an unsupported type ${JSON.stringify(type)}`)
  }
  if (Array.isArray(schema?.enum) && !schema.enum.includes(value)) {
    problems.push(`${path} must be one of ${schema.enum.join('/')} (got ${JSON.stringify(value)})`)
  }
  return problems
}

/** A controller stub whose every branch can be steered from the test. */
function stubController(overrides = {}) {
  const taskState = {
    taskId: 'task_1',
    sessionId: 'session_1',
    state: 'working',
    cycle: 0,
    maxRepairCycles: 3,
    requirementsRevision: 1,
    requirements: [],
    regression: [],
    assertions: [],
    memoryQueries: [],
    ledger: [],
    evidence: [],
    findings: [],
    finalization: { status: 'pending', attempts: 0 },
    acceptance: 'not_applicable',
    baselineFingerprint: null,
    workspaceFingerprint: null,
    ...(overrides.taskState ?? {}),
  }
  return {
    async status() {
      return overrides.status ?? {
        ok: true,
        context: { taskState, evidenceStore: { list: () => [] }, ledger: { list: () => [] }, applicable: false },
      }
    },
    async run() {
      return overrides.run ?? { action: 'none', skip: 'NO_SUPPORTED_PROJECT' }
    },
    async releaseBlock() {
      return overrides.releaseBlock ?? { ok: true, released: 0 }
    },
    async finalize() {
      return overrides.finalize ?? { ok: false, error: 'stub' }
    },
  }
}

function toolsFor(controller) {
  return createTools({ controller, config: { defaultMode: 'regression' }, logger: { info() {}, warn() {}, debug() {}, error() {} } })
}

/** Run one branch and assert its value conforms to the tool's OWN declared schema. */
async function assertConforms(tool, args, exec, label) {
  const value = await tool.execute(args, exec)
  const problems = problemsOf(tool.output.schema, value)
  assert.deepEqual(problems, [], `${label}: ${tool.name} returned a shape its declared schema rejects → ${problems.join('; ')}`)
  assert.equal(typeof tool.render, 'undefined' || typeof tool.output.render, 'function')
  // The renderer must survive the same value the host would hand it.
  assert.doesNotThrow(() => tool.output.render(args, value), `${label}: ${tool.name} render() threw on its own value`)
  return value
}

test('verification_run conforms to its declared schema when the gate does not run', async () => {
  const [run] = toolsFor(stubController())
  const value = await assertConforms(run, {}, { agent: { id: 'session_1' } }, 'not applicable')
  assert.equal(value.status, 'OK')
  assert.equal(value.code, 'NO_SUPPORTED_PROJECT')
  // The fix: no `null` stand-ins. A field with no value is ABSENT; a field that
  // does have one keeps its declared type.
  assert.equal('gate' in value, false)
  assert.equal(value.acceptance, 'not_applicable')
  assert.equal('detail' in value, false)
})

test('verification_run conforms when it reports a real gate verdict', async () => {
  const [run] = toolsFor(stubController({
    run: { action: 'complete', gate: { gate: 'verified', technicalAcceptance: 'verified', reason: 'ok' }, skip: undefined },
  }))
  const value = await assertConforms(run, {}, { agent: { id: 'session_1' } }, 'complete')
  assert.equal(value.gate, 'verified')
  assert.equal(value.acceptance, 'verified')
})

test('verification_run conforms when the gate blocks', async () => {
  const [run] = toolsFor(stubController({
    run: { action: 'block', reason: 'BUDGET_EXHAUSTED', detail: 'maxRepairCycles reached', gate: { gate: 'repair' } },
  }))
  const value = await assertConforms(run, {}, { agent: { id: 'session_1' } }, 'blocked')
  assert.equal(value.status, 'BLOCKED')
  assert.equal(value.detail, 'maxRepairCycles reached')
})

test('verification_run conforms when releasing a block fails', async () => {
  // The branch the first schema fix missed: it returned `gate: null,
  // detail: null` while the schema says `string`.
  const [run] = toolsFor(stubController({ releaseBlock: { ok: false, error: 'the task is not blocked' } }))
  const value = await assertConforms(run, { release: true }, { agent: { id: 'session_1' } }, 'release failed')
  assert.equal(value.code, 'RELEASE_FAILED')
  assert.equal('gate' in value, false)
  assert.equal('detail' in value, false)
})

test('every tool conforms on the no-live-agent path', async () => {
  const argsForFinalize = { report: 'x'.repeat(60), memoryOutcome: 'none' }
  for (const tool of toolsFor(stubController())) {
    const args = tool.name === 'verification_finalize' ? argsForFinalize : {}
    // `defineTool` enforces declared arguments before execute runs, so the
    // no-agent payload is only reachable with schema-valid arguments.
    const value = await assertConforms(tool, args, {}, 'no agent')
    assert.equal(value.status, 'ERROR')
    assert.equal(value.code, 'NO_AGENT')
  }
})

test('verification_status conforms on its unavailable path', async () => {
  const [, status] = toolsFor(stubController({ status: { ok: false, error: 'EACCES' } }))
  const value = await assertConforms(status, {}, { agent: { id: 'session_1' } }, 'status unavailable')
  assert.equal(value.code, 'STATUS_UNAVAILABLE')
  assert.equal('summary' in value, false)
})

test('verification_status conforms on the normal path', async () => {
  const [, status] = toolsFor(stubController())
  const value = await assertConforms(status, {}, { agent: { id: 'session_1' } }, 'status ok')
  assert.equal(value.status, 'OK')
  assert.ok(value.summary)
})

test('verification_finalize conforms on every refusal path', async () => {
  const [, , finalize] = toolsFor(stubController())
  await assertConforms(finalize, { report: 'too short', memoryOutcome: 'none' }, { agent: { id: 'session_1' } }, 'report too short')
  await assertConforms(finalize, { report: 'x'.repeat(60), memoryOutcome: 'written' }, { agent: { id: 'session_1' } }, 'missing excerpt')
})

test('verification_finalize conforms when the controller rejects the submission', async () => {
  const [, , finalize] = toolsFor(stubController({ finalize: { ok: false, error: 'state unreadable' } }))
  const value = await assertConforms(
    finalize,
    { report: 'x'.repeat(60), memoryOutcome: 'none' },
    { agent: { id: 'session_1' } },
    'finalize failed',
  )
  assert.equal(value.code, 'FINALIZE_FAILED')
})

test('verification_finalize conforms on a real readback verdict', async () => {
  const [, , finalize] = toolsFor(stubController({
    finalize: {
      ok: true,
      readback: { status: 'complete', code: 'CONTENT_MATCH', detail: 'matched', observedWrites: ['mcp__openviking__write'], observedReads: ['mcp__openviking__read'] },
      gate: { gate: 'verified', technicalAcceptance: 'verified' },
    },
  }))
  const value = await assertConforms(
    finalize,
    { report: 'x'.repeat(60), memoryOutcome: 'none' },
    { agent: { id: 'session_1' } },
    'finalize verified',
  )
  assert.equal(value.finalization, 'complete')
})
