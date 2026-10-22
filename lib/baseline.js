/**
 * Baseline capture: what the project looked like before this task touched it.
 *
 * The design chose "snapshot baseline + lazy baseline testing + cache", and the
 * single most important consequence is this: a hash is NOT a snapshot. A task
 * that saves only `workingTreeDiffHash` and reads the old files later reads
 * whatever the Agent has since written over them, so the frozen CONTENT of every
 * changed, previously-uncommitted and untracked input is captured here, before
 * the task's own mutations begin (§6.1).
 *
 * Two further rules are implemented rather than promised:
 *
 *   - the user's working tree is never checked out, reset or stashed to build a
 *     baseline. Restoration happens in the plugin's own directory, via a
 *     detached `git worktree` plus the frozen overlay (§6.2).
 *   - a baseline that could not be established is reported as absent. It is
 *     never silently treated as "everything already passed", because that is the
 *     difference between "no new failures" and "no idea" (§7.3, `UNKNOWN`).
 *
 * @module dsh-plugin-verification/baseline
 */

import { compositeFingerprint, sha256Hex } from './store.js'

/** Statuses `git status --porcelain` can report, normalized. */
const STATUS_MAP = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  U: 'unmerged',
  '?': 'untracked',
  '!': 'ignored',
}

/**
 * Parse `git status --porcelain` output.
 *
 * Both the NUL-separated and the newline-separated forms are accepted, because
 * the NUL form can be mangled by the shell layer that transports stdout.
 *
 * @param text - the raw status output.
 * @returns one entry per path, in git's order.
 */
export function parseGitStatus(text) {
  const source = String(text ?? '')
  const records = source.includes('\0') ? source.split('\0') : source.split(/\r?\n/)
  const entries = []

  for (let index = 0; index < records.length; index += 1) {
    const raw = records[index]
    if (raw === undefined || raw === '') continue
    if (raw.length < 4) continue

    const codeXY = raw.slice(0, 2)
    let path = raw.slice(3)
    const indexCode = codeXY[0]
    const worktreeCode = codeXY[1]
    const code = worktreeCode !== ' ' && worktreeCode !== '?' ? worktreeCode : indexCode
    let previousPath = null

    if (code === 'R' || code === 'C') {
      // Newline form: "R  old -> new". NUL form: the next record is the source.
      const arrow = path.indexOf(' -> ')
      if (arrow >= 0) {
        previousPath = unquotePath(path.slice(0, arrow))
        path = path.slice(arrow + 4)
      } else if (records[index + 1] !== undefined && !source.includes('\0')) {
        previousPath = unquotePath(records[index + 1])
        index += 1
      }
    }

    if (previousPath === null && source.includes('\0') && (code === 'R' || code === 'C')) {
      const next = records[index + 1]
      if (next !== undefined && next !== '') {
        previousPath = unquotePath(next)
        index += 1
      }
    }

    entries.push({
      path: unquotePath(path),
      previousPath,
      status: STATUS_MAP[code] ?? 'unknown',
    })
  }

  return entries
}

/** Undo git's C-style quoting for an unusual path. */
function unquotePath(path) {
  const text = String(path)
  if (!text.startsWith('"') || !text.endsWith('"')) return text
  const inner = text.slice(1, -1)
  return inner.replace(/\\(.)/g, (whole, char) => {
    if (char === 'n') return '\n'
    if (char === 't') return '\t'
    if (char === 'r') return '\r'
    if (char === '\\') return '\\'
    if (char === '"') return '"'
    return whole
  })
}

/**
 * Run one git command through the injected executor.
 *
 * @param run - the executor's `run`.
 * @param args - git arguments.
 * @param workdir - repository root.
 * @param signal - cancellation.
 * @returns `{ ok, stdout, report }`.
 */
async function git(run, args, workdir, signal) {
  const report = await run({ command: `git ${args}`, workdir, signal, label: `git ${args}` })
  return { ok: report.status === 'completed' && report.exitCode === 0, stdout: report.stdout ?? '', report }
}

/**
 * Build a bounded, content-based snapshot for a project without a git HEAD.
 *
 * This is the explicit non-git fallback: it hashes every regular file under the
 * project root (bounded by `snapshotMaxFiles` / `snapshotMaxFileBytes`) instead
 * of diffing `git status`. It is never implicit — `config.allowNonGitBaseline`
 * must be true, so a broken git repository still fails closed by default.
 *
 * @param options - `{ listProjectFiles, readProjectText, projectRoot, config, signal }`.
 * @returns `{ ok, entries, fingerprint, truncated, warning, error }`.
 */
