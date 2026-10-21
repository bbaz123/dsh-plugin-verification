/**
 * dsh-plugin-verification — the DSH Verification Gate.
 *
 * A HOST-plane Cordis plugin with exactly three contributions:
 *
 *   1. a global `systemPrompt` section carrying the gate contract (the soft
 *      half of enforcement);
 *   2. the `verification_run` / `verification_status` / `verification_finalize`
 *      tools, plus the monotonic guard that denies mutating tools while a task
 *      is blocked (the hard half);
 *   3. the lifecycle listeners that drive the state machine: `agent/created`
 *      (per-agent wiring), `agent/pre-step` (freeze the pre-task baseline),
 *      `agent/turn-stopping` (run the pipeline and steer), `tools/result`
 *      (observe what actually ran, for finalization verification).
 *
 * The plugin never modifies project code, never writes to the user's global
 * rules, and never writes long-term memory: it verifies, records, and hands the
 * finalization back to the Agent's existing rules (§8).
 *
 * @module dsh-plugin-verification
 */

import { readFileSync } from 'node:fs'
import { access, readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { Config, normalizeConfig } from './config.js'
import { createObservationBuffer, isRootAgent, readProjectText, serviceOf, verificationMessage } from './host/dsh.js'
import { MESSAGE_SOURCE_KIND } from './host/dsh.js'
import { createExecutor } from './host/execution.js'
import { createMemoryAdapter } from './host/openviking.js'
import { createController } from './runtime/controller.js'
import { RULES } from './rules.js'
import { TaskStore } from './store.js'
import { createTools } from './tools.js'

/** Cordis plugin name. */
export const name = 'verification-gate'

/**
 * The host registries and services this row needs.
 *
 * `shell` is in `inject` ON PURPOSE, and the reason is a MEASURED boot failure:
 * DSH starts a composition's plugin rows CONCURRENTLY, so an opportunistic
 * `ctx.get('shell')` inside `apply()` can lose the race against whichever row
 * provides it. The first revision read it that way and "degraded" to a disarmed
 * gate — silently and with no activation diagnostic, so after a restart the row
 * was live but contributed nothing (no tools, no prompt section) until the
 * bundle happened to be toggled by hand. Declaring the dependency makes Cordis
 * WAIT for the service instead of racing it; this profile already pins
 * `dsh-budget` to `storageDomain` for exactly the same reason.
 *
 * The consequence is the honest one: in a composition that provides no Shell
 * service at all, this row stays INACTIVE rather than loading a gate that could
 * never verify anything.
 */
export const inject = ['tools', 'systemPrompt', 'shell']

/** Plugin version, read from the manifest rather than duplicated. */
export const version = (() => {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return String(manifest.version ?? '0.0.0')
  } catch {
    return '0.0.0'
  }
})()

/** Where the plugin keeps its own state. Never inside the verified project. */
export function resolveStorageDir(config) {
  if (typeof config?.storageDir === 'string' && config.storageDir.trim() !== '') return config.storageDir.trim()
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'verification-gate')
}

/** Adapt the Cordis logger to the tiny interface the plugin uses. */
function buildLogger(ctx) {
  let logger
  try {
    logger = ctx?.logger
  } catch {
    logger = undefined
  }
  const call = (level, args) => {
    try {
      const method = logger?.[level]
      if (typeof method === 'function') method.apply(logger, args)
    } catch {
      // Logging must never change an outcome.
    }
  }
  return {
    debug: (...args) => call('debug', args),
    info: (...args) => call('info', args),
    warn: (...args) => call('warn', args),
    error: (...args) => call('error', args),
  }
}

/** The text blocks of one user message, for the requirements revision. */
function textsOf(messages) {
  const texts = []
  for (const message of Array.isArray(messages) ? messages : []) {
    // A notice THIS plugin injected is not a requirement of the user. Its text
    // carries EXAMPLE paths (e.g. "novel-studio/package.json"), and treating it as
    // user words made the gate bind itself to whichever project its own advice
    // happened to name — measured on 2026-10-12 and again on 2026-10-17, where a
    // turn whose notice mentioned a path flipped a not-applicable gate into
    // verifying that project. Only the user's own messages define the demand.
    if (message?.source?.kind === MESSAGE_SOURCE_KIND) continue
    for (const block of message?.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    }
  }
  return texts
}

