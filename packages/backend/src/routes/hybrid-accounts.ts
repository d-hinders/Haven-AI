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
import { authMiddleware } from '../middleware/auth.js'
import { isAddress as isValidAddress } from '@haven_ai/core'
import { DELEGATION_RAIL_CHAIN_IDS } from '../rails/delegation-contracts.js'
import { isValueBearingChain } from '../modules/accounts/index.js'
import {
  computeUserHybridAccountAddress,
  deploySaltForCounter,
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
import { recordOwnerTransfer } from '../infra/repositories/owner-transfers.js'
import { moneyPathRateLimit } from '../middleware/rate-limit.js'
import { loadHybridOwnerConfig } from '../rails/hybrid-account-config.js'
import { insertHybridAccountPasskey, listAccountPasskeys, passkeyEnrollmentDates } from '../infra/repositories/hybrid-signers.js'
import {
  allocateHybridDeploySalt,
  countAccountsForUser,
  countAccountsForUserOnChain,
  findAccountByCreateIdempotencyKey,
  findDelegatorHybridAccountForUser,
  findHybridAccountByAddressForReplay,
  findHybridAccountByAddressForUser,
  findOwnedHybridAccount,
  insertHybridAccount,
  inTransaction,
} from '../infra/repositories/smart-accounts.js'
import { boundedErrorDetails } from '../modules/payments/index.js'

/** Soft cap (#4023): accounts per user per chain. A 11th create answers 422. */
const MAX_ACCOUNTS_PER_USER_PER_CHAIN = 10

/**
 * The create-additional refusal codes (#4024). Clients branch on these, never
 * on the sentence — the New account dialog maps each one
 * (`packages/frontend/src/lib/new-account.ts` carries the same constants).
 */
const SOURCE_ACCOUNT_NOT_FOUND = 'SOURCE_ACCOUNT_NOT_FOUND'
const SOURCE_HAS_NO_PASSKEY = 'SOURCE_HAS_NO_PASSKEY'
const KEY_NOT_ON_SOURCE = 'KEY_NOT_ON_SOURCE'
const ACCOUNT_CAP_REACHED = 'ACCOUNT_CAP_REACHED'
const IDEMPOTENCY_KEY_REUSED = 'IDEMPOTENCY_KEY_REUSED'

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

/**
 * The answer to a create-additional that names an idempotency key some row of
 * the caller's already carries (#4024). Used twice: by the pre-check before
 * anything is validated, and by the insert's conflict path when a concurrent
 * attempt with the same key committed first. A key reused for a DIFFERENT
 * request is refused, as the send_idempotency_key pattern does
 * (payments.ts findPaymentReplay): the stored row pins the chain and its one
 * passkey, so another chain_id or key_id is a 409, never the first account.
 * The source account is not stored on the new row, so it cannot be pinned.
 */
async function answerCreateReplay(
  replay: { id: string; account_address: string; chain_id: number; created_at: string },
  request: { chainId: number; keyId: string },
  executor?: Parameters<typeof listAccountPasskeys>[1],
): Promise<{ status: 201 | 409; body: Record<string, unknown> }> {
  const replayKeys = await listAccountPasskeys(replay.id, executor)
  const sameKey = replayKeys.some((k) => k.key_id.toLowerCase() === request.keyId.toLowerCase())
  const mismatch = Number(replay.chain_id) !== request.chainId ? 'chain_id' : !sameKey ? 'key_id' : null
  if (mismatch) {
    return {
      status: 409,
      body: {
        error: `idempotency_key already belongs to an account with a different ${mismatch}`,
        error_code: IDEMPOTENCY_KEY_REUSED,
        id: replay.id,
      },
    }
  }
  return {
    status: 201,
    body: {
      id: replay.id,
      account_address: replay.account_address,
      // The STORED row's chain, not the request's (#4024).
      chain_id: Number(replay.chain_id),
      account_type: 'delegator_hybrid',
      deployed: false,
      created_at: replay.created_at,
    },
  }
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

    // ── Create-additional ──────────────────────────────────────────────────
    let ownerPasskeys: PasskeySigner[]
    let saltKey: string
    if (isAdditional) {
      // Idempotent replay FIRST (#1207's rule, account-shaped; #4024): before
      // the source, key and cap are checked, and before anything is derived
      // or written, a retried create answers the FIRST account. The order is
      // the point. Until #4024 the cap ran first, so a retried 10th create
      // whose response was lost got "cap reached" instead of the account it
      // had already made — and a client could not tell the two apart. The
      // read is scoped to the caller (`sub`), so a key never replays another
      // user's row; another user's identical key is simply a new create.
      //
      // A key reused for a different request is refused (answerCreateReplay).
      if (idempotency_key) {
        const replay = await findAccountByCreateIdempotencyKey(sub, idempotency_key)
        if (replay !== null) {
          const answer = await answerCreateReplay(replay, { chainId, keyId: String(key_id) })
          return reply.code(answer.status).send(answer.body)
        }
      }

      // Resolve the owner passkey from the SOURCE row: the server copies the
      // ONE named passkey's coordinates from the source account's stored
      // signer set — never from the request. Each refusal carries an
      // error_code (#4024).
      const source = await findDelegatorHybridAccountForUser(sub, source_account_id as string)
      if (source === null) {
        return reply.code(404).send({ error: 'Source account not found', error_code: SOURCE_ACCOUNT_NOT_FOUND })
      }
      const sourceSigners = await listAccountPasskeys(source.id)
      if (sourceSigners.length === 0) {
        return reply.code(422).send({
          error: 'The source account has no passkey to copy, so it cannot secure an additional account',
          error_code: SOURCE_HAS_NO_PASSKEY,
        })
      }
      const named = sourceSigners.find((s) => s.key_id.toLowerCase() === String(key_id).toLowerCase())
      if (!named) {
        return reply.code(422).send({ error: 'key_id is not a passkey on the source account', error_code: KEY_NOT_ON_SOURCE })
      }
      ownerPasskeys = [{ keyId: named.key_id, x: BigInt(named.public_key_x), y: BigInt(named.public_key_y) }]
      saltKey = named.key_id

      // Soft cap (#4023): 10 accounts per user per chain. Deliberately soft —
      // the cap bounds accident and abuse, not a business rule.
      const cap = await countAccountsForUserOnChain(sub, chainId)
      if (cap >= BigInt(MAX_ACCOUNTS_PER_USER_PER_CHAIN)) {
        return reply.code(422).send({
          error: `This user already has ${MAX_ACCOUNTS_PER_USER_PER_CHAIN} accounts on chain ${chainId}`,
          error_code: ACCOUNT_CAP_REACHED,
          cap: MAX_ACCOUNTS_PER_USER_PER_CHAIN,
          chain_id: chainId,
        })
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
    created = await inTransaction(async (tx) => {
      const lastAllocated = await allocateHybridDeploySalt(sub, saltKey, tx)
      const counter = BigInt(lastAllocated)
      // Counter value 0 is NEVER issued: pad('0x', {size: 32}) is the same
      // salt as '0x' (sdk/delegate-account.ts), which is every pre-#4023
      // account. The counter starts allocating at 1 (migration 114).
      const deploySalt = deploySaltForCounter(counter)

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

      const existing = await findHybridAccountByAddressForUser(sub, accountAddress, chainId, tx)
      if (existing !== null) {
        throw new RegistrationRefusal(409, { error: 'Account already registered', id: existing.id })
      }

      // isFirst gates the SIGNUP default only (#4023: a created account never
      // becomes the default — the additional INSERT passes false whatever the
      // count; only this signup path may set it).
      const totalCount = await countAccountsForUser(sub, tx)
      const isFirst = !isAdditional && totalCount === 0n

      const inserted = await insertHybridAccount(
        {
          userId: sub,
          accountAddress,
          chainId,
          // owner_address: the EOA owner for treasury ops (#828 revoke). A
          // pure-passkey account has none — its config lives in
          // hybrid_account_passkeys.
          name: name?.trim() || 'My account',
          isDefault: isAdditional ? false : isFirst,
          ownerAddress: isAdditional ? null : (owner_address?.toLowerCase() ?? null),
          singleSignerWaiverAt: recordWaiver ? new Date().toISOString() : null,
          deploySalt,
          // ON CONFLICT DO NOTHING: the UNIQUE(user_id, chain_id,
          // LOWER(account_address)) index (migration 114) is the arbiter when
          // two concurrent creates derive the same address; the loser
          // re-reads below instead of 500ing on a bare constraint violation.
          createIdempotencyKey: idempotency_key ?? null,
        },
        tx,
      )
      if (inserted === null) {
        // The insert hit a unique index and wrote nothing. Two can fire.
        //
        // (1) UNIQUE(user_id, create_idempotency_key) — the in-flight retry
        // (#4024): the client timed out while the first create was still in
        // its transaction and retried with the same key. Both passed the
        // pre-check (no row yet); this one waited on the counter row, drew
        // counter N+1, derived a DIFFERENT address, and lost on the key. The
        // winner has committed, so this statement sees it: answer it exactly
        // as the pre-check would (the same pin). Throwing a refusal rolls
        // this transaction back, so the counter bump is not kept.
        if (isAdditional && idempotency_key) {
          const keyWinner = await findAccountByCreateIdempotencyKey(sub, idempotency_key, tx)
          if (keyWinner !== null) {
            const answer = await answerCreateReplay(keyWinner, { chainId, keyId: String(key_id) }, tx)
            if (answer.status === 409) throw new RegistrationRefusal(409, answer.body)
            throw new RegistrationRefusal(201, { __replay: true, ...answer.body })
          }
        }
        // (2) UNIQUE(user_id, chain_id, LOWER(account_address)) — the
        // unique-address race. The winner is either this user's own
        // concurrent create (answer it — the idempotency contract) or another
        // user's row at the same derived address (impossible without shared
        // keys, but then the 409 is the honest answer).
        const winner = await findHybridAccountByAddressForReplay(sub, accountAddress, chainId, tx)
        if (winner === null) {
          throw new RegistrationRefusal(409, { error: 'Account already registered' })
        }
        throw new RegistrationRefusal(201, {
          __replay: true,
          id: winner.id,
          account_address: accountAddress,
          chain_id: chainId,
          created_at: winner.created_at,
        })
      }
      const accountId = inserted.id

      // Persist the passkey signer set (#885): the account address was derived
      // from EXACTLY these coordinates, so activation (#860 deploy) and revoke
      // can reconstruct the owner config for a pure-passkey account.
      for (const pk of ownerPasskeys) {
        await insertHybridAccountPasskey(
          accountId,
          { keyId: pk.keyId, x: `0x${pk.x.toString(16)}`, y: `0x${pk.y.toString(16)}` },
          tx,
        )
      }

      return { id: accountId, account_address: accountAddress, created_at: inserted.created_at }
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
    const owned = await findOwnedHybridAccount(userId, address, chainId)
    if (!owned) {
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
    // #4099: record that the OWNER sent this, so the feed reads it as "You"
    // rather than an unattributed transfer. Written after the receipt — the
    // transfer already executed — and fail-soft: a failed write is logged and
    // the send still answers success. Attribution only; nothing on the
    // payment path reads the record.
    if (result.txHash) {
      try {
        await recordOwnerTransfer({
          userId: sub,
          accountId: resolved.account.accountId,
          chainId: resolved.account.chainId,
          txHash: result.txHash,
          userOpHash: result.userOpHash,
          tokenAddress: result.transfer.token,
          toAddress: result.transfer.to,
          amountRaw: result.transfer.amount.toString(),
        })
      } catch (err) {
        request.log.warn(
          { err, accountId: resolved.account.accountId, txHash: result.txHash },
          'owner transfer landed but its record failed; it will read as Unknown',
        )
      }
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
