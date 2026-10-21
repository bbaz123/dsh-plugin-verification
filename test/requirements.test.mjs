/**
 * Requirements hygiene: only the USER's words define the demand.
 *
 * Measured defect (2026-10-12, recurred 2026-10-17): the gate's own notice is a
 * user-role message carrying EXAMPLE paths ("…, e.g. novel-studio/package.json").
 * Once that notice became the next turn's requirement text, the resolver scored
 * it against the filesystem, bound the task to the project its own advice named,
 * and the gate verified a project the user never mentioned. A notice is not a
 * requirement.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { internals } from '../lib/index.js'

test('the gate\'s own notices never become requirement text', () => {
  const texts = internals.textsOf([
    { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: '在 dsh-auto-plan-executor 里加闸门' }] },
    {
      id: 'm2',
      source: { kind: 'verification-gate', form: 'notice' },
      content: [{ type: 'text', text: '在聚合工作区里，消息中提到某个子项目下的真实文件路径（例如 novel-studio/package.json）也能识别。' }],
    },
    { id: 'm3', source: { kind: 'user' }, content: [{ type: 'text', text: '验收命令：在 dsh-auto-plan-executor 目录下执行 npm run check' }] },
  ])
  assert.deepEqual(texts, [
    '在 dsh-auto-plan-executor 里加闸门',
    '验收命令：在 dsh-auto-plan-executor 目录下执行 npm run check',
  ])
})

test('a message without a source is still treated as user text (older hosts)', () => {
  const texts = internals.textsOf([{ id: 'm1', content: [{ type: 'text', text: '改一下 novel-studio/ai/policy.mjs' }] }])
  assert.deepEqual(texts, ['改一下 novel-studio/ai/policy.mjs'])
})
