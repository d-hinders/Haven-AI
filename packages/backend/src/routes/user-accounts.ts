import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { retiredSafeInflowHandler, retiredSafeInflowRoute } from '../middleware/safe-inflow-retired.js'
import {
  deleteAccountForUser,
  findOwnedAccountAddress,
  findOwnedAccountDefaultFlag,
  findOwnedAccountForFunding,
  listAccountsForUser,
  renameAccountForUser,
  setDefaultAccountForUser,
} from '../infra/repositories/smart-accounts.js'
import { getChainClient } from '../infra/chain/index.js'
import {
  balanceFreshness,
  combineBalanceFreshness,
  knownBalance,
  recordKnownBalance,
  type BalanceFreshness,
} from '../modules/accounts/index.js'
import { formatTokenValue } from '../domain/tokens.js'
import { getChain } from '../domain/chains.js'
import {
  formatTokenAmount,
  getFaucetUrl,
  minimumUsefulTokens,
  parseTokenAmount,
} from '@haven_ai/core'

/**
 * #2914 (naming epic #2906 phase 5, the contraction): the dual-emit mapper
 * (`withAccountAddressAlias`) and the `toSafeAddressed` shim that fed it are
 * both gone. The repository row already carries `account_address`, so these
 * handlers now return it unchanged — there is no projection left to do.
 */

// ── Types ─────────────────────────────────────────────────────────

interface RenameAccountBody {
  name: string
}

// ── Routes ────────────────────────────────────────────────────────

export default async function userAccountsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  // GET /user/accounts — list all linked accounts for the authenticated user.
  // One address name (`account_address`) and now ONE envelope key. The retired
  // `safes` twin outlived #2914 by exactly one release, because `@haven_ai/cli` on
  // `latest` destructured it at five call sites and cannot dual-read the way
  // it can dual-send; `latest` is 0.3.0-alpha.0 now and reads `accounts`.
  app.get('/', async (request) => {
    const { sub } = request.user as { sub: string }

    return { accounts: await listAccountsForUser(sub) }
  })

  // POST /user/accounts/deploy — TOMBSTONE (#1984 closed it, #1988 deleted the
  // body). It relay-sponsored a wallet-owned Safe deployment through
  // `relaySafeDeploy`, which is deleted with this slice. Note what it never
  // had: any check that the caller owned `owner_address`. The relayer paid gas
  // to deploy a Safe for whatever address a caller named, bounded only by a
  // global rate limit — a surface that is now gone rather than guarded.
  app.post('/deploy', retiredSafeInflowRoute('deploy'), retiredSafeInflowHandler('deploy'))

  // POST /user/accounts — TOMBSTONE (#1984 closed it, #1988 deleted the body).
  // Importing is the other half of creating; both are how a Safe entered Haven.
  app.post('/', retiredSafeInflowRoute('import'), retiredSafeInflowHandler('import'))

  // PUT /user/accounts/:accountId — rename an account
  app.put<{ Params: { accountId: string }; Body: RenameAccountBody }>(
    '/:accountId',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { accountId } = request.params
      const { name } = request.body

      // `name` is a required string of at least one character by the spec,
      // enforced before the handler (#3030); blank after trimming is the
      // one refusal no schema states.
      if (name.trim().length === 0) {
        return reply.code(400).send({ error: 'Name is required' })
      }

      const renamed = await renameAccountForUser(name.trim(), accountId, sub)

      if (!renamed) {
        return reply.code(404).send({ error: 'Account not found' })
      }

      return renamed
    },
  )

  // PUT /user/accounts/:accountId/default — set an account as the default
  app.put<{ Params: { accountId: string } }>(
    '/:accountId/default',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { accountId } = request.params

      // Verify the account belongs to the user
      const owned = await findOwnedAccountAddress(accountId, sub)
      if (!owned) {
        return reply.code(404).send({ error: 'Account not found' })
      }

      await setDefaultAccountForUser(accountId, owned.account_address, sub)

      return { success: true }
    },
  )

  // DELETE /user/accounts/:accountId — remove (unlink) an account
  app.delete<{ Params: { accountId: string } }>(
    '/:accountId',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { accountId } = request.params

      // Check the account exists and belongs to user
      const owned = await findOwnedAccountDefaultFlag(accountId, sub)
      if (!owned) {
        return reply.code(404).send({ error: 'Account not found' })
      }

      const deleted = await deleteAccountForUser(accountId, sub, owned.is_default)
      if (!deleted) {
        // `false` has two causes since #3227: a live delegation/sweep/re-key
        // kept the account, or the tenant-scoped DELETE matched no row —
        // which, past the ownership check above, means a concurrent unlink by
        // the same owner (a double click) removed it first. The account is
        // gone, which is what was asked for: answer as before the change.
        if (!(await findOwnedAccountDefaultFlag(accountId, sub))) {
          return { success: true }
        }
        return reply.code(409).send({
          error: 'Cannot unlink this Haven wallet while an agent has a pending or active budget delegation or recovery is in progress',
        })
      }

      return { success: true }
    },
  )

  // ── Funding facts (#2534) ─────────────────────────────────────────
