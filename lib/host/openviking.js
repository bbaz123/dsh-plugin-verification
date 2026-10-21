/**
 * The OpenViking adapter.
 *
 * This plugin does not own long-term memory, and it does not invent a
 * memory API. The local OpenViking DSH plugin exposes no public search service
 * (its `openvikingMemory` service owns capture/recall, and memory READS reach the
 * model as MCP tools), so this adapter uses the sanctioned path for that
 * situation: the controlled tool-execution entry (`ctx.tools.execute`) against
 * the tool the profile actually mounts.
 *
 * Three rules make that safe rather than a guess:
 *
 *  1. the tool is DISCOVERED from the live registry, and its real schema is
 *     inspected before it is called — a tool whose schema has no identifiable
 *     query parameter is reported `unavailable`, never called blind
 *     (§7.2: "不能只看到工具名包含 search 就自动调用，更不能猜测参数");
 *  2. `empty` (the query succeeded and matched nothing) and `failed` (the query
 *     did not complete) are different statuses and are never conflated (§7.2);
 *  3. nothing here can bypass the agent's scope or the tool pipeline — the call
 *     goes through the registry's own pre-execute, guard and post-execute
 *     stages, so a policy denial arrives as `denied`.
 *
 * @module dsh-plugin-verification/host/openviking
 */

import { makeRetrievalReceipt } from '../protocol.js'

/** Property name patterns that may carry a free-text query. */
const QUERY_FIELDS = [/^query$/i, /^q$/i, /^text$/i, /^search(_?query)?$/i, /^keyword(s)?$/i, /^prompt$/i]

/** Property name patterns that may carry a result cap. */
const LIMIT_FIELDS = [/^limit$/i, /^top_?k$/i, /^topk$/i, /^max(_?results?)?$/i, /^count$/i, /^k$/i]

/** Names that suggest a read/search tool rather than a write tool. */
const SEARCH_HINT = /(search|find|query|recall|lookup)/i

/** Names that suggest a write tool — never used by the read adapter. */
const WRITE_HINT = /(write|add|save|remember|create|update|delete|forget|commit|capture)/i

/**
 * Inspect one registered tool schema and work out whether it is callable.
 *
 * @param schema - a `ToolSchema` from `ctx.tools.schemas()`.
 * @returns `{ usable, toolName, queryField, limitField, properties, reason }`.
 */
export function inspectMemoryTool(schema) {
  const name = schema?.name
  const properties = schema?.parameters?.properties ?? {}
  const keys = Object.keys(properties)
  const reason = []

  const queryField = keys.find((key) => {
    const type = properties[key]?.type
    return (type === 'string' || Array.isArray(type)) && QUERY_FIELDS.some((pattern) => pattern.test(key))
  })
  const limitField = keys.find((key) => {
    const type = properties[key]?.type
    return (type === 'number' || type === 'integer') && LIMIT_FIELDS.some((pattern) => pattern.test(key))
  })

  if (!name) reason.push('the schema has no name')
  if (keys.length === 0) reason.push('the schema declares no parameters')
  if (queryField === undefined) reason.push('no string parameter could be identified as the query')

  return {
    usable: reason.length === 0,
    toolName: name ?? null,
    queryField: queryField ?? null,
    limitField: limitField ?? null,
    properties: keys,
    reason: reason.join('; ') || 'query parameter identified',
  }
}

/**
 * Choose the memory search tool from the live registry.
 *
 * @param schemas - every schema visible in this process.
 * @param config - the resolved plugin configuration.
 * @returns `{ tool, inspection, candidates, reason }`, `tool` null when none fits.
 */
