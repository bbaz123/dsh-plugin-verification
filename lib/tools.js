/**
 * The three tools the Agent may call (§10.2).
 *
 * None of them can submit a PASS, and none accepts a shell string to replace the
 * required plan:
 *
 *   verification_run       run quick/regression/full, or release a block
 *   verification_status    read the verdict, the evidence index and the ledger
 *   verification_finalize  submit the final report plus the REAL memory outcome
 *
 * `verification_finalize` is deliberately unable to accept
 * `{ "memorySaved": true }` as proof: the claim is checked against the tool calls
 * this session actually produced (§8.2).
 *
 * @module dsh-plugin-verification/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { FINALIZATION_STATUS } from './protocol.js'
import { openRequirementsRevision } from './runtime/task-state.js'

/**
 * The canonical failure payload when there is no live agent.
 *
 * It carries ONLY keys the tool's own declared `output.schema` contains: the host
 * validates every tool result against that schema, and the schemas are
 * `additionalProperties: false`. The first revision also returned
 * `gate: null, detail: null` here — two keys that `verification_status` and
 * `verification_finalize` never declared — so their "no agent" path was a hard
 * host rejection waiting to happen.
 */
function noAgent(code, message) {
  return { status: 'ERROR', code, message }
}

/**
 * Drop absent optional fields instead of sending `null`.
 *
 * The host validates a tool result against the schema the tool DECLARED, and that
 * schema types `gate` / `acceptance` / `detail` as strings. Returning `null` for
 * "there is no verdict" was therefore rejected outright —
 * `tool "verification_run" returned invalid output: "value.gate" must be a string`
 * — on precisely the path that matters most: the task where the gate did not run.
 * For an optional property, "absent" is the honest encoding of "no value".
 */
function compact(object) {
  const out = {}
  for (const [key, value] of Object.entries(object)) {
    if (value === null || value === undefined) continue
    out[key] = value
  }
  return out
}

