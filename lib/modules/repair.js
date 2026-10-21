/**
 * Repair Coordinator: retrieve FIRST, then release the repair context.
 *
 * This is the strongest checkpoint in the plugin, and the order is the whole
 * point:
 *
 *     Record the finding  →  search the task ledger  →  search OpenViking
 *       →  resolve the relevant rules  →  issue a retrieval receipt
 *       →  build the repair packet  →  inject it into the Agent
 *
 * A failure to retrieve is NOT an empty result. When the pre-repair retrieval
 * did not complete, the loop stops and reports "修复前经验检索未完成" instead of
 * quietly repairing as if nothing were known (§7.6). The receipt is bound to the
 * task, the workspace fingerprint and the failure fingerprint, so a retrieval
 * taken before the code moved cannot authorise a repair afterwards
 * ({@link ticketAuthorizes}).
 *
 * What this can enforce is that retrieval HAPPENED and that its result reached
 * the next step. It cannot force the model to understand it — that is checked by
 * the next cycle's execution evidence, never by "the packet was injected".
 *
 * @module dsh-plugin-verification/modules/repair
 */

import {
  makeRepairPacket,
  makeRepairReadTicket,
  repairPacketHash,
  STAGE,
  ticketAuthorizes,
} from '../protocol.js'
import { retrievalVerdict } from './memory.js'
import { makeLedgerEntry, sha256Hex } from '../store.js'

/** Why the automatic repair loop stopped. */
export const REPAIR_BLOCK = {
  NO_PROGRESS: 'NO_PROGRESS',
  BUDGET_EXHAUSTED: 'BUDGET_EXHAUSTED',
  RETRIEVAL_INCOMPLETE: 'RETRIEVAL_INCOMPLETE',
  NO_FINDINGS: 'NO_FINDINGS',
}

/**
 * Derive the concrete checks the Agent must answer during the repair.
 *
 * @param findings - the blocking findings.
 * @returns one bounded instruction per finding, plus the shared constraints.
 */
export function requiredChecksFrom(findings) {
  const checks = []
  for (const finding of findings) {
    const head = finding.summary.replace(/\s+/g, ' ').slice(0, 200)
    switch (finding.action) {
      case 'repair_code':
        checks.push(`Identify the cause of: ${head} — then fix it and re-run the regression stage.`)
        break
      case 'provide_evidence':
        checks.push(`Produce the missing execution evidence for: ${head}`)
        break
      case 'fix_environment':
        checks.push(`Restore the environment so this check can run: ${head}`)
        break
      case 'explain_or_restore':
        checks.push(`Restore the required test coverage or justify its removal against the current requirement: ${head}`)
        break
      default:
        checks.push(`Consider: ${head}`)
        break
    }
  }
  return checks.slice(0, 12)
}

/** Render the repair packet as the model-facing steering text. */
export function renderRepairPacket(packet) {
  const lines = [
    '[verification-gate] 自动修复请求（附强制记忆检索凭据）',
    '',
    `repairId: ${packet.repairId}   cycle: ${packet.cycle}   restartFrom: ${packet.restartFrom}`,
    `workspaceFingerprint: ${packet.workspaceFingerprint}`,
    '',
    `当前问题：${packet.currentProblem.summary}`,
    `相关证据：${packet.currentProblem.evidenceIds.join(', ') || '（无）'}`,
    '',
    `修复前经验检索：status=${packet.memoryRetrieval.status}  queryId=${packet.memoryRetrieval.queryId ?? 'n/a'}`,
    packet.memoryRetrieval.memoryIds.length > 0
      ? `检索到的经验：\n${packet.memoryRetrieval.memoryIds.map((id) => `  - ${id}`).join('\n')}`
      : '检索到的经验：无（查询已成功完成，只是没有相关命中）',
    '',
    '必须逐条处理：',
    ...packet.requiredChecks.map((check, index) => `  ${index + 1}. ${check}`),
    '',
    '约束：',
    ...packet.constraints.map((constraint) => `  - ${constraint}`),
    '',
    `处理完成后会从 ${packet.restartFrom} 阶段重新验证；不要为了让检查通过而削弱测试。`,
  ]
  return lines.join('\n')
}

/**
 * Create the repair coordinator.
 *
 * @param options - `{ memoryResolver, config, logger }`.
 * @returns `{ prepare }`.
 */
