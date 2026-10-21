/**
 * End-to-end contract with a controllable test double.
 *
 * This is the §11 "most critical" scenario, plus the checkpoints that must not be
 * silently skipped:
 *
 *   first edit breaks a test → the gate really detects it
 *     → OpenViking retrieval is actually performed
 *       → the next input really contains the repair packet
 *         → the second edit fixes it
 *           → the gate re-runs, passes, and hands over the finalization
 *
 * The agent, the shell and the memory tool are all doubles, so every assertion
 * here is about the plugin's behaviour, not about a model's wording.
 */

import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { normalizeConfig } from '../lib/config.js'
import { createObservationBuffer } from '../lib/host/dsh.js'
import { createExecutor } from '../lib/host/execution.js'
import { createController, observedMutations } from '../lib/runtime/controller.js'
import { verifyMemoryReadback } from '../lib/runtime/finalization.js'
import { FINALIZATION_STATUS, GATE, TASK_STATE } from '../lib/protocol.js'
import { EvidenceStore, TaskStore } from '../lib/store.js'
import { argumentOf, createFakeMemoryAdapter, createFakeShell, writeVitestReport } from './helpers.mjs'

const PROJECT_ROOT = '/proj'
const HEAD = 'a'.repeat(40)

/** A workspace the test can mutate between cycles. */
function createWorkspace() {
  return { 'src/a.ts': 'export const value = 1\n', 'src/package.json': '{"name":"fixture"}' }
}

/**
 * Build a controller with every side effect replaced by a double.
 *
 * @param options - `{ config, memory, tests, baselineTests, statusOutput }`.
 * @returns the harness.
 */
async function createHarness(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'verification-gate-'))
  const config = normalizeConfig({
    projectRoot: PROJECT_ROOT,
    storageDir: dir,
    ...options.config,
  })

  const workspace = createWorkspace()
  const state = {
    /** Paths reported as pending by `git status`. */
    statusOutput: options.statusOutput ?? ' M src/a.ts\n',
    /** The current side's test report. */
    tests: options.tests ?? [{ name: 'a works', status: 'passed' }],
    /** The baseline side's test report, used inside the isolated worktree. */
    baselineTests: options.baselineTests ?? options.tests ?? [{ name: 'a works', status: 'passed' }],
    /** Replaced test results for the flake re-run. */
    inBaseline: false,
    commits: 0,
    testRuns: 0,
    /** When false the test run fails but writes no report at all. */
    reportWritable: options.reportWritable !== false,
  }

  const reportedFiles = {
    [`${PROJECT_ROOT}/package.json`]: JSON.stringify({ scripts: { test: 'vitest run' }, devDependencies: { vitest: '^3.0.0' } }),
    [`${PROJECT_ROOT}/pnpm-lock.yaml`]: 'lockfileVersion: 9\n',
    [`${PROJECT_ROOT}/tsconfig.json`]: '{}\n',
  }

  /** Resolve a path the plugin would use onto this harness's workspace keys. */
  const keysOf = (path) => {
    const absolute = String(path).replace(/\\/g, '/')
    const relative = absolute.startsWith(`${PROJECT_ROOT}/`) ? absolute.slice(PROJECT_ROOT.length + 1) : absolute
    return [absolute, relative]
  }

  const readProjectText = async (path) => {
    for (const key of keysOf(path)) {
      if (key in workspace) {
        const text = workspace[key]
        return { ok: true, text, bytes: Buffer.byteLength(text, 'utf8'), via: 'test' }
      }
      if (key in reportedFiles) {
        const text = reportedFiles[key]
        return { ok: true, text, bytes: Buffer.byteLength(text, 'utf8'), via: 'test' }
      }
    }
    return { ok: false, error: `ENOENT: ${String(path).replace(/\\/g, '/')}` }
  }

  const shell = createFakeShell(async (spec) => {
    const command = spec.command
    if (command.startsWith('git rev-parse HEAD')) return { exitCode: 0, stdout: `${HEAD}\n` }
    if (command.startsWith('git status')) return { exitCode: 0, stdout: state.statusOutput }
    if (command.startsWith('git worktree add')) return { exitCode: 0, stdout: 'Preparing worktree\n' }
    if (command.includes('vitest run')) {
      state.testRuns += 1
      const inBaseline = String(spec.workdir).includes('worktree')
      const items = inBaseline ? state.baselineTests : state.tests
      const path = argumentOf(command, 'outputFile')
      if (path !== null && state.reportWritable) {
        await writeVitestReport(path, items)
      }
      return {
        exitCode: items.some((item) => item.status === 'failed') ? 1 : 0,
        stdout: state.reportWritable ? 'Tests complete\n' : '',
      }
    }
    return { exitCode: 0, stdout: '' }
  })

  const executor = createExecutor({ shell, config, logger: silentLogger() })
  const memory = createFakeMemoryAdapter(options.memory ?? { status: 'empty' })
  const taskStore = new TaskStore({ dir })
  await taskStore.init()
  const observationBuffer = createObservationBuffer(200)
  const steers = []

  const controller = createController({
    ctx: { sandboxPolicy: { workspaceRoot: PROJECT_ROOT } },
    config,
    logger: silentLogger(),
    taskStore,
    executor,
    memoryAdapter: memory,
    observationBuffer,
    readProjectText,
    createFsx: () => ({
      exists: async (path) => {
        const keys = keysOf(path)
        return keys.some((key) => key in reportedFiles || key in workspace)
      },
      readText: async (path) => {
        const read = await readProjectText(path)
        if (!read.ok) throw new Error(read.error)
        return read.text
      },
    }),
    steer: (agent, text) => steers.push(text),
    detectProjectFn: async () => ({
      ok: true,
      kind: 'node',
      projectRoot: PROJECT_ROOT,
      packageManager: 'pnpm',
      testAdapter: 'vitest',
      checks: [{ id: 'test', kind: 'test', adapter: 'vitest', required: true }],
      lockfiles: ['pnpm-lock.yaml'],
      notes: [],
    }),
  })

  const agent = { id: options.sessionId ?? 'session_a' }

  return {
    config,
    dir,
    workspace,
    state,
    shell,
    memory,
    steers,
    controller,
    agent,
    observationBuffer,
    taskStore,
    observation: (name, value) => observationBuffer.observe({ name, callId: `c${Math.random()}`, agent: { id: agent.id } }, { isError: false, value, content: [] }),
    async init(requirements = ['修复示例项目中的失败测试']) {
      return controller.initializeTask({ agent, requirements, firstMessageId: 'msg_1' })
    },
    async run(mode = 'regression') {
      return controller.run({ agent, signal: undefined, mode, reason: 'test' })
    },
  }
}

