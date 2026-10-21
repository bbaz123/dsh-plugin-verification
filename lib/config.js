/**
 * Plugin configuration: the row's `config:` block, normalised into the one
 * shape the rest of the plugin reads.
 *
 * Two sources of truth exist on purpose:
 *
 *   - `Config` (schemastery) is what the Loader validates and what
 *     `Config.listConfigs` shows in the Inspector. It is deliberately FLAT
 *     (one key per tunable) so a partially written row still gets every
 *     default resolved by the Loader itself.
 *   - `normalizeConfig()` is the runtime normaliser. Besides semantics the
 *     schema cannot express (mode vocabularies, numeric clamps), it also
 *     accepts the nested §10.1 shape (`verification:`, `memory:`, …) so a user
 *     who copies the design document's YAML into `cordis.patch.yml` still gets
 *     working values instead of `undefined`.
 *
 * @module dsh-plugin-verification/config
 */

import z from '@deepseek-ai/schemastery'

/** The §10.1 defaults, in the flat shape this plugin reads. */
export const DEFAULTS = Object.freeze({
  enabled: true,
  mode: 'enforce',

  defaultMode: 'regression',
  maxRepairCycles: 3,
  failFast: true,
  unknownRequiredCheck: 'block',
  baselinePolicy: 'new-failures',
  sameFailureNoProgressLimit: 2,

  baselineStrategy: 'snapshot-lazy',
  preserveInitialWorkspace: true,
  executeInIsolatedCopy: true,

  memoryBinding: 'existing-openviking',
  memoryRequiredBeforeRepair: true,
  memoryOnReadFailure: 'block',
  memoryMaxExperiences: 5,
  memoryTimeoutMs: 5000,
  memoryRetries: 1,
  memoryToolPattern: 'openviking',
  memorySearchTool: '',

  reviewEnabled: true,
  reviewRequireCurrentEvidence: true,

  finalizationBridgeExistingGlobalRules: true,
  finalizationVerifyMemoryReadback: true,
  finalizationOnMemoryWriteFailure: 'report-partial',

  executionAutoInstallDependencies: false,
  executionCommandTimeoutMs: 120000,
  executionMaxCapturedOutputBytes: 2097152,

  storageDir: '',
  projectRoot: '',
  requireDetectedProject: true,
  blockMutatingToolsWhileBlocked: true,
  maxObservedToolResults: 200,

  snapshotMaxFileBytes: 1048576,
  snapshotMaxFiles: 400,
  reportMaxBytes: 4194304,

  flakeRerunEnabled: true,
  flakeRerunMaxFiles: 10,

  mutatingToolNames: 'write,edit,pwsh,bash,run_code,rename,move,delete',
})

/** Flat Loader-visible schema. Unknown keys are rejected by the Loader. */
export const Config = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled),
  mode: z.union(['enforce', 'observe', 'off']).default(DEFAULTS.mode),

  defaultMode: z.union(['quick', 'regression', 'full']).default(DEFAULTS.defaultMode),
  maxRepairCycles: z.number().default(DEFAULTS.maxRepairCycles),
  failFast: z.boolean().default(DEFAULTS.failFast),
  unknownRequiredCheck: z.union(['block', 'warn']).default(DEFAULTS.unknownRequiredCheck),
  baselinePolicy: z.union(['new-failures', 'any-failure']).default(DEFAULTS.baselinePolicy),
  sameFailureNoProgressLimit: z.number().default(DEFAULTS.sameFailureNoProgressLimit),

  baselineStrategy: z.string().default(DEFAULTS.baselineStrategy),
  preserveInitialWorkspace: z.boolean().default(DEFAULTS.preserveInitialWorkspace),
  executeInIsolatedCopy: z.boolean().default(DEFAULTS.executeInIsolatedCopy),

  memoryBinding: z.string().default(DEFAULTS.memoryBinding),
  memoryRequiredBeforeRepair: z.boolean().default(DEFAULTS.memoryRequiredBeforeRepair),
  memoryOnReadFailure: z.union(['block', 'degrade']).default(DEFAULTS.memoryOnReadFailure),
  memoryMaxExperiences: z.number().default(DEFAULTS.memoryMaxExperiences),
  memoryTimeoutMs: z.number().default(DEFAULTS.memoryTimeoutMs),
  memoryRetries: z.number().default(DEFAULTS.memoryRetries),
  memoryToolPattern: z.string().default(DEFAULTS.memoryToolPattern),
  memorySearchTool: z.string().default(DEFAULTS.memorySearchTool),

  reviewEnabled: z.boolean().default(DEFAULTS.reviewEnabled),
  reviewRequireCurrentEvidence: z.boolean().default(DEFAULTS.reviewRequireCurrentEvidence),

  finalizationBridgeExistingGlobalRules: z.boolean().default(DEFAULTS.finalizationBridgeExistingGlobalRules),
  finalizationVerifyMemoryReadback: z.boolean().default(DEFAULTS.finalizationVerifyMemoryReadback),
  finalizationOnMemoryWriteFailure: z.union(['report-partial', 'block']).default(DEFAULTS.finalizationOnMemoryWriteFailure),

  executionAutoInstallDependencies: z.boolean().default(DEFAULTS.executionAutoInstallDependencies),
  executionCommandTimeoutMs: z.number().default(DEFAULTS.executionCommandTimeoutMs),
  executionMaxCapturedOutputBytes: z.number().default(DEFAULTS.executionMaxCapturedOutputBytes),

  storageDir: z.string().default(DEFAULTS.storageDir),
  projectRoot: z.string().default(DEFAULTS.projectRoot),
  requireDetectedProject: z.boolean().default(DEFAULTS.requireDetectedProject),
  blockMutatingToolsWhileBlocked: z.boolean().default(DEFAULTS.blockMutatingToolsWhileBlocked),
  maxObservedToolResults: z.number().default(DEFAULTS.maxObservedToolResults),

  snapshotMaxFileBytes: z.number().default(DEFAULTS.snapshotMaxFileBytes),
  snapshotMaxFiles: z.number().default(DEFAULTS.snapshotMaxFiles),
  reportMaxBytes: z.number().default(DEFAULTS.reportMaxBytes),

  flakeRerunEnabled: z.boolean().default(DEFAULTS.flakeRerunEnabled),
  flakeRerunMaxFiles: z.number().default(DEFAULTS.flakeRerunMaxFiles),

  mutatingToolNames: z.string().default(DEFAULTS.mutatingToolNames),
})

