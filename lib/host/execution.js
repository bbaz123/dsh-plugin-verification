/**
 * The execution seam.
 *
 * Every command this plugin runs goes through the DSH Shell service — never
 * through `node:child_process` — so the host's own working directory, output
 * caps, sandbox policy and cancellation apply to plugin-initiated execution
 * exactly as they apply to a model tool call (§9.1: calling a DSH service is
 * not permission to skip the service's policy).
 *
 * The seam also refuses to compress a run into one boolean. Exit status,
 * timeout, abort, output truncation and sandbox facts are reported separately,
 * because `exitCode === 0` alone cannot prove a run completed and produced a
 * report (§11: "命令超时后仍返回 0 → 按不完整执行处理").
 *
 * @module dsh-plugin-verification/host/execution
 */

import { sha256Hex, stableStringify } from '../store.js'

/** Runtime identity of this process, part of the evidence fingerprint. */
export function environmentFingerprint(extra = {}) {
  return `sha256:${sha256Hex(stableStringify({
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    ...extra,
  }))}`
}

/** Commands that would change the dependency environment. */
const INSTALL_PATTERNS = [
  /\bnpm\s+(install|i|ci|add)\b/i,
  /\bpnpm\s+(install|i|add|update|up)\b/i,
  /\byarn\s+(install|add|up)\b/i,
  /\bbun\s+(install|add)\b/i,
  /\bpip3?\s+install\b/i,
  /\bpoetry\s+(install|add|update)\b/i,
  /\buv\s+(pip\s+install|add|sync|lock)\b/i,
  /\bconda\s+(install|update)\b/i,
]

/**
 * Decide whether the plugin may run a command.
 *
 * V1 runs only commands it composed itself from a detected project toolchain, so
 * this is deliberately narrow: it exists to make "不静默联网安装" a code-level
 * rule rather than a promise. Anything that looks like a dependency mutation is
 * refused unless `execution.autoInstallDependencies` is explicitly enabled.
 *
 * @param command - the composed command line.
 * @param config - the resolved configuration.
 * @returns `{ allowed, reason }`.
 */
export function checkCommandAllowed(command, config) {
  const text = String(command ?? '')
  if (text.trim() === '') return { allowed: false, reason: 'empty command' }
  if (config?.executionAutoInstallDependencies === true) return { allowed: true, reason: 'dependency mutation is enabled by config' }
  for (const pattern of INSTALL_PATTERNS) {
    if (pattern.test(text)) {
      return {
        allowed: false,
        reason: `refusing a dependency-changing command while execution.autoInstallDependencies is false: ${text}`,
      }
    }
  }
  return { allowed: true, reason: 'read-only with respect to the dependency environment' }
}

/** Classify a settled shell result into this plugin's vocabulary. */
export function classifyShellResult(result) {
  if (result?.aborted === true) return 'aborted'
  if (result?.timedOut === true) return 'timed_out'
  if (result?.exitCode === 0) return 'completed'
  if (typeof result?.exitCode === 'number') return 'failed'
  return 'incomplete'
}

/**
 * Create the executor bound to one host context.
 *
 * @param options - `{ shell, config, logger, session, resolveSandboxPolicy }`.
 *   `session` is read **at call time** (a getter, not a snapshot): one executor
 *   serves whichever session is currently running the gate.
 *   `resolveSandboxPolicy(session)` is the host's own `ctx.sandboxPolicy.resolve`,
 *   injected so this module never reaches into the host's service shape.
 * @returns `{ run, resolve, environmentFingerprint }`.
 */
