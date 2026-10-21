/**
 * One assertion record.
 *
 * Kept in its own module so `assertion.js` handles only the stage logic and the
 * record shape has exactly one home (the review stage and the status tool read
 * the same fields).
 *
 * @module dsh-plugin-verification/modules/assertion-record
 */

/** The three standing levels an assertion can have. */
export const ASSERTION_AUTHORITY = {
  /** Project tests, confirmed specifications, existing snapshots. */
  AUTHORITATIVE: 'authoritative',
  /** Build, typecheck, or an explicitly configured project rule. */
  MACHINE: 'machine',
  /** A lead: never blocks on its own. */
  ADVISORY: 'advisory',
}

let counter = 0

/**
 * Build one assertion record.
 *
 * @param input - the assertion fields.
 * @returns a frozen assertion.
 */
export function makeAssertion(input) {
  counter += 1
  return Object.freeze({
    id: input.id ?? `assertion_${Date.now().toString(36)}${counter.toString(36)}`,
    source: input.source ?? 'model_expectation',
    authority: input.authority ?? ASSERTION_AUTHORITY.ADVISORY,
    status: input.status ?? 'unknown',
    name: input.name ?? '',
    detail: input.detail ?? '',
    evidenceIds: input.evidenceIds ?? [],
    scope: input.scope ?? '',
    createdAt: Date.now(),
  })
}
