/**
 * Create-additional account provisioning, extracted from
 * `routes/hybrid-accounts.ts` (#4895, epic #4885).
 *
 * ## Why it moved
 *
 * The logic was inline in the route, inside its own transaction. Merchant
 * services (#4895) needs the SAME creation — a dedicated account whose owner
 * is one passkey copied server-side from a source account the caller owns —
 * but it has to commit the setting and the merchant marker in the SAME
 * transaction as the account row. A route cannot hand its transaction to
 * another route, so the logic became a function that takes one.
 *
 * ## What did NOT change
 *
 * The behaviour is the pre-#4895 route's, statement for statement:
 *
 * - the idempotency replay runs FIRST, before the source, key and cap checks
 *   (#4024) — a retried create answers the FIRST account, never a cap refusal;
 * - a key reused for a different chain or passkey is `IDEMPOTENCY_KEY_REUSED`,
 *   not the first account;
 * - the owner passkey's coordinates are copied from the SOURCE row's stored
 *   signer set, never from the request;
 * - the insert is `ON CONFLICT DO NOTHING` and the loser re-reads the winner
 *   instead of 500ing on a bare constraint violation;
 * - a created account never becomes the default.
 *
 * `routes/__tests__/hybrid-accounts.test.ts` and
 * `routes/__tests__/hybrid-accounts-create-race.db.test.ts` are the
 * characterization tests for that claim: they were written against the inline
 * version and are unchanged by the extraction.
 *
 * ## Refusals
 *
 * Every refusal is a `CreateAdditionalRefusal` carrying the HTTP status and
 * the body the route sends. It is THROWN rather than returned because the
 * caller is inside a transaction: a refusal must roll back the salt-counter
 * bump, and an exception is what `withTransaction` rolls back on. The caller
 * catches it and answers.
 */
import {
  allocateHybridDeploySalt,
  countAccountsForUserOnChain,
  findAccountByCreateIdempotencyKey,
  findDelegatorHybridAccountForUser,
  findHybridAccountByAddressForReplay,
  findHybridAccountByAddressForUser,
  insertHybridAccount,
  type Executor,
} from '../../infra/repositories/smart-accounts.js'
import {
  insertHybridAccountPasskey,
  listAccountPasskeys,
} from '../../infra/repositories/hybrid-signers.js'
import {
  computeUserHybridAccountAddress,
  deploySaltForCounter,
  type PasskeySigner,
} from '../../rails/hybrid-provisioning.js'
import { boundedErrorDetails } from '../payments/index.js'

/**
 * The create-additional refusal codes (#4024). Clients branch on these, never
 * on the sentence — the New account dialog maps each one
 * (`packages/frontend/src/lib/new-account.ts` carries the same constants).
 */
export const SOURCE_ACCOUNT_NOT_FOUND = 'SOURCE_ACCOUNT_NOT_FOUND'
export const SOURCE_HAS_NO_PASSKEY = 'SOURCE_HAS_NO_PASSKEY'
export const KEY_NOT_ON_SOURCE = 'KEY_NOT_ON_SOURCE'
export const ACCOUNT_CAP_REACHED = 'ACCOUNT_CAP_REACHED'
export const IDEMPOTENCY_KEY_REUSED = 'IDEMPOTENCY_KEY_REUSED'

/**
 * The chain the delegation rail does not serve. The pre-#4895 route answered
 * this case with a sentence and no code; #4895's dialog has to branch on it,
 * so the code is additive on the same 400.
 */
export const UNSUPPORTED_NETWORK = 'UNSUPPORTED_NETWORK'

/** Soft cap (#4023): accounts per user per chain. An 11th create answers 422. */
export const MAX_ACCOUNTS_PER_USER_PER_CHAIN = 10

export interface CreateAdditionalInput {
  userId: string
  chainId: number
  /** The account the caller owns whose stored signer set the new owner is copied from. */
  sourceAccountId: string
  /** The WebAuthn credential the user authenticated with; must be on the source. */
  keyId: string
  /** Display label; defaults to 'My account'. */
  name?: string
  /** Retried-create dedup, the payments.ts `send_idempotency_key` pattern. */
  idempotencyKey?: string
  /**
   * The single-signer acknowledgement to record on the row, or null (#1153).
   * The caller decides whether it applies — the route records it only for a
   * value-bearing chain below the signer floor — and this function writes it
   * verbatim, exactly as the inline version did.
   */
  singleSignerWaiverAt?: string | null
}

export interface CreatedAdditionalAccount {
  id: string
  account_address: string
  chain_id: number
  created_at: string
}

export interface CreateAdditionalResult {
  account: CreatedAdditionalAccount
  /**
   * True when this call answered an account an earlier (or concurrent) call
   * created — the idempotency replay, or the winner of a unique-index race.
   * False when this call inserted the row.
   */
  replayed: boolean
}

