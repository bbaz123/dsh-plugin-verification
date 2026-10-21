/**
 * Durable task state, the evidence store, and the task error ledger.
 *
 * Everything here lives under the plugin's OWN storage directory
 * (`storageDir`, default `$DSH_HOME/storages/verification-gate`), never inside
 * the verified project: a project's build, a test run, or the Agent's own edits
 * must not be able to overwrite the evidence that judges them (§9.2).
 *
 * The one behavioural rule worth stating loudly is the fail-closed read: a task
 * state file that exists but cannot be read or parsed is an ERROR, not an empty
 * task. Treating "I could not read the state" as "there is no state" would let a
 * corrupt file silently release a blocked task — the fail-open shape recorded
 * in `viking://~/memories/experiences/安全状态读取失败被当成空导致fail-open.md`.
 *
 * @module dsh-plugin-verification/store
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { TASK_STATE } from './protocol.js'

/** Lowercase hex sha256 of a string or buffer. */
export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** A short, human-comparable hash prefix. */
export function shortHash(value, length = 12) {
  return sha256Hex(value).slice(0, length)
}

/**
 * Stable JSON for hashing: object keys are sorted at every depth, so two shapes
 * describing the same thing hash identically.
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

/** Hash a composite fingerprint from named parts. */
export function compositeFingerprint(parts) {
  return `sha256:${sha256Hex(stableStringify(parts))}`
}

/** Read the byte size of a file, or undefined when it does not exist. */
export function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The evidence store of one task.
 *
 * Records are appended, never replaced: a later round adds new evidence with a
 * new id, and old records keep their own validity, which is what makes "which
 * round fixed what, and what did it break" answerable (§5.1).
 */
export class EvidenceStore {
  constructor(records = []) {
    /** @type {Map<string, object>} */
    this.records = new Map()
    for (const record of records) this.records.set(record.id, record)
  }

  /** Append one record and return it. */
  add(record) {
    this.records.set(record.id, record)
    return record
  }

  /** Look one record up by id. */
  get(id) {
    return this.records.get(id)
  }

  /** Every record, insertion ordered. */
  list() {
    return [...this.records.values()]
  }

  /** Records of one stage. */
  byStage(stage) {
    return this.list().filter((record) => record.stage === stage)
  }

  /** The most recent valid record for a stage, if any. */
  latestValid(stage) {
    const candidates = this.byStage(stage).filter((record) => record.validity === 'valid')
    return candidates.length > 0 ? candidates[candidates.length - 1] : undefined
  }

  /**
   * Mark every record produced for an earlier workspace fingerprint as `stale`.
   *
   * Called whenever a new mutation is observed. Stale records are kept — they
   * are the history of the round — but they can no longer ground a blocking
   * finding, because §11 requires "测试后源码再次改变" to invalidate the old
   * evidence rather than quietly reuse it.
   *
   * @param currentFingerprint - the workspace fingerprint now.
   * @returns the number of records invalidated.
   */
  invalidateStale(currentFingerprint) {
    let invalidated = 0
    for (const [id, record] of this.records) {
      if (record.validity === 'valid' && record.workspaceFingerprint !== null && record.workspaceFingerprint !== currentFingerprint) {
        this.records.set(id, { ...record, validity: 'stale' })
        invalidated += 1
      }
    }
    return invalidated
  }

  /** A resolver suitable for `authorizeFinding`. */
  resolver() {
    return (id) => this.records.get(id)
  }

  /** JSON-safe snapshot. */
  toJSON() {
    return { records: this.list() }
  }

  /** Rebuild from {@link toJSON}. */
  static fromJSON(data) {
    return new EvidenceStore(Array.isArray(data?.records) ? data.records : [])
  }
}