export function selectMemoryTool(schemas, config) {
  const all = Array.isArray(schemas) ? schemas : []
  const exact = config?.memorySearchTool?.trim()
  const patternText = config?.memoryToolPattern?.trim()

  let matcher = () => true
  if (exact) {
    matcher = (name) => name === exact
  } else if (patternText) {
    let regex
    try {
      regex = new RegExp(patternText, 'i')
    } catch {
      regex = null
    }
    matcher = (name) => (regex ? regex.test(name) : name.toLowerCase().includes(patternText.toLowerCase()))
  }

  const candidates = all.filter((schema) => {
    const name = String(schema?.name ?? '')
    if (name === '') return false
    if (!matcher(name)) return false
    if (WRITE_HINT.test(name) && !SEARCH_HINT.test(name)) return false
    return SEARCH_HINT.test(name)
  })

  const ranked = [...candidates].sort((left, right) => {
    const score = (name) => (/\bsearch\b/i.test(name) ? 0 : /\bfind\b/i.test(name) ? 1 : /\bquery\b/i.test(name) ? 2 : 3)
    return score(left.name) - score(right.name)
  })

  for (const schema of ranked) {
    const inspection = inspectMemoryTool(schema)
    if (inspection.usable) return { tool: schema, inspection, candidates: candidates.map((entry) => entry.name), reason: inspection.reason }
  }

  return {
    tool: null,
    inspection: ranked.length > 0 ? inspectMemoryTool(ranked[0]) : null,
    candidates: candidates.map((entry) => entry.name),
    reason: ranked.length === 0
      ? `no registered tool matched the memory pattern "${exact || patternText}" with a search-like name`
      : `candidate "${ranked[0].name}" is not callable: ${inspectMemoryTool(ranked[0]).reason}`,
  }
}

/**
 * Pull a memory list out of whatever the tool returned.
 *
 * The tool surface is not ours, so this accepts the shapes it can recognise and
 * otherwise keeps the raw text as a single record — it never invents structure
 * it did not receive.
 *
 * @param value - the canonical tool value.
 * @param content - the model-facing content blocks.
 * @returns an array of `{ id, uri, title, abstract, score, text }`.
 */