/**
 * Cordis plugin entry point.
 *
 * @param ctx - the plugin's Cordis context (host plane).
 * @param rawConfig - the row's `config:` block.
 */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const logger = buildLogger(ctx)

  if (!config.enabled) {
    logger.info(`[verification-gate] disabled by config (v${version}); turns close without verification.`)
    return
  }

  // `inject` guarantees the Shell service is ACTIVE before this function runs,
  // so this is a contract assertion, not the opportunistic lookup the first
  // revision used — that one could lose the concurrent-startup race and disarm
  // the whole gate without any diagnostic.
  const shell = ctx.shell
  if (typeof shell?.resolve !== 'function' || typeof shell?.execute !== 'function') {
    logger.error(
      '[verification-gate] the injected Shell service has no resolve/execute pair; '
      + 'refusing to load a gate that could not run a single project check.',
    )
    return
  }

  const storageDir = resolveStorageDir(config)
  const taskStore = new TaskStore({ dir: storageDir })
  /**
   * The session under verification, for the execution seam's sandbox lookup.
   *
   * Why a slot rather than a direct reference (2026-10-13): the executor is
   * built before the controller, yet only the controller is handed `agent` (and
   * therefore the session) on every entry point. The slot is read lazily — by
   * the time a check actually runs, `onTurnStopping` has already filled it.
   * Leaving it unset keeps the executor's previous behaviour exactly.
   */
  const currentSessionRef = { current: undefined }
  const executor = createExecutor({
    shell,
    config,
    logger,
    // Read the controller's live value on every call. `currentSession()` returns
    // the session object itself, which is exactly what the host's
    // `sandboxPolicy.resolve({ session })` expects. (Storing the function here
    // instead of calling it would pass a thunk as the session — the host would
    // then resolve back to the deployment default with no error, i.e. the fix
    // would silently do nothing.)
    session: () => currentSessionRef.current(),
    // Pass the host's own resolver so the seam never reaches into the service shape.
    resolveSandboxPolicy: (session) => {
      try {
        return serviceOf(ctx, 'sandboxPolicy')?.resolve({ session })
      } catch {
        return undefined
      }
    },
  })
  const memoryAdapter = createMemoryAdapter({ tools: ctx.tools, config, logger })
  const observationBuffer = createObservationBuffer(config.maxObservedToolResults)

  const controller = createController({
    ctx,
    config,
    logger,
    taskStore,
    executor,
    memoryAdapter,
    observationBuffer,
    readProjectText: (path, maxBytes) => readProjectText(ctx, path, maxBytes),
    workspaceRoot: () => {
      try {
        return serviceOf(ctx, 'sandboxPolicy')?.workspaceRoot
      } catch {
        return undefined
      }
    },
    createFsx: () => ({
      exists: async (path) => {
        try {
          await access(path)
          return true
        } catch {
          return false
        }
      },
      readText: async (path) => readFile(path, 'utf8'),
      // Needed to see whether an aggregate workspace root holds sub-projects at
      // all; without it the gate can only ever report "not applicable" there.
      readdir: async (path) => readdir(path),
    }),
    steer: (agent, text) => agent.steer(verificationMessage(text)),
  })

  // The controller owns "which session is being verified"; the executor asks for
  // it on every check. The slot holds the controller's **getter**, and the
  // executor calls it, so the value read is the session object itself — a thunk
  // would sail past the host's `resolve({ session })` and silently leave the
  // deployment default in force (no error, no fix).
  currentSessionRef.current = controller.currentSession

  logger.info(
    `[verification-gate] v${version} armed: mode=${config.mode}, defaultMode=${config.defaultMode}, `
    + `maxRepairCycles=${config.maxRepairCycles}, storage=${storageDir}, memoryTool=`
    + `${memoryAdapter.discover().tool?.name ?? 'NONE'}`,
  )

  // ── prompt section (soft enforcement) ─────────────────────────────────────
  const sectionName = typeof rawConfig?.sectionName === 'string' && rawConfig.sectionName.trim() !== ''
    ? rawConfig.sectionName.trim()
    : 'verification:policy'
  const order = Number.isFinite(rawConfig?.order)
    ? rawConfig.order
    : (ctx.systemPrompt.getSectionOrder?.('TOOL_REPORT') ?? 118)
  ctx.effect(() => ctx.systemPrompt.section({ name: sectionName, order, text: RULES }), 'verification-gate: prompt section')

  // ── tools (hard enforcement) ──────────────────────────────────────────────
  for (const tool of createTools({ controller, config, logger })) {
    ctx.effect(() => ctx.tools.register(tool), `verification-gate: tool ${tool.name}`)
  }

  // ── observation of what actually ran ──────────────────────────────────────
  ctx.on('tools/result', (exec, result) => {
    try {
      observationBuffer.observe(exec, result)
    } catch (error) {
      logger.debug?.(`[verification-gate] could not record a tool result: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // ── per-agent wiring ──────────────────────────────────────────────────────
  /**
   * Wire ONE live agent: its `agent/pre-step` baseline hook and its tool guard.
   *
   * Idempotent by identity: an agent that was already live when this row loaded
   * is wired at load time, and a later `agent/created` for the same agent must
   * not add a SECOND pre-step listener (two listeners would run `initializeTask`
   * twice for one turn).
   *
   * @param agent - a live root agent (`{ id, ctx, steer }`).
   */
  const wiredAgents = new WeakSet()
  function wireAgent(agent) {
    if (agent === undefined || agent === null || agent.ctx === undefined) return
    if (wiredAgents.has(agent)) return
    wiredAgents.add(agent)
    const disposers = []

    // Registration on `agent.ctx` is a cross-context contribution: it has two
    // owners, so its disposer is retained here as well and a failure to wire one
    // part must not fail agent creation (this event is serial and awaited).
    try {
      // Freeze the task's baseline BEFORE the task's own first step runs. This is
      // the only moment at which "what the user left behind" is still observable.
      disposers.push(agent.ctx.on('agent/pre-step', async (payload, next) => {
        try {
          const root = isRootAgent(ctx, agent)
          if (root.isRoot) {
            const messages = payload?.messages ?? []
            await controller.initializeTask({
              agent,
              requirements: textsOf(messages),
              firstMessageId: messages[0]?.id ?? null,
              signal: payload?.signal,
            })
          }
        } catch (error) {
          // A failure here must not stop the model from working; the gate reports
          // what it could not establish through its own state instead.
          logger.warn(`[verification-gate] pre-step initialisation failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        return next()
      }))

      // The monotonic guard. Obtained through the agent's own context so it
      // applies only to that agent, and read through the optional-service entry
      // so an absent registry cannot fail agent creation.
      const agentTools = serviceOf(agent.ctx, 'tools')
      if (typeof agentTools?.guard === 'function') {
        disposers.push(agentTools.guard((exec) => controller.guardReason(exec)))
      }
    } catch (error) {
      logger.warn(`[verification-gate] per-agent wiring failed for ${agent.id}: ${error instanceof Error ? error.message : String(error)}`)
    }

    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch {
          // Disposal is best effort: the agent context unwinds it as well.
        }
      }
      controller.live.delete(agent.id)
    }, `verification-gate: agent ${agent.id}`)
  }

  // Agents created AFTER this row loaded are announced here.
  ctx.on('agent/created', ({ agent }) => {
    wireAgent(agent)
  })

  // Agents that ALREADY existed when this row loaded are never announced again.
  //
  // Measured 2026-10-18: after a restart the session restored at startup had its
  // agent created while the composition was still loading, so `agent/created`
  // fired before this listener existed. That agent never got the `agent/pre-step`
  // hook, no baseline was ever frozen for its task, and EVERY run of that task
  // was then rejected as `baseline_never_established` — including a 66/66 green
  // suite that the gate itself executed in the right directory. Wiring the live
  // roots once the registry is available closes that startup window without
  // weakening the fail-closed rule: a baseline is still only ever frozen before
  // the task's first step, never after the fact.
  //
  // `agents` stays OPTIONAL (it is not in this row's `inject`): a composition
  // without it simply keeps the previous behaviour, and a missing registry must
  // not hold the whole gate inactive.
  ctx.inject(['agents'], (scoped) => {
    const registry = serviceOf(scoped, 'agents')
    let live = []
    try {
      live = registry?.roots?.() ?? []
    } catch (error) {
      logger.debug?.(`[verification-gate] could not read live agents at load: ${error instanceof Error ? error.message : String(error)}`)
      live = []
    }
    const agents = Array.isArray(live) ? live : []
    for (const agent of agents) wireAgent(agent)
    if (agents.length > 0) logger.debug?.(`[verification-gate] wired ${agents.length} agent(s) that predate this row`)
  })

  // ── the gate itself ───────────────────────────────────────────────────────
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    try {
      const root = isRootAgent(ctx, agent)
      if (!root.isRoot) return
      const outcome = await controller.onTurnStopping({ agent, turn, signal })
      if (outcome.action === 'steer') {
        agent.steer(verificationMessage(outcome.text))
        logger.debug?.(`[verification-gate] steered a ${outcome.kind} instruction for turn ${turn}`)
      }
    } catch (error) {
      // The gate must never be the reason a turn fails to close.
      logger.error(`[verification-gate] turn-stopping failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    }
  })

  // ── teardown: no residue, no duplicate gate after a reload ────────────────
  ctx.effect(() => () => {
    controller.live.clear()
    controller.projectCache.clear()
    observationBuffer.clear()
  }, 'verification-gate: state')
}

/** Exposed for the wiring verification; not part of the plugin's public contract. */
export const internals = { createController, createTools, TaskStore, RULES, verificationMessage, textsOf }

export { Config }
