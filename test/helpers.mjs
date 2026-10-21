/**
 * Shared test doubles.
 *
 * Nothing here spawns a process: the executor seam, the filesystem and the
 * OpenViking tool surface are all injected, so the whole suite runs without a
 * DSH install and without touching a real project.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * A Shell service double.
 *
 * @param handler - `(spec) => { exitCode, stdout, stderr, timedOut, aborted }`
 *   or `(spec) => Promise<...>`.
 * @returns an object shaped like `ctx.shell`.
 */
export function createFakeShell(handler) {
  const calls = []
  return {
    calls,
    resolve(request) {
      return {
        command: request.command,
        workdir: request.workdir ?? process.cwd(),
        timeoutMs: request.timeoutMs ?? 120000,
        stdoutMaxBytes: request.stdoutMaxBytes ?? 2097152,
        onExpiry: 'kill',
        signal: request.signal,
      }
    },
    async execute(spec) {
      calls.push(spec)
      const outcome = (await handler(spec)) ?? {}
      return {
        status: 'completed',
        exitCode: outcome.exitCode ?? 0,
        signal: null,
        async result() {
          return {
            exitCode: outcome.exitCode ?? 0,
            signal: null,
            timedOut: outcome.timedOut === true,
            aborted: outcome.aborted === true,
            timeoutMs: spec.timeoutMs,
            stdout: { text: outcome.stdout ?? '', truncated: outcome.truncated === true },
            stderr: { text: outcome.stderr ?? '', truncated: false },
            sandbox: outcome.sandbox,
          }
        },
      }
    },
  }
}

/** A filesystem double backed by a plain object of path to text. */
export function createFakeFsx(files = {}) {
  const normalized = new Map(Object.entries(files).map(([path, text]) => [path.replace(/\\/g, '/'), text]))
  return {
    files: normalized,
    async exists(path) {
      return normalized.has(String(path).replace(/\\/g, '/'))
    },
    async readText(path) {
      const key = String(path).replace(/\\/g, '/')
      if (!normalized.has(key)) throw new Error(`ENOENT: ${key}`)
      return normalized.get(key)
    },
    /**
     * The immediate child names under `path`, derived from the known files.
     *
     * Exists so a test can describe an AGGREGATE workspace (a root that holds
     * several projects and has no manifest of its own) without touching a real
     * directory tree.
     */
    async readdir(path) {
      const prefix = `${String(path).replace(/\\/g, '/').replace(/\/+$/, '')}/`
      const names = new Set()
      for (const key of normalized.keys()) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        if (rest === '') continue
        names.add(rest.split('/')[0])
      }
      return [...names].sort()
    },
    async readProjectText(path, maxBytes) {
      const key = String(path).replace(/\\/g, '/')
      if (!normalized.has(key)) return { ok: false, error: `ENOENT: ${key}` }
      const text = normalized.get(key)
      return { ok: true, text, bytes: Buffer.byteLength(text, 'utf8'), via: 'test' }
    },
  }
}

/** A file writer double that records what would have been written. */
export function createFakeWriter() {
  const written = new Map()
  return {
    written,
    async write(path, text) {
      written.set(String(path).replace(/\\/g, '/'), text)
      return path
    },
    async read(path) {
      const key = String(path).replace(/\\/g, '/')
      return written.has(key) ? written.get(key) : null
    },
  }
}

/** A memory adapter double. */
export function createFakeMemoryAdapter({ status = 'empty', memories = [], failWith = null } = {}) {
  const queries = []
  return {
    queries,
    discover: () => ({ tool: status === 'unavailable' ? null : { name: 'mcp__openviking__search' }, inspection: null, candidates: [], reason: 'test double' }),
    available: () => status !== 'unavailable',
    async search({ checkpoint, purpose, query }) {
      queries.push({ checkpoint, purpose, query })
      if (status === 'failed' && checkpoint === 'repair') {
        return {
          receipt: { queryId: `q${queries.length}`, checkpoint, purpose, query, status: 'failed', memoryIds: [], error: failWith ?? 'boom', elapsedMs: 1, attemptedAt: Date.now() },
          memories: [],
          schema: null,
        }
      }
      return {
        receipt: {
          queryId: `q${queries.length}`,
          checkpoint,
          purpose,
          query,
          status,
          memoryIds: memories.map((memory) => memory.uri).filter(Boolean),
          elapsedMs: 1,
          attemptedAt: Date.now(),
        },
        memories,
        schema: null,
      }
    },
  }
}

/** Write a Vitest-shaped JSON report to disk, creating parent directories. */
export async function writeVitestReport(path, items) {
  const body = JSON.stringify({
    numTotalTests: items.length,
    numPassedTests: items.filter((item) => item.status === 'passed').length,
    numFailedTests: items.filter((item) => item.status === 'failed').length,
    success: items.every((item) => item.status !== 'failed'),
    testResults: [{
      name: 'src/example.test.ts',
      assertionResults: items.map((item) => ({
        fullName: item.name,
        status: item.status,
        failureMessages: item.status === 'failed' ? [item.message ?? `failure in ${item.name}`] : [],
      })),
    }],
  }, null, 2)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body, 'utf8')
}

/** Write a pytest-shaped JUnit XML report to disk. */
export async function writeJUnitReport(path, items) {
  const cases = items.map((item) => {
    if (item.status === 'failed') {
      return `  <testcase classname="tests.test_example" name="${item.name}" file="tests/test_example.py" time="0.01"><failure message="${item.message ?? 'assertion failed'}">traceback</failure></testcase>`
    }
    if (item.status === 'skipped') {
      return `  <testcase classname="tests.test_example" name="${item.name}" file="tests/test_example.py" time="0.0"><skipped/></testcase>`
    }
    return `  <testcase classname="tests.test_example" name="${item.name}" file="tests/test_example.py" time="0.01"/>`
  })
  const body = [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<testsuite name="pytest" tests="${items.length}" failures="${items.filter((item) => item.status === 'failed').length}" errors="0" skipped="${items.filter((item) => item.status === 'skipped').length}">`,
    ...cases,
    '</testsuite>',
  ].join('\n')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body, 'utf8')
}

/** Extract a `--flag=value` or `--flag value` style argument from a command line. */
export function argumentOf(command, flag) {
  const match = new RegExp(`--${flag}=(?:"([^"]+)"|(\\S+))`).exec(command)
  if (match !== null) return match[1] ?? match[2]
  const spaced = new RegExp(`--${flag}\\s+(?:"([^"]+)"|(\\S+))`).exec(command)
  return spaced === null ? null : (spaced[1] ?? spaced[2])
}
