/**
 * Merchant services — turning them on and off, and the dashboard read
 * (#4895, epic #4885).
 *
 * ## What this route does
 *
 * A signed-in user with at least one account calls `POST /merchant-services`
 * to turn merchant services on. In ONE transaction the route:
 *
 *   1. records the per-user setting (`merchant_service_settings.enabled`),
 *   2. creates a dedicated account through the SAME create-additional path the
 *      New account dialog uses (`modules/accounts/create-additional.ts`), and
 *   3. marks that account as the merchant account
 *      (`smart_accounts.is_merchant_account`).
 *
 * The FIRST turn-on carries what the existing path takes — the network, the
 * user's existing account and the id of one of its passkeys. It names NO
 * account to mark: the account is the one this request creates. The server
 * receives no passkey assertion; it checks that the passkey id belongs to the
 * source account, and the session is the authentication.
 *
 * Once the merchant account exists, turning merchant services back on needs
 * none of the three: the route answers the existing account without calling
 * the creation logic, so there is no network to choose and no passkey to copy.
 * The dialog sends an empty request then. All three fields are therefore
 * optional in the schema and required by the handler only when there is no
 * merchant account yet (`MERCHANT_SETUP_DETAILS_REQUIRED`).
 *
 * `DELETE /merchant-services` records the setting as off and keeps the account
 * and its history. `GET /merchant-services` returns the setting and the
 * merchant account for the dashboard.
 *
 * ## One merchant account per user, on one network
 *
 * The database enforces the first half: `smart_accounts_one_merchant_per_user`
 * is a partial unique index on `(user_id) WHERE is_merchant_account`
 * (migration 126). The second half is this route's: the network chosen when
 * merchant services are first turned on is permanent for the pilot, so a
 * turn-on naming a different chain is refused with
 * `MERCHANT_ACCOUNT_ON_OTHER_NETWORK` — never with the generic key-reuse code,
 * because the existing-merchant-account check runs BEFORE the creation logic
 * and therefore before any idempotency key is derived. It also runs before
 * the supported-network check, so any network other than the account's gets
 * that one code, served or not.
 *
 * ## Why the setting row is locked first
 *
 * Two tabs, or a double click, both reach the "is there already a merchant
 * account?" read. `lockMerchantSetting` takes a row lock on the caller's
 * setting row, so the second request waits for the first to commit and then
 * sees its account. Without the lock both would read "none" and both would
 * enter the creation logic. The derived idempotency key would still stop a
 * second account row — the loser conflicts on the key's unique index and
 * answers the winner — but only after it had derived an address and drawn a
 * salt-counter value it then throws away. The lock makes the read above
 * authoritative, so the second request never reaches the creation logic.
 *
 * ## Money path
 *
 * The route creates a spend-capable account and decides which account merchant
 * payments are received into, so it carries the money-path rate limit and sits
 * on the money-path perimeter. Nothing here moves funds or signs anything.
 */
import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { moneyPathRateLimit } from '../middleware/rate-limit.js'
import { DELEGATION_RAIL_CHAIN_IDS } from '../rails/delegation-contracts.js'
import { inTransaction } from '../infra/repositories/smart-accounts.js'
import {
  disableMerchantSetting,
  enableMerchantSetting,
  findMerchantAccountForUser,
  lockMerchantSetting,
  markMerchantAccount,
  readMerchantSetting,
  type MerchantAccountRow,
} from '../infra/repositories/merchant-services.js'
// dep-lint-exempt: the create-additional provisioning must reach the smart-account and hybrid-signer repositories, and `infra/repositories/analytics.ts` imports the accounts barrel — so re-exporting this file from `modules/accounts/index.ts` closes an accounts ↔ repositories cycle. The deep import is the only acyclic path (#4895).
import {
  createAdditionalHybridAccount,
  CreateAdditionalRefusal,
  UNSUPPORTED_NETWORK,
} from '../modules/accounts/create-additional.js'
import {
  MERCHANT_ACCOUNT_ADDRESS_UNAVAILABLE,
  MERCHANT_ACCOUNT_ALREADY_REGISTERED,
  MERCHANT_ACCOUNT_NAME,
  MERCHANT_ACCOUNT_ON_OTHER_NETWORK,
  MERCHANT_SETUP_DETAILS_REQUIRED,
  merchantIdempotencyKey,
} from '../domain/merchant-services.js'

