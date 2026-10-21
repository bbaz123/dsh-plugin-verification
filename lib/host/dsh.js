/**
 * The DSH seam.
 *
 * Everything this plugin knows about the host's live objects is funnelled
 * through here, so the rest of the plugin stays testable with plain
 * dependencies and the host-specific shape lives in one file.
 *
 * Two host facts drive the design:
 *
 *   - `agent/turn-stopping` is a SERIAL event awaited before the turn boundary
 *     commits. A listener that objects steers (`agent.steer(...)`) and the
 *     machine re-reads its inbox: fresh steering runs another step. Nothing has
 *     to be "returned" for the turn to continue (§4.1).
 *   - a subagent session is an Agent like any other, so the gate must be able to
 *     tell whether it is looking at a ROOT session. `ctx.agents.roots()` is that
 *     answer, and the gate skips every non-root session — otherwise a delegated
 *     review child would recursively trigger its own gate (§11: "审查子任务
 *     不递归触发自己的审查 Gate").
 *
 * @module dsh-plugin-verification/host/dsh
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

/** The message source kind this plugin stamps on everything it injects. */
export const MESSAGE_SOURCE_KIND = 'verification-gate'

/**
 * Read an OPTIONAL host service.
 *
 * Cordis enforces `inject` on plain property access inside a plugin fiber: an
 * undeclared service does not read as `undefined`, it THROWS. Declaring these in
 * `inject` would be worse than optional in this plugin's case — a composition
 * without one of them would leave the whole gate inactive with no explanation —
 * so every optional capability is read through `ctx.get()`, which reports a
 * missing or inactive service as `undefined` and lets the plugin say what it
 * could not do.
 *
 * @param ctx - any Cordis context.
 * @param name - the service key.
 * @returns the value, or undefined when it is absent or inactive.
 */
export function serviceOf(ctx, name) {
  try {
    if (typeof ctx?.get !== 'function') return undefined
    return ctx.get(name) ?? undefined
  } catch {
    return undefined
  }
}

/** Bound for the one-line notice summary, mirroring the host's own bound. */
const SUMMARY_MAX_CHARS = 120

/**
 * Build the user-role message this plugin injects.
 *
 * `source.kind` names the producer (the harness's vocabulary is merge-extensible
 * and consumers fall through unknown kinds), and `form: 'notice'` states that
 * this is a one-off account rather than a snapshot that supersedes anything.
 *
 * @param text - the model-facing text.
 * @param summary - the short account shown collapsed; defaults to the first line.
 * @returns an immutable UserMessage.
 */
export function verificationMessage(text, summary) {
  const firstLine = String(summary ?? text).split('\n')[0].trim()
  return createUserMessage({
    content: [{ type: 'text', text: String(text) }],
    source: {
      kind: MESSAGE_SOURCE_KIND,
      form: 'notice',
      summary: firstLine.length > SUMMARY_MAX_CHARS ? `${firstLine.slice(0, SUMMARY_MAX_CHARS - 1)}…` : firstLine,
    },
  })
}

/**
 * Whether this agent is a root session the gate may judge.
 *
 * Unknown is treated as "not root": if the registry cannot be read, skipping the
 * gate costs a verification run, while judging a child session would recurse.
 *
 * @param ctx - the host context.
 * @param agent - the agent proposing to stop.
 * @returns `{ isRoot, reason }`.
 */
export function isRootAgent(ctx, agent) {
  if (!agent || typeof agent.id !== 'string') return { isRoot: false, reason: 'the payload carried no agent identity' }
  try {
    const agents = serviceOf(ctx, 'agents')
    const roots = agents?.roots?.()
    if (!Array.isArray(roots)) return { isRoot: false, reason: 'the agent registry is unavailable' }
    const found = roots.some((entry) => entry?.id === agent.id)
    return found
      ? { isRoot: true, reason: 'root session' }
      : { isRoot: false, reason: 'delegated session (subagent parent owns the gate)' }
  } catch (error) {
    return { isRoot: false, reason: `the agent registry could not be read: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * A bounded, insertion-ordered record of settled tool results.
 *
 * This is how the plugin can later VERIFY a claim about a tool call — "记忆已写入
 * 并回读" — against what actually ran, instead of trusting a submitted boolean
 * (§8.2). Observation only: `tools/result` is the frozen final outcome.
 *
 * @param limit - maximum retained observations.
 * @returns `{ observe, list, find, clear }`.
 */
export function createObservationBuffer(limit) {
  const entries = []
  return {
    observe(exec, result) {
      entries.push({
        name: exec?.name ?? 'unknown',
        callId: String(exec?.callId ?? ''),
        agentId: exec?.agent?.id ?? null,
        isError: result?.isError === true,
        errorCode: result?.error?.code ?? null,
        value: safeValue(result?.value),
        text: contentText(result?.content),
        at: Date.now(),
      })
      while (entries.length > limit) entries.shift()
    },
    list() {
      return [...entries]
    },
    find(predicate) {
      return entries.filter(predicate)
    },
    clear() {
      entries.length = 0
    },
  }
}

/** Keep a value only when it round-trips through JSON, bounded to a sane size. */
function safeValue(value) {
  if (value === undefined) return null
  try {
    const text = JSON.stringify(value)
    if (text === undefined) return null
    return text.length > 20000 ? `${text.slice(0, 20000)}…` : JSON.parse(text)
  } catch {
    return null
  }
}

/** Concatenate the text blocks of one result. */
function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * Read a project file for the baseline snapshot.
 *
 * The policy-aware `ctx.fs` service is used when it is available; the direct
 * read is a fallback for a composition without it. Either way the result is
 * bounded and the failure is reported rather than swallowed.
 *
 * @param ctx - the host context.
 * @param absolutePath - the host path to read.
 * @param maxBytes - the read bound.
 * @returns `{ ok, text?, bytes?, error? }`.
 */
export async function readProjectText(ctx, absolutePath, maxBytes) {  let text
  let via = 'fs'
  try {
    const fs = serviceOf(ctx, 'fs')
    if (typeof fs?.resolve === 'function' && typeof fs?.readText === 'function') {
      const target = await fs.resolve(absolutePath)
      text = await fs.readText(target)
    } else {
      via = 'node:fs'
      text = await readFile(absolutePath, 'utf8')
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), via }
  }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > maxBytes) return { ok: false, error: `file is larger than the snapshot bound (${bytes} > ${maxBytes})`, via, bytes }
  return { ok: true, text, bytes, via }
}

/**
 * Write a file inside the plugin's OWN storage tree.
 *
 * Plugin-managed material (snapshots, reports, task state) deliberately does not
 * go through the sandboxed project write path: it must remain writable and
 * auditable even while a project is being verified, and it never lands inside
 * the verified project (§9.2).
 *
 * @param absolutePath - destination path.
 * @param text - file body.
 * @returns the written path.
 */
export async function writePluginFile(absolutePath, text) {
  await import('node:fs/promises').then((fs) => fs.mkdir(dirname(absolutePath), { recursive: true }))
  const tmp = `${absolutePath}.${process.pid}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, absolutePath)
  return absolutePath
}
