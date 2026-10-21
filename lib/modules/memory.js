/**
 * Memory Resolver: the four mandatory OpenViking checkpoints.
 *
 * Experience may ADD a concern. It may never remove one:
 *
 *     Required Checks = Project Required Checks
 *                     ∪ Deterministic Change Mapping
 *                     ∪ Relevant Experience Suggestions
 *
 * A checkpoint that comes back `empty` is a completed query with nothing
 * relevant — it does not excuse the normal verification, and it does not count
 * as a failure. A checkpoint that comes back `failed`, `denied` or `unavailable`
 * is an INCOMPLETE retrieval, and the caller decides what that means for the
 * stage it guards (§7.2, §7.6).
 *
 * @module dsh-plugin-verification/modules/memory
 */

import { STAGE } from '../protocol.js'

/** The four checkpoints that must run, whatever the mode. */
export const CHECKPOINTS = [
  {
    id: 'change',
    stage: STAGE.MEMORY,
    purpose: 'change',
    guard: 'the change context must be grounded in past experience before scope is chosen',
  },
  {
    id: 'regression',
    stage: STAGE.REGRESSION,
    purpose: 'regression',
    guard: 'historical regressions of this area must be able to add test targets',
  },
  {
    id: 'assertion',
    stage: STAGE.ASSERTION,
    purpose: 'assertion',
    guard: 'business boundaries, invariants and conventions must be able to add checks',
  },
  {
    id: 'repair',
    stage: STAGE.REPAIR,
    purpose: 'repair',
    guard: 'the current failure fingerprint must be checked against how it was fixed before',
  },
]

/** Compose the query text of one checkpoint from the analysis so far. */
export function buildQuery(checkpointId, context) {
  const components = (context?.change?.components ?? []).join(' ')
  const risks = (context?.change?.riskSignals ?? []).map((signal) => signal.kind).join(' ')
  const requirement = (context?.requirements?.texts ?? []).join(' ').slice(0, 300)

  switch (checkpointId) {
    case 'change':
      return `verification scope and pitfalls for changes in ${components || 'this project'}; risk signals ${risks || 'none'}; task ${requirement || 'n/a'}`
    case 'regression':
      return `regressions caused by changes in ${components || 'this project'}; what breaks when ${components || 'it'} changes`
    case 'assertion':
      return `invariants, business boundaries and required checks for ${components || 'this project'}; task ${requirement || 'n/a'}`
    case 'repair':
      return `failure ${context?.failureFingerprint ?? 'unknown'} in ${components || 'this project'}: ${String(context?.failureSummary ?? '').slice(0, 300)}`
    default:
      return String(context?.query ?? '')
  }
}

/**
 * Extract check suggestions from retrieved experience.
 *
 * Retrieved text is LOW-TRUST DATA: it is read, summarised and injected as a
 * lead. Nothing in it is executed, and a suggestion never replaces a project's
 * own required check (§9.2).
 *
 * @param memories - retrieved memory records.
 * @returns `{ suggestions, memoryIds }`.
 */
export function suggestionsFromMemories(memories) {
  const suggestions = []
  const memoryIds = []
  for (const memory of memories ?? []) {
    const text = String(memory?.text ?? memory?.abstract ?? '').trim()
    const id = memory?.uri ?? memory?.id ?? null
    if (id !== null) memoryIds.push(id)
    if (text === '') continue
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim().replace(/^[-*•\d.)\s]+/, '')
      if (trimmed.length < 12) continue
      if (!/(must|must not|never|always|check|verify|confirm|avoid|禁止|必须|不得|确认|检查|验证|避免)/i.test(trimmed)) continue
      suggestions.push({ text: trimmed.slice(0, 400), memoryId: id })
      if (suggestions.length >= 12) return { suggestions, memoryIds }
    }
  }
  return { suggestions, memoryIds }
}

/**
 * Create the resolver for one plugin instance.
 *
 * @param options - `{ adapter, config, logger }`.
 * @returns `{ resolveCheckpoint, unionRequiredChecks }`.
 */
