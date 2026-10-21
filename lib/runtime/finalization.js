/**
 * Finalization: hand the settled verification back to the Agent's own rules.
 *
 * There is a real runtime problem this module exists to solve (§8): passing the
 * gate does not, by itself, give the model another turn. DSH closes the turn
 * when `agent/turn-stopping` returns, so "now run your existing global review
 * rules" has to be an explicit next input — which means steering, not returning.
 *
 * The plugin therefore does three things and no more:
 *
 *   1. it hands over the facts (what was verified, what the ledger holds, what
 *      remained unconfirmed) and points at the rules the Agent already owns; it
 *      does NOT copy those rules and does NOT write to AGENTS.md;
 *   2. it VERIFIES a claim about a long-term memory write against what actually
 *      ran — a `{ memorySaved: true }` submission is accepted as a claim and
 *      then checked against observed tool results, never trusted (§8.2);
 *   3. it refuses to loop: a second handoff with nothing changed is not sent.
 *
 * @module dsh-plugin-verification/runtime/finalization
 */

import { FINALIZATION_STATUS } from '../protocol.js'
import { sha256Hex } from '../store.js'

/** A memory write tool, as opposed to a read. */
const WRITE_HINT = /(write|add|save|remember|create|update|commit|capture|put|store)/i

/** A memory read tool. */
const READ_HINT = /(search|find|get|read|query|recall|list)/i

/**
 * Render the finalization handoff.
 *
 * The Agent already has the global rules; this text names the deliverable and
 * supplies the facts, and deliberately does not restate the rules.
 *
 * @param options - `{ taskState, gate, evidenceStore, ledger }`.
 * @returns the model-facing text.
 */
export function renderFinalizationHandoff({ taskState, gate, evidenceStore, ledger }) {
  const lines = [
    '[verification-gate] 技术验证已通过，进入收尾交接',
    '',
    `taskId: ${taskState.taskId}   轮次: ${taskState.cycle}`,
    `技术验收: ${gate.technicalAcceptance}   收尾状态: ${gate.finalizationStatus}`,
    `工作区指纹: ${taskState.workspaceFingerprint}`,
    '',
    '本任务的验证结果：',
  ]

  const regression = taskState.regression.at(-1)
  if (regression !== undefined) {
    lines.push(`  - 回归：${regression.summary?.verdict ?? 'unknown'} — ${regression.summary?.reason ?? ''}`)
    lines.push(`  - 检查：${(regression.current?.byCheck ?? []).map((check) => `${check.id}=${check.status}`).join(', ') || '（无）'}`)
  } else {
    lines.push('  - 回归：未执行（本项目没有可检测的测试入口）')
  }
  lines.push(`  - 断言：${taskState.assertions.at(-1)?.summary?.total ?? 0} 条，其中未决必测项 ${taskState.assertions.at(-1)?.summary?.unknownRequired ?? 0} 条`)
  lines.push(`  - 证据：${evidenceStore.list().length} 条（有效 ${evidenceStore.list().filter((record) => record.validity === 'valid').length} 条）`)

  const openLedger = ledger.open()
  lines.push('', 'Task Error Ledger：')
  lines.push(openLedger.length === 0
    ? '  - 无未解决问题'
    : openLedger.map((entry) => `  - [${entry.status}] ${entry.stage}/${entry.kind}: ${String(entry.summary).slice(0, 160)}`).join('\n'))

  const coverage = taskState.review?.requirementCoverage ?? []
  lines.push('', `需求覆盖（共 ${coverage.length} 条，语义判断由你按已有全局规则完成）：`)
  for (const item of coverage.slice(0, 8)) {
    lines.push(`  - (${item.status}) ${String(item.requirement).slice(0, 120)}`)
  }
  if (coverage.length === 0) lines.push('  - 本任务没有记录到用户需求文本')

  const unconfirmed = (taskState.findings ?? []).filter((finding) => finding.blocking !== true && finding.kind !== 'advisory')
  lines.push('', '尚未确认的问题：')
  lines.push(unconfirmed.length === 0
    ? '  - 无'
    : unconfirmed.map((finding) => `  - ${finding.kind}: ${String(finding.summary).slice(0, 160)}`).join('\n'))

  lines.push(
    '',
    '请按你已有的全局规则完成最终复盘：',
    '  1. 输出【发现的问题】【修复内容】【验证结果】【错误根因】【以后避免规则】；',
    '  2. 只有确实存在跨任务可复用的自身错误经验时才写入 OpenViking，并在写入后用同一 URI 回读验证；',
    '  3. 然后调用 verification_finalize 提交报告，并声明本次记忆收尾的真实结果（written / none）；',
    '     该工具会用本会话实际观察到的工具调用校验你的声明，仅提交一个布尔值不会被采信；',
    '  4. 如果你在收尾过程中又修改了代码，技术验证结果会失效并从回归阶段重新执行。',
    '',
    '插件不会替你写记忆，也不会修改你的全局规则。',
  )

  return lines.join('\n')
}

/** Normalize one observation for matching. */
function normalizeText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** A dedup key for a written body, used when no stable record id is returned. */
export function dedupKeyOf(text) {
  const normalized = normalizeText(text)
  if (normalized === '') return null
  return `sha256:${sha256Hex(normalized.slice(0, 2000)).slice(0, 16)}`
}

/**
 * Extract candidate record identifiers from a tool result.
 *
 * URI-shaped values are preferred: a write that returns `viking://…` gives the
 * readback something exact to match, which §8.2 asks for before falling back to
 * a content key.
 */
