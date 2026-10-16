/**
 * Hybrid DeleGator account provisioning (#825, epic #821 Phase 1).
 *
 * POST /accounts/hybrid — owner-facing: computes the counterfactual Hybrid
 * address for the given owner configuration (EOA and/or passkey P256 keys)
 * and records the account row. NO transaction happens here: the address is
 * deterministic and deployment rides the first sponsored operation (#828).
 *
 * Fail-closed wiring (the #745 dark-launch pattern): the row carries
 * account_type='delegator_hybrid' and execution_rail='delegation'. When this
 * route first shipped, nothing routed to that rail value — the payments route
 * blocked it cleanly rather than falling through to a legacy path that could
 * not serve it. #829 then landed the delegation payment rail, so payments DO
 * route here now; the fail-closed shape remains as the pattern for the next
 * dark-launched rail.
 */

import { FastifyInstance } from 'fastify'
// dep-lint-exempt: 5 provisioning statements (duplicate check, first-account gate, insert with rail+type, passkey persist, ownership read) whose guards travel with the insert; a >100-line move deferred under #999
import { pad, toHex } from 'viem'
import pool from '../db.js'
import { withTransaction } from '../infra/transaction.js'
import { authMiddleware } from '../middleware/auth.js'
import { isAddress as isValidAddress } from '@haven_ai/core'
import { DELEGATION_RAIL_CHAIN_IDS } from '../rails/delegation-contracts.js'
import { isValueBearingChain } from '../modules/accounts/index.js'
import {
  computeUserHybridAccountAddress,
  type PasskeySigner,
} from '../rails/hybrid-provisioning.js'
import {
  prepareSignerChange,
  submitSignerChange,
  validateSignedSubmission,
  type SignerActionAccount,
  type SignerActionBody,
} from '../rails/hybrid-signer-actions.js'
import { prepareTransfer, submitTransfer, type TransferBody } from '../rails/hybrid-transfers.js'
import { moneyPathRateLimit } from '../middleware/rate-limit.js'
import { loadHybridOwnerConfig } from '../rails/hybrid-account-config.js'
import { INSERT_HYBRID_ACCOUNT_PASSKEY_SQL, listAccountPasskeys, passkeyEnrollmentDates } from '../infra/repositories/hybrid-signers.js'
import {
  ALLOCATE_HYBRID_DEPLOY_SALT_SQL,
  COUNT_ACCOUNTS_FOR_USER_ON_CHAIN_SQL,
  COUNT_ACCOUNTS_FOR_USER_SQL,
  FIND_ACCOUNT_BY_CREATE_IDEMPOTENCY_KEY_SQL,
  FIND_DELEGATOR_HYBRID_ACCOUNT_FOR_USER_SQL,
  FIND_HYBRID_ACCOUNT_BY_ADDRESS_FOR_REPLAY_SQL,
  FIND_HYBRID_ACCOUNT_BY_ADDRESS_FOR_USER_SQL,
  FIND_OWNED_HYBRID_ACCOUNT_SQL,
  INSERT_HYBRID_ACCOUNT_SQL,
} from '../infra/repositories/smart-accounts.js'
import { boundedErrorDetails } from '../modules/payments/index.js'

/** Soft cap (#4023): accounts per user per chain. A 11th create answers 422. */
const MAX_ACCOUNTS_PER_USER_PER_CHAIN = 10

interface CreateHybridBody {
  chain_id?: number
  name?: string
  owner_address?: string
  passkeys?: Array<{ key_id?: string; x?: string; y?: string }>
  /**
   * #4023 create-additional: the account the dialog is viewing (or the
   * default). Present ⇒ this request creates an ADDITIONAL account whose
   * owner is the single passkey named by `key_id`, copied from THIS row's
   * signer set — never from the client.
   */
  source_account_id?: string
  /**
   * #4023 create-additional: the WebAuthn credential the user authenticated
   * the dialog with. Must be one of the source account's passkeys; the NEW
   * account's owner config is that passkey ALONE (no backups, no EOA).
   */
  key_id?: string
  /**
   * #4023: retried-create dedup, the payments.ts `send_idempotency_key`
   * pattern. A retried create returns the FIRST account it created.
   */
  idempotency_key?: string
  /**
   * Optional acknowledgment that a single-signer account has no recovery —
   * "losing my only device loses this account".
   *
   * **Not required for anything.** It gated provisioning under #908; #1153
   * turned the signer floor into a post-funding recommendation, so nothing
   * refuses a single-signer account any more. Sending it records the
   * acknowledgement durably (`smart_accounts.single_signer_waiver_at`) as history
   * and changes no outcome; omitting it changes no outcome either. Kept on the
   * request shape so existing clients that send it keep working.
   */
  single_signer_waiver?: { acknowledged?: boolean }
}