//
// `GET /user/accounts/:accountId/funding` — the machine-readable funding hand-off.
//
// Funding is a HUMAN step (a transfer from the user's own wallet or exchange);
// today the only instruction is the address the dashboard renders, which an
// agent driving the CLI cannot see. This endpoint is READ-ONLY FACTS for the
// human to act on: chain identity, the per-token `minimum_useful_human`
// constants from `@haven_ai/core`, and the live balances. It constructs no
// transfer, calls no faucet, and grants no authority — the `owner_cli`
// opt-in covers it for exactly that reason, via the central allow-list.

interface FundingToken {
  symbol: string
  address: string
  decimals: number
  balance_human: string
  minimum_useful_human: string | null
  /**
   * #3317: present only when this token's balance read FAILED. Absent on a
   * clean read — additive, like the `BalanceItem` marker on /balances.
   */
  balanceFreshness?: BalanceFreshness
}

interface FundingResponse {
  account_address: string
  chain: { id: number; name: string; explorer_url: string }
  tokens: FundingToken[]
  native: {
    symbol: string
    balance_human: string
    needed: boolean
    /** #3317: present only when the native balance read failed. */
    balanceFreshness?: BalanceFreshness
  }
  faucet_url?: string
  funded: boolean
  /**
   * #3317: the worst marker across the token legs, when any read failed —
   * the aggregate that lets a consumer distrust the whole payload at a
   * glance (an `unavailable` leg means `funded` may be UNKNOWN-low, never
   * claimed true off the degraded data).
   */
  balanceFreshness?: BalanceFreshness
}

