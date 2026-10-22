import test from 'node:test'
import assert from 'node:assert/strict'

import { captureBaseline, currentFacts } from '../lib/baseline.js'
import { diffAgainstBaseline } from '../lib/modules/change.js'

/** A project with no git repository at all. */
function fixture(files) {
  const run = async () => ({ status: 'completed', exitCode: 1, stdout: '', stderr: 'not a git repository' })
  const listProjectFiles = async () => ({ paths: Object.keys(files).sort(), truncated: false })
  const readProjectText = async (absolute) => {
    const relative = String(absolute).replace(/\\/g, '/').replace(/^\/proj\//, '')
    const text = files[relative]
    if (text === undefined) return { ok: false, error: `missing ${relative}` }
    return { ok: true, text, bytes: Buffer.byteLength(text) }
  }
  return { run, listProjectFiles, readProjectText }
}

const CONFIG = { allowNonGitBaseline: true, snapshotMaxFiles: 100, snapshotMaxFileBytes: 1_000_000 }

async function snapshot(files, config = CONFIG) {
  const ports = fixture(files)
  return captureBaseline({
    ...ports,
    projectRoot: '/proj',
    taskId: 'task-1',
    snapshotDir: undefined,
    config,
    signal: new AbortController().signal,
    lockfiles: [],
  })
}

async function facts(files, config = CONFIG) {
  const ports = fixture(files)
  return currentFacts({
    ...ports,
    projectRoot: '/proj',
    config,
    signal: new AbortController().signal,
    lockfiles: [],
  })
}

test('without the opt-in, a non-git project still fails closed', async () => {
  const files = { 'a.js': 'a' }
  const result = await facts(files, { ...CONFIG, allowNonGitBaseline: false })
  assert.equal(result.ok, false)
  assert.match(result.error, /allowNonGitBaseline/)
})

test('with the opt-in, baseline and current facts use the same bounded file hash', async () => {
  const files = { 'a.js': 'a', 'src/b.js': 'b' }
  const baseline = await snapshot(files)
  const current = await facts(files)
  assert.equal(baseline.nonGit, true)
  assert.equal(baseline.head, null)
  assert.equal(baseline.entries.length, 2)
  assert.equal(current.ok, true)
  assert.equal(current.nonGit, true)
  assert.equal(current.fingerprint, baseline.fingerprint)
  assert.deepEqual(diffAgainstBaseline(baseline, current), { added: [], modified: [], removed: [], renamed: [], unchanged: current.entries })
})

test('editing, adding and removing a file are visible through the non-git diff', async () => {
  const baseline = await snapshot({ 'a.js': 'a', 'src/b.js': 'b' })
  const edited = await facts({ 'a.js': 'a2', 'src/b.js': 'b' })
  assert.notEqual(edited.fingerprint, baseline.fingerprint)
  assert.deepEqual(diffAgainstBaseline(baseline, edited).modified.map((entry) => entry.path), ['a.js'])

  const added = await facts({ 'a.js': 'a', 'src/b.js': 'b', 'src/c.js': 'c' })
  assert.deepEqual(diffAgainstBaseline(baseline, added).added.map((entry) => entry.path), ['src/c.js'])

  const removed = await facts({ 'a.js': 'a' })
  assert.deepEqual(diffAgainstBaseline(baseline, removed).removed.map((entry) => entry.path), ['src/b.js'])
})

test('the opt-in without a file enumerator is reported, not guessed', async () => {
  const ports = fixture({ 'a.js': 'a' })
  const result = await currentFacts({
    run: ports.run,
    projectRoot: '/proj',
    config: CONFIG,
    signal: new AbortController().signal,
    readProjectText: ports.readProjectText,
    lockfiles: [],
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /file enumerator/)
})