/** A logger that keeps the test output readable. */
function silentLogger() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
}

test('a broken edit is detected, experience is retrieved, and a repair packet is steered', async () => {
  const harness = await createHarness({
    tests: [{ name: 'a works', status: 'failed', message: 'expected 2 to be 1' }],
    baselineTests: [{ name: 'a works', status: 'passed' }],
  })
  await harness.init()

  // The task edits a file, which is what makes the gate applicable at all.
  harness.workspace['src/a.ts'] = 'export const value = 2\n'
  const outcome = await harness.run()

  assert.equal(outcome.action, 'steer')
  assert.equal(outcome.kind, 'repair')
  assert.equal(outcome.packet.memoryRetrieval.status, 'empty')
  assert.match(outcome.text, /自动修复请求/)
  assert.match(outcome.text, /a works/)
  assert.ok(outcome.packet.requiredChecks.length >= 1)

  // All four checkpoints really ran, and their receipts were appended.
  const checkpoints = harness.memory.queries.map((query) => query.checkpoint)
  assert.deepEqual(checkpoints, ['change', 'regression', 'assertion', 'repair'])

  const status = await harness.controller.status(harness.agent.id)
  const queries = status.context.taskState.memoryQueries
  assert.equal(queries.length, 4)
  assert.equal(queries.every((query) => query.queryId !== undefined), true)

  // The finding reached the ledger as an open, unresolved entry.
  assert.equal(status.context.ledger.open().length >= 1, true)
  assert.equal(status.context.taskState.findings.some((finding) => finding.kind === 'confirmed_defect' && finding.blocking === true), true)
})