export function recordIdsIn(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  if (text === null) return []
  const ids = new Set()
  for (const match of text.matchAll(/viking:\/\/[^\s"'\\]+/g)) ids.add(match[0])
  for (const match of text.matchAll(/"(?:uri|path|id|memoryId|memory_id)"\s*:\s*"([^"]+)"/g)) ids.add(match[1])
  return [...ids]
}

/**
 * Verify a memory-write claim against what actually ran.
 *
 * @param options - `{ observations, claim, config }`.
 * @returns the readback verdict.
 */
export function verifyMemoryReadback({ observations, claim, config }) {
  const pattern = config.memoryToolPattern
  const matches = (name) => {
    try {
      return new RegExp(pattern, 'i').test(name)
    } catch {
      return String(name).toLowerCase().includes(String(pattern).toLowerCase())
    }
  }

  const memoryCalls = (observations ?? []).filter((entry) => matches(entry.name))
  const writes = memoryCalls.filter((entry) => WRITE_HINT.test(entry.name) && !READ_HINT.test(entry.name))
  const reads = memoryCalls.filter((entry) => READ_HINT.test(entry.name))

  if (claim?.outcome === 'none' || claim?.memorySaved === false) {
    if (writes.length > 0) {
      return {
        status: FINALIZATION_STATUS[1],
        code: 'CLAIM_CONTRADICTS_OBSERVATION',
        detail: `the report claims no memory write, but ${writes.length} write call(s) were observed (${writes.map((entry) => entry.name).join(', ')})`,
        observedWrites: writes.map((entry) => entry.name),
        observedReads: reads.map((entry) => entry.name),
      }
    }
    return {
      status: FINALIZATION_STATUS[3],
      code: 'NOT_REQUIRED',
      detail: 'the Agent reported no long-term memory write and none was observed',
      observedWrites: [],
      observedReads: [],
    }
  }

  if (writes.length === 0) {
    return {
      status: FINALIZATION_STATUS[1],
      code: 'NO_WRITE_OBSERVED',
      detail: 'a memory write was claimed but no matching write tool call was observed in this session',
      observedWrites: [],
      observedReads: reads.map((entry) => entry.name),
    }
  }

  const lastWrite = writes[writes.length - 1]
  const afterWrite = memoryCalls.filter((entry) => entry.at >= lastWrite.at && entry !== lastWrite)
  const readback = afterWrite.filter((entry) => READ_HINT.test(entry.name))

  if (readback.length === 0) {
    return {
      status: FINALIZATION_STATUS[1],
      code: 'NO_READBACK_OBSERVED',
      detail: `a write tool (${lastWrite.name}) ran, but no read-back call followed it`,
      observedWrites: writes.map((entry) => entry.name),
      observedReads: [],
    }
  }

  const ids = [...recordIdsIn(lastWrite.value), ...recordIdsIn(lastWrite.text)]
  const dedupKey = dedupKeyOf(claim?.contentExcerpt ?? lastWrite.text)
  const readbackText = normalizeText(readback.map((entry) => `${entry.name} ${entry.text} ${JSON.stringify(entry.value ?? null)}`).join(' '))

  const matchedIds = ids.filter((id) => readbackText.includes(normalizeText(id)))
  if (matchedIds.length > 0) {
    return {
      status: FINALIZATION_STATUS[0],
      code: 'ID_MATCH',
      detail: `the record returned by ${lastWrite.name} (${matchedIds[0]}) was found again in the read-back call ${readback[readback.length - 1].name}`,
      matchedIds,
      observedWrites: writes.map((entry) => entry.name),
      observedReads: readback.map((entry) => entry.name),
    }
  }

  const excerpt = normalizeText(String(claim?.contentExcerpt ?? '').slice(0, 120))
  if (excerpt !== '' && readbackText.includes(excerpt)) {
    return {
      status: FINALIZATION_STATUS[0],
      code: 'CONTENT_MATCH',
      detail: 'the reported content excerpt appears in the read-back result',
      dedupKey,
      observedWrites: writes.map((entry) => entry.name),
      observedReads: readback.map((entry) => entry.name),
    }
  }

  return {
    status: FINALIZATION_STATUS[1],
    code: 'NO_MATCHING_READBACK',
    detail: ids.length > 0
      ? `a read-back ran (${readback[readback.length - 1].name}) but none of the written record ids (${ids.slice(0, 3).join(', ')}) appeared in its result`
      : 'a read-back ran but neither a returned record id nor the reported content could be matched in its result',
    dedupKey,
    observedWrites: writes.map((entry) => entry.name),
    observedReads: readback.map((entry) => entry.name),
  }
}

/**
 * Whether the gate may treat finalization as settled.
 *
 * The handoff is delivered once. If the Agent produces no verdict afterwards,
 * the status stays `partial` and is reported — it is never upgraded to
 * `complete` by silence, and it never blocks the turn forever (§8.3).
 *
 * @param finalization - the persisted finalization record.
 * @param options - `{ config }`.
 * @returns `{ settled, status, reason }`.
 */
export function finalizationSettled(finalization, { config }) {
  const status = finalization?.status ?? FINALIZATION_STATUS[2]
  if (status === FINALIZATION_STATUS[0]) return { settled: true, status, reason: 'finalization complete' }
  if (status === FINALIZATION_STATUS[3]) return { settled: true, status, reason: 'no long-term memory write was required' }
  if (finalization?.attempts > 0) {
    return {
      settled: config?.mode === 'observe' ? true : true,
      status,
      reason: `the finalization handoff was delivered ${finalization.attempts} time(s); the remaining work belongs to the Agent's own review rules`,
    }
  }
  return { settled: false, status, reason: 'the finalization handoff has not been delivered yet' }
}