/** Map the nested §10.1 shape onto the flat keys. */
const NESTED = {
  verification: {
    defaultMode: 'defaultMode',
    maxRepairCycles: 'maxRepairCycles',
    failFast: 'failFast',
    unknownRequiredCheck: 'unknownRequiredCheck',
    baselinePolicy: 'baselinePolicy',
    sameFailureNoProgressLimit: 'sameFailureNoProgressLimit',
  },
  baseline: {
    strategy: 'baselineStrategy',
    preserveInitialWorkspace: 'preserveInitialWorkspace',
    executeInIsolatedCopy: 'executeInIsolatedCopy',
  },
  memory: {
    binding: 'memoryBinding',
    requiredBeforeRepair: 'memoryRequiredBeforeRepair',
    onReadFailure: 'memoryOnReadFailure',
    maxExperiences: 'memoryMaxExperiences',
    timeoutMs: 'memoryTimeoutMs',
    retries: 'memoryRetries',
    toolPattern: 'memoryToolPattern',
    searchTool: 'memorySearchTool',
  },
  review: {
    enabled: 'reviewEnabled',
    requireCurrentEvidence: 'reviewRequireCurrentEvidence',
  },
  finalization: {
    bridgeExistingGlobalRules: 'finalizationBridgeExistingGlobalRules',
    verifyMemoryReadback: 'finalizationVerifyMemoryReadback',
    onMemoryWriteFailure: 'finalizationOnMemoryWriteFailure',
  },
  execution: {
    autoInstallDependencies: 'executionAutoInstallDependencies',
    commandTimeoutMs: 'executionCommandTimeoutMs',
    maxCapturedOutputBytes: 'executionMaxCapturedOutputBytes',
  },
}

/** Clamp a number into an inclusive range, falling back on a non-finite value. */
function clamp(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/** Read a boolean, treating only a strict boolean as a value. */
function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** Read a string from a fixed vocabulary, falling back on anything else. */
function oneOf(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback
}

/**
 * Flatten a possibly nested §10.1 config into the flat key space.
 *
 * @param raw - the row's config block.
 * @returns a flat object (nested values win over the flat spelling).
 */
export function flattenConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const flat = {}
  for (const [key, value] of Object.entries(source)) {
    if (key in NESTED && value !== null && typeof value === 'object') continue
    flat[key] = value
  }
  for (const [group, mapping] of Object.entries(NESTED)) {
    const nested = source[group]
    if (nested === null || typeof nested !== 'object') continue
    for (const [nestedKey, flatKey] of Object.entries(mapping)) {
      if (nested[nestedKey] !== undefined) flat[flatKey] = nested[nestedKey]
    }
  }
  return flat
}

/**
 * Normalise one row's config into the runtime shape.
 *
 * @param raw - the row's `config:` block (flat, nested, or both).
 * @returns a frozen, fully defaulted configuration.
 */