test('after the fix the gate re-runs, passes, and hands the finalization over exactly once', async () => {
  const harness = await createHarness({
    tests: [{ name: 'a works', status: 'failed', message: 'boom' }],
    baselineTests: [{ name: 'a works', status: 'passed' }],
  })
  await harness.init()
  harness.workspace['src/a.ts'] = 'export const value = 2\n'
  const first = await harness.run()
  assert.equal(first.action, 'steer')

  // The Agent applies the repair and the test passes again.
  harness.state.tests = [{ name: 'a works', status: 'passed' }]
  harness.workspace['src/a.ts'] = 'export const value = 3\n'
  const second = await harness.run()
  assert.equal(second.action, 'steer')
  assert.equal(second.kind, 'finalization')
  assert.match(second.text, /技术验证已通过/)
  assert.match(second.text, /verification_finalize/)

  const third = await harness.run()
  assert.equal(third.action, 'complete')
  const status = await harness.controller.status(harness.agent.id)
  assert.equal(status.context.taskState.state, TASK_STATE.COMPLETED)
  assert.equal(status.context.taskState.gate.technicalAcceptance, 'verified')
})

test('a pre-existing failure is reported, not attributed to this task', async () => {
  const failing = [{ name: 'already broken', status: 'failed', message: 'old failure' }]
  const harness = await createHarness({ tests: failing, baselineTests: failing })
  await harness.init()
  harness.workspace['src/a.ts'] = 'export const value = 2\n'
  const outcome = await harness.run()

  assert.equal(outcome.action, 'steer')
  assert.equal(outcome.kind, 'finalization')
  const status = await harness.controller.status(harness.agent.id)
  const regression = status.context.taskState.regression.at(-1)
  assert.equal(regression.comparison.verdict, 'pre_existing')
  assert.equal(status.context.ledger.open().length, 0)
})

test('an incomplete pre-repair retrieval blocks instead of being treated as an empty result', async () => {
  const harness = await createHarness({
    memory: { status: 'failed' },
    tests: [{ name: 'a works', status: 'failed', message: 'boom' }],
    baselineTests: [{ name: 'a works', status: 'passed' }],
  })
  await harness.init()
  harness.workspace['src/a.ts'] = 'export const value = 2\n'
  const outcome = await harness.run()

  assert.equal(outcome.action, 'block')
  assert.equal(outcome.reason, 'RETRIEVAL_INCOMPLETE')
  const status = await harness.controller.status(harness.agent.id)
  assert.equal(status.context.taskState.state, TASK_STATE.BLOCKED)
  assert.equal(status.context.taskState.gate.gate, GATE.BLOCKED)
  // The repair must NOT have been released.
  assert.equal(status.context.taskState.lastRepair, undefined)
})

test('a repeat of the same failure stops the loop as no progress', async () => {
  const harness = await createHarness({
    config: { sameFailureNoProgressLimit: 2, maxRepairCycles: 5 },
    tests: [{ name: 'a works', status: 'failed', message: 'same' }],
    baselineTests: [{ name: 'a works', status: 'passed' }],
  })
  await harness.init()
  harness.workspace['src/a.ts'] = 'export const value = 2\n'

  const first = await harness.run()
  assert.equal(first.action, 'steer')
  assert.equal(first.kind, 'repair')

  const second = await harness.run()
  assert.equal(second.action, 'block')
  assert.equal(second.reason, 'NO_PROGRESS')
})

test('the repair budget is shared by the whole gate and stops the loop when spent', async () => {
  const harness = await createHarness({
    config: { maxRepairCycles: 1, sameFailureNoProgressLimit: 99 },
    tests: [{ name: 'a works', status: 'failed', message: 'boom' }],
    baselineTests: [{ name: 'a works', status: 'passed' }],
  })
  await harness.init()
  harness.workspace['src/a.ts'] = 'export const value = 2\n'
  assert.equal((await harness.run()).kind, 'repair')

  // A different failure, so the no-progress rule cannot be what stops it.
  harness.state.tests = [{ name: 'a works', status: 'failed', message: 'a different failure' }]
  harness.workspace['src/a.ts'] = 'export const value = 4\n'
  const outcome = await harness.run()
  assert.equal(outcome.action, 'block')
  assert.equal(outcome.reason, 'BUDGET_EXHAUSTED')
})

