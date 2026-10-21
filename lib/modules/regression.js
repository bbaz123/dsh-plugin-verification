/**
 * Regression Engine: compare test ITEMS, not one "suite failed" bit.
 *
 * The engine owns four things the rest of the plugin must not re-implement:
 *
 *   - one execution plan, run once per side. A test that already ran is never
 *     run twice just because Assertion is a separate stage (§7.4);
 *   - a lazy baseline: the frozen baseline is executed in an ISOLATED directory
 *     only when the current side actually failed, which keeps the common case
 *     cheap without ever restoring the user's working tree;
 *   - item-level comparison (delegated to `compareTestRuns`), so a pre-existing
 *     failure is not blamed on this task;
 *   - evidence that says exactly what ran, where its raw report is, and whether
 *     the result was complete.
 *
 * Two failure modes are corrected rather than reported: a run that exited 0 but
 * produced no parsable report is NOT a pass, and a failure that disappears on an
 * immediate re-run is recorded as unstable rather than as fixed (§7.3).
 *
 * @module dsh-plugin-verification/modules/regression
 */

import { mkdir, symlink } from 'node:fs/promises'
import { dirname } from 'node:path'

import { ADAPTER_VERSION, compareTestRuns, parseReport } from '../adapters.js'
import { makeEvidence, STAGE } from '../protocol.js'

