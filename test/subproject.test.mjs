/**
 * Aggregate-workspace contract.
 *
 * The measured failure this file exists for: a workspace root that is a CONTAINER
 * of projects (no manifest of its own) made the gate decline on every turn —
 * loaded, healthy and silent, which the user correctly reported as "the plugin is
 * not running".
 *
 * Two properties are pinned here:
 *
 *   1. a container root is RESOLVED to the one sub-project the turn is about,
 *      from signals that exist before the turn mutates anything — and when the
 *      signals are ambiguous the answer is `null`, never a best guess;
 *   2. declining is VISIBLE: it is said once per task, with the reason.
 */

import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { findSubProject, pathTokensOf } from '../lib/adapters.js'
import { normalizeConfig } from '../lib/config.js'
import { createObservationBuffer } from '../lib/host/dsh.js'
import { createExecutor } from '../lib/host/execution.js'
import { createController } from '../lib/runtime/controller.js'
import { TaskStore } from '../lib/store.js'
import { createFakeFsx, createFakeMemoryAdapter, createFakeShell } from './helpers.mjs'

const AGG = '/agg'
const HEAD = 'b'.repeat(40)

/** An aggregate workspace: a container holding two real projects. */
function aggregateFiles() {
  return {
    '/agg/novel-studio/package.json': JSON.stringify({ scripts: { test: 'node --test' }, devDependencies: { vitest: '^3.0.0' } }),
    '/agg/novel-studio/pnpm-lock.yaml': 'lockfileVersion: 9\n',
    '/agg/novel-studio/ai/writing/policy.mjs': 'export const policy = 1\n',
    '/agg/dsh-tools/package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
    '/agg/dsh-tools/README.md': '# tools\n',
  }
}

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }

// ── the decision function ────────────────────────────────────────────────────

test('path tokens are taken only from things that look like a relative file path', () => {
  const tokens = pathTokensOf([
    '从 ai/writing/policy.mjs 开始改，参考 https://example.com/a/b.ts 与 C:/tmp/c.ts，还有 foo/bar',
  ])
  assert.deepEqual(tokens, ['ai/writing/policy.mjs'])
})

test('a harness reference (@path) is read as the same relative path', async () => {
  // The gate's own notice recommends naming a path, and the harness writes it
  // `@a/b.ts`. Before the fix the leading `@` stayed in the token, so the
  // reference scored zero against every candidate and the advice was unusable.
  assert.deepEqual(pathTokensOf(['这一轮在 @novel-studio/package.json 所在项目里']), ['novel-studio/package.json'])
  const resolved = await findSubProject({
    workspaceRoot: AGG,
    texts: ['这一轮在 @novel-studio/ai/writing/policy.mjs 所在项目里'],
    fsx: createFakeFsx(aggregateFiles()),
  })
  assert.equal(resolved.projectRoot, `${AGG}/novel-studio`)
  assert.equal(resolved.via, 'mentioned-paths')
})

test('a task that declined is re-decided on a later turn, not pinned for the generation', async () => {
  const h = await createAggregateHarness(aggregateFiles())
  await h.controller.initializeTask({ agent: h.agent, requirements: ['把东西修一下'], firstMessageId: 'msg_1' })
  assert.equal(h.controller.live.get(h.agent.id).applicable, false)

  // Same process generation, same task identity, but this turn names the project.
  await h.controller.initializeTask({
    agent: h.agent,
    requirements: ['改一下 novel-studio/ai/writing/policy.mjs'],
    firstMessageId: 'msg_1',
  })
  const context = h.controller.live.get(h.agent.id)
  assert.equal(context.applicable, true)
  assert.equal(context.projectRoot, `${AGG}/novel-studio`)
  assert.notEqual(context.taskState.baseline, null)
  // The stale verdict of the declined attempt must not survive.
  assert.equal(context.taskState.acceptance, null)
  // §4.2: a new demand opens a revision instead of reviewing against the old text.
  assert.equal(context.taskState.requirementsRevision, 2)
  assert.deepEqual(context.taskState.requirements, ['改一下 novel-studio/ai/writing/policy.mjs'])
})

test('a container workspace holding several projects is not resolved without a signal', async () => {
  const resolved = await findSubProject({ workspaceRoot: AGG, texts: ['把东西修一下'], fsx: createFakeFsx(aggregateFiles()) })
  assert.equal(resolved, null)
})

test('a named path that exists under exactly one child resolves that child', async () => {
  const resolved = await findSubProject({
    workspaceRoot: AGG,
    texts: ['改一下 ai/writing/policy.mjs 的策略'],
    fsx: createFakeFsx(aggregateFiles()),
  })
  assert.equal(resolved.projectRoot, `${AGG}/novel-studio`)
  assert.equal(resolved.via, 'mentioned-paths')
  assert.equal(resolved.project.kind, 'node')
})

