/**
 * Wiring verification: the plugin must be genuinely loaded by Cordis, not merely
 * parse.
 *
 * What this proves, against the REAL `@deepseek-ai/cordis` and the REAL
 * `@deepseek-ai/dsh-tools` (no module mocks):
 *
 *   1. the entry exposes the shape the Loader resolves (name / inject / Config /
 *      apply), and the Config schema accepts a row's `config` block;
 *   2. `apply()` registers exactly one prompt section and exactly three tools on
 *      a live context;
 *   3. every tool definition is registry-ready (schema fields present, render and
 *      execute callable) and a real execution produces a canonical value;
 *   4. `agent/created` really wires the per-agent contributing listeners;
 *   5. `agent/turn-stopping` in a directory with no supported project leaves the
 *      session completely alone (the gate must not interfere where it has no
 *      business), and does not throw;
 *   6. everything is disposed with the plugin's own context — no leftover
 *      listeners, so a reload cannot stack two gates.
 *
 * Run: `node verify/wiring.mjs`. Needs no DSH profile to pass checks 1–6; the
 * profile-link check is reported as a SKIP when the bundle is not installed yet.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const results = []
let failures = 0

/**
 * Run one check and record its verdict.
 *
 * Awaited on purpose: a rejecting async body must be recorded as FAIL instead of
 * surfacing as an unhandled rejection that leaves the check looking green.
 */