app.get<{ Params: { accountId: string } }>(
  '/:accountId/funding',
  async (request, reply): Promise<FundingResponse> => {
    const { sub } = request.user as { sub: string }
    const { accountId } = request.params

    // A malformed id is refused before the handler by the spec's
    // `format: uuid` (#3030) — 400, never 404, so a caller debugging a typo
    // still sees the two cases apart.

    // ONE tenant-scoped read: ownership, the account address and its chain, with
    // the delegation-rail scope the account lists apply (#2413) — funding
    // instructions are for the account an agent spends from.
    const owned = await findOwnedAccountForFunding(accountId, sub)
    if (!owned) {
      return reply.code(404).send({ error: 'Account not found' }) as never
    }
    const chainId = owned.chain_id
    const chain = getChain(chainId)

    // The same ethers-backed balance read `GET /balances/:accountAddress` runs —
    // no new chain machinery — and the two routes now share #3295's degraded
    // read: a failed leg serves the LAST-KNOWN balance for that (chain,
    // account, token), marked stale, or '0' marked `unavailable` when no
    // balance has ever been read (first read after a deploy). The endpoint
    // never 500s a hand-off whose whole job is to be pasteable, and it never
    // claims `funded` off a fabricated zero: `funded` counts only a KNOWN
    // value — a fresh read or a stale last-known one — so an RPC blip
    // (#2769's failure class) degrades the balance figures without
    // unfunding the account. The `balanceFreshness` markers are additive;
    // a clean read is byte-identical to the pre-#3317 response.
    // #3295: a fulfilled leg records the value as this token's last-known
    // balance (the store keeps even a zero — a successful read of zero is the
    // truth); a rejected leg substitutes the last-known balance, or the '0'
    // filler when none exists, and marks which happened.
    const client = getChainClient('ethers')
    const tokens = Object.values(chain.tokens)
    const nativeToken = tokens.find((t) => t.address === null)!
    const erc20Tokens = tokens.filter((t) => t.address !== null)

    const results = await Promise.allSettled([
      client.getNativeBalance(chainId, owned.account_address),
      ...erc20Tokens.map((token) =>
        client.getTokenBalance(chainId, token.address!, owned.account_address),
      ),
    ])

    const nativeResult = results[0]
    const nativeKnown = knownBalance(chainId, owned.account_address, null)
    if (nativeResult.status === 'fulfilled') {
      recordKnownBalance(chainId, owned.account_address, null, nativeResult.value.toString())
    }
    const nativeFreshness =
      nativeResult.status === 'rejected' ? balanceFreshness(true, nativeKnown) : null
    const nativeRaw =
      nativeResult.status === 'fulfilled'
        ? nativeResult.value.toString()
        : nativeKnown?.balance ?? '0'

    // One pass over the ERC-20s: project each balance to its human shape and
    // keep the raw atomic value alongside, because `funded` compares at the
    // atomic level (the same bigint the balance RPC returned) rather than
    // re-parsing a rounded human string. #3317: `funded` counts ONLY a known
    // value — a fresh read, or the stale last-known one a rejected read
    // serves. The '0' filler for a never-read token is not a balance, and a
    // fabricated zero must never unfund the account, so that token simply
    // cannot make the answer true (it can never make it false either: before
    // #3317 the filler zero fed the comparison and did exactly that).
    let funded = false
    const fundingTokens: FundingToken[] = erc20Tokens.map((token, i) => {
      const result = results[i + 1]
      const known = knownBalance(chainId, owned.account_address, token.address)
      if (result.status === 'fulfilled') {
        recordKnownBalance(chainId, owned.account_address, token.address, result.value.toString())
      }
      const raw =
        result.status === 'fulfilled'
          ? result.value.toString()
          : known?.balance ?? '0'
      const freshness =
        result.status === 'rejected' ? balanceFreshness(true, known) : null
      const minimum = minimumUsefulTokens(token.symbol)
      // #3317: `funded` counts only KNOWN values — a fresh read, or the stale
      // last-known one a rejected read serves (a figure we actually saw from
      // the chain). The '0' filler for a never-read token is not a balance
      // and cannot answer the comparison: unknown is not unfunded, and a
      // fabricated zero must never unfund the account.
      if (freshness?.status !== 'unavailable') {
        const rawBigint = BigInt(raw)
        if (minimum !== undefined && rawBigint >= parseTokenAmount(minimum, token.decimals)) {
          funded = true
        }
      }
      return {
        symbol: token.symbol,
        address: token.address!,
        decimals: token.decimals,
        balance_human: formatTokenValue(raw, token.decimals),
        minimum_useful_human: minimum ?? null,
        ...(freshness ? { balanceFreshness: freshness } : {}),
      }
    })
    const tokensFreshness = combineBalanceFreshness(
      fundingTokens.map((t) => t.balanceFreshness),
    )

    const response: FundingResponse = {
      account_address: owned.account_address,
      chain: { id: chainId, name: chain.name, explorer_url: chain.explorerUrl },
      tokens: fundingTokens,
      native: {
        symbol: nativeToken.symbol,
        balance_human: formatTokenAmount(BigInt(nativeRaw), nativeToken.decimals),
        // Sponsored UserOps: the human never needs ETH/xDAI to fund.
        needed: false,
        ...(nativeFreshness ? { balanceFreshness: nativeFreshness } : {}),
      },
      funded,
      ...(tokensFreshness ? { balanceFreshness: tokensFreshness } : {}),
    }
    const faucet = getFaucetUrl(chainId)
    if (faucet !== undefined) {
      response.faucet_url = faucet
    }
    return response
  },
)

// ── Approvers (Safe owners) — DELETED (#1988, epic #1440 slice 5) ────
  //
  // Five routes lived under the old prefix: a known-approvers list, a
  // per-account approver list and add, an owner-change transaction builder,
  // and a per-address removal. They constructed and
  // guarded Safe owner-change self-calls (Haven never signed one) and stored
  // the label/type decoration in `safe_approver_metadata` — the table the
  // epic's approved phase 5 drops in #1990. `modules/accounts/safe-owner-tx.ts`
  // went with them.
  //
  // WHAT THIS COSTS, stated rather than buried: this was Haven's only surface
  // for adding a backup owner to a legacy Safe (#1229's preventive recovery).
  // It is not the last way an owner reaches their account: an owner-signed
  // Safe transaction — including moving funds out — was relayable while the
  // owner-signed execution route stayed open (#2847 later deleted that last
  // live Safe-rail route), and a passkey already enrolled as an on-chain
  // owner still authorises there against the live owner list. Every one of the
  // 15 Safes in the epic's census is owned by an external EOA (or, in one
  // case, the prod relayer, wound down in #1985), and an EOA owner manages
  // owners directly at app.safe.global with their own key — which Haven's
  // non-custody rule requires to be true regardless of what Haven offers.
  //
  // The frontend callers (`ManageApprovers`, `RecoveryNudge`,
  // `useSafeApprovers`, `lib/approver-tx.ts`) are removed in #1989; until then
  // they see a 404 from these paths, the same owner-sequenced consequence
  // #1986 accepted for the approval queue.
}