/** A bounded, model-facing JSON block. */
function text(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

/**
 * Render the outcome of one controller instruction as model-facing text.
 *
 * @param outcome - a controller result.
 * @returns the text block array.
 */
export function renderOutcome(outcome) {
  if (outcome.action === 'steer') return text(outcome.text)
  if (outcome.action === 'block') {
    return text(`[verification-gate] 验证循环已停止：${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ''}`)
  }
  if (outcome.action === 'complete') {
    return text(`[verification-gate] 本轮验证结束：${outcome.gate?.gate ?? 'unknown'} — ${outcome.gate?.reason ?? ''}`)
  }
  return text(`[verification-gate] 验证门未介入（${outcome.skip ?? 'no applicable work'}）`)
}

/**
 * Build the three tool definitions bound to one controller.
 *
 * @param options - `{ controller, config, logger }`.
 * @returns an array of ToolDefinitions.
 */
export function createTools({ controller, config, logger }) {
  const runTool = defineTool({
    name: 'verification_run',
    description: [
      '运行 DSH 验证门（Change → Memory → Regression → Assertion → Review）。',
      '',
      '用途：',
      '  - 主动在任务中途验证当前工作区（mode: quick/regression/full）；',
      '  - 用户在被阻塞后明确要求继续时，用 release=true 解除阻塞并重新开始一轮验证；',
      '  - 用户在执行中补充了新要求时，用 requirements 提交新一版需求文本（会使需求审查失效并开启新版本）。',
      '',
      '本工具不接受任意 shell 命令，也不能提交 PASS：它只执行项目自身声明的检查（package.json 脚本、vitest、pytest、tsconfig），',
      '并把结果写入任务状态。判定由插件计算，模型无法通过参数授予自己通过。',
    ].join('\n'),
    parameters: {
      mode: {
        type: 'string',
        enum: ['quick', 'regression', 'full'],
        description: 'quick=直接相关测试与快速机器检查；regression=项目必测集合（默认）；full=全部声明检查（含 build/lint）。',
      },
      reason: {
        type: 'string',
        description: '为什么现在运行验证。用于任务记录与阻塞解除说明。',
      },
      requirements: {
        type: 'string',
        description: '用户新增/修订后的需求原文（可选）。提供时开启新的需求版本，使上一版需求审查失效；不会重新采集基线。',
      },
      release: {
        type: 'boolean',
        description: '用户已明确要求继续时设为 true：解除阻塞状态、重置修复预算，然后重新验证。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['OK', 'BLOCKED', 'ERROR'] },
          code: { type: 'string' },
          message: { type: 'string' },
          action: { type: 'string' },
          gate: { type: 'string' },
          acceptance: { type: 'string' },
          cycle: { type: 'number' },
          released: { type: 'number' },
          findings: { type: 'number' },
          blocking: { type: 'number' },
          detail: { type: 'string' },
        },
      },
      render: (args, value) => renderOutcome({
        action: value.status === 'BLOCKED' ? 'block' : value.status === 'ERROR' ? 'none' : 'steer',
        reason: value.code,
        detail: value.detail,
        gate: { gate: value.gate, reason: value.message },
        text: value.message,
      }),
    },
    async execute(args, exec) {
      const agent = exec?.agent
      if (agent === undefined || agent === null) return noAgent('NO_AGENT', 'verification_run 需要一个调用会话')

      let released = 0
      if (args.release === true) {
        const outcome = await controller.releaseBlock(agent.id, args.reason ?? 'released through verification_run')
        if (outcome.ok !== true) {
          return compact({ status: 'ERROR', code: 'RELEASE_FAILED', message: `无法解除阻塞：${outcome.error}`, gate: null, detail: null })
        }
        released = outcome.released ?? 0
      }

      const status = await controller.status(agent.id)
      if (args.requirements !== undefined && String(args.requirements).trim() !== '') {
        if (status.ok === true) {
          const revision = openRequirementsRevision(status.context.taskState, [String(args.requirements)])
          logger?.info?.(`[verification-gate] requirements revision ${revision} opened by verification_run`)
        }
      }

      const outcome = await controller.run({
        agent,
        signal: exec.signal,
        mode: args.mode ?? config.defaultMode,
        reason: args.reason ?? 'explicit verification_run',
      })

      const context = status.ok === true ? status.context : null
      const summary = context === null ? null : {
        cycle: context.taskState.cycle,
        findings: (context.taskState.findings ?? []).length,
        blocking: (context.taskState.findings ?? []).filter((finding) => finding.blocking === true).length,
      }

      return compact({
        status: outcome.action === 'block' ? 'BLOCKED' : 'OK',
        code: outcome.action === 'block' ? (outcome.reason ?? 'BLOCKED') : (outcome.skip ?? 'RAN'),
        message: renderOutcome(outcome)[0].text,
        action: outcome.action,
        gate: outcome.gate?.gate ?? context?.taskState?.gate?.gate ?? null,
        acceptance: outcome.gate?.technicalAcceptance ?? context?.taskState?.acceptance ?? null,
        cycle: summary?.cycle ?? null,
        released,
        findings: summary?.findings ?? 0,
        blocking: summary?.blocking ?? 0,
        detail: outcome.detail ?? null,
      })
    },
  })

  const statusTool = defineTool({
    name: 'verification_status',
    description: [
      '查询 DSH 验证门的当前状态：任务阶段、轮次、工作区指纹、技术验收、收尾状态、门禁判定、',
      '未解决问题（Task Error Ledger）、证据索引与四次强制经验检索的记录。',
      '',
      '当修改类工具被验证门拒绝、或你需要向用户解释为什么验证没有通过时，先用本工具读取真实状态，',
      '不要凭记忆描述验证结果。本工具是只读的。',
    ].join('\n'),
    parameters: {
      includeEvidence: {
        type: 'boolean',
        description: '是否返回完整证据索引（默认 true）。证据较多时可设为 false。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['OK', 'ERROR'] },
          code: { type: 'string' },
          message: { type: 'string' },
          summary: { type: 'json' },
        },
      },
      render: (_args, value) => text(value.message),
    },
    async execute(args, exec) {
      const agent = exec?.agent
      if (agent === undefined || agent === null) return noAgent('NO_AGENT', 'verification_status 需要一个调用会话')
      const found = await controller.status(agent.id)
      if (found.ok !== true) {
        return compact({
          status: 'ERROR',
          code: 'STATUS_UNAVAILABLE',
          message: `无法读取任务状态：${found.error}。这是一个硬错误，不要据此声称验证通过。`,
          summary: null,
        })
      }
      const { taskSummary } = await import('./runtime/task-state.js')
      const summary = taskSummary({
        taskState: found.context.taskState,
        evidenceStore: found.context.evidenceStore,
        ledger: found.context.ledger,
        applicable: found.context.applicable,
      })
      if (args.includeEvidence === false) summary.evidence = `${summary.evidence.length} 条（已省略）`
      return {
        status: 'OK',
        code: 'OK',
        message: [
          '[verification-gate] 当前状态',
          JSON.stringify(summary, null, 2),
        ].join('\n'),
        summary,
      }
    },
  })

  const finalizeTool = defineTool({
    name: 'verification_finalize',
    description: [
      '提交本次任务的最终复盘报告，并声明长期记忆收尾的真实结果。',
      '',
      '要求：',
      '  - report：必填。你的最终复盘文本（【发现的问题】【修复内容】【验证结果】【错误根因】等）；',
      '  - memoryOutcome：必填。written = 本次确实向 OpenViking 写入了长期经验；none = 本次没有可复用的自身错误经验；',
      '  - memoryExcerpt：memoryOutcome=written 时必填，填写你写入内容的一段原文（用于与回读结果比对）。',
      '',
      '插件不会相信一个布尔值：它会用本会话实际观察到的工具调用核验你的声明——',
      '是否真的调用了写入工具、写入后是否真的做了回读、回读结果是否能匹配上写入返回的记录标识或内容。',
      '只搜到一条相似旧记忆不会被当作本次写入成功。核验不通过时状态为 partial，插件不会声称已经长期记住。',
    ].join('\n'),
    parameters: {
      report: {
        type: 'string',
        required: true,
        description: '最终复盘报告全文。',
      },
      memoryOutcome: {
        type: 'string',
        required: true,
        enum: ['written', 'none'],
        description: 'written = 本次写入了长期经验；none = 本次没有需要沉淀的错误经验。',
      },
      memoryExcerpt: {
        type: 'string',
        description: 'memoryOutcome=written 时必填：你写入内容的一段原文（前若干行即可）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['OK', 'PARTIAL', 'ERROR'] },
          code: { type: 'string' },
          message: { type: 'string' },
          finalization: { type: 'string', enum: [...FINALIZATION_STATUS] },
          readbackCode: { type: 'string' },
        },
      },
      render: (_args, value) => text(value.message),
    },
    async execute(args, exec) {
      const agent = exec?.agent
      if (agent === undefined || agent === null) return noAgent('NO_AGENT', 'verification_finalize 需要一个调用会话')

      const report = String(args.report ?? '').trim()
      if (report.length < 40) {
        return {
          status: 'ERROR',
          code: 'REPORT_TOO_SHORT',
          message: 'report 太短，不能作为最终复盘：请提供完整的复盘内容。',
          finalization: FINALIZATION_STATUS[2],
          readbackCode: 'NOT_EVALUATED',
        }
      }
      if (args.memoryOutcome === 'written' && String(args.memoryExcerpt ?? '').trim() === '') {
        return {
          status: 'ERROR',
          code: 'MEMORY_EXCERPT_REQUIRED',
          message: 'memoryOutcome=written 时必须提供 memoryExcerpt，否则插件无法核验写入与回读是否对应。',
          finalization: FINALIZATION_STATUS[2],
          readbackCode: 'NOT_EVALUATED',
        }
      }

      const outcome = await controller.finalize({ agent, args })
      if (outcome.ok !== true && outcome.readback === undefined) {
        return {
          status: 'ERROR',
          code: 'FINALIZE_FAILED',
          message: `收尾提交失败：${outcome.error}`,
          finalization: FINALIZATION_STATUS[2],
          readbackCode: 'NOT_EVALUATED',
        }
      }

      const verified = outcome.readback?.status === FINALIZATION_STATUS[0]
      const notRequired = outcome.readback?.status === FINALIZATION_STATUS[3]
      // One fallback for the whole gate line, never one per field: two different
      // per-field defaults produced a self-contradicting pair
      // ("技术验收：not_verified  门禁：verified") on a task that had no gate yet.
      const gateLine = outcome.gate === undefined || outcome.gate === null
        ? '技术验收/门禁：本会话尚无验证结论（未建立可判定的验证任务）——收尾提交只记录了报告与记忆回读结果'
        : `技术验收：${outcome.gate.technicalAcceptance ?? 'unknown'}   门禁：${outcome.gate.gate ?? 'unknown'}`
      const lines = [
        `[verification-gate] 收尾提交结果：${outcome.readback?.status}`,
        `核验代码：${outcome.readback?.code}`,
        `核验说明：${outcome.readback?.detail}`,
        `观察到的写入调用：${(outcome.readback?.observedWrites ?? []).join(', ') || '（无）'}`,
        `观察到的回读调用：${(outcome.readback?.observedReads ?? []).join(', ') || '（无）'}`,
        gateLine,
      ]
      if (!verified && !notRequired) {
        lines.push(
          '',
          '本次长期记忆收尾未被确认为成功。按规则不得声称“已经长期记住”：',
          '若你确实写入了经验，请先真正执行一次回读（读取同一个 URI），确认内容存在，再重新提交 verification_finalize。',
        )
      }
      return {
        status: verified || notRequired ? 'OK' : 'PARTIAL',
        code: outcome.readback?.code ?? 'UNKNOWN',
        message: lines.join('\n'),
        finalization: outcome.readback?.status ?? FINALIZATION_STATUS[2],
        readbackCode: outcome.readback?.code ?? 'UNKNOWN',
      }
    },
  })

  return [runTool, statusTool, finalizeTool]
}