export function createMemoryResolver({ adapter, config, logger }) {
  /**
   * Run one checkpoint and append its receipt to the task's query log.
   *
   * Receipts are APPENDED, never overwritten: §5.1 requires that a later
   * checkpoint cannot erase the record of an earlier one, because that record is
   * what proves retrieval actually happened.
   *
   * @param options - `{ taskState, checkpointId, context, agent, signal }`.
   * @returns `{ receipt, memories, suggestions, ok }`.
   */
  async function resolveCheckpoint({ taskState, checkpointId, context, agent, signal }) {
    const checkpoint = CHECKPOINTS.find((entry) => entry.id === checkpointId)
    if (checkpoint === undefined) throw new Error(`unknown memory checkpoint "${checkpointId}"`)

    const query = buildQuery(checkpointId, {
      ...context,
      requirements: taskState?.requirements ? { texts: taskState.requirements } : context?.requirements,
    })

    const outcome = await adapter.search({ agent, checkpoint: checkpointId, purpose: checkpoint.purpose, query, signal })
    const { suggestions, memoryIds } = suggestionsFromMemories(outcome.memories)

    // `empty` is a completed query: record it as such, and keep going.
    taskState.memoryQueries.push({ ...outcome.receipt, memoryIds: memoryIds.length > 0 ? memoryIds : outcome.receipt.memoryIds })

    logger?.debug?.(
      `[verification-gate] memory checkpoint ${checkpointId}: ${outcome.receipt.status} `
      + `(${outcome.memories.length} record(s), ${suggestions.length} suggestion(s))`,
    )

    return {
      receipt: outcome.receipt,
      memories: outcome.memories,
      suggestions,
      ok: outcome.receipt.status === 'success' || outcome.receipt.status === 'empty',
    }
  }

  /**
   * Union the project's required checks with the deterministic change mapping
   * and the experience suggestions.
   *
   * @param options - `{ projectRequired, changeDerived, suggestions }`.
   * @returns `{ required, addedByExperience, notes }`.
   */
  function unionRequiredChecks({ projectRequired = [], changeDerived = [], suggestions = [] }) {
    const required = []
    const seen = new Set()
    const add = (entry) => {
      const key = typeof entry === 'string' ? entry : entry.id
      if (key === undefined || seen.has(key)) return
      seen.add(key)
      required.push(entry)
    }
    for (const entry of projectRequired) add(entry)
    for (const entry of changeDerived) add(entry)

    const addedByExperience = []
    for (const suggestion of suggestions) {
      const key = `experience:${suggestion.text.slice(0, 60)}`
      if (seen.has(key)) continue
      seen.add(key)
      const entry = { id: key, kind: 'experience', required: false, source: suggestion.memoryId, text: suggestion.text }
      required.push(entry)
      addedByExperience.push(entry)
    }

    return {
      required,
      addedByExperience,
      notes: addedByExperience.length > 0
        ? [`${addedByExperience.length} additional check(s) suggested by retrieved experience`]
        : ['no experience added a check for this task'],
    }
  }

  return { resolveCheckpoint, unionRequiredChecks }
}

/**
 * Whether an incomplete retrieval blocks the stage it guards.
 *
 * @param receipt - the checkpoint receipt.
 * @param config - the resolved configuration.
 * @param options - `{ beforeRepair }` when this guards the repair loop.
 * @returns `{ blocked, reason }`.
 */
export function retrievalVerdict(receipt, config, options = {}) {
  if (receipt?.status === 'success' || receipt?.status === 'empty') return { blocked: false, reason: 'retrieval completed' }
  const mustBlock = options.beforeRepair === true
    ? config.memoryRequiredBeforeRepair && config.memoryOnReadFailure === 'block'
    : false
  return {
    blocked: mustBlock,
    reason: mustBlock
      ? `pre-repair experience retrieval was ${receipt?.status}; automatic repair is blocked rather than treated as an empty result`
      : `retrieval was ${receipt?.status}; the stage continues under the configured degrade policy`,
  }
}