export function createExecutor({ shell, config, logger, session, resolveSandboxPolicy }) {
  /**
   * The sandbox policy for one plugin-initiated call.
   *
   * WHY THIS EXISTS (2026-10-13): without it, `shell.resolve` was called with
   * neither `sandboxPolicy` nor `session`, so the host resolved
   * `undefined ?? undefined ?? defaultMode` — the **deployment default**
   * (`workspace-write` here). That silently ran every check under a *stricter*
   * confinement than the session being verified: the author works in a wider
   * session, and the gate then reports the project red for failures the author
   * never had. Measured on one machine, one command: 37/17 inside the gate,
   * 54/54 in the session.
   *
   * Passing the session makes plugin-initiated execution inherit exactly the
   * session's own resolved policy — which is what this module's header has
   * always claimed ("the host's own … sandbox policy … apply to
   * plugin-initiated execution"). It widens nothing: a confined session
   * confines the gate identically. Absent a session (agentless call, unit
   * test) the policy is `undefined` and the call keeps its previous behaviour
   * byte for byte.
   */
  function sandboxPolicyFor() {
    const current = typeof session === 'function' ? session() : session
    if (current === undefined || current === null) return undefined
    if (typeof resolveSandboxPolicy !== 'function') return undefined
    try {
      return resolveSandboxPolicy(current)
    } catch (error) {
      logger?.warn?.(
        `[verification-gate] could not resolve the session sandbox policy: ${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
  }

  /**
   * Run one composed command and return a structured report.
   *
   * @param request - `{ command, workdir, timeoutMs, signal, label }`.
   * @returns the report; never throws for a command failure.
   */
  async function run({ command, workdir, timeoutMs, signal, label = 'command' }) {
    const allowed = checkCommandAllowed(command, config)
    if (!allowed.allowed) {
      return {
        label,
        command,
        workdir,
        status: 'refused',
        complete: false,
        refused: true,
        reason: allowed.reason,
        exitCode: null,
        timedOut: false,
        aborted: false,
        signal: null,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        sandbox: null,
        startedAt: Date.now(),
        endedAt: Date.now(),
        durationMs: 0,
      }
    }

    const startedAt = Date.now()
    let spec
    try {
      spec = shell.resolve({
        command,
        workdir,
        timeoutMs: timeoutMs ?? config.executionCommandTimeoutMs,
        stdoutMaxBytes: config.executionMaxCapturedOutputBytes,
        signal,
        // 继承当前会话已解析的策略（见 sandboxPolicyFor 的说明）。
        // 会话缺失 / 宿主没暴露策略服务时为 `undefined`，行为与改动前逐字节一致。
        sandboxPolicy: sandboxPolicyFor(),
      })
    } catch (error) {
      return {
        label,
        command,
        workdir,
        status: 'incomplete',
        complete: false,
        refused: false,
        reason: `could not resolve an execution spec: ${error instanceof Error ? error.message : String(error)}`,
        exitCode: null,
        timedOut: false,
        aborted: false,
        signal: null,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        sandbox: null,
        startedAt,
        endedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      }
    }

    let result
    try {
      const execution = await shell.execute(spec)
      result = await execution.result()
    } catch (error) {
      return {
        label,
        command,
        workdir: spec.workdir,
        status: 'incomplete',
        complete: false,
        refused: false,
        reason: `execution failed before it produced a process result: ${error instanceof Error ? error.message : String(error)}`,
        exitCode: null,
        timedOut: false,
        aborted: false,
        signal: null,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        sandbox: null,
        startedAt,
        endedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      }
    }

    const endedAt = Date.now()
    const status = classifyShellResult(result)
    const stdout = result?.stdout?.text ?? ''
    const stderr = result?.stderr?.text ?? ''
    const stdoutTruncated = result?.stdout?.truncated === true
    const stderrTruncated = result?.stderr?.truncated === true

    logger?.debug?.(
      `[verification-gate] ${label}: ${status} (exit=${String(result?.exitCode)}, timeout=${String(result?.timedOut)}, `
      + `aborted=${String(result?.aborted)}) in ${endedAt - startedAt}ms`,
    )

    return {
      label,
      command,
      workdir: spec.workdir,
      status,
      // "Complete" answers "did this execution produce a whole result?", NOT
      // "did the command succeed": a failing test run is a complete result, and
      // treating it as incomplete would also strip it of the authority to ground
      // a defect. Only a timed-out, aborted, refused or truncated run is
      // incomplete (§5.2, §11).
      complete: (status === 'completed' || status === 'failed') && !stdoutTruncated && !stderrTruncated,
      refused: false,
      reason: status === 'completed' ? 'command completed' : `command settled as ${status}`,
      exitCode: typeof result?.exitCode === 'number' ? result.exitCode : null,
      timedOut: result?.timedOut === true,
      aborted: result?.aborted === true,
      signal: result?.signal ?? null,
      stdout,
      stderr,
      stdoutTruncated,
      stderrTruncated,
      stdoutSpillPath: result?.stdout?.spillPath ?? null,
      stderrSpillPath: result?.stderr?.spillPath ?? null,
      sandbox: result?.sandbox ?? null,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
    }
  }

  return { run, environmentFingerprint }
}