const HEX_COORD_RE = /^0x[0-9a-fA-F]{1,64}$/

/**
 * String-ness narrow in the cross-realm-safe form, mirroring
 * agent-connection-setups.ts. The request schema covers `key_id` PRESENCE
 * but has no `minLength` (POST /accounts/hybrid passkeys item), so emptiness
 * stays a handler check: an empty key_id was a 400 before the #3032 flip
 * (round-1 finding F2) and must stay one.
 */
function isString(value: unknown): value is string {
  return Object.prototype.toString.call(value) === '[object String]'
}

export default async function hybridAccountRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  /**
   * A typed refusal raised INSIDE the registration transaction. The rollback
   * is the point — a refused registration must commit nothing, not even the
   * counter bump — and the outer catch turns it into the response.
   */
  class RegistrationRefusal extends Error {
    constructor(
      readonly status: number,
      readonly body: Record<string, unknown>,
    ) {
      super(String(body.error ?? 'registration refused'))
      this.name = 'RegistrationRefusal'
    }
  }

  app.post<{ Body: CreateHybridBody }>(
    '/hybrid',
    // #4023: the create route is a money path (a new spend-capable account),
    // so it carries the same rate limit as every other money-path route.
    { config: moneyPathRateLimit },
    async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const {
      chain_id,
      name,
      owner_address,
      passkeys,
      single_signer_waiver,
      source_account_id,
      key_id,
      idempotency_key,
    } = request.body ?? {}

    // Two request shapes share this route: the historical signup (owner_address
    // and/or passkeys FROM the client) and #4023's create-additional, which
    // names a source account the user owns and the passkey they authenticated
    // with — the owner config is copied SERVER-SIDE from that row, never
    // accepted from the client. Mixing the shapes is a 400: the owner fields
    // would silently change meaning on the additional path.
    const isAdditional = source_account_id !== undefined || key_id !== undefined
    if (isAdditional && (source_account_id === undefined || key_id === undefined)) {
      return reply.code(400).send({ error: 'source_account_id and key_id are required together' })
    }
    if (isAdditional && (owner_address !== undefined || passkeys !== undefined)) {
      return reply
        .code(400)
        .send({ error: 'an additional account copies its owner from the source account — do not send owner_address or passkeys' })
    }

    // #4023: the create-additional request has NO bare fallback — the chain is
    // part of what the dialog names. Signup keeps its dark-launch default (the
    // sanctioned `?? 84532`); no existing field changes meaning.
    const chainId = isAdditional ? chain_id : (chain_id ?? 84532)
    if (chainId === undefined) {
      return reply.code(400).send({ error: 'chain_id is required' })
    }
    if (!isAdditional) {
      if (owner_address !== undefined && !isValidAddress(owner_address)) {
        return reply.code(400).send({ error: 'owner_address must be a valid address' })
      }
      // The zero address is the Hybrid derivation's "no EOA owner" encoding —
      // {owner_address: 0x0, passkeys: [A]} derives the SAME account as pure-
      // passkey {passkeys: [A]} but would count as a second signer, silently
      // bypassing the #908 mainnet floor. Found by the money-path review.
      if (owner_address !== undefined && /^0x0{40}$/i.test(owner_address)) {
        return reply.code(400).send({ error: 'owner_address must not be the zero address' })
      }
    }
    const parsedPasskeys: PasskeySigner[] = []
    if (!isAdditional) {
      for (const pk of passkeys ?? []) {
        // `key_id` string-ness and the 0x-hex coordinate SHAPES are the request
        // schema's (#3032: this file is enforced — `required: ['key_id','x','y']`
        // and the coordinate patterns) — except EMPTINESS: the schema's `key_id`
        // has no `minLength`, so the old `!pk.key_id` 400 stays here as a named
        // check (#3032 round-1 finding F2; the schema does not cover it). What
        // stays SEMANTIC: the coordinates must PARSE as BigInt, which ajv's
        // pattern alone does not prove. The push below restates the now-proven
        // string-ness for the compiler — same idiom as the `owner_address` cast.
        if (!isString(pk.key_id) || pk.key_id.length === 0) {
          return reply.code(400).send({ error: 'each passkey needs a key_id' })
        }
        if (!pk.x || !pk.y || !HEX_COORD_RE.test(pk.x) || !HEX_COORD_RE.test(pk.y)) {
          return reply.code(400).send({ error: 'each passkey needs 0x-hex x and y coordinates' })
        }
        parsedPasskeys.push({ keyId: pk.key_id, x: BigInt(pk.x), y: BigInt(pk.y) })
      }
      if (!owner_address && parsedPasskeys.length === 0) {
        return reply.code(400).send({ error: 'at least one owner (owner_address or passkeys) is required' })
      }
      // Duplicate key_ids collapse to ONE on-chain key (and the passkey table's
      // ON CONFLICT dedupes) — they must not inflate the #908 signer count.
      const uniqueKeyIds = new Set(parsedPasskeys.map((pk) => pk.keyId.toLowerCase()))
      if (uniqueKeyIds.size !== parsedPasskeys.length) {
        return reply.code(400).send({ error: 'duplicate passkey key_id' })
      }
    }
    if (idempotency_key !== undefined && (!isString(idempotency_key) || idempotency_key.length === 0)) {
      return reply.code(400).send({ error: 'idempotency_key must be a non-empty string' })
    }

    // #1153: provisioning no longer refuses a single-signer account on a
    // value-bearing chain. The #908 floor became a recommendation shown AFTER
    // funding — the owner's call, recorded on that issue — because a wall in
    // the first minute blocked the one-Face-ID onboarding this rail exists to
    // offer, at the moment the user has nothing at risk and no context for
    // what a backup signer protects. An acknowledgement is still RECORDED
    // below when one is sent; it just no longer unblocks anything.
    const signerCount = isAdditional ? 1 : parsedPasskeys.length + (owner_address ? 1 : 0)
    const waiverAcknowledged = single_signer_waiver?.acknowledged === true

    if (!DELEGATION_RAIL_CHAIN_IDS.has(chainId)) {
      return reply.code(400).send({
        error: `Hybrid accounts are not available on chain ${chainId} yet`,
        supported: [...DELEGATION_RAIL_CHAIN_IDS],
      })
    }

    // Record the waiver ONLY when it actually gated something: a value-bearing
    // chain below the signer floor (#908 — "recorded, signed-off"). Testnet
    // requests and ≥2-signer accounts never carry one.
    const recordWaiver =
      waiverAcknowledged && isValueBearingChain(chainId) && signerCount < 2

    // ── Create-additional: resolve the owner passkey from the SOURCE row ──
    // The server copies the ONE named passkey's coordinates from the source
    // account's stored signer set — never from the request. A source with no
    // passkey (EOA-only) and a key_id outside its signer set are both typed
    // refusals: there is no owner config to derive here.
    let ownerPasskeys: PasskeySigner[]
    let saltKey: string
    if (isAdditional) {
      const source = await pool.query<{ id: string }>(
        FIND_DELEGATOR_HYBRID_ACCOUNT_FOR_USER_SQL,
        [source_account_id, sub],
      )
      if (source.rows.length === 0) {
        return reply.code(404).send({ error: 'Source account not found' })
      }
      const sourceSigners = await listAccountPasskeys(source.rows[0].id)
      if (sourceSigners.length === 0) {
        return reply.code(422).send({
          error: 'The source account has no passkey to copy — EOA-only accounts cannot create an additional account',
        })
      }
      const named = sourceSigners.find((s) => s.key_id.toLowerCase() === String(key_id).toLowerCase())
      if (!named) {
        return reply.code(422).send({ error: 'key_id is not a passkey on the source account' })
      }
      ownerPasskeys = [{ keyId: named.key_id, x: BigInt(named.public_key_x), y: BigInt(named.public_key_y) }]
      saltKey = named.key_id

      // Soft cap (#4023): 10 accounts per user per chain. Deliberately soft —
      // the cap bounds accident and abuse, not a business rule.
      const cap = await pool.query<{ count: string }>(COUNT_ACCOUNTS_FOR_USER_ON_CHAIN_SQL, [sub, chainId])
      if (BigInt(cap.rows[0]?.count ?? '0') >= BigInt(MAX_ACCOUNTS_PER_USER_PER_CHAIN)) {
        return reply.code(422).send({
          error: `This user already has ${MAX_ACCOUNTS_PER_USER_PER_CHAIN} accounts on chain ${chainId}`,
        })
      }

      // Idempotent replay (#1207's rule, account-shaped): before anything is
      // derived or written, a retried create answers the FIRST account.
      if (idempotency_key) {
        const replay = await pool.query<{ id: string; account_address: string; created_at: string }>(
          FIND_ACCOUNT_BY_CREATE_IDEMPOTENCY_KEY_SQL,
          [sub, idempotency_key],
        )
        if (replay.rows.length > 0) {
          return reply.code(201).send({
            id: replay.rows[0].id,
            account_address: replay.rows[0].account_address,
            chain_id: chainId,
            account_type: 'delegator_hybrid',
            deployed: false,
            created_at: replay.rows[0].created_at,
          })
        }
      }
    } else {
      ownerPasskeys = parsedPasskeys
      // The counter is per (user, signer): a passkey account counters on its
      // PRIMARY passkey; an EOA-only account on the owner address. Two
      // accounts built from different signers derive different addresses at
      // the same salt anyway — the counter exists so the SAME signer never
      // derives the same address twice, even after an unlink (the counter
      // table survives the hard DELETE; migration 114).
      saltKey = parsedPasskeys[0]?.keyId ?? `eoa:${String(owner_address).toLowerCase()}`
    }

    // ONE transaction (#4023): the counter bump, the derived row and the
    // copied passkeys commit together or not at all. Before this they were
    // separate pool.query calls, so a crash between them left a counter
    // that had moved with no account to show for it — harmless for a
    // never-reuse counter, fatal for the row/passkey pair (an account
    // whose owner config cannot be reconstructed). The chain round-trip
    // inside the transaction (the derivation RPC) trades a pooled
    // connection for that atomicity; registration is a once-per-account
    // operation, the same trade the #1673 deploy lock measures as acceptable.
    let created: { id: string; account_address: string; created_at: string } | RegistrationRefusal
    created = await withTransaction(pool, async (tx) => {
      const saltRow = await tx.query<{ last_allocated: string }>(ALLOCATE_HYBRID_DEPLOY_SALT_SQL, [
        sub,
        saltKey,
      ])
      const counter = BigInt(saltRow.rows[0].last_allocated)
      // Counter value 0 is NEVER issued: pad('0x', {size: 32}) is the same
      // salt as '0x' (sdk/delegate-account.ts), which is every pre-#4023
      // account. The counter starts allocating at 1 (migration 114).
      const deploySalt = pad(toHex(counter), { size: 32 })

      let accountAddress: string
      try {
        accountAddress = await computeUserHybridAccountAddress(chainId, {
          ownerAddress: isAdditional ? undefined : (owner_address as `0x${string}` | undefined),
          passkeys: ownerPasskeys,
          deploySalt,
        })
      } catch (err) {
        throw new RegistrationRefusal(502, {
          error: 'Could not derive the account address',
          details: boundedErrorDetails(err), // #3609: redacted + bounded
        })
      }

      const existing = await tx.query<{ id: string }>(
        FIND_HYBRID_ACCOUNT_BY_ADDRESS_FOR_USER_SQL,
        [sub, accountAddress, chainId],
      )
      if (existing.rows.length > 0) {
        throw new RegistrationRefusal(409, { error: 'Account already registered', id: existing.rows[0].id })
      }

      // isFirst gates the SIGNUP default only (#4023: a created account never
      // becomes the default — the additional INSERT passes false whatever the
      // count; only this signup path may set it).
      const firstCheck = await tx.query<{ count: string }>(COUNT_ACCOUNTS_FOR_USER_SQL, [sub])
      const isFirst = !isAdditional && firstCheck.rows[0]?.count === '0'

      const result = await tx.query<{ id: string; created_at: string }>(
        INSERT_HYBRID_ACCOUNT_SQL,
        // owner_address: the EOA owner for treasury ops (#828 revoke). A pure-
        // passkey account has none — its config lives in hybrid_account_passkeys.
        // ON CONFLICT DO NOTHING: the UNIQUE(user_id, chain_id,
        // LOWER(account_address)) index (migration 114) is the arbiter when
        // two concurrent creates derive the same address; the loser re-reads
        // below instead of 500ing on a bare constraint violation.
        [
          sub,
          accountAddress,
          chainId,
          name?.trim() || 'My account',
          isAdditional ? false : isFirst,
          isAdditional ? null : (owner_address?.toLowerCase() ?? null),
          recordWaiver ? new Date().toISOString() : null,
          deploySalt,
          idempotency_key ?? null,
        ],
      )
      if (result.rows.length === 0) {
        // The insert lost the unique-address race. The winner is either this
        // user's own concurrent create (answer it — the idempotency contract)
        // or another user's row at the same derived address (impossible
        // without shared keys, but then the 409 is the honest answer).
        const winner = await tx.query<{ id: string; created_at: string }>(
          FIND_HYBRID_ACCOUNT_BY_ADDRESS_FOR_REPLAY_SQL,
          [sub, accountAddress, chainId],
        )
        if (winner.rows.length === 0) {
          throw new RegistrationRefusal(409, { error: 'Account already registered' })
        }
        throw new RegistrationRefusal(201, {
          __replay: true,
          id: winner.rows[0].id,
          account_address: accountAddress,
          chain_id: chainId,
          created_at: winner.rows[0].created_at,
        })
      }
      const accountId = result.rows[0].id

      // Persist the passkey signer set (#885): the account address was derived
      // from EXACTLY these coordinates, so activation (#860 deploy) and revoke
      // can reconstruct the owner config for a pure-passkey account.
      for (const pk of ownerPasskeys) {
        await tx.query(
          INSERT_HYBRID_ACCOUNT_PASSKEY_SQL,
          [accountId, pk.keyId, `0x${pk.x.toString(16)}`, `0x${pk.y.toString(16)}`],
        )
      }

      return { id: accountId, account_address: accountAddress, created_at: result.rows[0].created_at }
    }).catch((err: unknown) => {
      if (err instanceof RegistrationRefusal) return err
      throw err
    })

    if (created instanceof RegistrationRefusal) {
      if (created.status === 201) {
        // The unique-race replay: answer the winner's account, 201 shape intact.
        return reply.code(201).send({
          id: created.body.id,
          account_address: created.body.account_address,
          chain_id: created.body.chain_id,
          account_type: 'delegator_hybrid',
          deployed: false,
          created_at: created.body.created_at,
        })
      }
      return reply.code(created.status).send(created.body)
    }

    return reply.code(201).send({
      id: created.id,
      account_address: created.account_address,
      chain_id: chainId,
      account_type: 'delegator_hybrid',
      // Counterfactual: no deployment tx — the first sponsored operation
      // (the budget grant, #828) deploys the code.
      deployed: false,
      created_at: created.created_at,
    })
  })

  /**
   * Resolve an account the caller owns from (address, chain) — the
   * account-scoped counterpart to agent-delegations' `loadOwnedDelegationAgent`.
   * Ownership is the `smart_accounts` row, so a caller can only ever reach their
   * own account regardless of which address they name.
   */
  async function resolveOwnedHybridAccount(
    userId: string,
    address: string,
    chainIdRaw: string | undefined,
  ): Promise<
    | { ok: true; account: SignerActionAccount }
    | { ok: false; status: 400 | 404 | 409; error: string }
  > {
    if (!isValidAddress(address)) {
      return { ok: false, status: 400, error: 'Invalid address' }
    }
    const chainId = Number(chainIdRaw)
    if (!Number.isFinite(chainId)) {
      return { ok: false, status: 400, error: 'chain_id is required' }
    }
    // `SELECT 1`, matching the sibling GET verbatim — the provisioning route's
    // duplicate check is a `SELECT id FROM smart_accounts`, and sharing that shape
    // would make pattern-matched test mocks ambiguous between the two.
    const owned = await pool.query(
      FIND_OWNED_HYBRID_ACCOUNT_SQL,
      [userId, address, chainId],
    )
    if (owned.rows.length === 0) {
      return { ok: false, status: 404, error: 'Account not found' }
    }
    const owner = await loadHybridOwnerConfig(userId, address, chainId)
    if (!owner) {
      return { ok: false, status: 409, error: 'Account signer configuration unknown' }
    }
    return {
      ok: true,
      account: {
        accountAddress: address as `0x${string}`,
        chainId,
        accountId: owner.accountId,
        config: owner.config,
        singleSignerWaiverAt: owner.singleSignerWaiverAt,
      },
    }
  }

  // ── Account-scoped signer management (#1081) ──────────────────────────────
  //
  // The agent-scoped twin (`/agents/:id/account-signers/*`, #888) required an
  // agent to exist before an account could enrol a backup or remove a key —
  // so a fresh account had no path to its own recovery setup, which is when
  // a user can add a backup before it holds funds.
  //
  // Same helpers, same authority rules, same last-signer guard — the only
  // difference is that the account is resolved by (address, chain) instead of
  // through an agent. `chain_id` stays on the query string so an account is
  // addressed identically here and on the sibling GET.
  app.post<{
    Params: { address: string }
    Querystring: { chain_id?: string }
    Body: SignerActionBody
  }>('/hybrid/:address/signers/prepare', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const resolved = await resolveOwnedHybridAccount(sub, request.params.address, request.query.chain_id)
    if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error })

    const result = await prepareSignerChange(resolved.account, request.body ?? {})
    if (!result.ok) {
      const { status, error, details } = result.failure
      return reply.code(status).send(details ? { error, details } : { error })
    }
    return result.prepared
  })

  app.post<{
    Params: { address: string }
    Querystring: { chain_id?: string }
    Body: SignerActionBody & { signature?: string; user_operation?: unknown }
  }>('/hybrid/:address/signers/submit', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    // Envelope first, matching the agent-scoped route's precedence.
    const envelope = validateSignedSubmission(request.body ?? {})
    if (!envelope.ok) {
      return reply.code(envelope.failure.status).send({ error: envelope.failure.error })
    }
    const resolved = await resolveOwnedHybridAccount(sub, request.params.address, request.query.chain_id)
    if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error })

    const result = await submitSignerChange(resolved.account, request.body ?? {})
    if (!result.ok) {
      const { status, error, details } = result.failure
      return reply.code(status).send(details ? { error, details } : { error })
    }
    return { updated: true, tx_hash: result.txHash }
  })

  // ── Owner-initiated send (#1083) ──────────────────────────────────────────
  // The rail's "Send": the treasury executes an ERC-20 transfer as a
  // sponsored account op the OWNER signs — same prepare/submit +
  // calldata-pinning discipline as signer changes, same device-decides
  // signature scheme (#1086). Works on a COUNTERFACTUAL account (#1106:
  // deploy + transfer ride one sponsored op).
  app.post<{
    Params: { address: string }
    Querystring: { chain_id?: string }
    Body: TransferBody
  }>('/hybrid/:address/transfers/prepare', { config: moneyPathRateLimit }, async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const resolved = await resolveOwnedHybridAccount(sub, request.params.address, request.query.chain_id)
    if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error })

    const result = await prepareTransfer(resolved.account, request.body ?? {})
    if (!result.ok) {
      const { status, error, details } = result.failure
      return reply.code(status).send(details ? { error, details } : { error })
    }
    return result.prepared
  })

  app.post<{
    Params: { address: string }
    Querystring: { chain_id?: string }
    Body: TransferBody & { signature?: string; user_operation?: unknown }
  }>('/hybrid/:address/transfers/submit', { config: moneyPathRateLimit }, async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const resolved = await resolveOwnedHybridAccount(sub, request.params.address, request.query.chain_id)
    if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error })

    const result = await submitTransfer(resolved.account, request.body ?? {})
    if (!result.ok) {
      const { status, error, details } = result.failure
      return reply.code(status).send(details ? { error, details } : { error })
    }
    return { submitted: true, tx_hash: result.txHash }
  })

  // ── GET /hybrid/:address/signers — the ACCOUNT's signer set (#1079) ───────
  //
  // The agent-scoped twin lives in agent-delegations.ts (#887); this one is
  // needed twice over: to resolve a signer at LOGIN (before any agent
  // exists), and to give account-level recovery a data source — a delegation
  // account with zero agents previously had no path to its own signer set.
  // Owner-scoped; public-key material only — nothing secret.
  app.get<{ Params: { address: string }; Querystring: { chain_id?: string } }>(
    '/hybrid/:address/signers',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      // Same resolution as the management routes below — one copy, so the
      // read and the write can never disagree about who owns an account.
      const resolved = await resolveOwnedHybridAccount(sub, request.params.address, request.query.chain_id)
      if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error })

      const { accountAddress, chainId, config, accountId } = resolved.account
      // #1679: enrollment dates let the UI label rows "Passkey · added {date}"
      // instead of a positional platform name. Joined by key_id rather than
      // threaded through the owner config — that config is the deploy/signing
      // shape and stays key material only. Null (never a guessed date) when a
      // row is somehow absent; the UI falls back to ordinal "Passkey N".
      const createdByKey = passkeyEnrollmentDates(await listAccountPasskeys(accountId))
      return {
        account_address: accountAddress,
        chain_id: chainId,
        owner_address: config.ownerAddress ?? null,
        passkeys: (config.passkeys ?? []).map((p) => ({
          key_id: p.keyId,
          x: `0x${p.x.toString(16)}`,
          y: `0x${p.y.toString(16)}`,
          created_at: createdByKey.get(p.keyId.toLowerCase()) ?? null,
        })),
      }
    },
  )
}
