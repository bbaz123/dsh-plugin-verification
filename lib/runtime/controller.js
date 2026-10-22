/**
 * The controller: one orchestrator for the whole verification loop.
 *
 * The design deliberately keeps ONE repair loop, ONE budget and ONE set of
 * counters (§3). The three stages are functions this controller calls, not
 * independent agents with their own retry logic, which is what makes the
 * cycle budget mean "three repairs for the gate" instead of "three per stage".
 *
 *     Change → Memory → Regression → Assertion → Review
 *        → (finding) Ledger → Memory → RepairPacket → steer
 *        → (clean) Finalization handoff → steer
 *
 * Three properties are load-bearing:
 *
 *   - `completed` is never accepted from a caller. It is produced by
 *     `computeGate` after the necessary conditions hold (§2.2).
 *   - a stage product is APPENDED per cycle, never overwritten, so the record
 *     still shows which round introduced what (§5.1).
 *   - a state file that cannot be read stops the task. It never becomes a fresh
 *     task, and it never becomes "verified" (§fail-closed).
 *
 * @module dsh-plugin-verification/runtime/controller
 */

import { buildExecutionPlan, detectProject, findSubProject } from '../adapters.js'
import { captureBaseline, currentFacts, lockfilesChanged } from '../baseline.js'
import { analyzeChange, changeIsVerifiable } from '../modules/change.js'
import { evaluateAssertions } from '../modules/assertion.js'
import { createRepairCoordinator, REPAIR_BLOCK } from '../modules/repair.js'
import { createMemoryResolver } from '../modules/memory.js'
import { createRegressionEngine } from '../modules/regression.js'
import { finalizeFindings, failureFingerprintOf, reviewEvidence } from '../modules/review.js'
import {
  ACCEPTANCE,
  computeGate,
  FINALIZATION_STATUS,
  GATE,
  makeTaskId,
  STAGE,
  TASK_STATE,
} from '../protocol.js'
import { finalizationSettled, renderFinalizationHandoff, verifyMemoryReadback } from './finalization.js'
import { dehydrate, loadOrCreateTask, openRequirementsRevision, policyFingerprint } from './task-state.js'

/** The tools that can change the workspace, denied while a task is blocked. */
const DEFAULT_MUTATING = ['write', 'edit', 'pwsh', 'bash', 'run_code']

/** Why a task could not run at all. */
export const SKIP_REASON = {
  NO_PROJECT: 'NO_SUPPORTED_PROJECT',
  DISABLED: 'DISABLED',
  OBSERVE_ONLY: 'OBSERVE_ONLY',
  NO_CHANGE: 'NO_CHANGE',
  NO_CHECKS: 'NO_DECLARED_CHECK',
  NOT_ROOT: 'NOT_ROOT_SESSION',
}

/**
 * Create the controller for one plugin instance.
 *
 * @param deps - injected host and engine dependencies.
 * @returns the controller API.
 */