export interface CreateAdditionalOptions {
  /**
   * Whether a replay answered from the INSERT's CONFLICT path must roll the
   * caller's transaction back (#4024).
   *
   * Default `true`, which is the pre-#4895 behaviour: the losing insert drew a
   * salt counter value it never used, and the inline route threw a refusal to
   * throw that bump away with the transaction. `routes/hybrid-accounts.ts`
   * relies on it, and its race suite pins it.
   *
   * A caller that has its OWN writes to commit after the replay passes
   * `false`: merchant services marks the answered account and enables the
   * setting in the same transaction, so rolling back would undo them. The
   * skipped counter value is harmless — the counter is never reused.
   */
  rollbackOnReplay?: boolean
}

/**
 * A refusal raised INSIDE the caller's transaction. The rollback is the point
 * — a refused registration must commit nothing, not even the counter bump —
 * and the caller's catch turns it into the response.
 */
export class CreateAdditionalRefusal extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.error ?? 'create-additional refused'))
    this.name = 'CreateAdditionalRefusal'
  }
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
  executor: Executor,
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

/**
 * Create one additional account for `input.userId`, inside the caller's
 * transaction.
 *
 * The caller owns the transaction boundary: this function never opens one, so
 * a caller that also writes a setting or a marker commits them together with
 * the account row, the copied passkey and the salt-counter bump — or rolls
 * every one of them back.
 *
 * Throws `CreateAdditionalRefusal` for every refusal; returns the account
 * (and whether it was a replay) on success.
 */