test('a container-qualified path is resolved from the child it names', async () => {
  const resolved = await findSubProject({
    workspaceRoot: AGG,
    texts: ['改一下 novel-studio/ai/writing/policy.mjs'],
    fsx: createFakeFsx(aggregateFiles()),
  })
  assert.equal(resolved.projectRoot, `${AGG}/novel-studio`)
  assert.equal(resolved.via, 'mentioned-paths')
})

test('a path that exists under more than one child stays unresolved', async () => {
  const files = aggregateFiles()
  files['/agg/dsh-tools/ai/writing/policy.mjs'] = 'export const other = 1\n'
  const resolved = await findSubProject({
    workspaceRoot: AGG,
    texts: ['改一下 ai/writing/policy.mjs'],
    fsx: createFakeFsx(files),
  })
  assert.equal(resolved, null)
})

test('a sub-project named as a plain word resolves that child (2026-10-18: no path typed)', async () => {
  const resolved = await findSubProject({
    workspaceRoot: AGG,
    texts: ['在 dsh-tools 插件中新增闸门：验收命令是在 dsh-tools 目录下执行 npm run check。'],
    fsx: createFakeFsx(aggregateFiles()),
  })
  assert.equal(resolved.projectRoot, `${AGG}/dsh-tools`)
  assert.equal(resolved.via, 'mentioned-name')
})

test('naming two sub-projects is ambiguous even without a path', async () => {
  const resolved = await findSubProject({
    workspaceRoot: AGG,
    texts: ['参考 novel-studio 的写法，把 dsh-tools 也改一下'],
    fsx: createFakeFsx(aggregateFiles()),
  })
  assert.equal(resolved, null)
})

test('a project name that only appears inside a longer token does not count as a mention', async () => {
  const resolved = await findSubProject({
    workspaceRoot: AGG,
    texts: ['把 novel-dsh-tools 这个名字改掉'],
    fsx: createFakeFsx(aggregateFiles()),
  })
  assert.equal(resolved, null)
})

test('the project this session already worked on wins, without re-deciding', async () => {
  const resolved = await findSubProject({
    workspaceRoot: AGG,
    texts: ['继续'],
    activeProjectRoot: `${AGG}/dsh-tools`,
    fsx: createFakeFsx(aggregateFiles()),
  })
  assert.equal(resolved.projectRoot, `${AGG}/dsh-tools`)
  assert.equal(resolved.via, 'session')
})

test('a workspace holding exactly one project resolves to it', async () => {
  const resolved = await findSubProject({
    workspaceRoot: '/only',
    texts: [],
    fsx: createFakeFsx({ '/only/app/package.json': '{"name":"app"}' }),
  })
  assert.equal(resolved.projectRoot, '/only/app')
  assert.equal(resolved.via, 'single-child')
})

test('an unreadable child manifest stops the resolution instead of picking another child', async () => {
  const fsx = createFakeFsx(aggregateFiles())
  const files = fsx.files
  files.set('/agg/broken/package.json', '{ not json')
  const resolved = await findSubProject({
    workspaceRoot: AGG,
    texts: ['改一下 ai/writing/policy.mjs'],
    fsx,
  })
  assert.equal(resolved, null)
})

// ── the wiring: a container root really runs the gate on its child ───────────

async function createAggregateHarness(files) {
  const dir = await mkdtemp(join(tmpdir(), 'verification-gate-agg-'))
  const config = normalizeConfig({ storageDir: dir })
  const fsx = createFakeFsx(files)
  const shell = createFakeShell(async (spec) => {
    if (spec.command.startsWith('git rev-parse HEAD')) return { exitCode: 0, stdout: `${HEAD}\n` }
    if (spec.command.startsWith('git status')) return { exitCode: 0, stdout: '' }
    if (spec.command.startsWith('git worktree add')) return { exitCode: 0, stdout: 'Preparing worktree\n' }
    return { exitCode: 0, stdout: '' }
  })
  const executor = createExecutor({ shell, config, logger: silentLogger })
  const taskStore = new TaskStore({ dir })
  await taskStore.init()
  const steers = []
  const observationBuffer = createObservationBuffer(50)

  const controller = createController({
    ctx: {},
    config,
    logger: silentLogger,
    taskStore,
    executor,
    memoryAdapter: createFakeMemoryAdapter({ status: 'empty' }),
    observationBuffer,
    readProjectText: async (path) => {
      const key = String(path).replace(/\\/g, '/')
      if (!fsx.files.has(key)) return { ok: false, error: `ENOENT: ${key}` }
      const text = fsx.files.get(key)
      return { ok: true, text, bytes: Buffer.byteLength(text, 'utf8'), via: 'test' }
    },
    createFsx: () => fsx,
    steer: (agent, text) => steers.push(text),
    workspaceRoot: () => AGG,
  })

  return { controller, taskStore, steers, observationBuffer, agent: { id: 'session_agg' } }
}