test('a blocked task denies mutating tools and releases only on explicit request', async () => {
  const harness = await createHarness({
    config: { maxRepairCycles: 0 },
    tests: [{ name: 'a works', status: 'failed', message: 'boom' }],
    baselineTests: [{ name: 'a works', status: 'passed' }],
  })
  await harness.init()
  harness.workspace['src/a.ts'] = 'export const value = 2\n'
  const outcome = await harness.run()
  assert.equal(outcome.action, 'block')

  const denial = harness.controller.guardReason({ agent: harness.agent, name: 'write' })
  assert.match(denial, /blocked/)
  // Read-only tools stay available, otherwise the Agent could not even report.
  assert.equal(harness.controller.guardReason({ agent: harness.agent, name: 'read' }), undefined)
  assert.equal(harness.controller.guardReason({ agent: { id: 'other' }, name: 'write' }), undefined)

  const released = await harness.controller.releaseBlock(harness.agent.id, 'user asked to continue')
  assert.equal(released.ok, true)
  assert.equal(harness.controller.guardReason({ agent: harness.agent, name: 'write' }), undefined)
  const status = await harness.controller.status(harness.agent.id)
  assert.equal(status.context.taskState.cycle, 0)
  assert.equal(status.context.taskState.state, TASK_STATE.WORKING)
})

test('a task that changed nothing does not run the project tests at all', async () => {
  const harness = await createHarness({ tests: [{ name: 'a works', status: 'passed' }] })
  await harness.init()
  const before = harness.shell.calls.filter((call) => call.command.includes('vitest')).length
  const outcome = await harness.run()
  assert.equal(outcome.action, 'complete')
  assert.equal(outcome.skip, 'NO_CHANGE')
  const after = harness.shell.calls.filter((call) => call.command.includes('vitest')).length
  assert.equal(after, before)
})

test('a change made after verification invalidates it and the gate runs again', async () => {
  const harness = await createHarness({ tests: [{ name: 'a works', status: 'passed' }] })
  await harness.init()
  harness.workspace['src/a.ts'] = 'export const value = 2\n'
  await harness.run()
  await harness.run()
  const verified = await harness.controller.status(harness.agent.id)
  assert.equal(verified.context.taskState.state, TASK_STATE.COMPLETED)
  // Read the number now: the status object holds the LIVE task state, so a later
  // run would change what this reference sees.
  const verifiedCycle = verified.context.taskState.cycle

  // The Agent edits again after verification (a change in the final review).
  harness.workspace['src/a.ts'] = 'export const value = 5\n'
  const outcome = await harness.controller.onTurnStopping({ agent: harness.agent, turn: 5, signal: undefined })
  assert.notEqual(outcome.action, 'none')
  const after = await harness.controller.status(harness.agent.id)
  assert.equal(after.context.taskState.cycle, verifiedCycle + 1)
})

test('the observed-mutation count is what makes a no-diff task verifiable', async () => {
  const harness = await createHarness({ tests: [{ name: 'a works', status: 'passed' }] })
  await harness.init()
  harness.observation('pwsh', { ok: true })
  assert.equal(observedMutations(harness.observationBuffer, harness.agent.id, harness.config).length, 1)
  assert.equal(observedMutations(harness.observationBuffer, 'someone-else', harness.config).length, 0)
})

