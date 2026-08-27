/**
 * Which accounts may be issued an Agent Passport (#2138, epic #1440).
 *
 * > **Owner decision, 2026-08-27, recorded verbatim:** *"we should not support
 * > issuance on legacy rails."*
 *
 * An **allowlist**, deliberately: a rail must opt in to being passport-eligible
 * rather than inherit eligibility by default. A future rail that nobody
 * remembers to classify is then refused, not silently issued — the fail-closed
 * direction for a credential that attests governance.
 *
 * ## Why `account_type` is an OR and not an AND
 *
 * `issuance.ts` already treats `execution_rail === 'delegation'` and
 * `account_type === 'delegator_hybrid'` as the same question when it decides
 * whether to derive the agent's smart-account address. A hybrid account is not
 * legacy by any reading, so refusing one because its rail string disagreed
 * would be a false refusal of a live account. Either marker qualifies.
 *
 * ## What "null rail" actually means
 *
 * `user_safes.execution_rail` is **NOT NULL** with default `'allowance_module'`,
 * and its CHECK admits exactly `allowance_module | session_key | delegation`
 * (migrations 036/041). So null never appears in the column — it appears from
 * the LEFT JOIN when an agent has **no bound account at all** (`agents.safe_id`
 * is nullable). #2138 described null as "the legacy population"; the truer
 * statement is that the column's DEFAULT is the legacy rail. Both are refused
 * here either way, so the distinction does not change behaviour — only the
 * reason a reader should give for it.
 *
 * ## One source, two languages
 *
 * The predicate and the SQL below must agree, and nothing in the type system
 * makes them. `__tests__/passport-rail-eligibility.test.ts` asserts they agree
 * across the column's whole CHECK domain, read from the migration rather than
 * restated — the drift guard, since a hand-kept second copy is exactly what
 * #2110 found rotting on the passport surface.
 */

/** The only `execution_rail` value that may receive a passport. */
export const PASSPORT_ISSUABLE_RAIL = 'delegation'

/** The account type that qualifies independently of the rail string. */
export const PASSPORT_ISSUABLE_ACCOUNT_TYPE = 'delegator_hybrid'

/**
 * SQL predicate over a `user_safes` alias. Kept beside the TypeScript one so a
 * reader cannot find one without the other.
 *
 * @param alias the `user_safes` alias in the surrounding query
 */
export function passportIssuableRailSql(alias: string): string {
  return `(${alias}.execution_rail = '${PASSPORT_ISSUABLE_RAIL}' OR ${alias}.account_type = '${PASSPORT_ISSUABLE_ACCOUNT_TYPE}')`
}

/**
 * True when this account may be issued a passport. Both markers null — an agent
 * with **no bound account at all** — is false, which is the fail-closed answer.
 */
export function isPassportIssuableAccount(
  executionRail: string | null | undefined,
  accountType: string | null | undefined,
): boolean {
  return executionRail === PASSPORT_ISSUABLE_RAIL || accountType === PASSPORT_ISSUABLE_ACCOUNT_TYPE
}

/**
 * Whether the account is bound at all. Both columns are NOT NULL in
 * `user_safes`, so they are null together — only when the LEFT JOIN misses.
 *
 * Callers use this to pick the more USEFUL refusal. An agent with no account
 * has no rail either, so the rail gate would fire first and report "this
 * account is on 'none'" — true, but a symptom. "No bound treasury account" is
 * the root cause, and the outcome is identical (refused) either way, so
 * ordering costs nothing and buys a better message.
 */
export function hasBoundAccount(
  executionRail: string | null | undefined,
  accountType: string | null | undefined,
): boolean {
  return executionRail != null || accountType != null
}

/** Operator- and caller-facing reason, one wording for every refusal site. */
export function passportRailRefusalReason(executionRail: string | null | undefined): string {
  const rail = executionRail ?? 'none'
  return (
    `Agent Passports are issued on the delegation rail only — this account is on '${rail}'. ` +
    'The legacy AllowanceModule rail and the Smart Sessions rail are retired ' +
    '(#1440, #834) and cannot transact, so a passport attesting on-chain-enforced ' +
    'controls would assert a control that cannot be exercised.'
  )
}
