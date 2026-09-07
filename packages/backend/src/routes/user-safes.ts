import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { retiredSafeInflowHandler } from '../middleware/safe-inflow-retired.js'
import {
  deleteSafeForUser,
  findOwnedSafeAddress,
  findOwnedSafeDefaultFlag,
  findOwnedSafeForFunding,
  listSafesForUser,
  renameSafeForUser,
  setDefaultSafeForUser,
} from '../infra/repositories/user-safes.js'
import { getChainClient } from '../infra/chain/index.js'
import { formatTokenValue } from '../domain/tokens.js'
import { getChain } from '../domain/chains.js'
import {
  formatTokenAmount,
  getFaucetUrl,
  minimumUsefulTokens,
  parseTokenAmount,
  UUID_RE,
} from '@haven_ai/core'

// ── Types ─────────────────────────────────────────────────────────

interface RenameSafeBody {
  name: string
}

// ── Routes ────────────────────────────────────────────────────────

export default async function userSafesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  // GET /user/safes — list all Safes for the authenticated user
  app.get('/', async (request) => {
    const { sub } = request.user as { sub: string }

    const safes = await listSafesForUser(sub)

    return { safes }
  })

  // POST /user/safes/deploy — TOMBSTONE (#1984 closed it, #1988 deleted the
  // body). It relay-sponsored a wallet-owned Safe deployment through
  // `relaySafeDeploy`, which is deleted with this slice. Note what it never
  // had: any check that the caller owned `owner_address`. The relayer paid gas
  // to deploy a Safe for whatever address a caller named, bounded only by a
  // global rate limit — a surface that is now gone rather than guarded.
  app.post('/deploy', retiredSafeInflowHandler('deploy'))

  // POST /user/safes — TOMBSTONE (#1984 closed it, #1988 deleted the body).
  // Importing is the other half of creating; both are how a Safe entered Haven.
  app.post('/', retiredSafeInflowHandler('import'))

  // PUT /user/safes/:safeId — rename a Safe
  app.put<{ Params: { safeId: string }; Body: RenameSafeBody }>(
    '/:safeId',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { safeId } = request.params
      const { name } = request.body

      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return reply.code(400).send({ error: 'Name is required' })
      }

      const renamed = await renameSafeForUser(name.trim(), safeId, sub)

      if (!renamed) {
        return reply.code(404).send({ error: 'Safe not found' })
      }

      return renamed
    },
  )

  // PUT /user/safes/:safeId/default — set a Safe as the default
  app.put<{ Params: { safeId: string } }>(
    '/:safeId/default',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { safeId } = request.params

      // Verify the Safe belongs to the user
      const owned = await findOwnedSafeAddress(safeId, sub)
      if (!owned) {
        return reply.code(404).send({ error: 'Safe not found' })
      }

      await setDefaultSafeForUser(safeId, owned.safe_address, sub)

      return { success: true }
    },
  )

  // DELETE /user/safes/:safeId — remove (unlink) a Safe
  app.delete<{ Params: { safeId: string } }>(
    '/:safeId',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { safeId } = request.params

      // Check the Safe exists and belongs to user
      const owned = await findOwnedSafeDefaultFlag(safeId, sub)
      if (!owned) {
        return reply.code(404).send({ error: 'Safe not found' })
      }

      const deleted = await deleteSafeForUser(safeId, sub, owned.is_default)
      if (!deleted) {
        return reply.code(409).send({
          error: 'Cannot unlink this Haven wallet while an agent has a pending or active budget delegation or recovery is in progress',
        })
      }

      return { success: true }
    },
  )

  // ── Funding facts (#2534) ─────────────────────────────────────────
//
// `GET /user/safes/:safeId/funding` — the machine-readable funding hand-off.
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
}

interface FundingResponse {
  account_address: string
  chain: { id: number; name: string; explorer_url: string }
  tokens: FundingToken[]
  native: { symbol: string; balance_human: string; needed: boolean }
  faucet_url?: string
  funded: boolean
}