test('a memory write claim is verified against what actually ran', () => {
  const config = normalizeConfig({})
  const noWrite = verifyMemoryReadback({ observations: [], claim: { outcome: 'written' }, config })
  assert.equal(noWrite.status, FINALIZATION_STATUS[1])
  assert.equal(noWrite.code, 'NO_WRITE_OBSERVED')

  const writeOnly = verifyMemoryReadback({
    observations: [{ name: 'mcp__openviking__write', value: { uri: 'viking://resources/x' }, text: '', at: 1 }],
    claim: { outcome: 'written', contentExcerpt: 'some experience' },
    config,
  })
  assert.equal(writeOnly.code, 'NO_READBACK_OBSERVED')

  const verified = verifyMemoryReadback({
    observations: [
      { name: 'mcp__openviking__write', value: { uri: 'viking://resources/x' }, text: '', at: 1 },
      { name: 'mcp__openviking__read', value: null, text: 'read viking://resources/x -> the experience body', at: 2 },
    ],
    claim: { outcome: 'written', contentExcerpt: 'some experience' },
    config,
  })
  assert.equal(verified.status, FINALIZATION_STATUS[0])
  assert.equal(verified.code, 'ID_MATCH')

  const mismatched = verifyMemoryReadback({
    observations: [
      { name: 'mcp__openviking__write', value: { uri: 'viking://resources/x' }, text: '', at: 1 },
      { name: 'mcp__openviking__search', value: null, text: 'a completely unrelated older memory', at: 2 },
    ],
    claim: { outcome: 'written', contentExcerpt: 'some experience' },
    config,
  })
  assert.equal(mismatched.status, FINALIZATION_STATUS[1])
  assert.equal(mismatched.code, 'NO_MATCHING_READBACK')

  const contradicted = verifyMemoryReadback({
    observations: [{ name: 'mcp__openviking__write', value: { uri: 'viking://resources/x' }, text: '', at: 1 }],
    claim: { outcome: 'none', memorySaved: false },
    config,
  })
  assert.equal(contradicted.status, FINALIZATION_STATUS[1])
  assert.equal(contradicted.code, 'CLAIM_CONTRADICTS_OBSERVATION')

  const notRequired = verifyMemoryReadback({ observations: [], claim: { outcome: 'none' }, config })
  assert.equal(notRequired.status, FINALIZATION_STATUS[3])
})

test('finalization reports partial rather than complete when the readback cannot be proven', async () => {
  const harness = await createHarness({ tests: [{ name: 'a works', status: 'passed' }] })
  await harness.init()
  harness.workspace['src/a.ts'] = 'export const value = 2\n'
  await harness.run()
  const outcome = await harness.controller.finalize({
    agent: harness.agent,
    args: { report: 'x'.repeat(60), memoryOutcome: 'written', memoryExcerpt: 'experience' },
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.readback.status, FINALIZATION_STATUS[1])
  const status = await harness.controller.status(harness.agent.id)
  assert.equal(status.context.taskState.finalization.status, FINALIZATION_STATUS[1])
})

test('a task with no captured baseline runs the checks but cannot claim verified', async () => {
  const harness = await createHarness({ tests: [{ name: 'a works', status: 'passed' }] })
  // No pre-step initialisation: this is the mid-session install path.
  harness.workspace['src/a.ts'] = 'export const value = 2\n'
  const outcome = await harness.run()
  const status = await harness.controller.status(harness.agent.id)
  assert.equal(status.context.taskState.baseline, null)
  // 2026-10-12 fix: the checks still run, but "no failures observed" without any
  // baseline is NOT acceptance. The verdict says why, and the gate asks for
  // evidence instead of handing over a finalization.
  assert.equal(status.context.taskState.regression.at(-1).comparison.verdict, 'baseline_never_established')
  assert.notEqual(status.context.taskState.acceptance, 'verified')
  assert.equal(status.context.taskState.findings.some(
    (finding) => finding.kind === 'verification_gap' && finding.blocking === true,
  ), true)
  assert.notEqual(outcome.action, 'complete')
})

test('a failed check that produced no usable report never becomes a false pass', async () => {
  // Measured shape (2026-10-12): the check exits non-zero and every child check
  // fails in ~0 ms with no output. The per-item comparison sees no test items,
  // so before this fix the gate reported acceptance `verified` with zero
  // findings: a false pass on a run that proved nothing.
  const harness = await createHarness({
    reportWritable: false,
    tests: [{ name: 'a works', status: 'failed', message: 'boom' }],
  })
  await harness.init()
  harness.workspace['src/a.ts'] = 'export const value = 2\n'
  const outcome = await harness.run()
  const status = await harness.controller.status(harness.agent.id)
  assert.notEqual(status.context.taskState.acceptance, 'verified')
  assert.equal(status.context.taskState.findings.some(
    (finding) => finding.kind === 'verification_gap' && finding.blocking === true,
  ), true)
  const reported = status.context.taskState.regression.at(-1).comparison
  assert.equal(reported.failedChecks.length >= 1, true)
  assert.equal(reported.failedChecks[0].reportMissing, true)
  assert.equal(outcome.action, 'steer')
  // The environment fault is a repair-class finding (the fix is environmental),
  // so the gate is `repair` — never a pass.
  assert.equal(status.context.taskState.gate.gate, 'repair')
})

test('every check failing in milliseconds is reported as an environment fault', async () => {
  const harness = await createHarness({
    reportWritable: false,
    tests: [{ name: 'a works', status: 'failed', message: 'boom' }],
  })
  await harness.init()
  harness.workspace['src/a.ts'] = 'export const value = 2\n'
  await harness.run()
  const status = await harness.controller.status(harness.agent.id)
  assert.equal(status.context.taskState.regression.at(-1).comparison.executionEnvironmentFailed, true)
  assert.equal(status.context.taskState.findings.some(
    (finding) => finding.kind === 'environment_problem' && finding.blocking === true,
  ), true)
})

test('a failing run that really executed is not written off as an environment fault', async () => {
  const harness = await createHarness({
    reportWritable: false,
    tests: [{ name: 'a works', status: 'failed', message: 'boom' }],
  })
  await harness.init()
  harness.workspace['src/a.ts'] = 'export const value = 2\n'
  const realNow = Date.now
  let offset = 0
  // The command really ran (135 s): a slow, failing run is a test result, not a
  // broken environment, and it must still be reported as an unproven failure.
  Date.now = () => realNow() + (offset += 135000)
  try {
    await harness.run()
  } finally {
    Date.now = realNow
  }
  const status = await harness.controller.status(harness.agent.id)
  assert.equal(status.context.taskState.regression.at(-1).comparison.executionEnvironmentFailed, false)
  assert.notEqual(status.context.taskState.acceptance, 'verified')
})

test('the plugin refuses to start a task over a state file it cannot trust', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'verification-gate-corrupt-'))
  const taskStore = new TaskStore({ dir })
  await taskStore.init()
  const config = normalizeConfig({ projectRoot: PROJECT_ROOT, storageDir: dir })
  const makeController = () => createController({
    ctx: {},
    config,
    logger: silentLogger(),
    taskStore,
    executor: createExecutor({ shell: createFakeShell(() => ({ exitCode: 0 })), config, logger: silentLogger() }),
    memoryAdapter: createFakeMemoryAdapter(),
    observationBuffer: createObservationBuffer(10),
    readProjectText: async () => ({ ok: false, error: 'ENOENT' }),
    createFsx: () => ({ exists: async () => false, readText: async () => '' }),
    steer: () => {},
    detectProjectFn: async () => null,
  })

  // A state file left behind by a crashed write: it exists, and it cannot be read.
  const sessionId = 'corrupt_session'
  const taskId = `${sessionId}::session`
  await taskStore.saveTask(createStateFixture(taskId, sessionId))
  const { writeFile } = await import('node:fs/promises')
  await writeFile(taskStore.statePath(taskId), 'not json at all', 'utf8')

  const outcome = await makeController().run({ agent: { id: sessionId }, signal: undefined, mode: 'regression' })
  assert.equal(outcome.action, 'block')
  assert.equal(outcome.reason, 'STATE_UNREADABLE')
})