export function normalizeConfig(raw) {
  const input = flattenConfig(raw)

  const pick = (key) => (input[key] === undefined ? DEFAULTS[key] : input[key])

  return Object.freeze({
    enabled: bool(pick('enabled'), DEFAULTS.enabled),
    mode: oneOf(pick('mode'), ['enforce', 'observe', 'off'], DEFAULTS.mode),

    defaultMode: oneOf(pick('defaultMode'), ['quick', 'regression', 'full'], DEFAULTS.defaultMode),
    maxRepairCycles: clamp(pick('maxRepairCycles'), 0, 20, DEFAULTS.maxRepairCycles),
    failFast: bool(pick('failFast'), DEFAULTS.failFast),
    unknownRequiredCheck: oneOf(pick('unknownRequiredCheck'), ['block', 'warn'], DEFAULTS.unknownRequiredCheck),
    baselinePolicy: oneOf(pick('baselinePolicy'), ['new-failures', 'any-failure'], DEFAULTS.baselinePolicy),
    sameFailureNoProgressLimit: clamp(pick('sameFailureNoProgressLimit'), 1, 10, DEFAULTS.sameFailureNoProgressLimit),

    baselineStrategy: String(pick('baselineStrategy') || DEFAULTS.baselineStrategy),
    preserveInitialWorkspace: bool(pick('preserveInitialWorkspace'), DEFAULTS.preserveInitialWorkspace),
    executeInIsolatedCopy: bool(pick('executeInIsolatedCopy'), DEFAULTS.executeInIsolatedCopy),

    memoryBinding: String(pick('memoryBinding') || DEFAULTS.memoryBinding),
    memoryRequiredBeforeRepair: bool(pick('memoryRequiredBeforeRepair'), DEFAULTS.memoryRequiredBeforeRepair),
    memoryOnReadFailure: oneOf(pick('memoryOnReadFailure'), ['block', 'degrade'], DEFAULTS.memoryOnReadFailure),
    memoryMaxExperiences: clamp(pick('memoryMaxExperiences'), 1, 50, DEFAULTS.memoryMaxExperiences),
    memoryTimeoutMs: clamp(pick('memoryTimeoutMs'), 250, 60000, DEFAULTS.memoryTimeoutMs),
    memoryRetries: clamp(pick('memoryRetries'), 0, 5, DEFAULTS.memoryRetries),
    memoryToolPattern: String(pick('memoryToolPattern') ?? DEFAULTS.memoryToolPattern),
    memorySearchTool: String(pick('memorySearchTool') || ''),

    reviewEnabled: bool(pick('reviewEnabled'), DEFAULTS.reviewEnabled),
    reviewRequireCurrentEvidence: bool(pick('reviewRequireCurrentEvidence'), DEFAULTS.reviewRequireCurrentEvidence),

    finalizationBridgeExistingGlobalRules: bool(
      pick('finalizationBridgeExistingGlobalRules'),
      DEFAULTS.finalizationBridgeExistingGlobalRules,
    ),
    finalizationVerifyMemoryReadback: bool(
      pick('finalizationVerifyMemoryReadback'),
      DEFAULTS.finalizationVerifyMemoryReadback,
    ),
    finalizationOnMemoryWriteFailure: oneOf(
      pick('finalizationOnMemoryWriteFailure'),
      ['report-partial', 'block'],
      DEFAULTS.finalizationOnMemoryWriteFailure,
    ),

    executionAutoInstallDependencies: bool(
      pick('executionAutoInstallDependencies'),
      DEFAULTS.executionAutoInstallDependencies,
    ),
    executionCommandTimeoutMs: clamp(
      pick('executionCommandTimeoutMs'),
      1000,
      3600000,
      DEFAULTS.executionCommandTimeoutMs,
    ),
    executionMaxCapturedOutputBytes: clamp(
      pick('executionMaxCapturedOutputBytes'),
      1024,
      268435456,
      DEFAULTS.executionMaxCapturedOutputBytes,
    ),

    storageDir: String(pick('storageDir') || ''),
    projectRoot: String(pick('projectRoot') || ''),
    requireDetectedProject: bool(pick('requireDetectedProject'), DEFAULTS.requireDetectedProject),
    blockMutatingToolsWhileBlocked: bool(
      pick('blockMutatingToolsWhileBlocked'),
      DEFAULTS.blockMutatingToolsWhileBlocked,
    ),
    maxObservedToolResults: clamp(pick('maxObservedToolResults'), 10, 2000, DEFAULTS.maxObservedToolResults),

    snapshotMaxFileBytes: clamp(pick('snapshotMaxFileBytes'), 1024, 134217728, DEFAULTS.snapshotMaxFileBytes),
    snapshotMaxFiles: clamp(pick('snapshotMaxFiles'), 1, 20000, DEFAULTS.snapshotMaxFiles),
    reportMaxBytes: clamp(pick('reportMaxBytes'), 1024, 268435456, DEFAULTS.reportMaxBytes),

    flakeRerunEnabled: bool(pick('flakeRerunEnabled'), DEFAULTS.flakeRerunEnabled),
    flakeRerunMaxFiles: clamp(pick('flakeRerunMaxFiles'), 1, 50, DEFAULTS.flakeRerunMaxFiles),

    mutatingToolNames: String(pick('mutatingToolNames') ?? DEFAULTS.mutatingToolNames),
    mutatingTools: String(pick('mutatingToolNames') ?? DEFAULTS.mutatingToolNames)
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== ''),
  })
}
