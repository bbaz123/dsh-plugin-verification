/**
 * Configuration contract: §10.1 values must arrive with defaults, the nested
 * shape from the design document must be accepted, and an out-of-range number
 * must be clamped rather than passed through.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { Config, DEFAULTS, flattenConfig, normalizeConfig } from '../lib/config.js'

test('the flat Loader schema resolves every default for a partial row', () => {
  const resolved = Config({ enabled: true, mode: 'enforce' })
  assert.equal(resolved.mode, 'enforce')
  assert.equal(resolved.maxRepairCycles, DEFAULTS.maxRepairCycles)
  assert.equal(resolved.memoryMaxExperiences, DEFAULTS.memoryMaxExperiences)
  assert.equal(resolved.executionCommandTimeoutMs, DEFAULTS.executionCommandTimeoutMs)
  assert.equal(resolved.blockMutatingToolsWhileBlocked, DEFAULTS.blockMutatingToolsWhileBlocked)
})

test('the Loader schema rejects a value outside a declared vocabulary', () => {
  assert.throws(() => Config({ mode: 'sometimes' }))
})

test('normalizeConfig accepts the nested §10.1 shape', () => {
  const config = normalizeConfig({
    verification: { defaultMode: 'full', maxRepairCycles: 5, unknownRequiredCheck: 'warn' },
    baseline: { executeInIsolatedCopy: false },
    memory: { onReadFailure: 'degrade', timeoutMs: 900 },
    review: { requireCurrentEvidence: false },
    execution: { autoInstallDependencies: true, commandTimeoutMs: 60000 },
  })
  assert.equal(config.defaultMode, 'full')
  assert.equal(config.maxRepairCycles, 5)
  assert.equal(config.unknownRequiredCheck, 'warn')
  assert.equal(config.executeInIsolatedCopy, false)
  assert.equal(config.memoryOnReadFailure, 'degrade')
  assert.equal(config.memoryTimeoutMs, 900)
  assert.equal(config.reviewRequireCurrentEvidence, false)
  assert.equal(config.executionAutoInstallDependencies, true)
  assert.equal(config.executionCommandTimeoutMs, 60000)
})

test('a nested value wins over the flat spelling of the same key', () => {
  const flat = flattenConfig({ maxRepairCycles: 1, verification: { maxRepairCycles: 4 } })
  assert.equal(flat.maxRepairCycles, 4)
})

test('an out-of-range number is clamped, not passed through', () => {
  const config = normalizeConfig({ maxRepairCycles: 999, memoryTimeoutMs: 1, executionMaxCapturedOutputBytes: 1 })
  assert.equal(config.maxRepairCycles, 20)
  assert.equal(config.memoryTimeoutMs, 250)
  assert.equal(config.executionMaxCapturedOutputBytes, 1024)
})

test('an unknown vocabulary value falls back to the default instead of propagating', () => {
  const config = normalizeConfig({ mode: 'whatever', memoryOnReadFailure: 'ignore', baselinePolicy: 7 })
  assert.equal(config.mode, DEFAULTS.mode)
  assert.equal(config.memoryOnReadFailure, DEFAULTS.memoryOnReadFailure)
  assert.equal(config.baselinePolicy, DEFAULTS.baselinePolicy)
})

test('the mutating-tool vocabulary is parsed into an array once', () => {
  const config = normalizeConfig({ mutatingToolNames: 'write, edit ,pwsh' })
  assert.deepEqual(config.mutatingTools, ['write', 'edit', 'pwsh'])
})

test('a configuration object is frozen so no stage can mutate the policy mid-run', () => {
  const config = normalizeConfig({})
  assert.equal(Object.isFrozen(config), true)
})