/** A minimal, well-formed persisted state for the corruption test. */
function createStateFixture(taskId, sessionId) {
  return {
    schemaVersion: 1,
    taskId,
    sessionId,
    state: 'working',
    requirements: [],
    requirementsRevision: 1,
    cycle: 0,
    memoryQueries: [],
    regression: [],
    assertions: [],
    ledger: [],
    evidence: [],
    finalization: { status: 'pending', attempts: 0 },
  }
}

test('the evidence store survives a pipeline run and keeps ids resolvable', async () => {
  const harness = await createHarness({
    tests: [{ name: 'a works', status: 'failed', message: 'boom' }],
    baselineTests: [{ name: 'a works', status: 'passed' }],
  })
  await harness.init()
  harness.workspace['src/a.ts'] = 'export const value = 2\n'
  await harness.run()
  const status = await harness.controller.status(harness.agent.id)
  const store = status.context.evidenceStore
  assert.ok(store instanceof EvidenceStore)
  assert.ok(store.list().length >= 3)
  // Every finding must cite evidence that exists — the §7.5 second check.
  for (const finding of status.context.taskState.findings) {
    for (const id of finding.evidenceIds) {
      assert.notEqual(store.get(id), undefined, `finding ${finding.id} cites missing evidence ${id}`)
    }
  }
})
