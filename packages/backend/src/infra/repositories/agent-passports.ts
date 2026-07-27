/**
 * Data access for `agent_passports` (#972, epic #970).
 *
 * First inhabitant of `infra/repositories/` — the home the module-boundary rules
 * already designate for SQL (`pg-only-in-infra`, see
 * `docs/architecture/10-module-boundaries.md` rule 3). The dependency gate
 * refused to let #972's new code reach the pool directly, which is the ratchet
 * working: existing debt stays baselined, new code complies.
 *
 * This adopts the convention #985 will generalise across the backend:
 *
 * - every function accepts an explicit `executor` LAST, so callers can compose
 *   within a transaction — but it DEFAULTS to the pool, because rule 3 says only this
 *   directory may import `db.ts`. Passing the pool in from a caller would have
 *   meant the caller importing it, which is the very thing the rule forbids;
 * - returns are domain-shaped, not raw `pg` rows;
 * - **tenant scoping is a required parameter, never defaulted.** A repository
 *   function callable without its scope is a privilege-escalation bug waiting
 *   for its first careless caller — see the ADR's "rules that are security
 *   properties, not style".
 */

import type { QueryResult, QueryResultRow } from 'pg'
import pool from '../../db.js'

/**
 * Anything that can run a query: the app's `db.ts` default export, a raw
 * `pg.Pool`, or a `PoolClient` inside a transaction.
 *
 * Structural rather than `Pool | PoolClient` because `db.ts` exports a thin
 * wrapper, not a `pg.Pool`. Typing the capability instead of the concrete class
 * is also what lets a caller pass a transaction client — the point of taking an
 * explicit executor in the first place.
 */
export interface Executor {
  query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>
}

export type PassportStatus = 'pending' | 'anchored' | 'failed'

/** Progress of the EAS ANCHOR only — never the authority on standing (#973). */
export type RevocationStatus = 'none' | 'pending' | 'confirmed'

export interface PassportRow {
  agent_id: string
  chain_id: number
  status: PassportStatus
  assurance_level: number
  attestation_uid: string | null
  tx_hash: string | null
  attempts: number
  last_error: string | null
  requested_at: Date
  anchored_at: Date | null
  revocation_status: RevocationStatus
  revocation_requested_at: Date | null
  revocation_confirmed_at: Date | null
  revocation_tx_hash: string | null
  revocation_attempts: number
  revocation_last_error: string | null
  revocation_next_attempt_at: Date | null
}

/** Facts the attestation claim is built from. Owner-scoped. */
export interface AgentPassportFacts {
  delegate_address: string | null
  chain_id: number | null
  /** The TREASURY the agent spends from — not the agent's own smart account. */
  safe_address: string | null
  account_type: string | null
  execution_rail: string | null
}

export async function findByAgent(agentId: string, db: Executor = pool): Promise<PassportRow | null> {
  const { rows } = await db.query<PassportRow>(
    `SELECT agent_id, chain_id, status, assurance_level, attestation_uid, tx_hash,
            attempts, last_error, requested_at, anchored_at,
            revocation_status, revocation_requested_at, revocation_confirmed_at,
            revocation_tx_hash, revocation_attempts, revocation_last_error,
            revocation_next_attempt_at
       FROM agent_passports WHERE agent_id = $1`,
    [agentId],
  )
  return rows[0] ?? null
}

/**
 * Agent facts for issuance. `userId` is REQUIRED — this is the tenant scope,
 * and an unscoped variant of this query must never exist.
 */
export async function findAgentFacts(
  agentId: string,
  userId: string,
  db: Executor = pool,
): Promise<AgentPassportFacts | null> {
  const { rows } = await db.query<AgentPassportFacts>(
    `SELECT a.delegate_address, s.chain_id, s.safe_address, s.account_type, s.execution_rail
       FROM agents a
       LEFT JOIN user_safes s ON s.id = a.safe_id
      WHERE a.id = $1 AND a.user_id = $2`,
    [agentId, userId],
  )
  return rows[0] ?? null
}

/**
 * Atomically claim the right to anchor. Returns true for exactly ONE caller.
 *
 * `ON CONFLICT DO NOTHING` on insert prevents a second passport ROW, but not a
 * second on-chain ATTESTATION — anchoring takes seconds (staticCall + attest +
 * wait), and a plain read-then-branch lets two callers both observe 'pending'
 * and both submit. The relayer would pay twice and we could track only one UID,
 * leaving a real, revocable attestation permanently invisible to Haven.
 *
 * A claim older than the stale window is reclaimable so a crashed attempt
 * recovers instead of wedging the passport forever.
 */