export function extractMemories(value, content) {
  const fromValue = kindOfList(value)
  if (fromValue.length > 0) return fromValue

  if (typeof value === 'string') {
    const parsed = tryJson(value)
    if (parsed !== undefined) {
      const again = kindOfList(parsed)
      if (again.length > 0) return again
    }
    return value.trim() === '' ? [] : [{ id: null, uri: null, title: null, abstract: null, score: null, text: value }]
  }

  const text = (Array.isArray(content) ? content : [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()

  if (text === '') return []
  const parsed = tryJson(text)
  if (parsed !== undefined) {
    const again = kindOfList(parsed)
    if (again.length > 0) return again
  }
  return [{ id: null, uri: null, title: null, abstract: null, score: null, text }]
}

/** Interpret known list-shaped payloads. */
function kindOfList(value) {
  if (Array.isArray(value)) return value.map(normalizeMemory)
  if (value === null || typeof value !== 'object') return []
  for (const key of ['results', 'memories', 'items', 'hits', 'data', 'entries']) {
    if (Array.isArray(value[key])) return value[key].map(normalizeMemory)
  }
  return []
}

/** Map one provider-shaped entry onto this plugin's record. */
function normalizeMemory(entry) {
  if (entry === null || typeof entry !== 'object') return { id: null, uri: null, title: null, abstract: null, score: null, text: String(entry ?? '') }
  return {
    id: entry.id ?? entry.memoryId ?? entry.uri ?? null,
    uri: entry.uri ?? entry.path ?? null,
    title: entry.title ?? entry.name ?? null,
    abstract: entry.abstract ?? entry.summary ?? entry.overview ?? null,
    score: typeof entry.score === 'number' ? entry.score : null,
    text: entry.content ?? entry.text ?? entry.abstract ?? entry.summary ?? '',
  }
}

/** Parse JSON, returning undefined when it is not JSON. */
function tryJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Create the memory adapter bound to one host context.
 *
 * @param options - `{ tools, config, logger, now }`.
 * @returns `{ search, discover, lastDiscovery }`.
 */
export function createMemoryAdapter({ tools, config, logger }) {
  let discovery = null
  let counter = 0

  /** Discover (and cache) the tool this profile mounts. */
  function discover(force = false) {
    if (discovery !== null && !force) return discovery
    let schemas = []
    try {
      schemas = tools?.schemas?.() ?? []
    } catch (error) {
      schemas = []
      logger?.warn?.(`[verification-gate] could not enumerate tools: ${error instanceof Error ? error.message : String(error)}`)
    }
    discovery = selectMemoryTool(schemas, config)
    logger?.debug?.(
      `[verification-gate] memory tool: ${discovery.tool?.name ?? 'NONE'} (${discovery.reason}); `
      + `candidates=[${discovery.candidates.join(', ')}]`,
    )
    return discovery
  }

  /** True when a callable memory search tool exists right now. */
  function available() {
    return discover().tool !== null && typeof tools?.execute === 'function'
  }

  /**
   * Run one retrieval.
   *
   * @param request - `{ agent, checkpoint, purpose, query, signal }`.
   * @returns a {@link makeRetrievalReceipt} receipt plus the extracted memories.
   */
  async function search({ agent, checkpoint, purpose, query, signal }) {
    const startedAt = Date.now()
    const attempt = ++counter
    const found = discover()

    const emit = (status, extra = {}) => {
      const receipt = makeRetrievalReceipt({
        checkpoint,
        purpose,
        query,
        status,
        toolName: found.tool?.name ?? null,
        memoryIds: (extra.memories ?? []).map((memory) => memory.uri ?? memory.id).filter(Boolean).slice(0, 20),
        error: extra.error ?? null,
        source: config.memoryBinding,
        attemptedAt: startedAt,
        elapsedMs: Date.now() - startedAt,
      })
      return { receipt, memories: extra.memories ?? [], schema: found.inspection }
    }

    if (found.tool === null || typeof tools?.execute !== 'function') {
      return emit('unavailable', { error: found.reason })
    }

    const args = { [found.inspection.queryField]: String(query ?? '') }
    if (found.inspection.limitField !== null) args[found.inspection.limitField] = config.memoryMaxExperiences

    let lastError = null
    for (let round = 0; round <= config.memoryRetries; round += 1) {
      const timeoutSignal = AbortSignal.timeout(config.memoryTimeoutMs)
      const fused = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
      try {
        const result = await tools.execute({
          callId: `verification-gate:memory:${attempt}:${round}`,
          name: found.tool.name,
          arguments: args,
          agent,
          signal: fused,
        })

        // Discovery is cached, but the profile may have reloaded the plugin that
        // owns the tool. A vanished tool means the adapter must re-discover
        // rather than keep reporting a stale success.
        if (result?.error?.code === 'UNKNOWN_TOOL') {
          discover(true)
          return emit('unavailable', { error: `tool ${found.tool.name} disappeared from the registry` })
        }
        if (result?.isError === true) {
          const code = result?.error?.code ?? 'TOOL_ERROR'
          const denied = code === 'ABORTED_BEFORE_DISPATCH' || /denied|forbidden|not.?permitted/i.test(result?.error?.message ?? '')
          lastError = `${code}: ${result?.error?.message ?? 'tool call failed'}`
          if (denied) return emit('denied', { error: lastError })
          continue
        }

        const memories = extractMemories(result?.value, result?.content)
        if (memories.length === 0) return emit('empty', { memories: [] })
        return emit('success', { memories: memories.slice(0, config.memoryMaxExperiences) })
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        if (timeoutSignal.aborted) lastError = `retrieval timed out after ${config.memoryTimeoutMs}ms`
        if (signal?.aborted === true) return emit('failed', { error: 'the turn was cancelled during retrieval' })
      }
    }

    return emit('failed', { error: lastError ?? 'retrieval failed without a reported cause' })
  }

  return { search, discover, available, get lastDiscovery() { return discovery } }
}