/** Default filesystem operations for preparing an isolated baseline worktree. */
const DEFAULT_FS = {
  async ensureDir(path) {
    await mkdir(path, { recursive: true })
  },
  async linkModules(linkPath, targetPath) {
    // On Windows a directory junction needs no elevation, which is why the
    // baseline shares the current dependency tree through a link instead of a
    // multi-gigabyte copy. It is only ever done when no lockfile changed.
    await symlink(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  },
}

/**
 * How fast a failing run has to settle before it counts as "the command never
 * really ran". A real test suite that fails takes seconds; a harness that cannot
 * start the process settles in milliseconds. The rule is deliberately
 * conservative: only a failing check that is BOTH instantaneous AND mute is
 * classified as an environment fault, so a genuinely fast failing suite is still
 * reported as a failing suite.
 */
const INSTANT_FAILURE_MAX_MS = 3000

/** Summarise one parsed report into a bounded, model-facing line. */
function summariseRun(label, parsed, report) {
  const summary = parsed?.summary
  if (summary === null || summary === undefined) {
    return `${label}: no structured report (status ${report.status})`
  }
  return `${label}: ${summary.total} test(s) — ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`
}

/**
 * Whether a failed execution looks like an environment fault rather than a real
 * failing run.
 *
 * Measured shape (2026-10-12): a check exited non-zero while every child check
 * failed in 0–1 ms with empty output — the command never produced a process
 * result, yet nothing downstream could tell that apart from "the suite failed".
 *
 * @param outcome - one `runCheck` outcome.
 * @returns true when the failure is environment-shaped.
 */
function isInstantaneousFailure(outcome) {
  if (outcome.report.status !== 'failed') return false
  if ((outcome.report.durationMs ?? 0) > INSTANT_FAILURE_MAX_MS) return false
  const stdout = String(outcome.report.stdout ?? '')
  const stderr = String(outcome.report.stderr ?? '')
  return stdout.trim() === '' && stderr.trim() === ''
}

/**
 * Create the regression engine bound to one host context.
 *
 * @param options - `{ executor, config, store, logger, fs }`.
 * @returns `{ runCheck, runPlan, verify }`.
 */
export function createRegressionEngine({ executor, config, store, logger, fs = DEFAULT_FS }) {
  /**
   * Run one check of the plan and produce its evidence.
   *
   * @param options - `{ taskState, check, workdir, reportDir, runId, signal, agent }`.
   * @returns the check outcome.
   */
  async function runCheck({ taskState, check, workdir, reportDir, runId, signal }) {
    const report = await executor.run({
      command: check.command,
      workdir,
      signal,
      label: `${runId}:${check.id}`,
    })

    let parsed = { ok: false, items: [], summary: null, error: 'no report was requested for this check' }
    let reportPath = null
    let reportBytes = null
    let reportTruncated = false

    if (check.reportFormat !== null && check.reportPath !== null) {
      reportPath = check.reportPath
      const read = await store.readReport(reportPath)
      if (read.ok) {
        const written = await store.writeReport(
          `${reportDir}/${check.id}.captured.report`,
          read.text,
          config.reportMaxBytes,
        )
        reportBytes = written.bytes
        reportTruncated = written.truncated
        parsed = parseReport(check.reportFormat, read.text)
      } else {
        parsed = { ok: false, items: [], summary: null, error: `the report file could not be read: ${read.error}` }
      }
    }

    // A nominal exit code cannot rescue a missing or unusable report.
    const reportMissing = check.reportFormat !== null && parsed.ok !== true
    const settled = report.status === 'completed' || report.status === 'failed'
    const validity = report.status === 'aborted' || report.status === 'timed_out' || report.status === 'refused'
      ? 'unavailable'
      : reportMissing || !settled || reportTruncated
        ? 'incomplete'
        : 'valid'

    const evidence = makeEvidence({
      stage: check.kind === 'test' ? STAGE.REGRESSION : STAGE.ASSERTION,
      producer: 'regression-engine',
      action: `ran \`${check.command}\` in ${workdir}`,
      workspaceFingerprint: taskState.workspaceFingerprint,
      environmentFingerprint: taskState.environmentFingerprint,
      validity,
      origin: 'current_execution',
      summary: parsed.ok
        ? summariseRun(check.id, parsed, report)
        : `${check.id}: ${reportMissing ? `report unusable (${parsed.error})` : `status ${report.status} (exit ${String(report.exitCode)})`}`,
      raw: reportPath ?? null,
      complete: report.complete === true && !reportMissing && !reportTruncated,
      detail: {
        status: report.status,
        exitCode: report.exitCode,
        timedOut: report.timedOut,
        aborted: report.aborted,
        durationMs: report.durationMs,
        stdoutTail: String(report.stdout ?? '').slice(-2000),
        stderrTail: String(report.stderr ?? '').slice(-2000),
        reportBytes,
        sandbox: report.sandbox,
      },
    })

    return { check, report, parsed, reportPath, reportMissing, validity, evidence }
  }

  /** Run every check of one plan in order. */
  async function runPlan({ taskState, plan, workdir, reportDir, runId, signal, only = null }) {
    await fs.ensureDir(reportDir)
    const checks = only === null ? plan.checks : plan.checks.filter((check) => only.includes(check.checkId ?? check.id))
    const outcomes = []
    for (const check of checks) {
      if (signal?.aborted === true) break
      outcomes.push(await runCheck({ taskState, check, workdir, reportDir, runId, signal }))
      if (config.failFast && outcomes[outcomes.length - 1].report.status === 'timed_out') {
        logger?.warn?.(`[verification-gate] ${check.id} timed out; stopping the rest of this plan`)
        break
      }
    }
    return outcomes
  }

  /**
   * Turn one plan's outcomes into one side of the comparison.
   *
   * @param outcomes - `runPlan` output.
   * @returns `{ items, failedChecks, failedCheckIds, summary, complete, byCheck }`.
   */
  function foldSide(outcomes) {
    const items = []
    for (const outcome of outcomes) {
      for (const item of outcome.parsed.items ?? []) items.push({ ...item, checkId: outcome.check.id })
    }
    const complete = outcomes.length > 0 && outcomes.every((outcome) => outcome.report.complete === true && !outcome.reportMissing)
    const failed = outcomes.filter((outcome) => outcome.report.status === 'failed' || (outcome.parsed.summary?.failed ?? 0) > 0)
    // The check-level record is the fact the per-item comparison cannot see: a
    // run can fail as a command while contributing zero test items, and that is
    // exactly the shape that used to pass as `clean` with no finding at all.
    const failedChecks = failed.map((outcome) => {
      const stdout = String(outcome.report.stdout ?? '')
      const stderr = String(outcome.report.stderr ?? '')
      return {
        id: outcome.check.id,
        kind: outcome.check.kind,
        command: outcome.check.command,
        status: outcome.report.status,
        exitCode: outcome.report.exitCode,
        durationMs: outcome.report.durationMs,
        complete: outcome.report.complete === true,
        reportMissing: outcome.reportMissing,
        reportFormat: outcome.check.reportFormat ?? null,
        reason: outcome.report.reason ?? null,
        parseError: outcome.parsed.error ?? null,
        observedItems: (outcome.parsed.items ?? []).length,
        observedFailedItems: outcome.parsed.items === undefined
          ? null
          : outcome.parsed.items.filter((item) => item.status === 'failed').length,
        instantaneous: isInstantaneousFailure(outcome),
        stdoutTail: stdout.slice(-400),
        stderrTail: stderr.slice(-400),
      }
    })
    return {
      items,
      complete,
      failedCheckIds: failed.map((outcome) => outcome.check.id),
      failedChecks,
      summary: {
        checks: outcomes.length,
        failedChecks: failed.length,
        items: items.length,
        failedItems: items.filter((item) => item.status === 'failed').length,
      },
      byCheck: outcomes.map((outcome) => ({
        id: outcome.check.id,
        kind: outcome.check.kind,
        adapter: outcome.check.adapter,
        command: outcome.check.command,
        reportFormat: outcome.check.reportFormat,
        status: outcome.report.status,
        exitCode: outcome.report.exitCode,
        timedOut: outcome.report.timedOut,
        complete: outcome.report.complete === true,
        reportMissing: outcome.reportMissing,
        reportPath: outcome.reportPath,
        parsed: outcome.parsed.summary,
        parseError: outcome.parsed.error,
        evidenceId: outcome.evidence.id,
        durationMs: outcome.report.durationMs,
        stdoutTail: String(outcome.report.stdout ?? '').slice(-4000),
        stderrTail: String(outcome.report.stderr ?? '').slice(-4000),
      })),
    }
  }

  /**
   * Prepare an isolated baseline directory: detached worktree + frozen overlay +
   * a dependency link when no lockfile changed.
   *
   * @returns `{ ok, dir, mode, error, warnings }`.
   */
  async function prepareBaselineWorkdir({ taskState, baselineDir, signal, lockfilesChanged = false }) {
    const snapshot = taskState.baseline
    if (snapshot === null || snapshot === undefined) {
      return { ok: false, dir: null, mode: null, error: 'this task has no captured baseline', warnings: [] }
    }
    const { materializeBaseline } = await import('../baseline.js')
    await fs.ensureDir(baselineDir)
    const materialized = await materializeBaseline({
      run: executor.run,
      projectRoot: snapshot.projectRoot,
      snapshot,
      dir: baselineDir,
      signal,
      writeSnapshotFile: (path, text) => store.writeReport(path, text, config.snapshotMaxFileBytes),
      readSnapshotFile: async (path) => {
        const read = await store.readReport(path)
        return read.ok ? read.text : null
      },
      logger,
    })
    if (!materialized.ok) return materialized

    // §6.3: the two sides must be given the dependency environment they each
    // should have. Sharing the current node_modules through a link is only
    // sound while the lockfile is unchanged; when it moved, the baseline's
    // environment cannot be reconstructed here and the comparison must say so
    // instead of comparing two different worlds.
    const unfrozen = Object.values(snapshot.lockfiles ?? {}).some((hash) => hash === null)
    if (unfrozen) {
      return {
        ...materialized,
        ok: false,
        error: 'a dependency lockfile could not be frozen, so the two sides cannot be given corresponding environments',
      }
    }
    if (lockfilesChanged) {
      return {
        ...materialized,
        ok: false,
        error: 'this task changed a dependency lockfile; the baseline environment cannot be reconstructed by sharing the current one',
      }
    }

    try {
      await fs.linkModules(`${baselineDir}/node_modules`, `${snapshot.projectRoot.replace(/[\\/]+$/, '')}/node_modules`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // EEXIST / EPERM: an existing link is fine, a refused link is not.
      if (!/exists/i.test(message)) {
        return { ...materialized, ok: false, error: `the baseline could not share the dependency tree: ${message}` }
      }
    }
    return materialized
  }

  /**
   * Run the regression stage of one cycle.
   *
   * @param options - `{ taskState, plan, cycle, signal, mode, baselinePolicy }`.
   * @returns `{ current, baseline, comparison, evidence, findings, preparedBaseline }`.
   */
  async function verify({ taskState, plan, cycle, signal, mode = 'regression', baselinePolicy = 'new-failures', lockfilesChanged = false }) {
    const runId = `cycle-${cycle}`
    const currentReportDir = store.reportDir(taskState.taskId, `${runId}-current`)
    const outcomes = await runPlan({
      taskState,
      plan,
      workdir: taskState.projectRoot,
      reportDir: currentReportDir,
      runId,
      signal,
    })
    const current = foldSide(outcomes)
    const evidence = outcomes.map((outcome) => outcome.evidence)
    const findings = []
    let baselineSide = null
    let preparedBaseline = null
    let baselineAvailable = false

    // Lazy baseline: only a failing current side needs to be attributed, and
    // only the isolated copy is ever restored.
    const needsBaseline = current.failedCheckIds.length > 0
    if (needsBaseline) {
      const baselineDir = `${store.snapshotDir(taskState.taskId, cycle)}/worktree`
      preparedBaseline = await prepareBaselineWorkdir({ taskState, baselineDir, signal, lockfilesChanged })
      if (preparedBaseline.ok) {
        const baselineReportDir = store.reportDir(taskState.taskId, `${runId}-baseline`)
        const baselineOutcomes = await runPlan({
          taskState,
          plan,
          workdir: baselineDir,
          reportDir: baselineReportDir,
          runId: `${runId}-baseline`,
          signal,
        })
        baselineSide = foldSide(baselineOutcomes)
        baselineAvailable = baselineSide.complete
        // The baseline records are re-stamped with `baseline_execution` origin and
        // the BASELINE fingerprint (so they can never ground a current-state
        // defect). They are re-identified in the process, so the per-check index
        // must be re-pointed at the ids that are actually stored — otherwise a
        // finding citing the baseline would cite evidence the store cannot
        // resolve, and §7.5's first check would rightly drop it.
        const baselineClones = baselineOutcomes.map((outcome) => makeEvidence({
          ...outcome.evidence,
          id: undefined,
          origin: 'baseline_execution',
          workspaceFingerprint: taskState.baselineFingerprint,
          action: `ran \`${outcome.check.command}\` in the isolated baseline copy`,
        }))
        evidence.push(...baselineClones)
        baselineSide.byCheck = baselineSide.byCheck.map((entry, index) => ({
          ...entry,
          evidenceId: baselineClones[index]?.id ?? null,
        }))
      } else {
        logger?.warn?.(`[verification-gate] baseline could not be materialized: ${preparedBaseline.error}`)
      }
    }

    const oracleChanged = taskState.change?.oracleChanged === true
    // Whether the task HAS a baseline at all is a different fact from whether the
    // lazy baseline was executed this cycle (§7.4): a clean current side legitimately
    // needs no comparison, while a task with no captured baseline has nothing to
    // compare against later.
    const baselineEstablished = taskState.baseline !== null && taskState.baseline !== undefined
    const comparison = compareTestRuns({
      baseline: baselineSide,
      current,
      baselineAvailable,
      baselineEstablished,
      oracleChanged,
    })
    // Whole-environment signal: when EVERY failed check settled instantly and
    // silently, the failure is "this environment never ran the command", not "the
    // project has failing tests". Recorded on the comparison so the review stage
    // can raise an environment fault instead of blaming the code.
    comparison.executionEnvironmentFailed = comparison.executionEnvironmentFailed ?? (
      current.failedChecks.length > 0 && current.failedChecks.every((check) => check.instantaneous === true)
    )

    if (baselinePolicy === 'any-failure' && current.failedCheckIds.length > 0) {
      comparison.verdict = 'any_failure'
      comparison.reason = 'policy treats any failure as blocking for this task'
    }

    // Flake detection: a failure that vanishes on an immediate focused re-run is
    // recorded as unstable, and NEVER as fixed.
    const testCheck = plan.checks.find((check) => check.kind === 'test')
    const focusable = testCheck !== undefined && (testCheck.adapter === 'vitest' || testCheck.adapter === 'pytest')
    if (config.flakeRerunEnabled && comparison.newFailures.length > 0 && focusable) {
      const failedFiles = [...new Set(comparison.newFailures.map((item) => item.file).filter((file) => file !== ''))]
      if (failedFiles.length > 0 && failedFiles.length <= config.flakeRerunMaxFiles) {
        const flakeCheck = {
          ...testCheck,
          id: 'test',
          // The report path must be the one the COMMAND writes to, otherwise the
          // re-run would be parsed from a file nobody produced and every failure
          // would look like it had vanished. The captured copy is already saved
          // under a separate name before parsing, so reusing the path is safe.
          reportPath: testCheck.reportPath,
          reportFormat: testCheck.reportFormat,
          command: `${testCheck.command} ${failedFiles.map((file) => (/\s/.test(file) ? `"${file}"` : file)).join(' ')}`.trim(),
        }
        const rerun = await runCheck({
          taskState,
          check: flakeCheck,
          workdir: taskState.projectRoot,
          reportDir: `${currentReportDir}-rerun`,
          runId: `${runId}-rerun`,
          signal,
        })
        evidence.push(rerun.evidence)
        const rerunFailures = new Set((rerun.parsed.items ?? []).filter((item) => item.status === 'failed').map((item) => item.id))
        const stillFailing = comparison.newFailures.filter((item) => rerunFailures.has(item.id))
        const unstable = comparison.newFailures.filter((item) => !rerunFailures.has(item.id))
        comparison.newFailures = stillFailing
        comparison.unstable = unstable
        if (unstable.length > 0 && stillFailing.length === 0) {
          comparison.verdict = 'unstable'
          comparison.reason = `${unstable.length} failure(s) did not reproduce on an immediate re-run and are recorded as unstable, not fixed`
        }
      }
    }

    return {
      current,
      baseline: baselineSide,
      baselineAvailable,
      preparedBaseline,
      comparison,
      evidence,
      findings,
      summary: {
        verdict: comparison.verdict,
        reason: comparison.reason,
        checks: current.summary.checks,
        failedChecks: current.failedCheckIds,
        newFailures: comparison.newFailures.length,
        preExistingFailures: comparison.unchangedFailures.length,
        baseline: baselineAvailable ? 'available' : (preparedBaseline === null ? 'not requested' : `unavailable (${preparedBaseline.error})`),
        mode,
      },
    }
  }

  return { runCheck, runPlan, verify, foldSide, prepareBaselineWorkdir }
}

/** The adapter version that participates in cache keys. */
export { ADAPTER_VERSION }