test('a container root verifies the sub-project it resolved, and remembers it', async () => {
  const h = await createAggregateHarness(aggregateFiles())
  const init = await h.controller.initializeTask({
    agent: h.agent,
    requirements: ['改一下 novel-studio/ai/writing/policy.mjs'],
    firstMessageId: 'msg_1',
  })
  assert.equal(init.ok, true)

  const context = h.controller.live.get(h.agent.id)
  assert.equal(context.applicable, true)
  assert.equal(context.projectRoot, `${AGG}/novel-studio`)
  assert.equal(context.taskState.activeProjectRoot, `${AGG}/novel-studio`)
  assert.equal(context.taskState.projectResolution.via, 'mentioned-paths')
  assert.notEqual(context.taskState.baseline, null)
  assert.ok(context.taskState.project.checks.some((check) => check.id === 'test'))

  // The binding must survive a host restart: it is in the state file, and it is
  // what a reloaded process resolves the next turn from.
  const loaded = await h.taskStore.loadTask(context.taskState.taskId)
  assert.equal(loaded.ok, true)
  assert.equal(loaded.state.activeProjectRoot, `${AGG}/novel-studio`)
})

test('a later turn of the same session keeps the sub-project it resolved', async () => {
  const h = await createAggregateHarness(aggregateFiles())
  await h.controller.initializeTask({ agent: h.agent, requirements: ['改一下 novel-studio/ai/writing/policy.mjs'], firstMessageId: 'msg_1' })

  // The turn that names nothing must not silently fall back to "container root
  // is not a project": within the session's lifetime the binding holds.
  await h.controller.initializeTask({ agent: h.agent, requirements: ['继续刚才的事'], firstMessageId: 'msg_2' })

  const context = h.controller.live.get(h.agent.id)
  assert.equal(context.applicable, true)
  assert.equal(context.projectRoot, `${AGG}/novel-studio`)
  assert.equal(context.taskState.activeProjectRoot, `${AGG}/novel-studio`)
})

test('a resolved project that declares no check is never reported as verified', async () => {
  const h = await createAggregateHarness({
    '/agg/plain/package.json': JSON.stringify({ name: 'plain', version: '1.0.0' }),
    '/agg/plain/src/a.mjs': 'export const a = 1\n',
  })
  await h.controller.initializeTask({ agent: h.agent, requirements: ['改一下 plain/src/a.mjs'], firstMessageId: 'msg_1' })
  h.observationBuffer.observe({ name: 'edit', callId: 'c1', agent: { id: h.agent.id } }, { isError: false, content: [] })

  const context = h.controller.live.get(h.agent.id)
  assert.equal(context.projectRoot, `${AGG}/plain`)
  assert.deepEqual(context.taskState.project.checks, [])

  const outcome = await h.controller.onTurnStopping({ agent: h.agent, turn: 1 })
  // Measured before the fix: acceptance "verified" with zero checks run.
  assert.equal(context.taskState.acceptance, 'not_applicable')
  assert.match(outcome.gate.reason, /declares no test/)
  assert.equal(outcome.skip, 'NO_DECLARED_CHECK')
  assert.equal(outcome.gate.technicalAcceptance, 'not_applicable')
})

test('declining is said once per task instead of happening silently', async () => {  const h = await createAggregateHarness(aggregateFiles())
  await h.controller.initializeTask({ agent: h.agent, requirements: ['把东西修一下'], firstMessageId: 'msg_1' })

  const context = h.controller.live.get(h.agent.id)
  assert.equal(context.applicable, false)
  assert.equal(context.taskState.acceptance, 'not_applicable')
  assert.match(context.taskState.notes.at(-1), /no single sub-project of it could be identified/)

  const first = await h.controller.onTurnStopping({ agent: h.agent, turn: 1 })
  assert.equal(first.action, 'steer')
  assert.equal(first.kind, 'not-applicable')
  assert.match(first.text, /验证门未介入/)
  assert.match(first.text, /NO_SUPPORTED_PROJECT/)
  // 2026-10-18: the advice must match the resolver. It may NOT recommend pinning
  // config.projectRoot (that made every session verify the same project), and it
  // MUST mention naming a sub-project directly, which the resolver now accepts.
  assert.doesNotMatch(first.text, /或用配置 projectRoot 指定项目根/)
  assert.match(first.text, /直接点名子项目目录/)

  const second = await h.controller.onTurnStopping({ agent: h.agent, turn: 2 })
  assert.equal(second.action, 'none')
})
