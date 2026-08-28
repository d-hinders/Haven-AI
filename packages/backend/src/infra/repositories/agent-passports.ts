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

import pool from '../../db.js'
import { passportIssuableRailSql } from '../../domain/passport-issuance-rail.js'
import { withTransaction, type Executor } from '../transaction.js'

// Re-exported: `Executor` was declared here first (#972) and several passport
// modules import it from this path. It now lives in `infra/transaction.ts`
// alongside `withTransaction` (#985); this keeps those importers working
// without a rename sweep that would add nothing.
export type { Executor }


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
  /**
   * The delegate EOA the LIVE attestation names — written by `markAnchored`,
   * never re-derived (#974). After a re-key this is the RETIRED key until the
   * re-anchor completes, and that disagreement with `agents.delegate_address`
   * IS the re-anchor queue's invariant (#1699).
   */
  agent_eoa: string | null
  smart_account: string | null
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
  agent_status: string
}

export async function findByAgent(agentId: string, db: Executor = pool): Promise<PassportRow | null> {
  const { rows } = await db.query<PassportRow>(
    `SELECT agent_id, chain_id, status, assurance_level, attestation_uid, tx_hash,
            attempts, last_error, requested_at, anchored_at,
            agent_eoa, smart_account,
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
    `SELECT a.delegate_address, a.status AS agent_status,
            s.chain_id, s.safe_address, s.account_type, s.execution_rail
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


export type ClaimOutcome = 'claimed' | 'not_claimed' | 'eoa_already_bound'

export async function claimForAnchoring(
  agentId: string,
  agentEoa: string,
  staleAfterSeconds = 600,
  db: Executor = pool,
): Promise<ClaimOutcome> {
  // Serialize competing claims for the SAME EOA across different agents
  // (#1042): the route path fires issuance directly while the sweep leader
  // may process another row — without this xact-scoped advisory lock, two
  // concurrent claims for different agents binding the same EOA would both
  // pass the NOT EXISTS below and both anchor. The lock key is the lowercased
  // EOA, so unrelated agents never contend. Runs inside ONE transaction so
  // the lock spans check + claim and releases on commit/rollback.
  const eoa = agentEoa.toLowerCase()
  return withTransaction(db, async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`passport-eoa:${eoa}`])
    const bound = await tx.query(
      `SELECT 1
         FROM agent_passports p2
         JOIN agents a2 ON a2.id = p2.agent_id
        WHERE p2.agent_id <> $1
          AND p2.status = 'anchored'
          AND a2.status <> 'revoked'
          AND LOWER(p2.agent_eoa) = $2
        LIMIT 1`,
      [agentId, eoa],
    )
    if ((bound.rowCount ?? 0) > 0) return 'eoa_already_bound'
    const { rowCount } = await tx.query(
      `UPDATE agent_passports
          SET anchoring_started_at = NOW(), attempts = attempts + 1, updated_at = NOW()
        WHERE agent_id = $1
          AND status <> 'anchored'
          AND (anchoring_started_at IS NULL
               OR anchoring_started_at < NOW() - MAKE_INTERVAL(secs => $2))`,
      [agentId, staleAfterSeconds],
    )
    return (rowCount ?? 0) > 0 ? 'claimed' : 'not_claimed'
  })
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
): Promise<{
  chain_id: number | null
  status: string
  execution_rail: string | null
  account_type: string | null
} | null> {
  // #2138: the rail comes back so the route can refuse a legacy account with a
  // reason, instead of accepting the request and silently never issuing. Both
  // columns are NOT NULL in `user_safes`; they arrive null here only when the
  // LEFT JOIN misses — the agent has no bound account.
  const { rows } = await db.query<{
    chain_id: number | null
    status: string
    execution_rail: string | null
    account_type: string | null
  }>(
    `SELECT s.chain_id, a.status, s.execution_rail, s.account_type
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
/**
 * Non-anchored passports DUE for another attempt (#1043).
 *
 * Backoff mirrors the revocation side (30s doubling to a 1h cap) without a
 * schema change: `updated_at` is bumped by every markFailed, so
 * `updated_at + backoff(attempts)` IS the next-attempt time. The exponent is
 * clamped before POWER so attempts cannot overflow the double. At the 1h cap
 * a stuck row costs at most 24 no-op attempts/day — bounded relayer exposure,
 * and every real attempt is still gas-free until `attest.staticCall` passes.
 *
 * Revoked agents are excluded (#1043 finding 3): anchoring a passport for a
 * revoked agent just to immediately queue its revocation is wasted gas and a
 * transient live credential. Their rows simply stop being due.
 *
 * `attempts` rides along so the sweep can alarm on rows past the attention
 * threshold instead of letting them churn silently.
 */
export async function listRetryable(
  limit: number,
  db: Executor = pool,
): Promise<Array<{ agent_id: string; user_id: string; attempts: number }>> {
  const { rows } = await db.query<{ agent_id: string; user_id: string; attempts: number }>(
    `SELECT p.agent_id, a.user_id, p.attempts
       FROM agent_passports p
       JOIN agents a ON a.id = p.agent_id
       LEFT JOIN user_safes s ON s.id = a.safe_id
      WHERE p.status <> 'anchored'
        AND a.status <> 'revoked'
        -- #2138: a legacy-rail row can never succeed - issuePassport refuses
        -- it. Without this exclusion it would fail every tick, climbing
        -- attempts until it trips ISSUANCE_ATTENTION_ATTEMPTS and alarms an
        -- operator about a refusal that is working as designed. Same remedy
        -- the revoked-agent exclusion above uses, for the same reason (#1043
        -- finding 3). Predicate shared with the TS gate - see
        -- domain/passport-issuance-rail.ts.
        AND ${passportIssuableRailSql('s')}
        AND p.updated_at < NOW() - MAKE_INTERVAL(secs =>
              LEAST(30 * POWER(2, LEAST(GREATEST(p.attempts, 0), 10)), 3600))
      ORDER BY p.requested_at ASC
      LIMIT $1`,
    [limit],
  )
  return rows
}

/**
 * Persist the anchor tx hash the moment it is broadcast, BEFORE the wait
 * (#1043 finding 2): if the wait or the anchored-write fails after broadcast,
 * the retry recovers the attestation from this receipt instead of minting a
 * second one on-chain.
 */
export async function recordBroadcast(
  agentId: string,
  txHash: string,
  db: Executor = pool,
): Promise<void> {
  await db.query(
    `UPDATE agent_passports SET tx_hash = $2, updated_at = NOW() WHERE agent_id = $1`,
    [agentId, txHash],
  )
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
  /**
   * The agent's CURRENT delegate address (#1699). Internal to the anchor
   * comparison — NOT disclosed. It differs from `agent_eoa` exactly while a
   * re-key has rotated the key underneath a still-live attestation, and that
   * difference is what lets the verifier say `re_anchoring` instead of
   * `anchored` for a credential naming a retired key.
   */
  current_delegate_address: string | null
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
         a.delegate_address AS current_delegate_address,
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
 * The zero address is refused BEFORE the query. Migration 051 already prevents
 * storing it, but the sentinel is dangerous enough to be rejected at every
 * layer that could ever handle it: a lookup by `0x0` resolving to any passport
 * would hand a merchant somebody else's credential.
 */
export const FIND_BY_AGENT_ADDRESS_SQL = `${VERIFICATION_SELECT}
    AND (p.agent_eoa = $1 OR p.smart_account = $1)
  ORDER BY (a.status <> 'revoked') DESC, p.updated_at DESC, p.agent_id
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
  /** The address the LIVE attestation names. Null until the first anchor. */
  agent_eoa: string | null
  /** The agent's CURRENT delegate. Differs from `agent_eoa` after a re-key. */
  delegate_address: string | null
}

export async function standingForAgent(
  agentId: string,
  db: Executor = pool,
): Promise<AgentStanding | null> {
  const { rows } = await db.query<AgentStanding>(
    `SELECT a.id AS agent_id, a.status AS agent_status,
            p.status AS passport_status, p.attestation_uid,
            p.revocation_status, p.revocation_confirmed_at,
            p.agent_eoa, a.delegate_address
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


// ── Re-anchoring after a re-key (#1699, epic #1694) ─────────────────────
//
// A re-key rotates `agents.delegate_address` in place. `PASSPORT_SCHEMA`'s
// first field is `address agentEoa` and EAS attestations are IMMUTABLE, so the
// live attestation keeps naming the retired key until it is revoked and a new
// one is issued.
//
// The queue for that work is defined by the INVARIANT — "the anchored
// attestation names an address the agent no longer uses" — for the same reason
// `LIST_REVOCATIONS_DUE_SQL` is: a flag would have to be written by whoever
// completes the re-key, and anything that never got the flag written (a crash
// between the credential swap and the enqueue, a re-key completed before this
// code existed) would strand a live credential for a retired key forever. The
// invariant is self-healing; a flag is not.
//
// `agent_eoa IS NOT NULL` matters: it is written only by `markAnchored`, so a
// row that has never anchored cannot enter this queue and be mistaken for a
// stale one.
const STALE_ANCHOR_PREDICATE = `p.status = 'anchored'
        AND a.status <> 'revoked'
        AND p.agent_eoa IS NOT NULL
        AND a.delegate_address IS NOT NULL
        AND LOWER(p.agent_eoa) <> LOWER(a.delegate_address)`

/**
 * Atomically claim the right to revoke a STALE anchor, leasing the row.
 *
 * Deliberately a separate gate from {@link claimRevocation} rather than a
 * loosened one. That function's `a.status = 'revoked'` clause is a security
 * property — it is what makes "this cannot revoke a live agent's anchor no
 * matter who calls it" true, and it is relied on by an unconditional
 * fire-and-forget call on the anchor-completion path. Relaxing it in place
 * would silently widen every existing caller. This gate instead swaps that
 * clause for a DIFFERENT, equally specific invariant: the agent is live, and
 * its attestation names a key it no longer holds.
 *
 * The two are mutually exclusive by construction (`a.status = 'revoked'` vs
 * `a.status <> 'revoked'`), so one agent can never be in both queues, and a
 * revoke that arrives mid-re-anchor moves the row from this queue to that one
 * rather than racing inside it.
 *
 * The lease reuses `revocation_next_attempt_at`, exactly as `claimRevocation`
 * does — pushing it into the future IS the claim, and a crashed holder is
 * reclaimed when it expires.
 */
export const CLAIM_REANCHOR_REVOCATION_SQL = `UPDATE agent_passports p
        SET revocation_status = 'pending',
            revocation_requested_at = COALESCE(p.revocation_requested_at, NOW()),
            revocation_next_attempt_at = NOW() + MAKE_INTERVAL(secs => $2),
            updated_at = NOW()
       FROM agents a
      WHERE a.id = p.agent_id
        AND p.agent_id = $1
        AND ${STALE_ANCHOR_PREDICATE}
        AND p.revocation_status <> 'confirmed'
        AND (p.revocation_next_attempt_at IS NULL OR p.revocation_next_attempt_at <= NOW())`

export async function claimReanchorRevocation(
  agentId: string,
  leaseSeconds = 300,
  db: Executor = pool,
): Promise<boolean> {
  const { rowCount } = await db.query(CLAIM_REANCHOR_REVOCATION_SQL, [agentId, leaseSeconds])
  return (rowCount ?? 0) > 0
}

/**
 * Hand the row back to the ISSUANCE state machine, once the retired
 * attestation is provably dead.
 *
 * Two preconditions, both load-bearing and both checked in the statement
 * rather than by the caller:
 *
 * - `revocation_status = 'confirmed'` — the retired attestation is revoked
 *   on-chain. Clearing `attestation_uid` before that would erase the only
 *   pointer Haven holds to a credential that is still live, stranding it
 *   permanently. This is why the epic's revoke-before-issue order is not
 *   merely mirrored at the passport layer but ENFORCED here.
 * - `attestation_uid = $2` — the caller revoked THAT uid. Without it a
 *   concurrent re-anchor could reset a row whose newer attestation is the one
 *   actually live.
 *
 * Everything anchor-shaped is cleared, `attempts` included: the next issuance
 * is a fresh attempt at a NEW attestation, not a continuation of the old
 * one's backoff, and carrying the count forward would put a healthy re-anchor
 * straight into the hour-long cap and trip the attention alarm.
 *
 * The row keeps its `agent_id`, `requested_at`, `chain_id` and
 * `assurance_level` — the passport's IDENTITY and history run unbroken across
 * the rotation, which is the whole point of #1699. `standing` is untouched
 * here because it is not a column of this table: it derives from
 * `agents.status`, which a re-key never changes.
 */
export const RESET_FOR_REANCHOR_SQL = `UPDATE agent_passports
        SET status = 'pending',
            attestation_uid = NULL, tx_hash = NULL,
            agent_eoa = NULL, smart_account = NULL,
            anchored_at = NULL, anchoring_started_at = NULL,
            attempts = 0, last_error = NULL,
            revocation_status = 'none',
            revocation_requested_at = NULL, revocation_confirmed_at = NULL,
            revocation_tx_hash = NULL, revocation_attempts = 0,
            revocation_last_error = NULL, revocation_next_attempt_at = NULL,
            updated_at = NOW()
      WHERE agent_id = $1
        AND status = 'anchored'
        AND revocation_status = 'confirmed'
        AND attestation_uid = $2`

export async function resetForReanchor(
  agentId: string,
  revokedAttestationUid: string,
  db: Executor = pool,
): Promise<boolean> {
  const { rowCount } = await db.query(RESET_FOR_REANCHOR_SQL, [agentId, revokedAttestationUid])
  return (rowCount ?? 0) > 0
}

/**
 * Stale anchors due for another re-anchor attempt, oldest first.
 *
 * **Note what is NOT excluded here, unlike the revocation due-list:
 * `revocation_status = 'confirmed'`.** For a revocation, confirmed is
 * terminal — the chain agrees and there is nothing left to do. For a
 * re-anchor it is the MIDDLE of the operation: the retired attestation is
 * dead, but the row still has to be handed back to issuance and a new
 * attestation minted. A re-anchor whose process died in that gap — between
 * `markRevocationConfirmed` and `resetForReanchor`, two sequential statements
 * with no transaction around them — would otherwise never be due again, and
 * the agent would keep a `pending`-shaped passport with no live attestation
 * for a key it does hold, forever. Excluding confirmed rows here was the
 * stranding bug found in review of this very slice.
 */
export const LIST_REANCHORS_DUE_SQL = `SELECT p.agent_id, a.user_id, p.revocation_attempts
       FROM agent_passports p
       JOIN agents a ON a.id = p.agent_id
      WHERE ${STALE_ANCHOR_PREDICATE}
        AND (p.revocation_next_attempt_at IS NULL OR p.revocation_next_attempt_at <= NOW())
      ORDER BY COALESCE(p.revocation_requested_at, p.anchored_at) ASC
      LIMIT $1`

export async function listReanchorsDue(
  limit: number,
  db: Executor = pool,
): Promise<Array<{ agent_id: string; user_id: string; revocation_attempts: number }>> {
  const { rows } = await db.query<{
    agent_id: string
    user_id: string
    revocation_attempts: number
  }>(LIST_REANCHORS_DUE_SQL, [limit])
  return rows
}

/**
 * Stale anchors unreconciled past a threshold — the re-anchor half of the
 * stuck alarm.
 *
 * A separate query from {@link LIST_STUCK_REVOCATIONS_SQL} rather than a
 * widened one, because the two are different incidents with different
 * remedies: a stuck REVOCATION means a revoked agent still holds a live
 * credential, a stuck RE-ANCHOR means a live agent's credential names a key it
 * no longer holds. Folding them into one count would make the alarm
 * unreadable at the moment it fires.
 *
 * `LIMIT 100` where the revocation twin has none: this is a log line, and the
 * sweep already truncates to the first 10 for display while reporting the true
 * count. An unbounded scan buys nothing an operator reads and, on a bad day,
 * serialises the whole table into a warning. The asymmetry is deliberate; the
 * twin predates the truncation and simply has not been revisited.
 */
export const LIST_STUCK_REANCHORS_SQL = `SELECT p.agent_id, p.agent_eoa, a.delegate_address,
              p.revocation_attempts, p.revocation_last_error
       FROM agent_passports p
       JOIN agents a ON a.id = p.agent_id
      WHERE ${STALE_ANCHOR_PREDICATE}
        AND COALESCE(p.revocation_requested_at, p.anchored_at) < NOW() - MAKE_INTERVAL(secs => $1)
      ORDER BY COALESCE(p.revocation_requested_at, p.anchored_at) ASC
      LIMIT 100`

export async function listStuckReanchors(
  olderThanSeconds: number,
  db: Executor = pool,
): Promise<
  Array<{
    agent_id: string
    agent_eoa: string | null
    delegate_address: string | null
    revocation_attempts: number
    revocation_last_error: string | null
  }>
> {
  const { rows } = await db.query<{
    agent_id: string
    agent_eoa: string | null
    delegate_address: string | null
    revocation_attempts: number
    revocation_last_error: string | null
  }>(LIST_STUCK_REANCHORS_SQL, [olderThanSeconds])
  return rows
}
