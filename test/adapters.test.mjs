/**
 * Adapter contract: detection is never guessed, and the composed command is one
 * the detected toolchain actually supports.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildExecutionPlan, detectProject } from '../lib/adapters.js'
import { parseGitStatus } from '../lib/baseline.js'
import { cacheKey, cacheUsable } from '../lib/baseline.js'
import { createFakeFsx } from './helpers.mjs'

test('a Node project is detected from package.json and its package manager from the lockfile', async () => {
  const fsx = createFakeFsx({
    '/p/package.json': JSON.stringify({
      scripts: { test: 'vitest run', build: 'tsc -p .' },
      devDependencies: { vitest: '^3.0.0' },
    }),
    '/p/pnpm-lock.yaml': 'lockfileVersion: 9',
    '/p/tsconfig.json': '{}',
  })
  const project = await detectProject({ projectRoot: '/p', fsx })
  assert.equal(project.ok, true)
  assert.equal(project.kind, 'node')
  assert.equal(project.packageManager, 'pnpm')
  assert.equal(project.testAdapter, 'vitest')
  assert.deepEqual(project.lockfiles, ['pnpm-lock.yaml'])
  assert.ok(project.checks.some((check) => check.id === 'typecheck'))
  assert.ok(project.checks.some((check) => check.id === 'build'))
})

test('a Python project is detected from its test configuration', async () => {
  const project = await detectProject({ projectRoot: '/py', fsx: createFakeFsx({ '/py/pyproject.toml': '[project]' }) })
  assert.equal(project.ok, true)
  assert.equal(project.kind, 'python')
  assert.equal(project.testAdapter, 'pytest')
})

test('an unsupported project is reported as absent, not as passing', async () => {
  const project = await detectProject({ projectRoot: '/nope', fsx: createFakeFsx({}) })
  assert.equal(project, null)
})

test('a package.json that cannot be read is an error, not an assumption', async () => {
  const fsx = {
    exists: async (path) => String(path).endsWith('package.json'),
    readText: async () => {
      throw new Error('EACCES')
    },
  }
  const project = await detectProject({ projectRoot: '/p', fsx })
  assert.equal(project.ok, false)
  assert.match(project.reason, /could not be read/)
})

test('the vitest plan asks for a structured JSON report', () => {
  const project = { kind: 'node', packageManager: 'pnpm', checks: [{ id: 'test', kind: 'test', adapter: 'vitest', required: true }] }
  const plan = buildExecutionPlan({ project, mode: 'regression', selection: {}, reportDir: 'C:/reports/run' })
  assert.equal(plan.checks.length, 1)
  assert.match(plan.checks[0].command, /vitest run --reporter=json --outputFile=/)
  assert.equal(plan.checks[0].reportFormat, 'vitest-json')
})

test('the pytest plan asks for JUnit XML', () => {
  const project = { kind: 'python', packageManager: 'python', checks: [{ id: 'test', kind: 'test', adapter: 'pytest', required: true }] }
  const plan = buildExecutionPlan({ project, mode: 'regression', selection: {}, reportDir: '/reports/run' })
  assert.match(plan.checks[0].command, /python -m pytest --junitxml=/)
  assert.equal(plan.checks[0].reportFormat, 'junit-xml')
})

test('full mode adds the optional checks and quick mode narrows the scope', () => {
  const project = {
    kind: 'node',
    packageManager: 'npm',
    checks: [
      { id: 'test', kind: 'test', adapter: 'vitest', required: true },
      { id: 'typecheck', kind: 'typecheck', adapter: 'tsc', required: false },
      { id: 'build', kind: 'build', adapter: 'script', command: 'tsc -p .', required: false },
      { id: 'lint', kind: 'lint', adapter: 'script', command: 'eslint .', required: false },
    ],
  }
  const full = buildExecutionPlan({ project, mode: 'full', selection: {}, reportDir: '/r' })
  const quick = buildExecutionPlan({ project, mode: 'quick', selection: {}, reportDir: '/r' })
  const regression = buildExecutionPlan({ project, mode: 'regression', selection: {}, reportDir: '/r' })
  assert.deepEqual(full.checks.map((check) => check.id), ['test', 'typecheck', 'build', 'lint'])
  assert.deepEqual(quick.checks.map((check) => check.id), ['test', 'typecheck'])
  assert.deepEqual(regression.checks.map((check) => check.id), ['test', 'typecheck'])
})

test('quick mode narrows a vitest run to the selected files', () => {
  const project = { kind: 'node', packageManager: 'pnpm', checks: [{ id: 'test', kind: 'test', adapter: 'vitest', required: true }] }
  const plan = buildExecutionPlan({ project, mode: 'quick', selection: { files: ['src/a.test.ts', 'src/b c.test.ts'] }, reportDir: '/r' })
  assert.match(plan.checks[0].command, /src\/a\.test\.ts/)
  assert.match(plan.checks[0].command, /"src\/b c\.test\.ts"/)
})

test('an npm project runs vitest and tsc through npx, not `npm run exec`', () => {
  // Same defect class as the script check: `npm run` takes a script name, so
  // `npm run exec vitest …` was never a valid command for npm projects.
  const vitest = buildExecutionPlan({
    project: { kind: 'node', packageManager: 'npm', checks: [{ id: 'test', kind: 'test', adapter: 'vitest', required: true }] },
    mode: 'regression', selection: {}, reportDir: '/r',
  })
  assert.match(vitest.checks[0].command, /^npx vitest run --reporter=json/)
  const tsc = buildExecutionPlan({
    project: { kind: 'node', packageManager: 'npm', checks: [{ id: 'typecheck', kind: 'typecheck', adapter: 'tsc', required: true }] },
    mode: 'regression', selection: {}, reportDir: '/r',
  })
  assert.equal(tsc.checks[0].command, 'npx tsc --noEmit')
})

test('an npm project runs a manifest script BY NAME, never by its body', () => {
  // 2026-10-18 measured on dsh-auto-plan-executor: the body-prefixed form was
  // `npm run node --import ./test/host-hooks.mjs --test …`, and npm answered
  // `Missing script: "node"`. `npm run` takes the script name.
  const project = {
    kind: 'node',
    packageManager: 'npm',
    checks: [{
      id: 'test',
      kind: 'test',
      adapter: 'script',
      command: 'node --import ./test/host-hooks.mjs --test test/a.test.mjs',
      required: true,
      source: 'package.json scripts.test',
    }],
  }
  const plan = buildExecutionPlan({ project, mode: 'regression', selection: {}, reportDir: '/r' })
  assert.equal(plan.checks[0].command, 'npm run test')
})

test('a pnpm project keeps running the script body directly (pnpm accepts a command)', () => {
  const project = {
    kind: 'node',
    packageManager: 'pnpm',
    checks: [{
      id: 'test',
      kind: 'test',
      adapter: 'script',
      command: 'node scripts/ci-offline-checks.mjs',
      required: true,
      source: 'package.json scripts.test',
    }],
  }
  const plan = buildExecutionPlan({ project, mode: 'regression', selection: {}, reportDir: '/r' })
  assert.equal(plan.checks[0].command, 'pnpm node scripts/ci-offline-checks.mjs')
})

test('a script check that did not come from package.json keeps its own body', () => {
  const project = {
    kind: 'node',
    packageManager: 'npm',
    checks: [{ id: 'build', kind: 'build', adapter: 'script', command: 'tsc -p .', required: false }],
  }
  const plan = buildExecutionPlan({ project, mode: 'full', selection: {}, reportDir: '/r' })
  assert.equal(plan.checks[0].command, 'tsc -p .')
})

test('a project with no applicable check says so instead of inventing one', () => {
  const plan = buildExecutionPlan({ project: { kind: 'node', packageManager: 'npm', checks: [] }, mode: 'regression', selection: {}, reportDir: '/r' })
  assert.equal(plan.checks.length, 0)
  assert.equal(plan.notes.length, 1)
})

test('git status output is parsed for modified, untracked, deleted and renamed paths', () => {
  const entries = parseGitStatus([
    ' M src/a.ts',
    '?? src/new.ts',
    'D  src/gone.ts',
    'R  src/old.ts -> src/renamed.ts',
    '',
  ].join('\n'))
  assert.deepEqual(entries.map((entry) => entry.path), ['src/a.ts', 'src/new.ts', 'src/gone.ts', 'src/renamed.ts'])
  assert.deepEqual(entries.map((entry) => entry.status), ['modified', 'untracked', 'deleted', 'renamed'])
  assert.equal(entries[3].previousPath, 'src/old.ts')
})

test('a quoted path with an escape is unquoted', () => {
  const entries = parseGitStatus('?? "src/with space.ts"')
  assert.equal(entries[0].path, 'src/with space.ts')
})

test('a cached result is reused only when every component matches', () => {
  const components = {
    workspaceFingerprint: 'sha256:ws',
    environmentFingerprint: 'sha256:env',
    command: 'pnpm exec vitest run',
    selection: { files: [] },
    oracleFingerprint: 'sha256:oracle',
    adapterVersion: '1',
  }
  const cached = { key: cacheKey(components), complete: true }
  assert.equal(cacheUsable(cached, components).reusable, true)
  assert.equal(cacheUsable(cached, { ...components, workspaceFingerprint: 'sha256:other' }).code, 'KEY_MISMATCH')
  assert.equal(cacheUsable({ ...cached, complete: false }, components).code, 'CACHED_INCOMPLETE')
  assert.equal(cacheUsable(null, components).code, 'NO_CACHE')
})