export async function claimForAnchoring(
  agentId: string,
  staleAfterSeconds = 600,
  db: Executor = pool,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE agent_passports
        SET anchoring_started_at = NOW(), attempts = attempts + 1, updated_at = NOW()
      WHERE agent_id = $1
        AND status <> 'anchored'
        AND (anchoring_started_at IS NULL
             OR anchoring_started_at < NOW() - MAKE_INTERVAL(secs => $2))`,
    [agentId, staleAfterSeconds],
  )
  return (rowCount ?? 0) > 0
}

/**
 * The agent's bound chain AND its status, owner-scoped. Null row = not this
 * user's agent.
 *
 * `status` rides along because every caller that decides whether to ISSUE a
 * passport needs it: minting a fresh attestation for a revoked agent is
 * exactly the divergence #973 exists to prevent, and a separate lookup would
 * be one a caller could forget.
 */
export async function findAgentChain(
  agentId: string,
  userId: string,
  db: Executor = pool,
): Promise<{ chain_id: number | null; status: string } | null> {
  const { rows } = await db.query<{ chain_id: number | null; status: string }>(
    `SELECT s.chain_id, a.status
       FROM agents a
       LEFT JOIN user_safes s ON s.id = a.safe_id
      WHERE a.id = $1 AND a.user_id = $2`,
    [agentId, userId],
  )
  return rows[0] ?? null
}

/** Record the intent. Returns false when a passport already exists (idempotent). */
export async function insertRequested(
  agentId: string,
  chainId: number,
  assuranceLevel: number,
  db: Executor = pool,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO agent_passports (agent_id, chain_id, status, assurance_level)
     VALUES ($1, $2, 'pending', $3)
     ON CONFLICT (agent_id) DO NOTHING`,
    [agentId, chainId, assuranceLevel],
  )
  return (rowCount ?? 0) > 0
}

/**
 * Record the anchor, INCLUDING the addresses that were attested (#974).
 *
 * The addresses are stored, not re-derived later, for two reasons: the Hybrid
 * account address is derived one-way from the EOA so there is no reverse
 * lookup without it, and a receipt must report what was actually attested
 * rather than a fresh derivation that could silently disagree with the chain.
 *
 * Takes the anchor facts as ONE object rather than a growing positional list:
 * the previous shape put `addresses` between `txHash` and the trailing
 * `db: Executor`, so the next caller needing a transaction client had to know
 * a new slot had appeared in the middle. A named object cannot be mis-slotted.
 *
 * The zero-address sentinel is an EAS ENCODING detail and is mapped to NULL
 * here — see migration 051. Storing it would collide every EOA-only agent on
 * one "address" in the verifier's lookup.
 */