app.get<{ Params: { safeId: string } }>(
  '/:safeId/funding',
  async (request, reply): Promise<FundingResponse> => {
    const { sub } = request.user as { sub: string }
    const { safeId } = request.params

    // Format first: a malformed id cannot name a row, so answering 400 rather
    // than 404 keeps the two cases apart for a caller debugging a typo.
    if (!UUID_RE.test(safeId)) {
      return reply.code(400).send({ error: 'Invalid Safe id' }) as never
    }

    // ONE tenant-scoped read: ownership, the Safe address and its chain, with
    // the delegation-rail scope the account lists apply (#2413) — funding
    // instructions are for the account an agent spends from.
    const owned = await findOwnedSafeForFunding(safeId, sub)
    if (!owned) {
      return reply.code(404).send({ error: 'Safe not found' }) as never
    }
    const chainId = owned.chain_id
    const chain = getChain(chainId)

    // The same ethers-backed balance read `GET /balances/:safeAddress` runs —
    // no new chain machinery, and a failed read reads as zero exactly as it
    // does there (a balance RPC hiccup must not 500 a hand-off whose whole
    // job is to be pasteable).
    const client = getChainClient('ethers')
    const tokens = Object.values(chain.tokens)
    const nativeToken = tokens.find((t) => t.address === null)!
    const erc20Tokens = tokens.filter((t) => t.address !== null)

    const results = await Promise.allSettled([
      client.getNativeBalance(chainId, owned.safe_address),
      ...erc20Tokens.map((token) =>
        client.getTokenBalance(chainId, token.address!, owned.safe_address),
      ),
    ])

    const nativeRaw =
      results[0].status === 'fulfilled' ? results[0].value.toString() : '0'

    // One pass over the ERC-20s: project each balance to its human shape and
    // keep the raw atomic value alongside, because `funded` compares at the
    // atomic level (the same bigint the balance RPC returned) rather than
    // re-parsing a rounded human string.
    let funded = false
    const fundingTokens: FundingToken[] = erc20Tokens.map((token, i) => {
      const result = results[i + 1]
      const raw = result.status === 'fulfilled' ? result.value.toString() : '0'
      const minimum = minimumUsefulTokens(token.symbol)
      const rawBigint = BigInt(raw)
      if (minimum !== undefined && rawBigint >= parseTokenAmount(minimum, token.decimals)) {
        funded = true
      }
      return {
        symbol: token.symbol,
        address: token.address!,
        decimals: token.decimals,
        balance_human: formatTokenValue(raw, token.decimals),
        minimum_useful_human: minimum ?? null,
      }
    })

    const response: FundingResponse = {
      account_address: owned.safe_address,
      chain: { id: chainId, name: chain.name, explorer_url: chain.explorerUrl },
      tokens: fundingTokens,
      native: {
        symbol: nativeToken.symbol,
        balance_human: formatTokenAmount(BigInt(nativeRaw), nativeToken.decimals),
        // Sponsored UserOps: the human never needs ETH/xDAI to fund.
        needed: false,
      },
      funded,
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
  // Five routes lived here: `GET /user/safes/known-approvers`, `GET|POST
  // /user/safes/:safeId/approvers`, `POST /user/safes/:safeId/approvers/tx`
  // and `DELETE /user/safes/:safeId/approvers/:address`. They constructed and
  // guarded Safe owner-change self-calls (Haven never signed one) and stored
  // the label/type decoration in `safe_approver_metadata` — the table the
  // epic's approved phase 5 drops in #1990. `modules/accounts/safe-owner-tx.ts`
  // went with them.
  //
  // WHAT THIS COSTS, stated rather than buried: this was Haven's only surface
  // for adding a backup owner to a legacy Safe (#1229's preventive recovery).
  // It is not the last way an owner reaches their account. `POST /safe/exec`
  // stays OPEN, so an owner-signed Safe transaction — including moving funds
  // out — is still relayable, and a passkey already enrolled as an on-chain
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