async function nonGitFacts({ listProjectFiles, readProjectText, projectRoot, config, signal }) {
  if (typeof listProjectFiles !== 'function') {
    return { ok: false, error: 'non-git baseline requires a project file enumerator' }
  }
  let listed
  try {
    listed = await listProjectFiles(projectRoot, { maxFiles: config.snapshotMaxFiles, signal })
  } catch (error) {
    return { ok: false, error: `non-git file enumeration failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  const paths = Array.isArray(listed) ? listed : (Array.isArray(listed?.paths) ? listed.paths : [])
  const truncated = listed?.truncated === true
  const root = projectRoot.replace(/[\\/]+$/, '')
  const entries = []
  for (const path of paths) {
    const read = await readProjectText(`${root}/${path}`, config.snapshotMaxFileBytes)
    entries.push({
      path,
      status: 'present',
      previousPath: null,
      sha256: read.ok ? sha256Hex(read.text) : null,
      bytes: read.ok ? read.bytes : null,
      reason: read.ok ? null : read.error,
    })
  }
  return {
    ok: true,
    entries,
    truncated,
    warning: `non-git workspace: fingerprint is a bounded full-tree hash (${entries.length} file(s))`,
    fingerprint: compositeFingerprint({
      head: null,
      entries: entries.map((entry) => ({ path: entry.path, status: entry.status, sha256: entry.sha256 })),
    }),
  }
}

/**
 * Capture the baseline snapshot.
 *
 * @param options - injection points and bounds.
 * @returns the snapshot record (also the value persisted in the task state).
 */
export async function captureBaseline({
  run,
  projectRoot,
  taskId,
  snapshotDir,
  config,
  signal,
  logger,
  readProjectText,
  listProjectFiles,
  writeSnapshotFile,
  lockfiles = [],
}) {
  const warnings = []
  let entries = []
  let head = null
  let gitAvailable = false
  let nonGit = false
  let truncated = false

  const headResult = await git(run, 'rev-parse HEAD', projectRoot, signal)
  if (headResult.ok && /^[0-9a-f]{7,40}$/i.test(headResult.stdout.trim())) {
    head = headResult.stdout.trim()
    gitAvailable = true
  } else {
    warnings.push('the project is not a git repository with a readable HEAD')
    if (config.allowNonGitBaseline === true) {
      const fallback = await nonGitFacts({ listProjectFiles, readProjectText, projectRoot, config, signal })
      if (fallback.ok === true) {
        entries = fallback.entries
        nonGit = true
        truncated = fallback.truncated
        warnings.push(fallback.warning)
      } else {
        warnings.push(fallback.error)
      }
    }
  }

  if (nonGit !== true) {
  let statusEntries = []
  if (gitAvailable) {
    const statusResult = await git(run, 'status --porcelain=v1 --untracked-files=all', projectRoot, signal)
    if (statusResult.ok) {
      statusEntries = parseGitStatus(statusResult.stdout)
    } else {
      warnings.push(`git status failed: ${statusResult.report.reason}`)
    }
  }

  if (statusEntries.length > config.snapshotMaxFiles) {
    truncated = true
    warnings.push(`the working tree has ${statusEntries.length} pending paths; only the first ${config.snapshotMaxFiles} were frozen`)
    statusEntries = statusEntries.slice(0, config.snapshotMaxFiles)
  }

  for (const entry of statusEntries) {
    if (entry.status === 'deleted' || entry.status === 'ignored') {
      entries.push({ ...entry, sha256: null, bytes: 0, stored: null, reason: 'no content to freeze' })
      continue
    }
    const absolute = `${projectRoot.replace(/[\\/]+$/, '')}/${entry.path}`
    const read = await readProjectText(absolute, config.snapshotMaxFileBytes)
    if (!read.ok) {
      entries.push({ ...entry, sha256: null, bytes: read.bytes ?? null, stored: null, reason: read.error })
      warnings.push(`could not freeze ${entry.path}: ${read.error}`)
      continue
    }
    const stored = snapshotDir === undefined ? null : `${snapshotDir}/files/${sha256Hex(entry.path).slice(0, 16)}`
    if (stored !== null && typeof writeSnapshotFile === 'function') {
      await writeSnapshotFile(stored, read.text)
    }
    entries.push({
      ...entry,
      sha256: sha256Hex(read.text),
      bytes: read.bytes,
      stored,
      reason: null,
    })
  }
  }

  const lockfileHashes = {}
  for (const lockfile of lockfiles) {
    const absolute = `${projectRoot.replace(/[\\/]+$/, '')}/${lockfile}`
    const read = await readProjectText(absolute, config.snapshotMaxFileBytes)
    lockfileHashes[lockfile] = read.ok ? sha256Hex(read.text) : null
  }

  const fingerprint = compositeFingerprint({
    head,
    entries: entries.map((entry) => ({ path: entry.path, status: entry.status, sha256: entry.sha256 })),
  })

  const snapshot = {
    taskId,
    projectRoot,
    head,
    gitAvailable,
    nonGit,
    entries,
    lockfiles: lockfileHashes,
    fingerprint,
    warnings,
    truncated,
    capturedAt: Date.now(),
    capturedPaths: entries.length,
    excluded: [
      'paths beyond snapshotMaxFiles',
      'file bodies beyond snapshotMaxFileBytes',
      'git-ignored paths (never covered by `--untracked-files=all`)',
      ...(nonGit ? ['non-git fallback: dependency/generated trees are skipped'] : []),
    ],
  }

  logger?.info?.(
    `[verification-gate] baseline captured: head=${head ?? 'none'} paths=${entries.length} `
    + `fingerprint=${String(fingerprint).slice(7, 19)} warnings=${warnings.length}`,
  )

  return snapshot
}

/**
 * Recompute the workspace fingerprint without persisting anything.
 *
 * @returns `{ ok, fingerprint, head, entries, error }`.
 */
export async function currentFacts({ run, projectRoot, signal, config, readProjectText, listProjectFiles, lockfiles = [] }) {
  const headResult = await git(run, 'rev-parse HEAD', projectRoot, signal)
  if (!headResult.ok) {
    if (config.allowNonGitBaseline === true) {
      const fallback = await nonGitFacts({ listProjectFiles, readProjectText, projectRoot, config, signal })
      if (fallback.ok === true) {
        const lockfileHashes = {}
        for (const lockfile of lockfiles) {
          const absolute = `${projectRoot.replace(/[\\/]+$/, '')}/${lockfile}`
          const read = await readProjectText(absolute, config.snapshotMaxFileBytes)
          lockfileHashes[lockfile] = read.ok ? sha256Hex(read.text) : null
        }
        return {
          ok: true,
          head: null,
          nonGit: true,
          entries: fallback.entries,
          lockfiles: lockfileHashes,
          fingerprint: fallback.fingerprint,
          warnings: [fallback.warning],
          error: null,
        }
      }
      return { ok: false, fingerprint: null, head: null, entries: [], error: fallback.error }
    }
    return {
      ok: false,
      fingerprint: null,
      head: null,
      entries: [],
      error: 'HEAD is unreadable (non-git workspace; set allowNonGitBaseline=true to use the bounded file hash)',
    }
  }
  const head = headResult.stdout.trim()
  const statusResult = await git(run, 'status --porcelain=v1 --untracked-files=all', projectRoot, signal)
  if (!statusResult.ok) {
    return { ok: false, fingerprint: null, head, entries: [], error: `git status failed: ${statusResult.report.reason}` }
  }

  let statusEntries = parseGitStatus(statusResult.stdout)
  if (statusEntries.length > config.snapshotMaxFiles) statusEntries = statusEntries.slice(0, config.snapshotMaxFiles)

  const entries = []
  for (const entry of statusEntries) {
    if (entry.status === 'deleted' || entry.status === 'ignored') {
      entries.push({ ...entry, sha256: null })
      continue
    }
    const absolute = `${projectRoot.replace(/[\\/]+$/, '')}/${entry.path}`
    const read = await readProjectText(absolute, config.snapshotMaxFileBytes)
    entries.push({ ...entry, sha256: read.ok ? sha256Hex(read.text) : null })
  }

  const lockfileHashes = {}
  for (const lockfile of lockfiles) {
    const absolute = `${projectRoot.replace(/[\\/]+$/, '')}/${lockfile}`
    const read = await readProjectText(absolute, config.snapshotMaxFileBytes)
    lockfileHashes[lockfile] = read.ok ? sha256Hex(read.text) : null
  }

  return {
    ok: true,
    head,
    entries,
    lockfiles: lockfileHashes,
    fingerprint: compositeFingerprint({
      head,
      entries: entries.map((entry) => ({ path: entry.path, status: entry.status, sha256: entry.sha256 })),
    }),
    error: null,
  }
}

/**
 * Whether a dependency lockfile changed relative to the baseline.
 *
 * @param baseline - the captured snapshot.
 * @param current - `currentFacts()` output.
 * @returns `{ changed, files }`.
 */
export function lockfilesChanged(baseline, current) {
  const before = baseline?.lockfiles ?? {}
  const after = current?.lockfiles ?? {}
  const files = []
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if ((before[name] ?? null) !== (after[name] ?? null)) files.push(name)
  }
  return { changed: files.length > 0, files }
}

/**
 * Materialize the frozen baseline into an isolated directory.
 *
 * Restoring the user's working tree in place is explicitly not an option, so the
 * committed state comes from a detached worktree and the frozen overlay is
 * written on top. When either step fails the caller gets `ok: false`, and the
 * comparison degrades to `unknown_attribution` instead of guessing (§7.3).
 *
 * @param options - injection points.
 * @returns `{ ok, dir, mode, warnings, error }`.
 */
export async function materializeBaseline({
  run,
  projectRoot,
  snapshot,
  dir,
  signal,
  writeSnapshotFile,
  readSnapshotFile,
  logger,
}) {
  const warnings = []

  if (snapshot?.gitAvailable !== true || snapshot?.head === null || snapshot?.head === undefined) {
    return { ok: false, dir: null, mode: null, warnings, error: 'the baseline has no usable git HEAD to materialize from' }
  }

  const worktree = await run({
    command: `git worktree add --detach --force "${dir}" ${snapshot.head}`,
    workdir: projectRoot,
    signal,
    label: 'git worktree add',
  })

  if (worktree.status !== 'completed' || worktree.exitCode !== 0) {
    return {
      ok: false,
      dir: null,
      mode: null,
      warnings,
      error: `git worktree add failed (${worktree.reason}): ${String(worktree.stderr ?? '').trim().slice(0, 400)}`,
    }
  }

  for (const entry of snapshot.entries ?? []) {
    if (entry.stored === null || entry.sha256 === null) continue
    const target = `${dir.replace(/[\\/]+$/, '')}/${entry.path}`
    try {
      const text = typeof readSnapshotFile === 'function' ? await readSnapshotFile(entry.stored) : null
      if (text === null) {
        warnings.push(`frozen content for ${entry.path} was not found; the baseline copy is incomplete`)
        continue
      }
      await writeSnapshotFile(target, text)
    } catch (error) {
      warnings.push(`could not restore ${entry.path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const incomplete = warnings.some((warning) => warning.includes('was not found'))
  logger?.info?.(`[verification-gate] baseline materialized at ${dir} (warnings=${warnings.length})`)

  return {
    ok: !incomplete,
    dir,
    mode: 'worktree',
    warnings,
    error: incomplete ? 'part of the frozen overlay could not be restored' : null,
  }
}

/**
 * The cache key of one piece of execution evidence (§6.4).
 *
 * @param parts - every input that could change the answer.
 * @returns the key.
 */
export function cacheKey(parts) {
  return compositeFingerprint({
    workspaceSnapshot: parts.workspaceFingerprint ?? null,
    executionEnvironment: parts.environmentFingerprint ?? null,
    commandDefinition: parts.command ?? null,
    testSelection: parts.selection ?? null,
    oracleDefinition: parts.oracleFingerprint ?? null,
    adapterVersion: parts.adapterVersion ?? null,
  })
}

/**
 * Whether a cached result may be reused.
 *
 * V1 prefers to re-run over a possibly wrong reuse: every component must match,
 * and the cached record must itself have been a complete run.
 *
 * @param cached - the cached record.
 * @param current - the current components.
 * @returns `{ reusable, code, reason }`.
 */
export function cacheUsable(cached, current) {
  if (cached === null || cached === undefined) return { reusable: false, code: 'NO_CACHE', reason: 'no cached evidence' }
  if (cached.complete !== true) return { reusable: false, code: 'CACHED_INCOMPLETE', reason: 'the cached run was not a complete execution' }
  const expected = cacheKey(current)
  if (cached.key !== expected) return { reusable: false, code: 'KEY_MISMATCH', reason: 'the workspace, environment, command or oracle changed' }
  return { reusable: true, code: 'OK', reason: 'every cache component matches' }
}