export async function markAnchored(
  agentId: string,
  anchor: {
    attestationUid: string
    txHash: string
    agentEoa: string | null
    smartAccount: string | null
  },
  db: Executor = pool,
): Promise<void> {
  const { attestationUid, txHash } = anchor
  const addresses = anchor
  await db.query(
    `UPDATE agent_passports
        SET status = 'anchored', attestation_uid = $2, tx_hash = $3,
            agent_eoa = $4, smart_account = $5,
            last_error = NULL, anchored_at = NOW(), updated_at = NOW()
      WHERE agent_id = $1`,
    [agentId, attestationUid, txHash, normalizeAddress(addresses.agentEoa), normalizeAddress(addresses.smartAccount)],
  )
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** Lowercase, with the zero-address sentinel mapped to NULL. */
function normalizeAddress(address: string | null | undefined): string | null {
  if (!address) return null
  const lower = address.toLowerCase()
  return lower === ZERO_ADDRESS ? null : lower
}

export async function markFailed(agentId: string, error: string, db: Executor = pool): Promise<void> {
  // Truncated: a provider error can be enormous and this column is for humans.
  // `attempts` is incremented by claimForAnchoring, not here — otherwise a
  // pre-claim failure (no treasury, unregistered schema) would double-count.
  // Clearing the claim makes the passport immediately retryable.
  await db.query(
    `UPDATE agent_passports
        SET status = 'failed', anchoring_started_at = NULL,
            last_error = $2, updated_at = NOW()
      WHERE agent_id = $1`,
    [agentId, error.slice(0, 500)],
  )
}

/** Non-anchored passports with their owning user, oldest first — the retry sweep. */
export async function listRetryable(
  limit: number,
  db: Executor = pool,
): Promise<Array<{ agent_id: string; user_id: string }>> {
  const { rows } = await db.query<{ agent_id: string; user_id: string }>(
    `SELECT p.agent_id, a.user_id
       FROM agent_passports p
       JOIN agents a ON a.id = p.agent_id
      WHERE p.status <> 'anchored'
      ORDER BY p.requested_at ASC
      LIMIT $1`,
    [limit],
  )
  return rows
}


// ── Verification lookups (#974) ─────────────────────────────────────
//
// Merchant-facing and therefore NOT owner-scoped — a merchant verifying an
// agent is not its owner. The `SELECT` list is the disclosure boundary: it
// carries no owner identity, no budgets, no balances, and no counterparties.

export interface VerificationRow {
  agent_id: string
  agent_status: string
  /**
  * When the agent's RECORD last changed — the receipt's monotonic epoch.
  *
  * Sourced from `agents.updated_at`, which moves only when a statement sets it
  * explicitly — there is no trigger. A rename and a key rotation do; the
  * `last_seen_at` touch in agentAuth does not. It is deliberately NOT named
  * `standing_changed_at` (#1015): that alias asserted a precision the column
  * does not carry, and propagated it through this type to every call site.
  * A change here does NOT imply the agent's standing changed.
  */
  record_updated_at: Date
  /**
  * The passport's stored assurance level (#975). READ, never assumed — the
  * verifier used to hardcode L0, which is correct only while the
  * `agent_passport_level_issuable` CHECK pins the column to 0. The ladder
  * exists so later tiers need no re-architecture; a verifier that hardcodes
  * the field the ladder communicates is exactly that re-architecture.
  */
  assurance_level: number
  passport_status: PassportStatus | null
  attestation_uid: string | null
  revocation_status: RevocationStatus | null
  revocation_confirmed_at: Date | null
  agent_eoa: string | null
  smart_account: string | null
  chain_id: number | null
  execution_rail: string | null
  /** Presence only — the verifier reports "treasury-bound", never the address. */
  safe_address: string | null
}

/**
 * The verifier resolves ANCHORED passports only — owner decision 2026-07-26.
 *
 * `p.status = 'anchored'` is the disclosure boundary, and it is stated here
 * rather than left to emerge. Today `markAnchored` writes `agent_eoa`,
 * `smart_account` and `attestation_uid` in the SAME statement that sets
 * `status = 'anchored'`, so a pending or failed row has NULLs in every lookup
 * column and cannot be found anyway. That is an accident of write ordering, not
 * a rule: the day someone records the addresses at request time — to show a
 * "passport pending" state, say — an unauthenticated endpoint would quietly
 * begin confirming that an address belongs to a Haven customer *before*
 * anything about it is public on-chain.
 *
 * With the filter explicit, the endpoint's disclosure has a line that can be
 * stated in one sentence: **the verifier only speaks about passports that are
 * already public on-chain.** Everything it reveals about an agent's existence
 * is readable from the EAS attestation by anyone. Live standing goes further
 * than the chain — that is the entire product, and #973's whole point — but it
 * now does so only for agents whose attestation is already published.
 *
 * A non-anchored passport returns the same `no_passport` as no passport at all.
 * Distinguishing "pending" from "none" would leak precisely what this filter
 * exists to withhold.
 */
const VERIFICATION_SELECT = `
  SELECT a.id AS agent_id, a.status AS agent_status, a.updated_at AS record_updated_at,
         p.assurance_level, p.status AS passport_status, p.attestation_uid,
         p.revocation_status, p.revocation_confirmed_at,
         p.agent_eoa, p.smart_account, p.chain_id,
         s.execution_rail, s.safe_address
    FROM agent_passports p
    JOIN agents a ON a.id = p.agent_id
    LEFT JOIN user_safes s ON s.id = a.safe_id
   WHERE p.status = 'anchored'`

/**
 * Resolve a passport from EITHER agent address.
 *
 * A merchant sees a different address depending on how the payment settled —
 * the delegate EOA on an EIP-3009 header, the Hybrid account in erc7710
 * redemption (#946 made that a per-payment choice) — and must be able to
 * verify from whichever one it holds.
 *
 * The zero address is refused BEFORE the query. Migration 050 already prevents
 * storing it, but the sentinel is dangerous enough to be rejected at every
 * layer that could ever handle it: a lookup by `0x0` resolving to any passport
 * would hand a merchant somebody else's credential.
 */
export const FIND_BY_AGENT_ADDRESS_SQL = `${VERIFICATION_SELECT}
    AND (p.agent_eoa = $1 OR p.smart_account = $1)
  LIMIT 1`

export async function findByAgentAddress(
  address: string,
  db: Executor = pool,
): Promise<VerificationRow | null> {
  const normalized = normalizeAddress(address)
  if (!normalized) return null
  const { rows } = await db.query<VerificationRow>(FIND_BY_AGENT_ADDRESS_SQL, [normalized])
  return rows[0] ?? null
}

export const FIND_BY_ATTESTATION_UID_SQL = `${VERIFICATION_SELECT}
    AND p.attestation_uid = $1
  LIMIT 1`

/** Resolve a passport by its EAS attestation UID — the evidence pointer. */
export async function findByAttestationUid(
  attestationUid: string,
  db: Executor = pool,
): Promise<VerificationRow | null> {
  const { rows } = await db.query<VerificationRow>(FIND_BY_ATTESTATION_UID_SQL, [attestationUid])
  return rows[0] ?? null
}

// ── Revocation (#973) ───────────────────────────────────────────────
//
// The DB is authoritative for standing; these functions track only how far the
// on-chain ANCHOR has got. Nothing here may gate the answer to "is this agent
// authorized right now?" — see `standingForAgent`.

/**
 * Agent standing, joined with anchor progress. The ONE query the verifier
 * (#974) reads, so the authority relationship is expressed in a single place:
 * `agent_status` decides, the passport columns merely describe the anchor.
 *
 * Deliberately NOT owner-scoped: a merchant verifying a passport is not the
 * agent's owner. It is keyed by the agent's own id and returns no PII, no
 * credentials, and no treasury detail — only what a verifier needs.
 */
export interface AgentStanding {
  agent_id: string
  agent_status: string
  passport_status: PassportStatus | null
  attestation_uid: string | null
  revocation_status: RevocationStatus | null
  revocation_confirmed_at: Date | null
}

export async function standingForAgent(
  agentId: string,
  db: Executor = pool,
): Promise<AgentStanding | null> {
  const { rows } = await db.query<AgentStanding>(
    `SELECT a.id AS agent_id, a.status AS agent_status,
            p.status AS passport_status, p.attestation_uid,
            p.revocation_status, p.revocation_confirmed_at
       FROM agents a
       LEFT JOIN agent_passports p ON p.agent_id = a.id
      WHERE a.id = $1`,
    [agentId],
  )
  return rows[0] ?? null
}

/**
 * Mark the anchor as needing revocation. Idempotent, and deliberately a no-op
 * unless the passport is actually anchored — there is nothing on-chain to
 * revoke otherwise, and inventing a pending revocation would make the
 * reconciliation sweep chase a row forever.
 */
export async function enqueueRevocation(agentId: string, db: Executor = pool): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE agent_passports
        SET revocation_status = 'pending',
            revocation_requested_at = COALESCE(revocation_requested_at, NOW()),
            revocation_next_attempt_at = NOW(),
            updated_at = NOW()
      WHERE agent_id = $1
        AND status = 'anchored'
        AND revocation_status = 'none'`,
    [agentId],
  )
  return (rowCount ?? 0) > 0
}

/**
 * Atomically claim the right to submit a revoke, leasing the row for
 * `leaseSeconds`. Exactly one caller wins.
 *
 * This is the SINGLE gate on submitting a revoke, and it encodes the whole
 * precondition rather than just a lock:
 *
 * - `a.status = 'revoked'` — the INVARIANT. Because the agent's own status is
 *   checked here, a caller cannot submit a revoke for a live agent even by
 *   mistake, and the anchor-completion hook can call this unconditionally.
 * - `status = 'anchored'` and not already confirmed — there must be something
 *   on-chain left to revoke.
 * - the lease — without it the fire-and-forget call and the sweep can both
 *   read 'pending' and both submit revoke(). EAS reverts on a second revoke
 *   (`AlreadyRevoked`), so the loser burns gas and then reverts on every
 *   backoff cycle forever, never converging.
 *
 * The lease reuses `revocation_next_attempt_at` rather than adding a column:
 * pushing it into the future IS the claim, and a crashed holder is reclaimed
 * when the lease expires. It also normalises `revocation_status` to 'pending'
 * so an agent revoked mid-anchor (never enqueued) is adopted by the sweep.
 */
export const CLAIM_REVOCATION_SQL = `UPDATE agent_passports p
        SET revocation_status = 'pending',
            revocation_requested_at = COALESCE(p.revocation_requested_at, NOW()),
            revocation_next_attempt_at = NOW() + MAKE_INTERVAL(secs => $2),
            updated_at = NOW()
       FROM agents a
      WHERE a.id = p.agent_id
        AND p.agent_id = $1
        AND a.status = 'revoked'
        AND p.status = 'anchored'
        AND p.revocation_status <> 'confirmed'
        AND (p.revocation_next_attempt_at IS NULL OR p.revocation_next_attempt_at <= NOW())`

export async function claimRevocation(
  agentId: string,
  leaseSeconds = 300,
  db: Executor = pool,
): Promise<boolean> {
  const { rowCount } = await db.query(CLAIM_REVOCATION_SQL, [agentId, leaseSeconds])
  return (rowCount ?? 0) > 0
}

export async function markRevocationConfirmed(
  agentId: string,
  txHash: string,
  db: Executor = pool,
): Promise<void> {
  await db.query(
    `UPDATE agent_passports
        SET revocation_status = 'confirmed', revocation_tx_hash = $2,
            revocation_confirmed_at = NOW(), revocation_last_error = NULL,
            revocation_next_attempt_at = NULL, updated_at = NOW()
      WHERE agent_id = $1`,
    [agentId, txHash],
  )
}

/**
 * Record a failed anchor attempt and schedule the next one.
 *
 * Stays `pending` — never `failed`. The owner decision is that revocation
 * retries until the DB and chain agree, so there is no terminal failure state
 * to get stuck in; a struggling revoke stays visible and due instead.
 */
export async function scheduleRevocationRetry(
  agentId: string,
  error: string,
  backoffSeconds: number,
  db: Executor = pool,
): Promise<void> {
  await db.query(
    `UPDATE agent_passports
        SET revocation_attempts = revocation_attempts + 1,
            revocation_last_error = $2,
            revocation_next_attempt_at = NOW() + MAKE_INTERVAL(secs => $3),
            updated_at = NOW()
      WHERE agent_id = $1`,
    [agentId, error.slice(0, 500), backoffSeconds],
  )
}

/**
 * Revocations due for another attempt.
 *
 * Defined by the INVARIANT — "the agent is revoked but its anchor is not
 * confirmed" — rather than by `revocation_status = 'pending'`. That difference
 * is load-bearing: an agent revoked WHILE its passport was still anchoring
 * never got enqueued (the enqueue guard requires an anchored row), so a
 * flag-based queue would miss it forever and the attestation would stay live
 * on-chain. Keying off the invariant makes that case self-healing.
 */
export const LIST_REVOCATIONS_DUE_SQL = `SELECT p.agent_id, p.revocation_attempts
       FROM agent_passports p
       JOIN agents a ON a.id = p.agent_id
      WHERE p.status = 'anchored'
        AND a.status = 'revoked'
        AND p.revocation_status <> 'confirmed'
        AND (p.revocation_next_attempt_at IS NULL OR p.revocation_next_attempt_at <= NOW())
      ORDER BY COALESCE(p.revocation_requested_at, p.anchored_at) ASC
      LIMIT $1`

export async function listRevocationsDue(
  limit: number,
  db: Executor = pool,
): Promise<Array<{ agent_id: string; revocation_attempts: number }>> {
  const { rows } = await db.query<{ agent_id: string; revocation_attempts: number }>(
    LIST_REVOCATIONS_DUE_SQL,
    [limit],
  )
  return rows
}

/**
 * Revocations unreconciled past a threshold — the stuck-revoke alarm.
 *
 * Same invariant-based definition as the due-list, and for the same reason: a
 * flag-based scan (`revocation_status = 'pending'`) is BLIND to an agent
 * revoked mid-anchor, which is precisely the case most likely to strand a live
 * attestation. The alarm must see every divergence, not only the enqueued ones.
 *
 * A stuck revoke is an operational incident: merchants checking only the chain
 * still see the agent as valid.
 */
export const LIST_STUCK_REVOCATIONS_SQL = `SELECT p.agent_id, p.revocation_requested_at, p.revocation_attempts, p.revocation_last_error
       FROM agent_passports p
       JOIN agents a ON a.id = p.agent_id
      WHERE p.status = 'anchored'
        AND a.status = 'revoked'
        AND p.revocation_status <> 'confirmed'
        AND COALESCE(p.revocation_requested_at, p.anchored_at) < NOW() - MAKE_INTERVAL(secs => $1)
      ORDER BY COALESCE(p.revocation_requested_at, p.anchored_at) ASC`

export async function listStuckRevocations(
  olderThanSeconds: number,
  db: Executor = pool,
): Promise<Array<{ agent_id: string; revocation_requested_at: Date | null; revocation_attempts: number; revocation_last_error: string | null }>> {
  const { rows } = await db.query<{
    agent_id: string
    revocation_requested_at: Date | null
    revocation_attempts: number
    revocation_last_error: string | null
  }>(LIST_STUCK_REVOCATIONS_SQL, [olderThanSeconds])
  return rows
}