/**
 * Every field is optional on the wire: required the first time, when the
 * account is created, and not needed once the merchant account exists.
 */
interface TurnOnBody {
  /** The network the merchant account is created on. Permanent for the pilot. */
  chain_id?: number
  /** An account the caller owns; the merchant account's owner passkey is copied from it. */
  source_account_id?: string
  /** The WebAuthn credential the user authenticated with; must be on the source account. */
  key_id?: string
}

/**
 * A refusal raised INSIDE the turn-on transaction. Thrown rather than returned
 * so the transaction rolls back — a refused turn-on must commit nothing, not
 * even the setting row's `updated_at`.
 */
class MerchantRefusal extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.error ?? 'merchant services refused'))
    this.name = 'MerchantRefusal'
  }
}

/** The wire shape of the merchant account. */
function serializeMerchantAccount(row: MerchantAccountRow): Record<string, unknown> {
  return {
    id: row.id,
    account_address: row.account_address,
    chain_id: Number(row.chain_id),
    name: row.name,
    created_at: row.created_at,
  }
}

export default async function merchantServiceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  /**
   * Turn merchant services on.
   *
   * 201 when this request created the account, 200 when it answered an
   * existing one (a repeat, a retry, or the second tab). Both carry the same
   * body; `created` says which happened.
   */
  app.post<{ Body: TurnOnBody | null }>('/', { config: moneyPathRateLimit }, async (request, reply) => {
    const { sub } = request.user as { sub: string }
    // Turning merchant services back on sends no body at all.
    const { chain_id, source_account_id, key_id } = request.body ?? {}

    let outcome: { account: MerchantAccountRow; created: boolean }
    try {
      outcome = await inTransaction(async (tx) => {
        // Serialise concurrent turn-ons for this user. See the header.
        await lockMerchantSetting(sub, tx)

        // The existing-merchant-account check runs BEFORE the creation logic,
        // so turning merchant services back on answers the account with no
        // network and no passkey in the request — and a network that IS named
        // and differs is refused with its own code rather than reaching the
        // idempotency key.
        const existing = await findMerchantAccountForUser(sub, tx)
        if (existing !== null) {
          if (chain_id !== undefined && Number(existing.chain_id) !== chain_id) {
            throw new MerchantRefusal(409, {
              error:
                `Merchant services are already on for chain ${existing.chain_id}. ` +
                "The merchant account's network is permanent for the pilot.",
              error_code: MERCHANT_ACCOUNT_ON_OTHER_NETWORK,
              chain_id: Number(existing.chain_id),
            })
          }
          await enableMerchantSetting(sub, tx)
          return { account: existing, created: false }
        }

        // No merchant account yet, so this request creates it and needs all
        // three fields. Every refusal below is thrown, so the setting row the
        // lock created rolls back with the transaction.
        const missing = [
          ...(chain_id === undefined ? ['chain_id'] : []),
          ...(source_account_id === undefined ? ['source_account_id'] : []),
          ...(key_id === undefined ? ['key_id'] : []),
        ]
        if (chain_id === undefined || source_account_id === undefined || key_id === undefined) {
          throw new MerchantRefusal(400, {
            error: `Turning merchant services on for the first time needs ${missing.join(', ')}`,
            error_code: MERCHANT_SETUP_DETAILS_REQUIRED,
            missing,
          })
        }

        // A code the dialog can branch on (#4895) — the create-additional
        // path answered this case with a sentence and no code.
        if (!DELEGATION_RAIL_CHAIN_IDS.has(chain_id)) {
          throw new MerchantRefusal(400, {
            error: `Merchant services are not available on chain ${chain_id} yet`,
            error_code: UNSUPPORTED_NETWORK,
            supported: [...DELEGATION_RAIL_CHAIN_IDS],
          })
        }

        // The SAME creation the New account dialog uses, inside THIS
        // transaction — so the setting, the account and the marker commit
        // together or not at all.
        const created = await createAdditionalHybridAccount(
          {
            userId: sub,
            chainId: chain_id,
            sourceAccountId: source_account_id,
            keyId: key_id,
            name: MERCHANT_ACCOUNT_NAME,
            idempotencyKey: merchantIdempotencyKey(chain_id),
          },
          tx,
          // This transaction has its own writes to commit after the replay
          // (the marker and the setting), so a conflict-path replay must NOT
          // roll it back. The setting-row lock makes that path unreachable
          // here anyway; the flag keeps the marker from being skipped if it
          // ever fires.
          { rollbackOnReplay: false },
        )

        // False only for a replayed account that is the caller's default —
        // never for the account this request just created. Thrown, so the
        // setting row rolls back with everything else.
        if (!(await markMerchantAccount(sub, created.account.id, tx))) {
          throw new MerchantRefusal(409, {
            error: 'The account already registered for merchant services cannot be used',
            error_code: MERCHANT_ACCOUNT_ALREADY_REGISTERED,
          })
        }
        // Re-read so the reply carries the row's name and created_at, not the
        // creation result's narrower shape.
        const account = await findMerchantAccountForUser(sub, tx)
        if (account === null) {
          throw new Error('merchant account missing inside the transaction that marked it')
        }
        await enableMerchantSetting(sub, tx)
        return { account, created: !created.replayed }
      })
    } catch (err) {
      if (err instanceof MerchantRefusal) return reply.code(err.status).send(err.body)
      if (err instanceof CreateAdditionalRefusal) {
        // The creation logic has two refusals with no code of its own: the
        // address could not be derived (502) and the derived address is
        // already registered (409). The dialog branches on codes, so this
        // route names them; `POST /accounts/hybrid` answers them as it did.
        // Matched on the status, so a future code-less refusal is not given
        // one of these two names by default.
        const fallback =
          err.status === 502
            ? MERCHANT_ACCOUNT_ADDRESS_UNAVAILABLE
            : err.status === 409
              ? MERCHANT_ACCOUNT_ALREADY_REGISTERED
              : undefined
        const error_code = err.body.error_code ?? fallback
        return reply.code(err.status).send(error_code === undefined ? err.body : { ...err.body, error_code })
      }
      throw err
    }

    return reply.code(outcome.created ? 201 : 200).send({
      enabled: true,
      created: outcome.created,
      merchant_account: serializeMerchantAccount(outcome.account),
    })
  })

  /**
   * Turn merchant services off.
   *
   * Records the setting and keeps the account and its history — the account is
   * NOT unlinked, and the marker stays, so turning the feature back on reuses
   * the same account. Idempotent: turning off when it was never on answers the
   * same body.
   */
  app.delete('/', async (request) => {
    const { sub } = request.user as { sub: string }
    const account = await inTransaction(async (tx) => {
      await lockMerchantSetting(sub, tx)
      await disableMerchantSetting(sub, tx)
      return findMerchantAccountForUser(sub, tx)
    })
    return {
      enabled: false,
      merchant_account: account === null ? null : serializeMerchantAccount(account),
    }
  })

  /**
   * The dashboard read: the setting and the merchant account, in one
   * authenticated call. Both reads are scoped to the caller, so another user's
   * setting is never returned.
   */
  app.get('/', async (request) => {
    const { sub } = request.user as { sub: string }
    const setting = await readMerchantSetting(sub)
    const account = await findMerchantAccountForUser(sub)
    return {
      enabled: setting?.enabled ?? false,
      enabled_at: setting?.enabled_at ?? null,
      disabled_at: setting?.disabled_at ?? null,
      merchant_account: account === null ? null : serializeMerchantAccount(account),
    }
  })
}