export function createController(deps) {
  const {
    config,
    logger,
    taskStore,
    executor,
    memoryAdapter,
    observationBuffer,
    steer,
    detectProjectFn = detectProject,
    resolveSubProjectFn = findSubProject,
  } = deps

  const memoryResolver = createMemoryResolver({ adapter: memoryAdapter, config, logger })
  const regressionEngine = createRegressionEngine({ executor, config, store: taskStore, logger })
  const repairCoordinator = createRepairCoordinator({ memoryResolver, config, logger })

  /** Live task contexts, keyed by session id. */
  const live = new Map()
  /** Serialisation chain per session: one verification run at a time. */
  const chains = new Map()
  /** Project detection cached per root for the lifetime of the plugin. */
  const projectCache = new Map()

  /**
   * The session whose turn is currently being verified (2026-10-13).
   *
   * Why it must exist: the execution seam needs a `session` to resolve the
   * host's sandbox policy. Without one the host falls back to the **deployment
   * default**, which can be *stricter* than the session being verified — the
   * gate then reports checks as failed for a confinement the author never had
   * (measured: 37/17 inside the gate vs 54/54 in the session, same command).
   *
   * The controller is the right owner because it is handed `agent` on every
   * entry point, so the session it records is exactly the one under
   * verification. Refreshed on each entry; `undefined` before the first call,
   * which keeps the executor's previous behaviour.
   */
  let activeSession

  /** The session under verification, for the execution seam's policy lookup. */
  const currentSession = () => activeSession

  /** Serialise work per session so a re-entrant turn-stopping cannot interleave. */
  function serialize(sessionId, operation) {
    const previous = chains.get(sessionId) ?? Promise.resolve()
    const next = previous.then(operation, operation)
    chains.set(sessionId, next.catch(() => {}))
    return next
  }

  /** Detect (and cache) the project under the configured root. */
  async function projectFor(projectRoot) {
    if (projectCache.has(projectRoot)) return projectCache.get(projectRoot)
    const fsx = deps.createFsx()
    const detected = await detectProjectFn({ projectRoot, fsx })
    projectCache.set(projectRoot, detected)
    return detected
  }

  /** The root every path in this task is relative to. */
  function resolveProjectRoot() {
    if (config.projectRoot.trim() !== '') return config.projectRoot.trim()
    try {
      const fromPolicy = deps.workspaceRoot?.()
      if (typeof fromPolicy === 'string' && fromPolicy !== '') return fromPolicy
    } catch {
      // fall through to the process directory
    }
    return process.cwd()
  }

  /**
   * Detect this task's project, resolving the ONE sub-project of an aggregate
   * workspace when the root has no manifest of its own.
   *
   * This exists because "the workspace root is not a project" and "there is
   * nothing here to verify" are NOT the same statement: a container directory
   * such as `C:\work` (holding `app/`, `lib/`, `tools/`) has no manifest at its
   * root, yet every turn in it is work on exactly one of those children. Treating
   * the two as one made the gate permanently inert in such a workspace — loaded,
   * healthy, and structurally unable to say anything — while reporting only that
   * it was "not applicable". The resolution order lives in `findSubProject` and
   * never guesses; when it cannot decide, this still returns `null`.
   *
   * @param context - the live task context (its `projectRoot` may be rewritten).
   * @param requirements - the requirement texts of this turn.
   * @returns `{ project, via }`.
   */
  async function projectWithResolution(context, requirements) {
    const atRoot = await projectFor(context.projectRoot)
    if (atRoot !== null) return { project: atRoot, via: 'workspace-root' }
    // An explicitly configured root is an instruction, not a workspace to search.
    if (config.projectRoot.trim() !== '') return { project: null, via: null }

    const sub = await resolveSubProjectFn({
      workspaceRoot: context.projectRoot,
      texts: requirements,
      activeProjectRoot: context.taskState.activeProjectRoot ?? null,
      fsx: deps.createFsx(),
    })
    if (sub === null) return { project: null, via: null }

    context.projectRoot = sub.projectRoot
    context.taskState.activeProjectRoot = sub.projectRoot
    context.taskState.projectResolution = { via: sub.via, projectRoot: sub.projectRoot, at: Date.now() }
    projectCache.set(sub.projectRoot, sub.project)
    logger?.info?.(`[verification-gate] workspace root is a container; resolving to sub-project ${sub.projectRoot} (via ${sub.via})`)
    return { project: sub.project, via: sub.via }
  }

  /** Build (or return) the live context of one session. */
  async function ensureTask({ sessionId, requirements = [], firstMessageId = null }) {
    const existing = live.get(sessionId)
    if (existing !== undefined) return { ok: true, ...existing }

    const taskId = makeTaskId(sessionId, firstMessageId)
    const loaded = await loadOrCreateTask({
      taskStore,
      sessionId,
      taskId,
      config,
      requirements,
    })
    if (loaded.ok === false) {
      // Fail closed: a state file that exists but cannot be trusted must not
      // become a fresh task, and must not become "verified".
      logger?.error?.(`[verification-gate] refusing to start a task for ${sessionId}: ${loaded.error}`)
      return { ok: false, error: loaded.error }
    }

    const context = {
      taskState: loaded.taskState,
      evidenceStore: loaded.evidenceStore,
      ledger: loaded.ledger,
      created: loaded.created,
      projectRoot: resolveProjectRoot(),
      project: null,
      applicable: null,
      initialized: false,
    }
    live.set(sessionId, context)
    return { ok: true, ...context }
  }

  /** Persist the live context. */
  async function persist(context) {
    const state = dehydrate(context.taskState, context.evidenceStore, context.ledger)
    context.taskState = state
    await taskStore.saveTask(state)
    return state
  }

  /**
   * Initialise a task: detect the project and freeze the baseline.
   *
   * Called from `agent/pre-step`, i.e. BEFORE the task's own mutations begin,
   * which is the only moment at which a trustworthy baseline exists (§4.1,
   * §6.1).
   */
  async function initializeTask({ agent, requirements, firstMessageId, signal }) {
    const sessionId = agent.id
    activeSession = agent.session
    const ensured = await ensureTask({ sessionId, requirements, firstMessageId })
    if (ensured.ok === false) return ensured
    const context = live.get(sessionId)
    if (context.initialized) {
      // A task that DECLINED (no supported project) is re-decided on every turn:
      // the scope it lacked may exist by now — the user names the project path,
      // or the workspace gains a manifest. Pinning "not applicable" for the whole
      // host generation made the gate's own advice ("name the path next turn")
      // useless, and looked exactly like "it ignored me" (2026-10-10 实测).
      if (context.applicable !== false) return { ok: true, context }
      context.initialized = false
      context.skipReason = null
      context.taskState.acceptance = null
      context.taskState.gate = null
      context.taskState.notes = []
    }

    // §4.2: a turn that states a NEW requirement opens a new revision. The
    // baseline is deliberately NOT re-frozen — only the demand the review is
    // measured against changes. Without this, the requirement text stayed frozen
    // at the message that happened to create the task (observed: three turns, one
    // unchanged `requirements`), so the gate reviewed the current code against an
    // older demand.
    const incoming = (Array.isArray(requirements) ? requirements : []).map((text) => String(text).slice(0, 4000))
    if (incoming.length > 0 && incoming.join('\n') !== (context.taskState.requirements ?? []).join('\n')) {
      const revision = openRequirementsRevision(context.taskState, incoming)
      logger?.info?.(`[verification-gate] requirements revision ${revision} opened by a new turn`)
    }

    if (!config.enabled || config.mode === 'off') {
      context.applicable = false
      context.skipReason = SKIP_REASON.DISABLED
      context.initialized = true
      return { ok: true, context }
    }

    const { project } = await projectWithResolution(context, requirements)
    context.project = project
    if (project === null && config.requireDetectedProject) {
      context.applicable = false
      context.skipReason = SKIP_REASON.NO_PROJECT
      context.initialized = true
      context.taskState.state = TASK_STATE.WORKING
      context.taskState.acceptance = 'not_applicable'
      context.taskState.notes = [
        `no supported project toolchain was detected under ${context.projectRoot}`
        + (config.projectRoot.trim() === '' ? ', and no single sub-project of it could be identified from this turn' : '')
        + '; the gate does not run here',
      ]
      logger?.debug?.(`[verification-gate] no supported project under ${context.projectRoot}; gate is not applicable`)
      await persist(context)
      return { ok: true, context }
    }
    if (project?.ok === false) {
      context.applicable = false
      context.skipReason = `PROJECT_UNREADABLE: ${project.reason}`
      context.initialized = true
      return { ok: true, context }
    }

    context.applicable = true
    context.taskState.projectRoot = context.projectRoot
    context.taskState.project = project === null ? null : {
      kind: project.kind,
      packageManager: project.packageManager,
      checks: project.checks,
      lockfiles: project.lockfiles,
    }
    context.taskState.environmentFingerprint = executor.environmentFingerprint()
    context.taskState.policyFingerprint = policyFingerprint(config)

    const snapshot = await captureBaseline({
      run: executor.run,
      projectRoot: context.projectRoot,
      taskId: context.taskState.taskId,
      snapshotDir: taskStore.snapshotDir(context.taskState.taskId, 0),
      config,
      signal,
      logger,
      readProjectText: deps.readProjectText,
      listProjectFiles: deps.listProjectFiles,
      writeSnapshotFile: (path, text) => taskStore.writeReport(path, text, config.snapshotMaxFileBytes),
      lockfiles: project?.lockfiles ?? [],
    })
    context.taskState.baseline = snapshot
    context.taskState.baselineFingerprint = snapshot.fingerprint
    context.taskState.workspaceFingerprint = snapshot.fingerprint
    context.initialized = true
    await persist(context)
    logger?.info?.(`[verification-gate] task ${context.taskState.taskId} initialised (baseline ${String(snapshot.fingerprint).slice(7, 19)})`)
    return { ok: true, context }
  }

  /** Read one live context, hydrating from disk when this process has none. */
  async function contextFor(sessionId) {
    const existing = live.get(sessionId)
    if (existing !== undefined) return { ok: true, context: existing }
    const ensured = await ensureTask({ sessionId })
    if (ensured.ok === false) return { ok: false, error: ensured.error }
    return { ok: true, context: live.get(sessionId) }
  }

  /** Mark a task blocked and remember that the notice still has to be shown. */
  async function blockTask(context, reason, detail) {
    context.taskState.state = TASK_STATE.BLOCKED
    context.taskState.blockedReason = reason
    context.taskState.blockedDetail = detail ?? null
    context.taskState.blockedNoticeIssued = false
    context.taskState.gate = computeGate({
      findings: context.taskState.findings ?? [],
      requiredChecks: context.taskState.requiredChecks ?? { total: 0, verified: 0, unknown: 0 },
      acceptance: context.taskState.acceptance ?? ACCEPTANCE[1],
      finalization: context.taskState.finalization ?? { status: FINALIZATION_STATUS[2] },
      blocked: true,
      blockedReason: `${reason}${detail ? `: ${detail}` : ''}`,
    })
    logger?.warn?.(`[verification-gate] task ${context.taskState.taskId} blocked: ${reason}${detail ? ` (${detail})` : ''}`)
    await persist(context)
    return { action: 'block', reason, detail, gate: context.taskState.gate }
  }

  /**
   * The verification pipeline of one cycle.
   *
   * @param options - `{ agent, signal, mode, reason }`.
   * @returns an instruction for the caller: `none`, `steer`, `block`, `complete`.
   */
  async function run({ agent, signal, mode = config.defaultMode, reason = 'turn-stopping' }) {
    const sessionId = agent?.id
    const found = await contextFor(sessionId)
    if (found.ok === false) {
      return { action: 'block', reason: 'STATE_UNREADABLE', detail: found.error }
    }
    const context = found.context

    if (!config.enabled || config.mode === 'off') return { action: 'none', skip: SKIP_REASON.DISABLED }
    if (context.applicable === false) return { action: 'none', skip: context.skipReason ?? SKIP_REASON.NO_PROJECT }
    if (context.applicable === null) {
      // Never initialised through pre-step: the pre-task baseline does not
      // exist, so only a run without failures can be accepted this time.
      context.project = context.project ?? (await projectWithResolution(context, context.taskState.requirements ?? [])).project
      // 2026-10-18 fix: the late-start path resolved the project for planning but never
      // wrote its root into the task state, so `regression.verify()` ran with
      // `workdir: taskState.projectRoot === undefined` — the host shell then used its own
      // cwd (the aggregate workspace root, which has no manifest) and every project check
      // failed with ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND. Keep the two paths consistent.
      if (context.project !== null) {
        context.taskState.projectRoot = context.projectRoot
        context.taskState.project = {
          kind: context.project.kind,
          packageManager: context.project.packageManager,
          checks: context.project.checks,
          lockfiles: context.project.lockfiles,
        }
      }
      if (context.project === null && config.requireDetectedProject) {
        context.applicable = false
        context.skipReason = SKIP_REASON.NO_PROJECT
        // Record WHY, so `verification_status` reports "not applicable" instead
        // of a gate that sounds like it is demanding evidence the task never owed.
        context.taskState.acceptance = ACCEPTANCE[2]
        context.taskState.gate = {
          gate: GATE.NOT_APPLICABLE,
          technicalAcceptance: ACCEPTANCE[2],
          finalizationStatus: FINALIZATION_STATUS[3],
          reason: `no supported project toolchain was detected under ${context.projectRoot}`,
          blockingFindingIds: [],
        }
        return { action: 'none', skip: SKIP_REASON.NO_PROJECT }
      }
      context.applicable = true
      context.initialized = true
      context.lateStart = true
      logger?.warn?.(`[verification-gate] task ${context.taskState.taskId} had no pre-step baseline (plugin loaded mid-task); it will be verified without a baseline`)
    }

    const taskState = context.taskState
    taskState.cycle += 1
    taskState.state = TASK_STATE.ANALYZING

    // ── fingerprints ────────────────────────────────────────────────────────
    const facts = await currentFacts({
      run: executor.run,
      projectRoot: context.projectRoot,
      signal,
      config,
      readProjectText: deps.readProjectText,
      listProjectFiles: deps.listProjectFiles,
      lockfiles: context.project?.lockfiles ?? [],
    })
    if (facts.ok === false) {
      return blockTask(context, 'FINGERPRINT_UNAVAILABLE', facts.error)
    }
    const previousFingerprint = taskState.workspaceFingerprint
    taskState.workspaceFingerprint = facts.fingerprint
    context.taskState.environmentFingerprint = executor.environmentFingerprint()
    const invalidated = context.evidenceStore.invalidateStale(facts.fingerprint)

    const lockMoved = lockfilesChanged(taskState.baseline, { lockfiles: facts.lockfiles ?? {} })
    const workspaceMoved = previousFingerprint !== null && previousFingerprint !== facts.fingerprint

    // ── change analysis ─────────────────────────────────────────────────────
    taskState.change = taskState.baseline === null || taskState.baseline === undefined
      ? null
      : analyzeChange({
        taskId: taskState.taskId,
        baseline: taskState.baseline,
        current: facts,
        requirements: { revision: taskState.requirementsRevision },
        previous: taskState.change,
      })

    const commandsRun = observedMutations(observationBuffer, sessionId, config).length
    const verifiable = changeIsVerifiable(taskState.change, { executedCommands: commandsRun })
    // A project that declares no check at all has NO machine axis: "verified"
    // would be a claim about zero checks, which is the false pass this plugin
    // exists to prevent (§7.1, "exitCode === 0 is not evidence" — and neither is
    // an empty check list). Measured: without this branch a no-check project with
    // real changes was reported `acceptance: verified` with 0 checks run.
    const declaredChecks = context.project?.checks ?? []
    const axisReason = declaredChecks.length === 0
      ? `the project under ${context.projectRoot} declares no test, typecheck, build or lint command`
      : verifiable.reason
    if (declaredChecks.length === 0 || (!verifiable.applicable && taskState.baseline !== null)) {
      taskState.acceptance = 'not_applicable'
      taskState.gate = {
        gate: GATE.VERIFIED,
        technicalAcceptance: 'not_applicable',
        finalizationStatus: FINALIZATION_STATUS[3],
        reason: axisReason,
        blockingFindingIds: [],
      }
      taskState.state = TASK_STATE.COMPLETED
      taskState.notes = [...(taskState.notes ?? []), axisReason]
      await persist(context)
      return {
        action: 'complete',
        gate: taskState.gate,
        skip: declaredChecks.length === 0 ? SKIP_REASON.NO_CHECKS : SKIP_REASON.NO_CHANGE,
      }
    }

    // ── memory checkpoint 1: change ─────────────────────────────────────────
    const changeMemory = await memoryResolver.resolveCheckpoint({
      taskState,
      checkpointId: 'change',
      context: { change: taskState.change },
      agent,
      signal,
    })

    // ── regression ──────────────────────────────────────────────────────────
    const plan = buildExecutionPlan({
      project: context.project ?? { kind: 'unknown', packageManager: null, checks: [] },
      mode,
      selection: { files: [] },
      reportDir: taskStore.reportDir(taskState.taskId, `cycle-${taskState.cycle}-current`),
    })

    const regressionMemory = await memoryResolver.resolveCheckpoint({
      taskState,
      checkpointId: 'regression',
      context: { change: taskState.change },
      agent,
      signal,
    })

    // "项目级范围"的 required check 必须指向真实可执行的检查 id：
    // detectProject 只会产出 test/typecheck/build/lint，派生一个不存在的 `full-suite`
    // 会让断言阶段永远拿不到证据（结构性死循环）。这里直接派生项目声明的 test 检查；
    // 项目没有任何 test 检查时不派生（不能用不存在的检查阻塞收尾）。
    const projectTestChecks = (context.project?.checks ?? []).filter((check) => check.kind === 'test')
    const changeDerived = taskState.change?.requiresProjectWideScope === true
      ? projectTestChecks.map((check) => ({ id: check.id, text: 'declared test check(s) must complete as a whole (project-wide edit)' }))
      : []
    const requiredChecks = memoryResolver.unionRequiredChecks({
      projectRequired: (context.project?.checks ?? []).filter((check) => check.required),
      changeDerived,
      suggestions: [...changeMemory.suggestions, ...regressionMemory.suggestions],
    })
    taskState.requiredChecks = { total: requiredChecks.required.length, verified: 0, unknown: 0 }
    taskState.requiredCheckList = requiredChecks.required

    let regression = null
    if (plan.checks.length > 0) {
      regression = await regressionEngine.verify({
        taskState,
        plan,
        cycle: taskState.cycle,
        signal,
        mode,
        baselinePolicy: config.baselinePolicy,
        lockfilesChanged: lockMoved.changed,
      })
      for (const record of regression.evidence) context.evidenceStore.add(record)
      taskState.regression.push({
        cycle: taskState.cycle,
        mode,
        summary: regression.summary,
        current: regression.current,
        baselineAvailable: regression.baselineAvailable,
        comparison: {
          verdict: regression.comparison.verdict,
          reason: regression.comparison.reason,
          baselineState: regression.comparison.baselineState ?? (regression.baselineAvailable ? 'available' : 'unavailable'),
          failedChecks: regression.current.failedChecks ?? [],
          executionEnvironmentFailed: regression.comparison.executionEnvironmentFailed === true,
          newFailures: regression.comparison.newFailures.map((item) => ({ id: item.id, file: item.file, signature: item.signature })),
          unchangedFailures: regression.comparison.unchangedFailures.map((item) => ({ id: item.id, signature: item.signature })),
          disappeared: regression.comparison.disappeared.map((item) => ({ id: item.id })),
          newlySkipped: regression.comparison.newlySkipped.map((item) => ({ id: item.id })),
          unstable: (regression.comparison.unstable ?? []).map((item) => ({ id: item.id })),
        },
      })
    } else {
      taskState.regression.push({
        cycle: taskState.cycle,
        mode,
        summary: { verdict: 'no_checks', reason: 'the project declares no applicable check', checks: 0 },
        current: { byCheck: [], items: [], summary: {} },
        baselineAvailable: false,
        comparison: { verdict: 'no_checks', reason: 'no applicable check', newFailures: [], unchangedFailures: [], disappeared: [], newlySkipped: [], unstable: [] },
      })
    }

    // ── memory checkpoint 3 + assertion ─────────────────────────────────────
    const assertionMemory = await memoryResolver.resolveCheckpoint({
      taskState,
      checkpointId: 'assertion',
      context: { change: taskState.change },
      agent,
      signal,
    })

    const assertionStage = evaluateAssertions({
      regression,
      plan,
      requiredChecks: requiredChecks.required,
      memorySuggestions: assertionMemory.suggestions,
      taskState,
    })
    taskState.assertions.push(assertionStage)
    taskState.requiredChecks = {
      total: requiredChecks.required.length,
      verified: requiredChecks.required.length - assertionStage.unknownRequired.length,
      unknown: assertionStage.unknownRequired.length,
    }

    // ── review ──────────────────────────────────────────────────────────────
    taskState.state = TASK_STATE.REVIEWING
    const review = reviewEvidence({
      taskState,
      change: taskState.change,
      regression,
      assertion: assertionStage,
      requiredChecks: requiredChecks.required,
      config,
    })
    for (const record of review.evidence) context.evidenceStore.add(record)

    const finalized = config.reviewEnabled
      ? finalizeFindings({
        findings: review.findings,
        store: context.evidenceStore,
        config,
        currentFingerprint: facts.fingerprint,
      })
      : { accepted: [], rejected: review.findings, blocking: [], advisory: [] }

    const cycleFindings = [...finalized.accepted, ...finalized.rejected]
    taskState.findings = cycleFindings
    taskState.review = {
      cycle: taskState.cycle,
      requirementCoverage: review.requirementCoverage,
      summary: review.summary,
      notes: review.notes,
      rejected: finalized.rejected.map((finding) => ({ id: finding.id, kind: finding.kind, reason: finding.reason })),
    }

    taskState.acceptance = finalized.blocking.length === 0 && taskState.requiredChecks.unknown === 0
      ? 'verified'
      : 'not_verified'

    const failureFingerprint = failureFingerprintOf(regression?.comparison)

    // ── gate ────────────────────────────────────────────────────────────────
    const observeOnly = config.mode === 'observe'
    const gate = computeGate({
      findings: observeOnly ? cycleFindings.map((finding) => ({ ...finding, blocking: false })) : cycleFindings,
      requiredChecks: observeOnly ? { ...taskState.requiredChecks, unknown: 0 } : taskState.requiredChecks,
      acceptance: observeOnly ? 'verified' : taskState.acceptance,
      finalization: taskState.finalization,
      blocked: false,
    })
    taskState.gate = gate

    logger?.info?.(
      `[verification-gate] cycle ${taskState.cycle} gate=${gate.gate} acceptance=${gate.technicalAcceptance} `
      + `findings=${cycleFindings.length}/${finalized.blocking.length} blocking (${gate.reason}); `
      + `invalidated=${invalidated} workspaceMoved=${workspaceMoved}`,
    )

    if (observeOnly) {
      taskState.state = TASK_STATE.WORKING
      await persist(context)
      return { action: 'none', gate, observe: true }
    }

    // ── act ─────────────────────────────────────────────────────────────────
    if (gate.gate === GATE.REPAIR || gate.gate === GATE.NEEDS_EVIDENCE) {
      const repair = await repairCoordinator.prepare({
        taskState,
        ledger: context.ledger,
        findings: finalized.blocking,
        stage: regression?.comparison?.verdict === 'clean' ? STAGE.ASSERTION : STAGE.REGRESSION,
        cycle: taskState.cycle,
        agent,
        signal,
        failureFingerprint,
        restartFrom: STAGE.REGRESSION,
      })
      if (repair.ok) {
        taskState.state = TASK_STATE.REPAIRING
        taskState.lastRepair = {
          repairId: repair.packet.repairId,
          cycle: taskState.cycle,
          retrieval: repair.receipt?.status ?? null,
          requiredChecks: repair.packet.requiredChecks,
        }
        await persist(context)
        return { action: 'steer', kind: 'repair', text: repairCoordinator.render(repair.packet), packet: repair.packet, gate }
      }
      const detail = repair.detail ?? repair.blockedReason
      if (repair.blockedReason === REPAIR_BLOCK.BUDGET_EXHAUSTED || repair.blockedReason === REPAIR_BLOCK.NO_PROGRESS) {
        return blockTask(context, repair.blockedReason, detail)
      }
      // Every other repair refusal is an incomplete retrieval: report it as the
      // reason the automatic loop stopped instead of repairing anyway.
      return blockTask(context, repair.blockedReason ?? 'REPAIR_REFUSED', detail)
    }

    if (gate.gate === GATE.FINALIZE) {
      const settled = finalizationSettled(taskState.finalization, { config })
      if (settled.settled) {
        taskState.finalization.status = settled.status === FINALIZATION_STATUS[2] ? FINALIZATION_STATUS[1] : settled.status
        taskState.finalization.notes = settled.reason
        taskState.state = TASK_STATE.COMPLETED
        await persist(context)
        return { action: 'complete', gate: taskState.gate }
      }
      taskState.state = TASK_STATE.FINALIZING
      taskState.finalization.attempts += 1
      taskState.finalization.lastHandoffFingerprint = facts.fingerprint
      taskState.finalization.status = FINALIZATION_STATUS[2]
      await persist(context)
      return {
        action: 'steer',
        kind: 'finalization',
        text: renderFinalizationHandoff({ taskState, gate, evidenceStore: context.evidenceStore, ledger: context.ledger }),
        gate,
      }
    }

    taskState.state = TASK_STATE.COMPLETED
    await persist(context)
    return { action: 'complete', gate, skips: [changeMemory.receipt.status, regressionMemory.receipt.status, assertionMemory.receipt.status] }
  }

  /**
   * The `agent/turn-stopping` entry point.
   *
   * Serial, awaited before the boundary commits. Steering here is what makes the
   * turn continue; returning without steering lets it close.
   */
  async function onTurnStopping({ agent, turn, signal }) {
    if (!config.enabled || config.mode === 'off') return { action: 'none', skip: SKIP_REASON.DISABLED }
    activeSession = agent.session
    return serialize(agent.id, async () => {
      const context = live.get(agent.id)
      if (context === undefined) {
        // No pre-step initialisation: run the pipeline once so a mid-session
        // install still produces an honest verdict.
        const ensured = await ensureTask({ sessionId: agent.id })
        if (ensured.ok === false) return { action: 'block', reason: 'STATE_UNREADABLE', detail: ensured.error }
      }
      const current = live.get(agent.id)
      if (current.applicable === false) {
        // A gate that declines SILENTLY is indistinguishable from a gate that is
        // not installed — which is exactly how a loaded-but-inert gate gets
        // reported as "the plugin is not running". Say it once per task, with the
        // reason and the way to give it a scope.
        if (current.taskState.declineNoticeIssued === true) return { action: 'none', skip: current.skipReason }
        current.taskState.declineNoticeIssued = true
        await persist(current)
        return { action: 'steer', kind: 'not-applicable', text: renderDeclinedNotice(current) }
      }

      if (current.taskState.state === TASK_STATE.BLOCKED) {
        if (current.taskState.blockedNoticeIssued === true) {
          return { action: 'none', skip: 'ALREADY_BLOCKED' }
        }
        current.taskState.blockedNoticeIssued = true
        await persist(current)
        const text = renderBlockedNotice(current)
        return { action: 'steer', kind: 'blocked', text, gate: current.taskState.gate }
      }

      if (current.taskState.state === TASK_STATE.COMPLETED
        && current.taskState.workspaceFingerprint !== null) {
        const facts = await currentFacts({
          run: executor.run,
          projectRoot: current.projectRoot,
          signal,
          config,
          readProjectText: deps.readProjectText,
          listProjectFiles: deps.listProjectFiles,
          lockfiles: current.project?.lockfiles ?? [],
        })
        if (facts.ok && facts.fingerprint === current.taskState.workspaceFingerprint) {
          return { action: 'none', skip: 'ALREADY_VERIFIED' }
        }
        current.taskState.state = TASK_STATE.WORKING
      }

      return run({ agent, signal, mode: config.defaultMode, reason: `turn-stopping(turn ${turn})` }).then(async (outcome) => {
        if (outcome.action !== 'block') return outcome
        // A block must be visible to the model in THIS turn: without steering,
        // the turn would close and the user would never hear why the loop
        // stopped. `blockedNoticeIssued` makes it exactly once.
        const blocked = live.get(agent.id)
        if (blocked !== undefined) {
          blocked.taskState.blockedNoticeIssued = true
          await persist(blocked)
          return { action: 'steer', kind: 'blocked', text: renderBlockedNotice(blocked), gate: blocked.taskState.gate }
        }
        return outcome
      })
    })
  }

  /**
   * Render the "the gate is loaded but took no part in this task" notice.
   *
   * Reported once per task, because the honest statement is not "verified" and
   * not "blocked" either: the gate never had a scope. Leaving that unsaid is what
   * makes a working plugin look like a missing one.
   */
  function renderDeclinedNotice(context) {
    const taskState = context.taskState ?? {}
    const lastNote = Array.isArray(taskState.notes) ? taskState.notes.at(-1) : null
    return [
      '【验证门未介入】',
      `验证门已装载并在运行，但本任务没有可验证的对象（${context.skipReason ?? SKIP_REASON.NO_PROJECT}）。`,
      lastNote === null || lastNote === undefined ? null : String(lastNote),
      `项目根：${context.projectRoot}`,
      '要让它介入（按下列顺序，任一条成立即可）：',
      '1) 本会话已经验过某个子项目（延续该绑定）；',
      '2) 消息里给出子项目下的相对路径，例如 novel-studio/package.json 或 ai/policy.mjs；',
      '3) 消息里直接点名子项目目录（独立词，例如 dsh-auto-plan-executor）；',
      '4) 工作区里只有一个可识别的子项目。',
      '同时点名两个及以上子项目视为歧义，它不会猜。也不要用 config.projectRoot 钉死：那是 profile 级配置，'
      + '一实例服务所有会话，2026-10-18 实测会把别的会话（改 dsh-auto-plan-executor 的那个）验到 novel-studio。',
    ].filter((line) => line !== null && String(line).trim() !== '').join('\n')
  }

  /** Render the "the loop stopped" notice the model must pass on to the user. */
  function renderBlockedNotice(context) {
    const taskState = context.taskState
    const lines = [
      '[verification-gate] 自动验证循环已停止，需要用户决定如何继续',
      '',
      `停止原因：${taskState.blockedReason ?? 'unknown'}`,
      taskState.blockedDetail ? `细节：${taskState.blockedDetail}` : '',
      `轮次：${taskState.cycle}/${taskState.maxRepairCycles}`,
      `工作区指纹：${taskState.workspaceFingerprint}`,
      '',
      '未解决的问题：',
    ]
    const open = context.ledger.open()
    lines.push(open.length === 0
      ? '  - （ledger 中没有未解决条目，问题出在收尾或检索环节）'
      : open.slice(0, 6).map((entry) => `  - [${entry.stage}/${entry.kind}] ${String(entry.summary).slice(0, 200)}`).join('\n'))
    lines.push(
      '',
      '请：',
      '  1. 把这个阻塞原因如实告诉用户，不要声称任务已验证完成；',
      '  2. 说明你打算如何解决（或说明为什么这是环境/用户决定的限制）；',
      '  3. 不要为了让检查通过而删除、跳过或弱化测试；',
      '  4. 在修改类工具被拒绝时，用 verification_status 查看状态；用户明确要求继续后，调用',
      '     verification_run（release=true）解除阻塞并重新开始一轮验证。',
    )
    return lines.filter((line) => line !== '').join('\n')
  }

  /**
   * The monotonic guard consulted by the host tool pipeline.
   *
   * Its source of truth is the in-memory task state, never a file read, so there
   * is no "could not read the state" case that could fail open. A session with no
   * live task is not blocked.
   *
   * @param exec - the pending tool execution.
   * @returns a denial reason, or undefined.
   */
  function guardReason(exec) {
    if (!config.blockMutatingToolsWhileBlocked) return undefined
    const sessionId = exec?.agent?.id
    if (typeof sessionId !== 'string') return undefined
    const context = live.get(sessionId)
    if (context === undefined || context.taskState.state !== TASK_STATE.BLOCKED) return undefined
    const name = String(exec?.name ?? '')
    const mutating = config.mutatingTools.length > 0 ? config.mutatingTools : DEFAULT_MUTATING
    if (!mutating.includes(name)) return undefined
    return `verification-gate: this task is blocked (${context.taskState.blockedReason ?? 'unknown'}). `
      + 'Report the block to the user; after the user explicitly asks to continue, call verification_run with release=true, '
      + 'then make the change. verification_status shows the current state.'
  }

  /** Release a block after the user explicitly asked to continue. */
  async function releaseBlock(sessionId, note) {
    const context = live.get(sessionId)
    if (context === undefined) return { ok: false, error: 'no live task for this session' }
    const fingerprint = context.taskState.lastRepair?.failureFingerprint ?? null
    const released = context.ledger.release(fingerprint, note ?? 'released by explicit user request')
    context.taskState.state = TASK_STATE.WORKING
    context.taskState.blockedReason = null
    context.taskState.blockedDetail = null
    context.taskState.blockedNoticeIssued = false
    context.taskState.releaseCount = (context.taskState.releaseCount ?? 0) + 1
    context.taskState.cycle = 0
    context.taskState.finalization = { ...(context.taskState.finalization ?? {}), attempts: 0, status: FINALIZATION_STATUS[2] }
    await persist(context)
    return { ok: true, released }
  }

  /** Record the Agent's finalization submission. */
  async function finalize({ agent, args }) {
    const found = await contextFor(agent?.id)
    if (found.ok === false) return { ok: false, error: found.error }
    const context = found.context
    const claim = {
      outcome: args?.memoryOutcome ?? (args?.memorySaved === false ? 'none' : 'written'),
      memorySaved: args?.memorySaved,
      contentExcerpt: args?.memoryExcerpt ?? '',
    }
    const observations = observationBuffer.list().filter((entry) => entry.agentId === agent.id)
    const readback = config.finalizationVerifyMemoryReadback
      ? verifyMemoryReadback({ observations, claim, config })
      : { status: FINALIZATION_STATUS[0], code: 'VERIFICATION_DISABLED', detail: 'readback verification is disabled by config' }

    context.taskState.finalization = {
      ...(context.taskState.finalization ?? {}),
      status: readback.status,
      readback,
      report: String(args?.report ?? '').slice(0, 20000),
      submittedAt: Date.now(),
    }
    if (readback.status === FINALIZATION_STATUS[1] && config.finalizationOnMemoryWriteFailure === 'block') {
      context.taskState.finalization.status = FINALIZATION_STATUS[2]
      await persist(context)
      return { ok: false, readback, gate: context.taskState.gate, error: 'memory readback was not verified and the policy blocks on that' }
    }
    await persist(context)
    return { ok: true, readback, gate: context.taskState.gate }
  }

  return {
    onTurnStopping,
    initializeTask,
    run,
    finalize,
    releaseBlock,
    guardReason,
    renderBlockedNotice,
    status: async (sessionId) => {
      const found = await contextFor(sessionId)
      if (found.ok === false) return { ok: false, error: found.error }
      return { ok: true, context: found.context }
    },
    live,
    projectCache,
    /** The session under verification; read by the execution seam. @see activeSession */
    currentSession,
  }
}

/** Tool observations that changed something, for the "did anything happen" test. */
export function observedMutations(observationBuffer, sessionId, config) {
  const mutating = config.mutatingTools?.length > 0 ? config.mutatingTools : DEFAULT_MUTATING
  return observationBuffer
    .list()
    .filter((entry) => entry.agentId === sessionId && mutating.includes(entry.name) && entry.isError !== true)
}