export async function createAdditionalHybridAccount(
  input: CreateAdditionalInput,
  tx: Executor,
  options: CreateAdditionalOptions = {},
): Promise<CreateAdditionalResult> {
  const { userId, chainId, sourceAccountId, keyId, name, idempotencyKey, singleSignerWaiverAt } = input
  const rollbackOnReplay = options.rollbackOnReplay ?? true

  // Idempotent replay FIRST (#1207's rule, account-shaped; #4024): before the
  // source, key and cap are checked, and before anything is derived or
  // written, a retried create answers the FIRST account. The order is the
  // point. Until #4024 the cap ran first, so a retried 10th create whose
  // response was lost got "cap reached" instead of the account it had already
  // made — and a client could not tell the two apart. The read is scoped to
  // the caller (`userId`), so a key never replays another user's row; another
  // user's identical key is simply a new create.
  if (idempotencyKey) {
    const replay = await findAccountByCreateIdempotencyKey(userId, idempotencyKey, tx)
    if (replay !== null) {
      const answer = await answerCreateReplay(replay, { chainId, keyId }, tx)
      if (answer.status === 409) throw new CreateAdditionalRefusal(409, answer.body)
      return {
        account: {
          id: String(answer.body.id),
          account_address: String(answer.body.account_address),
          chain_id: Number(answer.body.chain_id),
          created_at: String(answer.body.created_at),
        },
        replayed: true,
      }
    }
  }

  // Resolve the owner passkey from the SOURCE row: the server copies the ONE
  // named passkey's coordinates from the source account's stored signer set —
  // never from the request. Each refusal carries an error_code (#4024).
  const source = await findDelegatorHybridAccountForUser(userId, sourceAccountId, tx)
  if (source === null) {
    throw new CreateAdditionalRefusal(404, {
      error: 'Source account not found',
      error_code: SOURCE_ACCOUNT_NOT_FOUND,
    })
  }
  const sourceSigners = await listAccountPasskeys(source.id, tx)
  if (sourceSigners.length === 0) {
    throw new CreateAdditionalRefusal(422, {
      error: 'The source account has no passkey to copy, so it cannot secure an additional account',
      error_code: SOURCE_HAS_NO_PASSKEY,
    })
  }
  const named = sourceSigners.find((s) => s.key_id.toLowerCase() === keyId.toLowerCase())
  if (!named) {
    throw new CreateAdditionalRefusal(422, {
      error: 'key_id is not a passkey on the source account',
      error_code: KEY_NOT_ON_SOURCE,
    })
  }
  const ownerPasskeys: PasskeySigner[] = [
    { keyId: named.key_id, x: BigInt(named.public_key_x), y: BigInt(named.public_key_y) },
  ]
  const saltKey = named.key_id

  // Soft cap (#4023): 10 accounts per user per chain. Deliberately soft — the
  // cap bounds accident and abuse, not a business rule.
  const cap = await countAccountsForUserOnChain(userId, chainId, tx)
  if (cap >= BigInt(MAX_ACCOUNTS_PER_USER_PER_CHAIN)) {
    throw new CreateAdditionalRefusal(422, {
      error: `This user already has ${MAX_ACCOUNTS_PER_USER_PER_CHAIN} accounts on chain ${chainId}`,
      error_code: ACCOUNT_CAP_REACHED,
      cap: MAX_ACCOUNTS_PER_USER_PER_CHAIN,
      chain_id: chainId,
    })
  }

  // The counter bump, the derived row and the copied passkeys commit together
  // or not at all (#4023). The chain round-trip inside the transaction (the
  // derivation RPC) trades a pooled connection for that atomicity;
  // registration is a once-per-account operation, the same trade the #1673
  // deploy lock measures as acceptable.
  const lastAllocated = await allocateHybridDeploySalt(userId, saltKey, tx)
  const counter = BigInt(lastAllocated)
  // Counter value 0 is NEVER issued: pad('0x', {size: 32}) is the same salt as
  // '0x' (sdk/delegate-account.ts), which is every pre-#4023 account. The
  // counter starts allocating at 1 (migration 114).
  const deploySalt = deploySaltForCounter(counter)

  let accountAddress: string
  try {
    accountAddress = await computeUserHybridAccountAddress(chainId, {
      ownerAddress: undefined,
      passkeys: ownerPasskeys,
      deploySalt,
    })
  } catch (err) {
    throw new CreateAdditionalRefusal(502, {
      error: 'Could not derive the account address',
      details: boundedErrorDetails(err), // #3609: redacted + bounded
    })
  }

  const existing = await findHybridAccountByAddressForUser(userId, accountAddress, chainId, tx)
  if (existing !== null) {
    throw new CreateAdditionalRefusal(409, { error: 'Account already registered', id: existing.id })
  }

  const inserted = await insertHybridAccount(
    {
      userId,
      accountAddress,
      chainId,
      // owner_address: the EOA owner for treasury ops (#828 revoke). A
      // pure-passkey account has none — its config lives in
      // hybrid_account_passkeys.
      name: name?.trim() || 'My account',
      // A created account NEVER becomes the default (#4023): the additional
      // INSERT passes false whatever the count; only the signup path may set it.
      isDefault: false,
      ownerAddress: null,
      singleSignerWaiverAt: singleSignerWaiverAt ?? null,
      deploySalt,
      // ON CONFLICT DO NOTHING: the UNIQUE(user_id, chain_id,
      // LOWER(account_address)) index (migration 114) is the arbiter when two
      // concurrent creates derive the same address; the loser re-reads below
      // instead of 500ing on a bare constraint violation.
      createIdempotencyKey: idempotencyKey ?? null,
    },
    tx,
  )
  if (inserted === null) {
    // The insert hit a unique index and wrote nothing. Two can fire.
    //
    // (1) UNIQUE(user_id, create_idempotency_key) — the in-flight retry
    // (#4024): the client timed out while the first create was still in its
    // transaction and retried with the same key. Both passed the pre-check (no
    // row yet); this one waited on the counter row, drew counter N+1, derived
    // a DIFFERENT address, and lost on the key. The winner has committed, so
    // this statement sees it: answer it exactly as the pre-check would (the
    // same pin). Throwing a refusal rolls this transaction back, so the
    // counter bump is not kept.
    if (idempotencyKey) {
      const keyWinner = await findAccountByCreateIdempotencyKey(userId, idempotencyKey, tx)
      if (keyWinner !== null) {
        const answer = await answerCreateReplay(keyWinner, { chainId, keyId }, tx)
        if (answer.status === 409) throw new CreateAdditionalRefusal(409, answer.body)
        // The counter bump this transaction drew must go with it (#4024) —
        // unless the caller has its own writes to commit after the replay.
        if (rollbackOnReplay) throw new CreateAdditionalRefusal(201, answer.body)
        return {
          account: {
            id: String(answer.body.id),
            account_address: String(answer.body.account_address),
            chain_id: Number(answer.body.chain_id),
            created_at: String(answer.body.created_at),
          },
          replayed: true,
        }
      }
    }
    // (2) UNIQUE(user_id, chain_id, LOWER(account_address)) — the
    // unique-address race. The winner is either this user's own concurrent
    // create (answer it — the idempotency contract) or another user's row at
    // the same derived address (impossible without shared keys, but then the
    // 409 is the honest answer).
    const winner = await findHybridAccountByAddressForReplay(userId, accountAddress, chainId, tx)
    if (winner === null) {
      throw new CreateAdditionalRefusal(409, { error: 'Account already registered' })
    }
    const replayBody = {
      id: winner.id,
      account_address: accountAddress,
      chain_id: chainId,
      created_at: winner.created_at,
    }
    if (rollbackOnReplay) throw new CreateAdditionalRefusal(201, replayBody)
    return { account: replayBody, replayed: true }
  }

  // Persist the passkey signer set (#885): the account address was derived
  // from EXACTLY these coordinates, so activation (#860 deploy) and revoke can
  // reconstruct the owner config for a pure-passkey account.
  for (const pk of ownerPasskeys) {
    await insertHybridAccountPasskey(
      inserted.id,
      { keyId: pk.keyId, x: `0x${pk.x.toString(16)}`, y: `0x${pk.y.toString(16)}` },
      tx,
    )
  }

  return {
    account: {
      id: inserted.id,
      account_address: accountAddress,
      chain_id: chainId,
      created_at: inserted.created_at,
    },
    replayed: false,
  }
}