/** One ledger entry: a confirmed problem of THIS task and its handling. */
export function makeLedgerEntry(input) {
  return {
    id: input.id ?? `ledger_${randomUUID().slice(0, 8)}`,
    taskId: input.taskId,
    cycle: input.cycle ?? 1,
    stage: input.stage,
    kind: input.kind,
    summary: input.summary,
    findingIds: input.findingIds ?? [],
    evidenceIds: input.evidenceIds ?? [],
    failureFingerprint: input.failureFingerprint ?? null,
    repairId: input.repairId ?? null,
    status: input.status ?? 'open',
    resolutionEvidenceIds: input.resolutionEvidenceIds ?? [],
    notes: input.notes ?? '',
    recordedAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/**
 * The task error ledger.
 *
 * It answers the two questions the Repair Coordinator needs before it releases
 * a repair: has this exact failure been seen in this task before, and was it
 * resolved? A repeated fingerprint with no resolved entry is the "no progress"
 * signal that stops the loop early (§7.6).
 */
export class TaskErrorLedger {
  constructor(entries = []) {
    this.entries = new Map()
    for (const entry of entries) this.entries.set(entry.id, entry)
  }

  /** Append one entry. */
  record(entry) {
    this.entries.set(entry.id, entry)
    return entry
  }

  /** Every entry, insertion ordered. */
  list() {
    return [...this.entries.values()]
  }

  /** Open (unresolved) entries. */
  open() {
    return this.list().filter((entry) => entry.status !== 'resolved')
  }

  /** Entries that carry the same failure fingerprint. */
  byFingerprint(fingerprint) {
    if (!fingerprint) return []
    return this.list().filter((entry) => entry.failureFingerprint === fingerprint)
  }

  /**
   * How many times this failure fingerprint has already been recorded and
   * repaired without being resolved — the no-progress counter.
   *
   * Entries the user explicitly released are excluded: choosing to continue is
   * a decision, not another silent attempt.
   */
  attemptsFor(fingerprint) {
    return this.byFingerprint(fingerprint).filter((entry) => entry.status !== 'released').length
  }

  /**
   * Release every open entry with one fingerprint.
   *
   * Used only when the user explicitly asks the gate to continue past a block.
   * The entries stay in the ledger with `status: 'released'`, so the audit trail
   * keeps the fact that the loop stopped and that it was overridden.
   */
  release(fingerprint, note = '') {
    let released = 0
    for (const [id, entry] of this.entries) {
      if (entry.status === 'resolved' || entry.status === 'released') continue
      if (fingerprint !== null && entry.failureFingerprint !== fingerprint) continue
      this.entries.set(id, { ...entry, status: 'released', notes: note || entry.notes, updatedAt: Date.now() })
      released += 1
    }
    return released
  }

  /** Mark one entry resolved against evidence from the re-run. */
  resolve(id, { evidenceIds = [], notes = '' } = {}) {
    const entry = this.entries.get(id)
    if (entry === undefined) return undefined
    const updated = {
      ...entry,
      status: 'resolved',
      resolutionEvidenceIds: evidenceIds,
      notes: notes || entry.notes,
      updatedAt: Date.now(),
    }
    this.entries.set(id, updated)
    return updated
  }

  /** JSON-safe snapshot. */
  toJSON() {
    return { entries: this.list() }
  }

  /** Rebuild from {@link toJSON}. */
  static fromJSON(data) {
    return new TaskErrorLedger(Array.isArray(data?.entries) ? data.entries : [])
  }
}

/**
 * The filesystem-backed part of the store.
 *
 * `loadTask` distinguishes three outcomes deliberately:
 *   - `{ ok: true, state: null }`  → no state file: a genuinely new task.
 *   - `{ ok: true, state }`        → a state file that parsed.
 *   - `{ ok: false, error }`       → a file that exists but cannot be trusted.
 * The caller must fail CLOSED on the third: never create a fresh task over it.
 */
export class TaskStore {
  /**
   * @param options - `{ dir }` (the plugin storage root).
   */
  constructor({ dir }) {
    this.dir = dir
    this.tasksDir = join(dir, 'tasks')
    this.reportsDir = join(dir, 'reports')
    this.snapshotsDir = join(dir, 'snapshots')
    this.log = []
  }

  /** The directory one task owns. */
  taskDir(taskId) {
    const safe = sha256Hex(taskId).slice(0, 16)
    return join(this.tasksDir, safe)
  }

  /** Path of a task's state file. */
  statePath(taskId) {
    return join(this.taskDir(taskId), 'state.json')
  }

  /** Ensure the plugin's storage tree exists. */
  async init() {
    await mkdir(this.tasksDir, { recursive: true })
    await mkdir(this.reportsDir, { recursive: true })
    await mkdir(this.snapshotsDir, { recursive: true })
  }

  /**
   * Read one task's state. See the class comment: a broken file is an error.
   *
   * @param taskId - the task identity.
   * @returns `{ ok, state?, error? }`.
   */
  async loadTask(taskId) {
    const path = this.statePath(taskId)
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return { ok: true, state: null }
      return { ok: false, error: `state file unreadable: ${error instanceof Error ? error.message : String(error)}` }
    }
    const parsed = safeJsonParse(text)
    if (!parsed.ok) return { ok: false, error: `state file is not valid JSON: ${parsed.error}` }
    if (parsed.value === null || typeof parsed.value !== 'object' || typeof parsed.value.taskId !== 'string') {
      return { ok: false, error: 'state file does not describe a verification task' }
    }
    return { ok: true, state: parsed.value }
  }

  /** Atomically write one task's state. */
  async saveTask(state) {
    const path = this.statePath(state.taskId)
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
    await rename(tmp, path)
    return path
  }

  /** Directory for one task's raw execution reports. */
  reportDir(taskId, runId) {
    return join(this.reportsDir, sha256Hex(taskId).slice(0, 16), runId)
  }

  /** Directory for one task's baseline material. */
  snapshotDir(taskId, cycle) {
    return join(this.snapshotsDir, sha256Hex(taskId).slice(0, 16), `cycle-${cycle}`)
  }

  /** Write a bounded raw report and return its path. */
  async writeReport(path, text, maxBytes) {
    await mkdir(dirname(path), { recursive: true })
    const body = typeof text === 'string' ? text : String(text ?? '')
    const truncated = Buffer.byteLength(body, 'utf8') > maxBytes
    const stored = truncated ? body.slice(0, maxBytes) : body
    await writeFile(path, stored, 'utf8')
    return { path, bytes: Buffer.byteLength(stored, 'utf8'), truncated }
  }

  /** Read a previously written report, failing closed on a broken file. */
  async readReport(path) {
    try {
      return { ok: true, text: await readFile(path, 'utf8') }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

/**
 * Create the in-memory half of one task's state.
 *
 * @param input - identity and initial fingerprints.
 * @returns a fresh task state (the shape persisted by {@link TaskStore}).
 */
export function createTaskState(input) {
  return {
    schemaVersion: input.schemaVersion ?? 1,
    taskId: input.taskId,
    sessionId: input.sessionId,
    requirementsRevision: input.requirementsRevision ?? 1,
    requirements: input.requirements ?? [],
    state: TASK_STATE.WORKING,
    baselineFingerprint: input.baselineFingerprint ?? null,
    workspaceFingerprint: input.workspaceFingerprint ?? null,
    environmentFingerprint: input.environmentFingerprint ?? null,
    policyFingerprint: input.policyFingerprint ?? null,
    baseline: input.baseline ?? null,
    cycle: 0,
    maxRepairCycles: input.maxRepairCycles ?? 3,
    change: null,
    memoryQueries: [],
    regression: [],
    assertions: [],
    review: null,
    ledger: [],
    evidence: [],
    finalization: { status: 'pending', attempts: 0, readback: null, notes: '' },
    blockedReason: null,
    observedToolResults: [],
    // Which project this task is actually about, and how it was chosen. In an
    // aggregate workspace the workspace root is a container, so the verified
    // root is bound to the TASK and must survive a host restart (§4.2).
    activeProjectRoot: null,
    projectResolution: null,
    declineNoticeIssued: false,
    gate: null,
    lastError: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}