export function createRepairCoordinator({ memoryResolver, config, logger }) {
  /**
   * Record the findings, retrieve experience, and build the authorised packet.
   *
   * @param options - the repair inputs.
   * @returns `{ ok, packet, ticket, receipt, ledgerEntryIds, blockedReason }`.
   */
  async function prepare({
    taskState,
    ledger,
    findings,
    stage = STAGE.REGRESSION,
    cycle,
    agent,
    signal,
    failureFingerprint,
    restartFrom = STAGE.REGRESSION,
  }) {
    if (findings.length === 0) {
      return { ok: false, blockedReason: REPAIR_BLOCK.NO_FINDINGS, packet: null, ticket: null, receipt: null, ledgerEntryIds: [] }
    }

    // 1. Record the current findings in the task's own ledger.
    const ledgerEntryIds = []
    for (const finding of findings) {
      const entry = makeLedgerEntry({
        taskId: taskState.taskId,
        cycle,
        stage,
        kind: finding.kind,
        summary: finding.summary,
        findingIds: [finding.id],
        evidenceIds: finding.evidenceIds,
        failureFingerprint,
      })
      ledger.record(entry)
      taskState.ledger.push(entry)
      ledgerEntryIds.push(entry.id)
    }

    // 2. Has this exact failure already been repaired in this task without
    //    being resolved? Re-explaining the same thing is not progress.
    const attempts = ledger.attemptsFor(failureFingerprint)
    if (failureFingerprint !== null && attempts >= config.sameFailureNoProgressLimit) {
      logger?.warn?.(`[verification-gate] failure ${failureFingerprint} has recurred ${attempts} time(s); stopping the automatic loop`)
      return {
        ok: false,
        blockedReason: REPAIR_BLOCK.NO_PROGRESS,
        packet: null,
        ticket: null,
        receipt: null,
        ledgerEntryIds,
        detail: `${attempts} attempt(s) at the identical failure fingerprint`,
      }
    }

    // 3. The shared repair budget: three repairs for the whole gate, not three
    //    per stage.
    if (cycle > config.maxRepairCycles) {
      return {
        ok: false,
        blockedReason: REPAIR_BLOCK.BUDGET_EXHAUSTED,
        packet: null,
        ticket: null,
        receipt: null,
        ledgerEntryIds,
        detail: `cycle ${cycle} exceeds maxRepairCycles ${config.maxRepairCycles}`,
      }
    }

    // 4. Mandatory retrieval, before any repair context is released.
    const checkpoint = await memoryResolver.resolveCheckpoint({
      taskState,
      checkpointId: 'repair',
      context: {
        change: taskState.change,
        failureFingerprint,
        failureSummary: findings.map((finding) => finding.summary).join(' | '),
      },
      agent,
      signal,
    })

    const verdict = retrievalVerdict(checkpoint.receipt, config, { beforeRepair: true })
    if (verdict.blocked) {
      logger?.warn?.(`[verification-gate] pre-repair retrieval incomplete: ${verdict.reason}`)
      return {
        ok: false,
        blockedReason: REPAIR_BLOCK.RETRIEVAL_INCOMPLETE,
        packet: null,
        ticket: null,
        receipt: checkpoint.receipt,
        ledgerEntryIds,
        detail: verdict.reason,
      }
    }

    // 5. Build the packet and its receipt.
    const packet = makeRepairPacket({
      taskId: taskState.taskId,
      workspaceFingerprint: taskState.workspaceFingerprint,
      stage,
      findingIds: findings.map((finding) => finding.id),
      summary: findings.map((finding) => finding.summary).join(' | ').slice(0, 1200),
      evidenceIds: [...new Set(findings.flatMap((finding) => finding.evidenceIds))],
      memoryQueryId: checkpoint.receipt.queryId,
      queryStatus: checkpoint.receipt.status,
      memoryIds: checkpoint.receipt.memoryIds,
      taskHistoryIds: ledgerEntryIds,
      requiredChecks: requiredChecksFrom(findings),
      restartFrom,
      cycle,
    })

    const ticket = makeRepairReadTicket({
      taskId: taskState.taskId,
      workspaceFingerprint: taskState.workspaceFingerprint,
      failureFingerprint,
      memoryQueryId: checkpoint.receipt.queryId,
      queryStatus: checkpoint.receipt.status,
      repairPacketHash: `sha256:${sha256Hex(repairPacketHash(packet)).slice(0, 24)}`,
    })

    const authorization = ticketAuthorizes(ticket, {
      workspaceFingerprint: taskState.workspaceFingerprint,
      failureFingerprint,
    })
    if (!authorization.ok) {
      return {
        ok: false,
        blockedReason: REPAIR_BLOCK.RETRIEVAL_INCOMPLETE,
        packet: null,
        ticket,
        receipt: checkpoint.receipt,
        ledgerEntryIds,
        detail: `${authorization.code}: ${authorization.reason}`,
      }
    }

    logger?.info?.(
      `[verification-gate] repair packet ${packet.repairId} authorised (cycle ${cycle}, `
      + `retrieval ${checkpoint.receipt.status}, ${packet.requiredChecks.length} required check(s))`,
    )

    return { ok: true, packet, ticket, receipt: checkpoint.receipt, ledgerEntryIds, blockedReason: null, authorization }
  }

  return { prepare, render: renderRepairPacket, requiredChecksFrom }
}