async function check(label, fn) {
  try {
    await fn()
    results.push(`PASS  ${label}`)
  } catch (error) {
    failures += 1
    results.push(`FAIL  ${label}\n      ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Record a check that could not run in this environment. */
function skip(label, why) {
  results.push(`SKIP  ${label}\n      ${why}`)
}

const { Context } = await import('@deepseek-ai/cordis')
const plugin = await import('../lib/index.js')

const storageDir = await mkdtemp(join(tmpdir(), 'verification-wiring-'))

// ── 1. entry shape and Config ───────────────────────────────────────────────
await check('entry exports name / inject / Config / apply', () => {
  assert.equal(plugin.name, 'verification-gate')
  // `shell` is injected, not looked up opportunistically: the opportunistic read
  // lost the concurrent-startup race and left the gate silently disarmed.
  assert.deepEqual(plugin.inject, ['tools', 'systemPrompt', 'shell'])
  assert.equal(typeof plugin.Config, 'function')
  assert.equal(typeof plugin.apply, 'function')
  assert.match(plugin.version, /^\d+\.\d+\.\d+/)
})

await check('without the injected Shell service the row stays INACTIVE (no silent disarm)', async () => {
  const bare = new Context()
  const registered = []
  bare.provide('tools', {
    register: (definition) => {
      registered.push(definition.name)
      return () => {}
    },
    schemas: () => [],
    guard: () => () => {},
    execute: async () => ({ isError: true, error: { code: 'UNKNOWN_TOOL' }, content: [] }),
  })
  bare.provide('systemPrompt', { getSectionOrder: () => 118, section: () => () => {} })
  // No `shell` provider at all.
  const fiber = bare.plugin(plugin, plugin.Config({ enabled: true, storageDir }))
  await fiber
  assert.equal(registered.length, 0, 'the gate must not contribute anything without a Shell service')
  assert.notEqual(fiber.state, 2, 'the row must be held inactive rather than half-loaded')
  await fiber.dispose?.()
})

await check('the Config schema accepts a §10.1 row and resolves its defaults', () => {
  const resolved = plugin.Config({ enabled: true, mode: 'enforce', defaultMode: 'regression' })
  assert.equal(resolved.mode, 'enforce')
  assert.equal(resolved.maxRepairCycles, 3)
  assert.equal(resolved.memoryToolPattern, 'openviking')
})

// ── 2/3/4. apply() on a real context ────────────────────────────────────────
const ctx = new Context()
const sections = []
const tools = []
const guards = []
const preStepWired = []
const disposers = []

const rootAgent = {
  id: 'wiring-session',
  ctx: new Context(),
}
rootAgent.ctx.provide('tools', {
  register: () => () => {},
  guard: (fn) => {
    guards.push(fn)
    return () => {
      guards.length = 0
    }
  },
})
// Counted BEFORE apply(): a root agent that is already live when the row loads
// must be wired at load time (2026-10-18 startup-window defect).
const originalRootOn = rootAgent.ctx.on.bind(rootAgent.ctx)
rootAgent.ctx.on = (name, listener) => {
  if (name === 'agent/pre-step') preStepWired.push(rootAgent.id)
  return originalRootOn(name, listener)
}

ctx.provide('systemPrompt', {
  getSectionOrder: () => 118,
  section: (section) => {
    sections.push(section)
    return () => {
      sections.length = 0
    }
  },
})
ctx.provide('tools', {
  register: (definition) => {
    tools.push(definition)
    return () => {
      tools.length = 0
    }
  },
  schemas: () => [],
  guard: () => () => {},
  execute: async () => ({ isError: true, error: { code: 'UNKNOWN_TOOL' }, content: [] }),
})
ctx.provide('shell', {
  resolve: (request) => ({ ...request, workdir: request.workdir ?? storageDir, timeoutMs: request.timeoutMs ?? 1000 }),
  execute: async () => ({
    status: 'completed',
    exitCode: 0,
    signal: null,
    async result() {
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: 1000,
        stdout: { text: '', truncated: false },
        stderr: { text: '', truncated: false },
      }
    },
  }),
})
ctx.provide('agents', { roots: () => [rootAgent], get: () => rootAgent })
ctx.provide('sandboxPolicy', { workspaceRoot: storageDir, defaultMode: 'workspace-write', resolve: () => ({}) })

// Keep the effect disposers so disposal can be asserted.
const realEffect = ctx.effect.bind(ctx)
ctx.effect = (callback, label) => {
  const disposer = realEffect(callback, label)
  disposers.push({ label, disposer })
  return disposer
}

await check('apply() registers exactly one prompt section and three tools', () => {
  plugin.apply(ctx, plugin.Config({ enabled: true, mode: 'enforce', storageDir }))
  assert.equal(sections.length, 1, `sections=${sections.length}`)
  assert.equal(tools.length, 3, `tools=${tools.length}`)
})

await check('the prompt section carries the gate contract', () => {
  const section = sections[0]
  assert.equal(section.name, 'verification:policy')
  assert.equal(section.order, 118)
  assert.match(section.text, /验证门/)
  assert.match(section.text, /verification_run/)
  assert.match(section.text, /verification_finalize/)
})

await check('exactly the three §10.2 tools are exposed, and none can submit a PASS', () => {
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['verification_finalize', 'verification_run', 'verification_status'])
  for (const tool of tools) {
    assert.equal(typeof tool.execute, 'function', `${tool.name} has no execute`)
    assert.equal(typeof tool.output?.render, 'function', `${tool.name} has no render`)
    assert.ok(tool.parameters?.properties !== undefined, `${tool.name} has no parameter schema`)
  }
  const run = tools.find((tool) => tool.name === 'verification_run')
  assert.deepEqual(run.parameters.properties.mode.enum, ['quick', 'regression', 'full'])
  const finalize = tools.find((tool) => tool.name === 'verification_finalize')
  assert.deepEqual(finalize.parameters.required, ['report', 'memoryOutcome'])
})

await check('an agent that already exists when the row loads is wired for pre-step (startup window)', () => {
  // The registry was provided BEFORE apply(), so this root predates the row —
  // exactly the case that produced "baseline never established" after a restart.
  assert.deepEqual(preStepWired, [rootAgent.id], `pre-step wiring at load: ${preStepWired.join(',') || '(none)'}`)
  assert.equal(guards.length, 1, 'the mutating-tool guard was not registered for the pre-existing agent')
})

await check('agent/created wires a newly created agent, and re-announcing never double-wires', async () => {
  // Re-announcing an already-wired agent must NOT add a second pre-step listener.
  await ctx.serial('agent/created', { agent: rootAgent, source: 'startup' })
  assert.deepEqual(preStepWired, [rootAgent.id], `double-wired: ${preStepWired.join(',')}`)

  const lateAgent = { id: 'wiring-late', ctx: new Context() }
  lateAgent.ctx.provide('tools', {
    register: () => () => {},
    guard: (fn) => {
      guards.push(fn)
      return () => {}
    },
  })
  const lateOn = lateAgent.ctx.on.bind(lateAgent.ctx)
  lateAgent.ctx.on = (name, listener) => {
    if (name === 'agent/pre-step') preStepWired.push(lateAgent.id)
    return lateOn(name, listener)
  }
  await ctx.serial('agent/created', { agent: lateAgent, source: 'startup' })
  assert.deepEqual(preStepWired, [rootAgent.id, lateAgent.id], `late agent wiring: ${preStepWired.join(',')}`)
})

// ── 5. a real execution of a tool, and the turn-stopping path ───────────────
await check('verification_status executes and renders a real report', async () => {
  const status = tools.find((tool) => tool.name === 'verification_status')
  const value = await status.execute({ includeEvidence: true }, { agent: rootAgent, signal: new AbortController().signal })
  assert.equal(value.status, 'OK', `status=${value.status} code=${value.code}`)
  const blocks = status.output.render({}, value)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /verification-gate/)
})

await check('a project the gate does not support is left completely alone', async () => {
  const outcome = await ctx.serial('agent/turn-stopping', { agent: rootAgent, turn: 1, signal: new AbortController().signal })
  // The listener returns nothing; what matters is that it neither threw nor
  // steered anything into the session.
  assert.equal(outcome, undefined)
  const inbox = rootAgent.steers ?? []
  assert.equal(inbox.length, 0)
})

await check('the gate never throws out of turn-stopping, even with a broken agent', async () => {
  await ctx.serial('agent/turn-stopping', { agent: { id: 'wiring-session-2' }, turn: 1, signal: new AbortController().signal })
})

// ── 6. disposal ─────────────────────────────────────────────────────────────
await check('every contribution is an owned, reversible effect', () => {
  const labels = disposers.map((entry) => entry.label)
  assert.ok(labels.some((label) => label.includes('prompt section')), `labels: ${labels.join(' | ')}`)
  assert.equal(labels.filter((label) => label.startsWith('verification-gate: tool')).length, 3, `labels: ${labels.join(' | ')}`)
  assert.ok(labels.some((label) => label.includes('state')))
  for (const entry of disposers) assert.equal(typeof entry.disposer, 'function', `${entry.label} has no disposer`)
  for (const entry of disposers) entry.disposer()
  assert.equal(sections.length, 0)
  assert.equal(tools.length, 0)
})

// ── 7. load through the REAL Cordis plugin loader (inject enforcement) ──────
// Loading through `ctx.plugin` is what the profile does, and it is the only way
// to reproduce Cordis's rule that an undeclared service does not read as
// undefined but THROWS. An earlier revision of this plugin read `ctx.shell`
// directly and failed activation in the real profile; this check exists so that
// class of defect cannot come back unnoticed.
await check('the plugin activates through the real loader with inject enforcement', async () => {
  const equipped = new Context()
  const registered = []
  equipped.provide('tools', {
    register: (definition) => {
      registered.push(definition.name)
      return () => {}
    },
    schemas: () => [],
    guard: () => () => {},
    execute: async () => ({ isError: true, error: { code: 'UNKNOWN_TOOL' }, content: [] }),
  })
  equipped.provide('systemPrompt', { getSectionOrder: () => 118, section: () => () => {} })
  equipped.provide('shell', {
    resolve: (request) => ({ ...request, workdir: request.workdir ?? storageDir, timeoutMs: request.timeoutMs ?? 1000 }),
    execute: async () => ({
      status: 'completed',
      exitCode: 0,
      signal: null,
      async result() {
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          aborted: false,
          timeoutMs: 1000,
          stdout: { text: '', truncated: false },
          stderr: { text: '', truncated: false },
        }
      },
    }),
  })
  // Deliberately NOT provided: agents, fs, sandboxPolicy. The plugin must treat
  // those as absent capabilities, not as a reason to fail activation.
  const fiber = equipped.plugin(plugin, plugin.Config({ enabled: true, storageDir }))
  await fiber
  assert.deepEqual(registered.sort(), ['verification_finalize', 'verification_run', 'verification_status'])
  await fiber.dispose?.()
})

// ── the profile link (informational until the bundle is installed) ──────────
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profileName = process.env.DSH_PROFILE || 'web'
const profileRoots = [
  join(dshHome, 'profiles', profileName, 'node_modules'),
  join(dshHome, 'profiles', 'node_modules'),
].filter((root) => existsSync(root))

if (profileRoots.length === 0) {
  skip('the bundle resolves from a DSH profile install', 'no profile node_modules directory was found')
} else {
  let resolved = null
  for (const root of profileRoots) {
    try {
      resolved = createRequire(join(root, 'index.js')).resolve('dsh-plugin-verification')
      break
    } catch {
      // try the next root
    }
  }
  if (resolved === null) {
    skip('the bundle resolves from a DSH profile install', 'not installed yet: run plugin_manager install_bundle, then re-run')
  } else {
    await check('the bundle resolves from a DSH profile install', () => {
      assert.match(resolved.replace(/\\/g, '/'), /dsh-plugin-verification/)
    })
  }
}

console.log(results.join('\n'))
const passed = results.filter((line) => line.startsWith('PASS')).length
const skipped = results.filter((line) => line.startsWith('SKIP')).length
console.log(`\n${passed}/${results.length - skipped} wiring checks passed${skipped > 0 ? ` (${skipped} skipped)` : ''}`)
process.exitCode = failures > 0 ? 1 : 0
