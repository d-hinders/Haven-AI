import { RelayerBudgetExceededError } from '../lib/relayer-spend-guard.js'
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ethers } from 'ethers'
import { hashTypedData } from 'viem'
import { buildX402ExpectedMessage, type X402ExpectedContext } from '@haven_ai/sdk'
import pool from '../db.js'
import { agentAuthMiddleware, type AgentContext } from '../middleware/agentAuth.js'
import { moneyPathRateLimit } from '../middleware/rate-limit.js'
import { AgentPaymentNextAction, AgentPaymentPhase, AgentPaymentRail } from '../lib/agent-payment-taxonomy.js'
import { getExplorerUrl } from '../lib/chains.js'
import { getFiatValuesForTokenAmount } from '../lib/fiat-values.js'
import { formatTokenValue } from '../lib/tokens.js'
import { isAddress as isValidAddress } from '@haven_ai/core'
import {
  getTokenAllowance,
  getTokenBalance,
  getLatestBlockTimeSec,
  computeEffectiveAllowance,
  generateTransferHash,
  recoverSigner,
  executeAllowanceTransfer,
} from '../lib/allowance-module.js'
import { waitForFreshAllowanceNonce } from '../lib/allowance-nonce-coordinator.js'
import { tryRecordMachinePaymentEvidenceBaseById } from '../lib/machine-payment-evidence.js'
import {
  createMachineApproval,
  createPaymentIntent,
  resolvePaymentToken,
  type PaymentIntentRow,
} from '../lib/machine-payments.js'
import { decideCoverage } from '../lib/payment-coverage.js'
import { passportReferenceFor } from '../lib/passport/x402-delivery.js'
import { emitFunnelEvent } from '../lib/onboarding-funnel.js'
import {
  agentPaymentStatusHttpCode,
  getAgentPaymentStatus,
} from '../lib/agent-payment-status.js'
import { redactVendorSecrets } from '../lib/execution-rail.js'
import { selectDelegation, prepareDelegationPayment } from '../lib/delegation-authorization.js'
import { userOpTypedData } from '../lib/delegation-rail.js'
import { delegationSigningPayload, recoverDelegationSigner } from '../lib/delegation-policy.js'
import { computeHybridAccountAddress } from '../lib/hybrid-provisioning.js'
import {
  buildSettlementDelegation,
  assembleSettlementPayload,
  encodeXPaymentHeader,
} from '../lib/x402-delegation.js'
import { serializeUserOp, deserializeUserOp, resolveExecutionRail, sessionRailRetired } from '../lib/execution-rail.js'

// ── Constants ─────────────────────────────────────────────────────

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const DECIMAL_ATOMIC_AMOUNT_RE = /^[0-9]+$/

// ── Types ─────────────────────────────────────────────────────────

interface X402AuthorizeBody {
  url: string
  payTo: string
  merchantPayTo?: string
  amount: string          // atomic units
  asset: string           // token contract address
  network: string         // CAIP-2 chain ID or x402 network name
  description?: string
  maxTimeoutSeconds?: number
  category?: string       // api_access, data, compute
  idempotencyKey?: string
  signature?: string      // delegate signature (optional — enables one-shot authorize+execute)
  /**
   * #946: explicit settlement-scheme request on the delegation rail
   * ('erc7710' | 'eip3009'). Optional — the payTo shape (merchant vs the
   * agent's own delegate EOA) already selects the scheme; when present this
   * is validated against that shape so a confused client fails loudly
   * instead of getting the wrong flow.
   */
  settlementScheme?: string
  /**
   * #1058: the erc7710 challenge entry's `extra.facilitatorAddresses`,
   * forwarded VERBATIM. Pins the settlement child's redeemer caveat and is
   * echoed in the v2 X-PAYMENT header's accepted entry.
   */
  facilitatorAddresses?: string[]
}

interface X402ApprovalRow {
  id: string
  status: string
  token_symbol: string
  amount_human: string
  expires_at: string
  machine_challenge_id: string | null
}

// Deliberately the SDK's type, not a local copy: the edge signer rebuilds this
// message from @haven_ai/sdk, so a divergent backend copy would silently sign a
// message no signer can reconstruct. The local clone had already gone stale
// against the v2 typedDataHash field (#1138).

// ── Helpers ───────────────────────────────────────────────────────

function isPositiveDecimalAtomicAmount(value: string): boolean {
  return DECIMAL_ATOMIC_AMOUNT_RE.test(value) && BigInt(value) > 0n
}

/**
 * Normalise an Ethereum address to its canonical EIP-55 checksum form.
 *
 * x402 payment-required headers are emitted by third-party services that may
 * ship malformed (non-checksummed or mis-cased) addresses. ethers v6 throws
 * `bad address checksum` when ABI-encoding such values, which surfaced here
 * as a confusing "Failed to generate transfer hash" error.
 *
 * Lower-casing first lets `getAddress()` skip checksum validation and just
 * recompute it, so any 40-hex address (any casing) is accepted.
 */
function normaliseAddress(addr: string): string {
  return ethers.getAddress(addr.toLowerCase())
}

function chainIdFromX402Network(network: string): number | null {
  if (network === 'base') return 8453
  if (network.startsWith('eip155:')) {
    const chainId = Number(network.slice('eip155:'.length))
    return Number.isInteger(chainId) ? chainId : null
  }
  return null
}

/**
 * EIP-712 digest of the payload the account actually validates (#1138).
 *
 * On the delegation rail `payloadHash` is the bare ERC-4337 UserOp hash, which
 * the account does NOT validate — so binding it alone tells the edge signer
 * nothing about the typed data it is being asked to sign. Committing to this
 * digest inside the Haven-signed expected context is what keeps the signer's
 * verify-then-sign property intact on this rail.
 */
function typedDataDigest(typedData: unknown): string | undefined {
  if (!typedData || typeof typedData !== 'object') return undefined
  try {
    return hashTypedData(typedData as Parameters<typeof hashTypedData>[0])
  } catch (err) {
    // Unhashable typed data is a backend defect, not a client error, and it is
    // not survivable: the edge signer re-derives this same digest and would
    // refuse the payload anyway. Fail here with a message that says so, rather
    // than letting a raw viem type error surface as an opaque 500.
    throw new Error(
      'Failed to hash the delegation-rail signing payload for the x402 expected context. ' +
        'sign_data.typed_data must be a complete EIP-712 payload (domain, types, primaryType, message). ' +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

async function signX402ExpectedContext(context: X402ExpectedContext) {
  const privateKey = process.env.X402_BINDING_PRIVATE_KEY
  if (!privateKey) {
    throw new Error(
      'X402_BINDING_PRIVATE_KEY must be set to authenticate x402 expected context. ' +
        'Do not fall back to RELAYER_PRIVATE_KEY — the binding signer must be a dedicated key ' +
        'so that the edge signer can verify it against HAVEN_X402_BINDING_SIGNER.',
    )
  }
  const wallet = new ethers.Wallet(privateKey)
  const message = buildX402ExpectedMessage(context)
  return {
    // Derived from the context, never chosen here: a v2 context carries a
    // typed-data commitment and a v1 one does not. Announcing a version the
    // message does not match is precisely the downgrade the signer rejects.
    version: (context.typedDataHash ? 2 : 1) as 1 | 2,
    message,
    signature: await wallet.signMessage(message),
    signer: wallet.address,
  }
}

/**
 * #961: the per-agent hourly x402 cap, enforced on EVERY rail. Returns the cap
 * when exceeded (caller 429s), null when within it. On the delegation rail
 * each authorize runs a sponsored bundler estimation, so this cap is also
 * sponsorship-cost protection (#717 surface), not just API hygiene.
 */
async function agentHourlyX402CapExceeded(agentId: string): Promise<number | null> {
  const agentConfig = await pool.query(
    `SELECT max_x402_per_hour FROM agents WHERE id = $1`,
    [agentId],
  )
  // 100 = default max x402 calls per hour (rate limit), NOT chain 100.
  const maxPerHour = agentConfig.rows[0]?.max_x402_per_hour ?? 100
  const recentCount = await pool.query(
    `SELECT COUNT(*) as cnt FROM payment_intents
     WHERE agent_id = $1 AND source = 'x402' AND created_at > NOW() - interval '1 hour'`,
    [agentId],
  )
  return Number(recentCount.rows[0].cnt) >= maxPerHour ? maxPerHour : null
}

async function currentPaymentIntentStatus(id: string, agent: AgentContext): Promise<string> {
  const current = await pool.query<{ status: string }>(
    `SELECT status FROM payment_intents WHERE id = $1 AND agent_id = $2`,
    [id, agent.id],
  )
  return current.rows[0]?.status ?? 'unknown'
}

function x402MetadataNetwork(metadata: unknown): string | null {
  if (!metadata) return null
  const parsed = typeof metadata === 'string'
    ? (() => {
        try {
          return JSON.parse(metadata) as unknown
        } catch {
          return null
        }
      })()
    : metadata
  if (!parsed || typeof parsed !== 'object') return null
  const network = (parsed as { network?: unknown }).network
  return typeof network === 'string' ? network : null
}

function existingX402IntentMismatch(
  existing: Record<string, unknown>,
  requested: {
    resourceUrl: string
    fundingTo: string
    merchantTo: string
    amountRaw: string
    tokenAddress: string
    network: string
    facilitatorAddresses?: string[]
  },
): string | null {
  const existingResource = existing.x402_resource_url ?? existing.payment_resource_url
  if (existingResource && existingResource !== requested.resourceUrl) return 'resource_url'

  const existingFundingTo = typeof existing.to_address === 'string' ? existing.to_address.toLowerCase() : null
  if (existingFundingTo && existingFundingTo !== requested.fundingTo.toLowerCase()) return 'funding_to'

  const existingMerchant = existing.x402_merchant_address ?? existing.merchant_address
  if (typeof existingMerchant === 'string' && existingMerchant.toLowerCase() !== requested.merchantTo.toLowerCase()) {
    return 'merchant_to'
  }

  if (existing.amount_raw && existing.amount_raw !== requested.amountRaw) return 'amount'

  const existingToken = typeof existing.token_address === 'string' ? existing.token_address.toLowerCase() : null
  if (existingToken && existingToken !== requested.tokenAddress.toLowerCase()) return 'asset'

  const existingNetwork = x402MetadataNetwork(existing.machine_metadata)
  if (existingNetwork && existingNetwork !== requested.network) return 'network'

  // #1058: a replay after the merchant rotated its advertised facilitators
  // would hand back a child pinned to the OLD redeemer — internally
  // consistent but dead on arrival at the merchant's matcher. 409 so the
  // client re-keys. 3009-mode state has no facilitators key; treat absent
  // and undefined as equal.
  const state = existing.prepared_user_op as { facilitatorAddresses?: string[] } | null | undefined
  const existingFacilitators = Array.isArray(state?.facilitatorAddresses) ? state.facilitatorAddresses : null
  const requestedFacilitators = requested.facilitatorAddresses ?? null
  if (JSON.stringify(existingFacilitators) !== JSON.stringify(requestedFacilitators)) {
    return 'facilitator_addresses'
  }

  return null
}

function pendingApprovalResponse(
  approval: X402ApprovalRow,
  remainingHuman: string | null,
  context: {
    url: string
    merchantPayTo: string | null
    chainId: number
    amountAtomic: string
    asset: string
    network: string
    description?: string
    idempotencyKey?: string
  },
) {
  return {
    payment_id: approval.id,
    kind: 'approval_request',
    rail: AgentPaymentRail.X402,
    status: 'pending_approval',
    phase: AgentPaymentPhase.UserApprovalRequired,
    next_action: AgentPaymentNextAction.WaitForUserApproval,
    message:
      `This x402 funding payment of ${approval.amount_human} ${approval.token_symbol} is waiting for user approval in Haven. ` +
      'Do not start a new merchant session or create another payment; poll this payment id and resume the original x402 request after approval.',
    remaining: remainingHuman,
    requested: approval.amount_human,
    token: approval.token_symbol,
    resource_url: context.url,
    merchant_address: context.merchantPayTo,
    chain_id: context.chainId,
    amount_atomic: context.amountAtomic,
    asset: context.asset,
    network: context.network,
    description: context.description ?? null,
    idempotency_key: context.idempotencyKey ?? null,
    expires_at: approval.expires_at,
    challenge_id: approval.machine_challenge_id,
    x402: {
      amount_atomic: context.amountAtomic,
      asset: context.asset,
      network: context.network,
      resource_url: context.url,
      merchant_address: context.merchantPayTo,
      description: context.description ?? null,
      idempotency_key: context.idempotencyKey ?? null,
    },
  }
}

// ── Routes ────────────────────────────────────────────────────────

export default async function x402Routes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', agentAuthMiddleware)

  /**
   * POST /x402/authorize — Authorize an x402 payment
   *
   * Two modes:
   * 1. Without `signature`: creates a payment intent, returns sign_hash (agent signs, then calls POST /payments/:id/sign)
   * 2. With `signature`: creates intent AND executes in one shot (for SDK convenience)
   */
  const authorizeX402Handler = async (
    request: FastifyRequest<{ Body: X402AuthorizeBody }>,
    reply: FastifyReply,
  ) => {
    const agent = request.agent as AgentContext
    const {
      url,
      amount,
      asset,
      network,
      description,
      category,
      idempotencyKey,
      maxTimeoutSeconds,
      signature,
    } = request.body
      if (maxTimeoutSeconds !== undefined && (typeof maxTimeoutSeconds !== 'number' || !Number.isFinite(maxTimeoutSeconds))) {
        // #1053 review (minor): a non-numeric value used to NaN through the
        // clamp and surface as a 502; it is a caller error and gets a 400.
        return reply.code(400).send({ error: 'maxTimeoutSeconds must be a finite number' })
      }
    let { payTo } = request.body
    let { merchantPayTo } = request.body

    // 1. Validate inputs
    if (!url || typeof url !== 'string') {
      return reply.code(400).send({ error: 'Resource URL is required' })
    }
    if (!payTo || !isValidAddress(payTo)) {
      return reply.code(400).send({ error: 'Valid payTo address is required' })
    }
    // Re-checksum to canonical EIP-55 form. Third-party x402 servers sometimes
    // ship mis-cased addresses; ethers ABI-encoding rejects those downstream.
    payTo = normaliseAddress(payTo)
    if (!amount || typeof amount !== 'string') {
      return reply.code(400).send({ error: 'Amount (atomic units) is required' })
    }
    if (!isPositiveDecimalAtomicAmount(amount)) {
      return reply.code(400).send({
        error: 'Invalid amount — must be a positive decimal integer in atomic units',
      })
    }
    if (!asset || typeof asset !== 'string') {
      return reply.code(400).send({ error: 'Asset (token address) is required' })
    }
    if (!network || typeof network !== 'string') {
      return reply.code(400).send({ error: 'Network is required' })
    }
    const requestedChainId = chainIdFromX402Network(network)
    if (!requestedChainId) {
      return reply.code(400).send({ error: `Unsupported x402 network: ${network}` })
    }
    if (requestedChainId !== agent.chain_id) {
      return reply.code(400).send({
        error: `x402 network ${network} does not match agent chain ${agent.chain_id}`,
      })
    }
    if (merchantPayTo !== undefined) {
      if (!merchantPayTo || !isValidAddress(merchantPayTo)) {
        return reply.code(400).send({ error: 'Valid merchantPayTo address is required' })
      }
      merchantPayTo = normaliseAddress(merchantPayTo)
    }
    if (idempotencyKey !== undefined && (
      typeof idempotencyKey !== 'string' ||
      idempotencyKey.length === 0 ||
      idempotencyKey.length > 128
    )) {
      return reply.code(400).send({ error: 'idempotencyKey must be a non-empty string up to 128 characters' })
    }

    // #946: settlementScheme is validated for EVERY rail — a legacy-rail agent
    // requesting erc7710 must fail loudly, not silently get the 3009 two-leg.
    const { settlementScheme } = request.body
    if (settlementScheme !== undefined && !['erc7710', 'eip3009'].includes(settlementScheme)) {
      return reply.code(400).send({ error: "settlementScheme must be 'erc7710' or 'eip3009'" })
    }
    if (settlementScheme === 'erc7710' && agent.execution_rail !== 'delegation') {
      return reply.code(400).send({
        error: 'erc7710 settlement requires a delegation-rail account — the legacy AllowanceModule rail settles via EIP-3009 only',
      })
    }
    // #1058: facilitator addresses pin the settlement child's redeemer caveat.
    // Garbage here would either brick the child (unredeemable) or silently
    // skip the pin — both are caller errors that must fail loudly.
    const { facilitatorAddresses } = request.body
    if (facilitatorAddresses !== undefined) {
      if (
        !Array.isArray(facilitatorAddresses) ||
        facilitatorAddresses.length === 0 ||
        facilitatorAddresses.length > 16 ||
        facilitatorAddresses.some((a) => typeof a !== 'string' || !isValidAddress(a))
      ) {
        return reply.code(400).send({
          error: 'facilitatorAddresses must be 1-16 valid addresses (the erc7710 challenge entry\'s extra.facilitatorAddresses)',
        })
      }
      if (agent.execution_rail !== 'delegation') {
        // Same scheme confusion the erc7710 settlementScheme rejection above
        // fails loudly on — a legacy-rail client believing a redeemer pin
        // exists must not silently proceed unpinned.
        return reply.code(400).send({
          error: 'facilitatorAddresses applies to erc7710 direct settlement, which requires a delegation-rail account',
        })
      }
    }

    // 2. Resolve token from asset address (shared with the MPP core).
    const tokenResult = resolvePaymentToken(agent.chain_id, asset)
    if (!tokenResult.ok) {
      return reply.code(400).send({ error: tokenResult.error, supported: tokenResult.supported })
    }
    // tokenAddress is the AllowanceModule token address (ZERO_ADDRESS for native).
    const { tokenConfig, tokenAddress } = tokenResult

    // 3. Parse amount (already in atomic units from x402)
    const amountRaw = BigInt(amount)

    // Human-readable amount for storage
    const amountHuman = formatTokenValue(amountRaw.toString(), tokenConfig.decimals)

    // #993 (review finding on #1120): the retired-rail refusal must hold on
    // EVERY money entry point, not just /payments — a session-marked account
    // previously slipped into the legacy AllowanceModule x402 flow below.
    const railDecision = resolveExecutionRail({
      safeExecutionRail: agent.execution_rail ?? null,
      chainId: agent.chain_id,
    })
    if (railDecision.rail === 'retired_session') {
      const retired = sessionRailRetired('account')
      return reply.code(retired.statusCode).send(retired.body)
    }

    // ── Delegation rail (#830, epic #821) — DIRECT settlement ──────────────
    // The agent's budget delegation IS the settlement instrument: the delegate
    // account re-delegates a narrowed slice (exact amount, payee pin, short
    // expiry) to the merchant, who redeems the [child, budget] chain. The
    // period budget is metered by the settlement itself — no funding leg, no
    // delegate hot balance, no sweep (epic #713's class is gone on this rail).
    if (agent.execution_rail === 'delegation') {
      if (tokenAddress === ZERO_ADDRESS) {
        return reply.code(400).send({ error: 'Native-token x402 is not supported on the delegation rail' })
      }

      // ── Scheme routing (#946) ────────────────────────────────────────────
      // erc7710 direct settlement is the default and the destination; the
      // EIP-3009 two-leg below is a deliberate, temporary interop bridge for
      // facilitators that cannot redeem a delegation chain (RFC #791 §18).
      // The payTo shape selects the scheme: the standard-x402 SDK contract
      // sends payTo = the agent's own delegate EOA (the funding target) with
      // merchantPayTo = the merchant, while erc7710 callers send the merchant
      // as payTo. An explicit settlementScheme, when present, must agree.
      const fundingShape = payTo.toLowerCase() === agent.delegate_address.toLowerCase()
      if (settlementScheme === 'eip3009' && !fundingShape) {
        return reply.code(400).send({
          error: 'eip3009 settlement requires payTo = the agent delegate EOA (the funding target) and merchantPayTo = the merchant',
        })
      }
      if (settlementScheme === 'erc7710' && fundingShape) {
        return reply.code(400).send({
          error: 'erc7710 settlement requires payTo = the merchant, not the agent delegate EOA',
        })
      }
      if (facilitatorAddresses !== undefined && fundingShape) {
        // #1058: on the 3009 two-leg the merchant settles via EIP-3009 — a
        // redeemer pin is meaningless there and forwarding it means the
        // client confused its schemes.
        return reply.code(400).send({
          error: 'facilitatorAddresses applies to erc7710 direct settlement only — the EIP-3009 funding leg has no redeemer',
        })
      }

      // ── #961 hardening: cap, one-shot, replay — BEFORE any sponsored prepare ──
      // One-shot authorize+execute is a legacy-rail convenience; on this rail
      // the signature is typed data over prepared state that does not exist
      // yet, so a provided signature can never be valid. Refuse loudly instead
      // of silently minting a fresh intent per call.
      if (signature !== undefined) {
        return reply.code(400).send({
          error:
            'One-shot authorize+execute is not supported on the delegation rail — authorize first, ' +
            'then sign the returned sign_data and submit it (POST /payments/:id/sign for EIP-3009 ' +
            'funding, POST /x402/:id/settle for erc7710).',
        })
      }
      // Idempotent replay must RESUME, never dead-end: reconstruct the signing
      // payload from stored state instead of re-running an estimation. The
      // unique index excludes rows whose STATUS is failed/expired — a
      // past-expires_at row still holds the key until something flips its
      // status, so the replay path lazily expires it (below) to free the key
      // for a fresh create.
      // NOTE: this helper must NOT return the Fastify reply through the
      // async boundary — Reply is a thenable, so `await` on it resolves to
      // undefined and the caller's falsy-check would double-execute the
      // request (found by the #961 tests). It returns {code, body}; the
      // caller sends.
      const delegationReplay = async (
        existing: Record<string, unknown>,
      ): Promise<{ code: number; body: unknown } | null> => {
        if (existing.status === 'confirmed' && existing.tx_hash) {
          return { code: 200, body: {
            success: true,
            payment_id: existing.id,
            status: existing.status,
            tx_hash: existing.tx_hash,
            chain_id: existing.chain_id ?? agent.chain_id,
            safe_address: existing.safe_address,
            payer: existing.safe_address,
            token: existing.token_symbol,
            amount: existing.amount_human,
            to: existing.to_address,
            merchant_to: existing.x402_merchant_address,
            resource_url: existing.x402_resource_url,
            explorer_url: getExplorerUrl(
              (existing.chain_id as number) ?? agent.chain_id, 'tx', existing.tx_hash as string,
            ),
          } }
        }
        if (existing.status !== 'pending_signature') return null
        if (new Date(existing.expires_at as string) < new Date()) {
          // Lazy-expire: nothing else on the authorize path flips a stale
          // pending row, and until its status changes the partial unique
          // index still holds the idempotency key — every retry would loop
          // on a bare 409 (found by review, #961 M2).
          await pool.query(
            `UPDATE payment_intents SET status = 'expired'
             WHERE id = $1 AND agent_id = $2 AND status = 'pending_signature'`,
            [existing.id, agent.id],
          )
          return null
        }
        const mismatch = existingX402IntentMismatch(existing, {
          resourceUrl: url,
          fundingTo: payTo,
          merchantTo: merchantPayTo?.toLowerCase() ?? payTo.toLowerCase(),
          amountRaw: amountRaw.toString(),
          tokenAddress,
          network,
          facilitatorAddresses,
        })
        if (mismatch) {
          return { code: 409, body: {
            payment_id: existing.id,
            status: existing.status,
            error: `idempotencyKey already belongs to a different x402 ${mismatch}`,
          } }
        }
        if (existing.prepared_user_op == null) return null
        const state = deserializeUserOp(existing.prepared_user_op) as Record<string, unknown>
        // The stored intent's chain is authoritative for the reconstructed
        // typed data — agent.chain_id happens to equal it today (the network
        // check pins it), but the sign_hash was computed against the intent.
        const intentChainId = (existing.chain_id as number) ?? agent.chain_id
        const accountAddress = await computeHybridAccountAddress(intentChainId, {
          ownerAddress: agent.delegate_address as `0x${string}`,
        })
        const isErc7710State = Boolean(state?.child && state?.budget)
        const sign_data = isErc7710State
          ? {
              hash: existing.sign_hash,
              signature_scheme: 'eip712_delegation',
              typed_data: delegationSigningPayload(
                state.child as never, intentChainId,
              ),
              instructions:
                'Sign sign_data.typed_data with your delegate (agent) key (EIP-712). Then POST ' +
                `/x402/${existing.id}/settle with { signature } to receive the X-PAYMENT header.`,
            }
          : {
              hash: existing.sign_hash,
              signature_scheme: 'eip712_userop',
              typed_data: userOpTypedData(state, accountAddress as `0x${string}`, intentChainId),
              components: {
                safe: agent.safe_address,
                account: accountAddress,
                token: existing.token_address,
                to: existing.to_address,
                amount: existing.amount_raw,
              },
              instructions:
                'Sign sign_data.typed_data with your delegate (agent) key (EIP-712). Then POST ' +
                `/payments/${existing.id}/sign with { signature } — the funding redemption moves ` +
                'the exact amount to your delegate EOA; retry the merchant with your EIP-3009 header.',
            }
        const replayExpectedAuth = await signX402ExpectedContext({
          paymentId: existing.id as string,
          payloadHash: existing.sign_hash as string,
          resourceUrl: url,
          merchantTo: (existing.x402_merchant_address as string | null) ?? payTo.toLowerCase(),
          amount: amountRaw.toString(),
          asset: tokenAddress,
          network,
          expiresAt: existing.expires_at as string,
          // #1138: a replay re-issues the SAME sign_data, so it must re-issue
          // the same commitment — otherwise a replayed delegation-rail intent
          // would hand back a v1 binding the signer refuses to sign under.
          typedDataHash: typedDataDigest(sign_data.typed_data),
        })
        return { code: 201, body: {
          payment_id: existing.id,
          status: existing.status,
          expires_at: existing.expires_at,
          chain_id: agent.chain_id,
          safe_address: agent.safe_address,
          payer: agent.safe_address,
          token: tokenConfig.symbol,
          amount: existing.amount_human,
          to: existing.to_address,
          merchant_to: existing.x402_merchant_address ?? null,
          resource_url: existing.x402_resource_url ?? url,
          x402_expected_auth: replayExpectedAuth,
          idempotent_replay: true,
          sign_data,
        } }
      }
      const findExistingByKey = async () => {
        if (!idempotencyKey) return null
        const existingResult = await pool.query(
          `SELECT *
           FROM payment_intents
           WHERE agent_id = $1
             AND (x402_idempotency_key = $2 OR machine_idempotency_key = $2)
             AND COALESCE(payment_rail, source) = 'x402'
             AND status <> 'failed'
           ORDER BY created_at DESC
           LIMIT 1`,
          [agent.id, idempotencyKey],
        )
        return existingResult.rows[0] ?? null
      }
      const preExisting = await findExistingByKey()
      if (preExisting) {
        const replayed = await delegationReplay(preExisting)
        if (replayed) return reply.code(replayed.code).send(replayed.body)
      }

      // Per-agent hourly cap — AFTER the replay lookup (a replay creates
      // nothing and runs no estimation, so it must never be rate-limited;
      // legacy-rail parity) but BEFORE any sponsored prepare, so the cap is
      // sponsorship-cost protection too (#717 surface).
      const delegationCap = await agentHourlyX402CapExceeded(agent.id)
      if (delegationCap !== null) {
        return reply.code(429).send({
          error: `Rate limit exceeded: max ${delegationCap} x402 payments per hour`,
          retry_after_seconds: 60,
        })
      }

      if (fundingShape) {
        // ── EIP-3009 fallback: delegation-metered funding leg (#946) ──────
        // treasury ──(budget delegation)──▶ agent EOA, then the EOA signs the
        // standard EIP-3009 header client-side and the facilitator settles
        // EOA→merchant. The budget is metered at the funding hop (accepted
        // bridge downside — see the issue); recipient-PINNED budgets cannot
        // fund the EOA, so 3009-mode structurally requires an open budget
        // (owner decision 2026-07-15: pinned agents are erc7710-only).
        if (!merchantPayTo) {
          return reply.code(400).send({
            error: 'merchantPayTo is required for EIP-3009 x402 on the delegation rail — the ledger must record the real merchant, not the funding target',
          })
        }
        let fundingAuth
        try {
          fundingAuth = await prepareDelegationPayment(
            { id: agent.id, chain_id: agent.chain_id, delegate_address: agent.delegate_address },
            tokenAddress,
            payTo.toLowerCase(),
            amountRaw,
          )
        } catch (err) {
          // Caveat rejection (budget/expiry) or bundler failure — database untouched.
          return reply.code(502).send({
            error: 'Delegation-rail funding authorization failed (on-chain policy or bundler)',
            details: redactVendorSecrets(err instanceof Error ? err.message : String(err)),
          })
        }
        if (!fundingAuth) {
          return reply.code(403).send({
            error:
              `Agent has no delegation able to fund EIP-3009 settlement for ${tokenConfig.symbol}. ` +
              '3009-mode needs an open (unpinned) budget delegation — merchant-pinned budgets settle via erc7710 only.',
          })
        }

        const intent = await createPaymentIntent({
          agent,
          rail: 'x402',
          payTo,
          tokenSymbol: tokenConfig.symbol,
          tokenAddress,
          amountRaw,
          amountHuman,
          allowanceNonce: 0,
          signHash: fundingAuth.prepared.userOpHash,
          resourceUrl: url,
          category: category ?? null,
          merchantAddress: merchantPayTo.toLowerCase(),
          challengeId: null,
          idempotencyKey: idempotencyKey ?? null,
          metadata: { network, settlement_scheme: 'eip3009' },
          executionRail: 'delegation',
          delegationHash: fundingAuth.delegationHash,
          // #1059: on the funding leg the budget IS the signed instrument.
          budgetDelegationHash: fundingAuth.delegationHash,
          preparedUserOp: serializeUserOp(fundingAuth.prepared.userOperation),
          conflictTarget: 'x402_idempotency_key',
        })
        if (!intent) {
          // #961: a concurrent claim won the insert — resume THAT intent
          // instead of dead-ending the client on a bare 409.
          const winner = await findExistingByKey()
          if (winner) {
            const replayed = await delegationReplay(winner)
            if (replayed) return reply.code(replayed.code).send(replayed.body)
          }
          return reply.code(409).send({ error: 'Idempotent replay in progress — retry the original request' })
        }

        // Mirror the legacy-rail 201 shape (chain/payer/merchant/expected-auth)
        // so the standard-x402 SDK machinery — receipt mapping and the edge
        // signer's expected-context binding check — works unchanged; only the
        // signing scheme differs (the account's UserOp typed data).
        const fundingExpectedAuth = await signX402ExpectedContext({
          paymentId: intent.id,
          payloadHash: fundingAuth.prepared.userOpHash,
          resourceUrl: url,
          merchantTo: merchantPayTo.toLowerCase(),
          amount: amountRaw.toString(),
          asset: tokenAddress,
          network,
          expiresAt: intent.expires_at,
          // #1138: commit to the typed data, not just the 4337 hash — the
          // signer signs the former and can only verify what is bound.
          typedDataHash: typedDataDigest(fundingAuth.prepared.signingTypedData),
        })
        return reply.code(201).send({
          payment_id: intent.id,
          status: intent.status,
          expires_at: intent.expires_at,
          chain_id: agent.chain_id,
          safe_address: agent.safe_address,
          payer: agent.safe_address,
          token: tokenConfig.symbol,
          amount: amountHuman,
          to: payTo.toLowerCase(),
          merchant_to: merchantPayTo.toLowerCase(),
          resource_url: url,
          x402_expected_auth: fundingExpectedAuth,
          sign_data: {
            hash: fundingAuth.prepared.userOpHash,
            signature_scheme: 'eip712_userop',
            // The account validates THIS typed data (not the bare 4337 hash).
            typed_data: fundingAuth.prepared.signingTypedData,
            components: {
              safe: agent.safe_address,
              account: fundingAuth.prepared.delegateAccountAddress,
              token: tokenAddress,
              to: payTo.toLowerCase(),
              amount: amountRaw.toString(),
            },
            instructions:
              'Sign sign_data.typed_data with your delegate (agent) key (EIP-712; ' +
              '@haven_ai/sdk does this automatically). Then POST ' +
              `/payments/${intent.id}/sign with { signature } — the funding redemption ` +
              'moves the exact amount to your delegate EOA, after which you retry the ' +
              'merchant with your EIP-3009 X-PAYMENT header. Sweep any residual.',
          },
        })
      }

      const budget = await selectDelegation(agent.id, tokenAddress, payTo.toLowerCase())
      if (!budget) {
        return reply.code(403).send({
          error: `Agent has no active budget delegation for ${tokenConfig.symbol} to this merchant`,
        })
      }
      let built
      let delegateAccountAddress
      try {
        delegateAccountAddress = await computeHybridAccountAddress(agent.chain_id, {
          ownerAddress: agent.delegate_address as `0x${string}`,
        })
        built = buildSettlementDelegation({
          chainId: agent.chain_id,
          delegateAccountAddress: delegateAccountAddress as `0x${string}`,
          budgetDelegation: JSON.parse(budget.delegation_json),
          asset: tokenAddress as `0x${string}`,
          amountAtomic: amountRaw,
          payTo: payTo.toLowerCase() as `0x${string}`,
          // #1058: pin the child to the merchant's advertised facilitators —
          // normalized for the caveat; the VERBATIM strings are stored below
          // for the header echo (the v2 matcher deep-equals them).
          redeemers: facilitatorAddresses?.map((a) => normaliseAddress(a) as `0x${string}`),
          // Reviewed (#1053 minor): validated numeric at the route top — a
          // string here would NaN through the clamp into a 502.
          maxTimeoutSeconds: maxTimeoutSeconds ?? 300,
        })
      } catch (err) {
        return reply.code(502).send({
          error: 'Could not build the settlement delegation',
          details: redactVendorSecrets(err instanceof Error ? err.message : String(err)),
        })
      }

      const intent = await createPaymentIntent({
        agent,
        rail: 'x402',
        payTo,
        tokenSymbol: tokenConfig.symbol,
        tokenAddress,
        amountRaw,
        amountHuman,
        allowanceNonce: 0,
        signHash: built.childHash,
        resourceUrl: url,
        category: category ?? null,
        merchantAddress: (merchantPayTo ?? payTo).toLowerCase(),
        challengeId: null,
        idempotencyKey: idempotencyKey ?? null,
        // #1053 review, finding 5 (the quick half): record the scheme like the
        // 3009 path does, so the accounting feed can tell schemes apart without
        // parsing prepared_user_op. The hash-semantics column is the follow-up.
        metadata: { network, settlement_scheme: 'erc7710' },
        executionRail: 'delegation',
        delegationHash: built.childHash,
        // #1059: the CHILD is signed, but the parent budget does the metering —
        // recorded uniformly so the accounting feed never parses prepared_user_op.
        budgetDelegationHash: budget.delegation_hash,
        preparedUserOp: serializeUserOp({
          child: built.child,
          budget: JSON.parse(budget.delegation_json),
          delegateAccountAddress,
          network,
          // Echoed back to the merchant in the v2 X-PAYMENT header — must be
          // the QUOTED value, and the child's expiry was derived from it.
          maxTimeoutSeconds: maxTimeoutSeconds ?? 300,
          // #1058: echoed verbatim; the child's redeemer caveat was built
          // from these (normalized), so state and caveat stay one thing.
          facilitatorAddresses,
        }),
        conflictTarget: 'x402_idempotency_key',
      })
      if (!intent) {
        // #961: a concurrent claim won the insert — resume THAT intent
        // instead of dead-ending the client on a bare 409.
        const winner = await findExistingByKey()
        if (winner) {
          const replayed = await delegationReplay(winner)
          if (replayed) return reply.code(replayed.code).send(replayed.body)
        }
        return reply.code(409).send({ error: 'Idempotent replay in progress — retry the original request' })
      }

      return reply.code(201).send({
        payment_id: intent.id,
        status: intent.status,
        expires_at: intent.expires_at,
        sign_data: {
          hash: built.childHash,
          signature_scheme: 'eip712_delegation',
          typed_data: built.signingPayload,
          components: {
            account: delegateAccountAddress,
            token: tokenAddress,
            to: payTo.toLowerCase(),
            amount: amountRaw.toString(),
          },
          instructions:
            'Sign sign_data.typed_data with your delegate (agent) key (EIP-712; ' +
            '@haven_ai/sdk signUserOpTypedDataForDelegation-style). Then POST ' +
            `/x402/${intent.id}/settle with { signature } to receive the X-PAYMENT ` +
            'header, and retry the merchant with it. The merchant settles directly.',
        },
      })
    }

    if (idempotencyKey) {
      const existingResult = await pool.query(
        `SELECT *
         FROM payment_intents
         WHERE agent_id = $1
           AND (x402_idempotency_key = $2 OR machine_idempotency_key = $2)
           AND COALESCE(payment_rail, source) = 'x402'
           AND status <> 'failed'
         ORDER BY created_at DESC
         LIMIT 1`,
        [agent.id, idempotencyKey],
      )
      const existing = existingResult.rows[0]
      if (existing?.status === 'confirmed' && existing.tx_hash) {
        return reply.code(200).send({
          success: true,
          payment_id: existing.id,
          status: existing.status,
          tx_hash: existing.tx_hash,
          chain_id: existing.chain_id ?? agent.chain_id,
          safe_address: existing.safe_address,
          payer: existing.safe_address,
          token: existing.token_symbol,
          amount: existing.amount_human,
          to: existing.to_address,
          merchant_to: existing.x402_merchant_address,
          resource_url: existing.x402_resource_url,
          explorer_url: getExplorerUrl(existing.chain_id ?? agent.chain_id, 'tx', existing.tx_hash),
        })
      }
      if (existing?.status === 'pending_signature' || existing?.status === 'expired') {
        const mismatch = existingX402IntentMismatch(existing, {
          resourceUrl: url,
          fundingTo: payTo,
          merchantTo: merchantPayTo?.toLowerCase() ?? payTo.toLowerCase(),
          amountRaw: amountRaw.toString(),
          tokenAddress,
          network,
          facilitatorAddresses,
        })
        if (mismatch) {
          return reply.code(409).send({
            payment_id: existing.id,
            status: existing.status,
            error: `idempotencyKey already belongs to a different x402 ${mismatch}`,
          })
        }
        let existingHash = existing.sign_hash
        let existingNonce = existing.allowance_nonce
        let existingExpiresAt = existing.expires_at
        let existingStatus = existing.status
        const refreshedAllowance = await getTokenAllowance(
          agent.chain_id,
          agent.safe_address,
          agent.delegate_address,
          existing.token_address,
        )

        if (BigInt(refreshedAllowance.nonce) !== BigInt(existing.allowance_nonce)) {
          existingNonce = refreshedAllowance.nonce
          existingHash = await generateTransferHash(
            agent.chain_id,
            agent.safe_address,
            existing.token_address,
            existing.to_address,
            BigInt(existing.amount_raw),
            ZERO_ADDRESS,
            0n,
            refreshedAllowance.nonce,
          )

        }

        const refreshedResult = await pool.query<{
          id: string
          status: string
          sign_hash: string
          allowance_nonce: number
          expires_at: string
        }>(
          `UPDATE payment_intents
           SET allowance_nonce = $1,
               sign_hash = $2,
               status = 'pending_signature',
               expires_at = NOW() + interval '10 minutes',
               error_message = NULL
           WHERE id = $3
             AND agent_id = $4
             AND COALESCE(payment_rail, source) = 'x402'
             AND status IN ('pending_signature', 'expired')
             AND tx_hash IS NULL
             AND signature IS NULL
             AND (
               status = 'expired'
               OR expires_at <= NOW()
               OR allowance_nonce <> $1
               OR sign_hash <> $2
             )
           RETURNING id, status, sign_hash, allowance_nonce, expires_at`,
          [existingNonce, existingHash, existing.id, agent.id],
        )
        if (refreshedResult.rows.length > 0) {
          existingHash = refreshedResult.rows[0].sign_hash
          existingNonce = refreshedResult.rows[0].allowance_nonce
          existingExpiresAt = refreshedResult.rows[0].expires_at
          existingStatus = refreshedResult.rows[0].status
        } else if (existing.status === 'expired' || BigInt(refreshedAllowance.nonce) !== BigInt(existing.allowance_nonce)) {
          const status = await currentPaymentIntentStatus(existing.id, agent)
          return reply.code(409).send({
            payment_id: existing.id,
            status,
            error: `x402 payment is ${status}, expected pending_signature`,
          })
        }

        const x402ExpectedAuth = await signX402ExpectedContext({
          paymentId: existing.id,
          payloadHash: existingHash,
          resourceUrl: existing.x402_resource_url,
          merchantTo: existing.x402_merchant_address ?? existing.to_address,
          amount: existing.amount_raw,
          asset: existing.token_address,
          network,
          expiresAt: existingExpiresAt,
        })

        return reply.code(200).send({
          payment_id: existing.id,
          status: existingStatus,
          expires_at: existingExpiresAt,
          chain_id: existing.chain_id ?? agent.chain_id,
          safe_address: existing.safe_address,
          payer: existing.safe_address,
          token: existing.token_symbol,
          amount: existing.amount_human,
          to: existing.to_address,
          merchant_to: existing.x402_merchant_address,
          resource_url: existing.x402_resource_url,
          x402_expected_auth: x402ExpectedAuth,
          sign_data: {
            hash: existingHash,
            components: {
              safe: existing.safe_address,
              token: existing.token_address,
              to: existing.to_address,
              amount: existing.amount_raw,
              payment_token: ZERO_ADDRESS,
              payment: '0',
              nonce: existingNonce,
            },
            instructions:
              'Sign the hash with your delegate private key using raw ECDSA (not eth_sign). ' +
              'Then POST /payments/' + existing.id + '/sign with { signature } to execute.',
          },
        })
      }
      if (existing) {
        return reply.code(409).send({
          payment_id: existing.id,
          status: existing.status,
          error: 'x402 payment already in progress',
        })
      }

      const existingApprovalResult = await pool.query<X402ApprovalRow>(
        `SELECT id, status, token_symbol, amount_human, expires_at,
                machine_challenge_id
         FROM approval_requests
         WHERE agent_id = $1
           AND machine_idempotency_key = $2
           AND COALESCE(payment_rail, source) = 'x402'
           AND status <> 'expired'
         ORDER BY created_at DESC
         LIMIT 1`,
        [agent.id, idempotencyKey],
      )
      const existingApproval = existingApprovalResult.rows[0]
      if (existingApproval) {
        const status = await getAgentPaymentStatus(agent, existingApproval.id)
        if (!status) {
          return reply.code(409).send({ error: 'x402 approval already exists but could not be loaded' })
        }
        return reply.code(agentPaymentStatusHttpCode(status)).send(status)
      }
    }

    // 4. Policy check: agent must have this token in the on-chain allowance config
    const dbAllowance = await pool.query(
      `SELECT allowance_amount FROM agent_allowances
       WHERE agent_id = $1 AND LOWER(token_address) = LOWER($2)`,
      [agent.id, tokenAddress],
    )
    if (dbAllowance.rows.length === 0) {
      return reply.code(403).send({
        error: `Agent is not configured for ${tokenConfig.symbol} payments`,
      })
    }

    // 5. Rate limiting: max x402 payments per hour (#961: shared helper)
    const exceededCap = await agentHourlyX402CapExceeded(agent.id)
    if (exceededCap !== null) {
      return reply.code(429).send({
        error: `Rate limit exceeded: max ${exceededCap} x402 payments per hour`,
        retry_after_seconds: 60,
      })
    }

    // 6. On-chain allowance check + auto-queue when over the remaining allowance
    let onChainAllowance
    let chainTimeSec: number
    try {
      ;[onChainAllowance, chainTimeSec] = await Promise.all([
        getTokenAllowance(
          agent.chain_id,
          agent.safe_address,
          agent.delegate_address,
          tokenAddress,
        ),
        getLatestBlockTimeSec(agent.chain_id),
      ])
    } catch (err) {
      return reply.code(502).send({
        error: 'Failed to read on-chain allowance',
        details: err instanceof Error ? err.message : String(err),
      })
    }

    // Proactively avoid the stale-nonce race (#692): if a prior transfer for this
    // delegate just incremented the nonce, wait until that increment is visible
    // before signing, so the sign_hash never targets an already-consumed nonce.
    // Best-effort with a timeout fallback — the preflight + retry still cover it.
    onChainAllowance.nonce = await waitForFreshAllowanceNonce(
      agent.chain_id,
      agent.safe_address,
      agent.delegate_address,
      tokenAddress,
      onChainAllowance.nonce,
      async () =>
        (
          await getTokenAllowance(
            agent.chain_id,
            agent.safe_address,
            agent.delegate_address,
            tokenAddress,
          )
        ).nonce,
    )

    const effective = computeEffectiveAllowance(onChainAllowance, chainTimeSec)

    // Pre-flight: read the delegate's on-chain balance for this token before
    // doing anything that creates state. Even with a full Safe AllowanceModule
    // top-up the merchant payment cannot settle unless the delegate ends up
    // holding the amount, so the real coverage is
    // `delegateBalance + remainingAllowance`. If that's short, return a
    // structured `insufficient_funds` failure with no payment intent or
    // approval row — there is no approval the wallet owner could grant that
    // would make this payment succeed; the originating Safe needs more funds
    // or the agent's per-token allowance needs to be raised.
    //
    // Note: the existing over-budget branch below treats `amount > remaining`
    // as approval-required. That assumes the delegate's existing balance is
    // zero. The pre-flight short-circuits the unrecoverable case but does
    // not change the approval-required path — small overages still queue.
    let delegateBalance: bigint
    try {
      delegateBalance = await getTokenBalance(
        agent.chain_id,
        agent.delegate_address,
        tokenAddress,
      )
    } catch (err) {
      return reply.code(502).send({
        error: 'Failed to read delegate token balance',
        details: err instanceof Error ? err.message : String(err),
      })
    }

    // Balance-aware coverage decision (see lib/payment-coverage.decideCoverage):
    // x402's delegate can hold liquid funds from the hot-wallet leg, so a small
    // overage the balance covers still queues; only amounts beyond
    // delegateBalance + remaining are unfunded.
    const decision = decideCoverage('balance-aware', {
      amount: amountRaw,
      remaining: effective.remaining,
      delegateBalance,
    })

    if (decision.kind === 'insufficient') {
      const shortfallRaw = decision.shortfall
      const totalCoverage = decision.totalCoverage
      const balanceHuman = ethers.formatUnits(delegateBalance, tokenConfig.decimals)
      const remainingHuman = ethers.formatUnits(effective.remaining, tokenConfig.decimals)
      const coverageHuman = ethers.formatUnits(totalCoverage, tokenConfig.decimals)
      const shortfallHuman = ethers.formatUnits(shortfallRaw, tokenConfig.decimals)
      return reply.code(422).send({
        error:
          `Insufficient funds to pay ${amountHuman} ${tokenConfig.symbol}: ` +
          `delegate balance ${balanceHuman} + remaining allowance ${remainingHuman} ` +
          `= ${coverageHuman} ${tokenConfig.symbol}, short by ${shortfallHuman}. ` +
          'Fund the Safe or raise the agent allowance and retry.',
        error_code: 'insufficient_funds',
        phase: AgentPaymentPhase.InsufficientFunds,
        next_action: AgentPaymentNextAction.FundSafeOrRaiseAllowance,
        rail: AgentPaymentRail.X402,
        chain_id: agent.chain_id,
        token: tokenConfig.symbol,
        asset: tokenAddress,
        network,
        amount: amountHuman,
        amount_atomic: amountRaw.toString(),
        delegate_balance: balanceHuman,
        delegate_balance_atomic: delegateBalance.toString(),
        remaining_allowance: remainingHuman,
        remaining_allowance_atomic: effective.remaining.toString(),
        shortfall: shortfallHuman,
        shortfall_atomic: shortfallRaw.toString(),
        resource_url: url,
        merchant_address: merchantPayTo?.toLowerCase() ?? null,
        // Intentionally not echoing the agent's delegate or safe address here.
        // The agent holds both via its credential, and the delegate EOA is
        // the only entity that briefly holds liquid funds during the x402
        // hot-wallet leg — leaking it through a structured pre-flight error
        // (which agent runtimes may log, persist, or relay) is unnecessary
        // surveillance surface for no agent benefit.
      })
    }

    if (decision.kind === 'queue') {
      const remainingHuman = ethers.formatUnits(effective.remaining, tokenConfig.decimals)
      const merchantPart = merchantPayTo ? ` to merchant ${merchantPayTo}` : ''
      const approvalReason = `x402 payment for ${url}${merchantPart}${category ? ` (${category})` : ''} — exceeds remaining allowance (${amountHuman} ${tokenConfig.symbol} requested, ${remainingHuman} available)`
      const metadata = {
        protocol: 'x402',
        network,
        category: category ?? null,
        description: description ?? null,
      }

      // Shared approval-row writer (see lib/machine-payments.createMachineApproval)
      // so the column set, ON CONFLICT target, and 'pending'/24h semantics stay
      // identical to the MPP path. For x402, source/payment_rail are 'x402' and
      // there is no challenge — dedupe is on the idempotency key.
      let approval: X402ApprovalRow | null = await createMachineApproval({
        agent,
        rail: 'x402',
        payTo,
        tokenSymbol: tokenConfig.symbol,
        tokenAddress,
        amountRaw,
        amountHuman,
        reason: approvalReason,
        resourceUrl: url,
        merchantAddress: merchantPayTo ?? null,
        challengeId: null,
        idempotencyKey: idempotencyKey ?? null,
        metadata,
      })
      if (!approval && idempotencyKey) {
        const existingApprovalResult = await pool.query<X402ApprovalRow>(
          `SELECT id, status, token_symbol, amount_human, expires_at,
                  machine_challenge_id
           FROM approval_requests
           WHERE agent_id = $1
             AND machine_idempotency_key = $2
             AND COALESCE(payment_rail, source) = 'x402'
             AND status <> 'expired'
           ORDER BY created_at DESC
           LIMIT 1`,
          [agent.id, idempotencyKey],
        )
        approval = existingApprovalResult.rows[0] ?? null
      }
      if (!approval) {
        return reply.code(409).send({ error: 'x402 approval already exists but could not be loaded' })
      }
      if (approval.status !== 'pending') {
        const status = await getAgentPaymentStatus(agent, approval.id)
        if (!status) {
          return reply.code(409).send({ error: 'x402 approval already exists but could not be loaded' })
        }
        return reply.code(agentPaymentStatusHttpCode(status)).send(status)
      }
      return reply.code(202).send(pendingApprovalResponse(approval, remainingHuman, {
        url,
        merchantPayTo: merchantPayTo?.toLowerCase() ?? null,
        chainId: agent.chain_id,
        amountAtomic: amountRaw.toString(),
        asset,
        network,
        description,
        idempotencyKey,
      }))
    }

    // 7. Generate transfer hash on-chain.
    //
    // For standard x402, `payTo` can be the agent-owned delegate EOA because
    // the protocol's merchant-facing payment header is settled from an EOA.
    // Haven does not control that EOA or its private key. This transfer is only
    // a Safe AllowanceModule top-up authorized by the agent signature and
    // constrained by the user's on-chain allowance; the backend merely relays it.
    let signHash: string
    try {
      signHash = await generateTransferHash(
        agent.chain_id,
        agent.safe_address,
        tokenAddress,
        payTo,
        amountRaw,
        ZERO_ADDRESS,
        0n,
        onChainAllowance.nonce,
      )
    } catch (err) {
      return reply.code(502).send({
        error: 'Failed to generate transfer hash',
        details: err instanceof Error ? err.message : String(err),
      })
    }

    // 10. Store intent via the shared writer (see createPaymentIntent) so the
    // column set / status / expiry stay identical to the MPP core. x402 dedupes
    // on x402_idempotency_key; source/payment_rail are 'x402' and there is no
    // challenge.
    let intent = await createPaymentIntent({
      agent,
      rail: 'x402',
      payTo,
      tokenSymbol: tokenConfig.symbol,
      tokenAddress,
      amountRaw,
      amountHuman,
      allowanceNonce: onChainAllowance.nonce,
      signHash,
      resourceUrl: url,
      category: category ?? null,
      merchantAddress: merchantPayTo ?? null,
      challengeId: null,
      idempotencyKey: idempotencyKey ?? null,
      metadata: {
        protocol: 'x402',
        network,
        category: category ?? null,
        description: description ?? null,
      },
      conflictTarget: 'x402_idempotency_key',
    })
    if (!intent && idempotencyKey) {
      const existingResult = await pool.query<PaymentIntentRow>(
        `SELECT *
         FROM payment_intents
         WHERE agent_id = $1
           AND (x402_idempotency_key = $2 OR machine_idempotency_key = $2)
           AND COALESCE(payment_rail, source) = 'x402'
           AND status NOT IN ('failed', 'expired')
         ORDER BY created_at DESC
         LIMIT 1`,
        [agent.id, idempotencyKey],
      )
      intent = existingResult.rows[0] ?? null
    }
    if (!intent) {
      return reply.code(409).send({ error: 'x402 payment already exists but could not be loaded' })
    }

    // Exact-amount funding invariant (#716, epic #713): the funding transfer
    // must move EXACTLY the intent's recorded amount — never the request's.
    // On an idempotency replay the intent is reloaded from the DB, and without
    // this guard a replay carrying a different `amount` would execute the
    // request's number while the record says otherwise (padding/mutation
    // sneaking past the ledger). Fail closed on any mismatch.
    if (BigInt(intent.amount_raw) !== amountRaw) {
      return reply.code(409).send({
        payment_id: intent.id,
        error:
          'Amount does not match the existing payment for this idempotency key — ' +
          `stored ${intent.amount_raw}, requested ${amountRaw.toString()}`,
      })
    }

    // 11. If signature provided, execute immediately (one-shot mode)
    if (signature) {
      // Verify signature
      let recoveredAddress: string
      try {
        recoveredAddress = recoverSigner(signHash, signature)
      } catch (err) {
        return reply.code(400).send({
          error: 'Invalid signature format',
          details: err instanceof Error ? err.message : String(err),
        })
      }

      if (recoveredAddress.toLowerCase() !== agent.delegate_address.toLowerCase()) {
        return reply.code(403).send({
          error: 'Signature does not match delegate address',
          expected: agent.delegate_address,
          recovered: recoveredAddress,
        })
      }

      // Record the signature first (pending_signature → signed), then execute on-chain.
      // We do NOT set status='submitted' until we have a txHash in hand — if the process
      // crashes between a premature 'submitted' write and the RPC call, the intent would be
      // permanently stuck (idempotency check blocks retry on any status not in
      // ('failed','expired')). Instead we keep the record in 'pending_signature' until
      // execution succeeds, then flip it to 'confirmed' in one atomic write.
      const signatureResult = await pool.query<{ id: string }>(
        `UPDATE payment_intents
         SET signature = $1, signed_at = NOW()
         WHERE id = $2
           AND agent_id = $3
           AND COALESCE(payment_rail, source) = 'x402'
           AND status = 'pending_signature'
           AND tx_hash IS NULL
         RETURNING id`,
        [signature, intent.id, agent.id],
      )
      if (signatureResult.rows.length === 0) {
        const status = await currentPaymentIntentStatus(intent.id, agent)
        return reply.code(409).send({
          payment_id: intent.id,
          status,
          error: 'Payment intent changed before execution',
        })
      }

      // Execute on-chain
      try {
        const { txHash } = await executeAllowanceTransfer(
          agent.chain_id,
          agent.safe_address,
          tokenAddress,
          payTo.toLowerCase(),
          amountRaw,
          ZERO_ADDRESS,
          0n,
          agent.delegate_address,
          signature,
          { agentId: agent.id, userId: agent.user_id },
        )

        const fiatValues = await getFiatValuesForTokenAmount(
          tokenConfig.symbol,
          amountHuman,
        )

        const confirmedResult = await pool.query<{ id: string }>(
          `UPDATE payment_intents
           SET status = 'confirmed',
               tx_hash = $1,
               submitted_at = NOW(),
               confirmed_at = NOW(),
               usd_value = $3,
               eur_value = $4
           WHERE id = $2
             AND agent_id = $5
             AND COALESCE(payment_rail, source) = 'x402'
             AND status = 'pending_signature'
             AND tx_hash IS NULL
           RETURNING id`,
          [txHash, intent.id, fiatValues.usd, fiatValues.eur, agent.id],
        )

        if (confirmedResult.rows.length === 0) {
          const status = await currentPaymentIntentStatus(intent.id, agent)
          return reply.code(409).send({
            payment_id: intent.id,
            status,
            error: 'Payment intent changed after on-chain execution',
          })
        }

        await tryRecordMachinePaymentEvidenceBaseById(intent.id, agent.id, request.log)
        emitFunnelEvent(agent.user_id, 'first_payment_settled', { payment_id: intent.id, rail: 'x402' })

        return reply.code(201).send({
          success: true,
          payment_id: intent.id,
          status: 'confirmed',
          tx_hash: txHash,
          chain_id: agent.chain_id,
          safe_address: agent.safe_address,
          payer: agent.safe_address,
          token: tokenConfig.symbol,
          amount: amountHuman,
          to: payTo.toLowerCase(),
          merchant_to: merchantPayTo?.toLowerCase() ?? null,
          resource_url: url,
          explorer_url: getExplorerUrl(agent.chain_id, 'tx', txHash),
        })
      } catch (err) {
        // #717: over-budget = refused before submission — 429, intent stays
        // pending for retry.
        if (err instanceof RelayerBudgetExceededError) {
          return reply.code(429).send({ payment_id: intent.id, status: intent.status, error: err.message })
        }
        const errorMsg = err instanceof Error ? err.message : String(err)
        await pool.query(
          `UPDATE payment_intents
           SET status = 'failed', error_message = $1
           WHERE id = $2
             AND agent_id = $3
             AND COALESCE(payment_rail, source) = 'x402'
             AND status = 'pending_signature'
             AND tx_hash IS NULL`,
          [errorMsg, intent.id, agent.id],
        )
        return reply.code(502).send({
          success: false,
          payment_id: intent.id,
          status: 'failed',
          error: 'On-chain execution failed',
          details: errorMsg,
        })
      }
    }

    const x402ExpectedAuth = await signX402ExpectedContext({
      paymentId: intent.id,
      payloadHash: signHash,
      resourceUrl: url,
      merchantTo: merchantPayTo?.toLowerCase() ?? payTo.toLowerCase(),
      amount: amountRaw.toString(),
      asset: tokenAddress,
      network,
      expiresAt: intent.expires_at,
    })

    // 12. No signature — return intent for client-side signing
    return reply.code(201).send({
      payment_id: intent.id,
      status: 'pending_signature',
      expires_at: intent.expires_at,
      chain_id: agent.chain_id,
      safe_address: agent.safe_address,
      payer: agent.safe_address,
      token: tokenConfig.symbol,
      amount: amountHuman,
      to: payTo.toLowerCase(),
      merchant_to: merchantPayTo?.toLowerCase() ?? null,
      resource_url: url,
      x402_expected_auth: x402ExpectedAuth,
      sign_data: {
        hash: signHash,
        components: {
          safe: agent.safe_address,
          token: tokenAddress,
          to: payTo.toLowerCase(),
          amount: amountRaw.toString(),
          payment_token: ZERO_ADDRESS,
          payment: '0',
          nonce: onChainAllowance.nonce,
        },
        instructions:
          'Sign the hash with your delegate private key using raw ECDSA (not eth_sign). ' +
          'Then POST /payments/' + intent.id + '/sign with { signature } to execute, ' +
          'or re-call POST /x402/authorize with the signature field included for one-shot execution.',
      },
    })
  }

  app.post<{ Body: X402AuthorizeBody }>('/', { config: moneyPathRateLimit }, authorizeX402Handler)
  app.post<{ Body: X402AuthorizeBody }>('/authorize', { config: moneyPathRateLimit }, authorizeX402Handler)

  // ── POST /x402/:id/settle — delegation rail (#830) ───────────────────────
  // The agent has signed the settlement child (EIP-712). Assemble the
  // X-PAYMENT header and hand it back; the MERCHANT redeems the [child,
  // budget] chain — Haven submits nothing, holds no key. The intent flips to
  // 'submitted'; final settlement is observed via the merchant/receipt path.
  app.post<{ Params: { id: string }; Body: { signature?: string } }>(
    '/:id/settle',
    { config: moneyPathRateLimit },
    async (request, reply) => {
      const agent = request.agent as AgentContext
      const { id } = request.params
      const { signature } = request.body ?? {}
      if (!signature || !/^0x[0-9a-fA-F]+$/.test(signature)) {
        return reply.code(400).send({ error: 'A delegate EIP-712 signature is required' })
      }

      const row = await pool.query<{
        id: string
        status: string
        execution_rail: string | null
        prepared_user_op: unknown
        chain_id: number
        x402_resource_url: string | null
        to_address: string
        amount_raw: string
        token_address: string
      }>(
        `SELECT id, status, execution_rail, prepared_user_op, chain_id, x402_resource_url,
                to_address, amount_raw, token_address
         FROM payment_intents
         WHERE id = $1 AND agent_id = $2`,
        [id, agent.id],
      )
      const intent = row.rows[0]
      if (!intent) return reply.code(404).send({ error: 'Payment not found' })
      if (intent.execution_rail !== 'delegation') {
        return reply.code(409).send({ error: 'This payment is not a delegation-rail x402 settlement' })
      }
      if (intent.status !== 'pending_signature') {
        return reply.code(409).send({ error: `Payment is ${intent.status}, expected pending_signature` })
      }
      if (intent.prepared_user_op == null) {
        return reply.code(502).send({ error: 'Settlement state was lost — re-authorize' })
      }

      try {
        const state = deserializeUserOp(intent.prepared_user_op) as {
          child: Parameters<typeof assembleSettlementPayload>[1]
          budget: Parameters<typeof assembleSettlementPayload>[3]
          delegateAccountAddress: `0x${string}`
          network: string
          maxTimeoutSeconds?: number
          facilitatorAddresses?: string[]
        }
        // #946 guard: a 3009-mode funding intent stores a prepared UserOp, not
        // an erc7710 {child, budget} settlement state. Refuse it here
        // structurally — otherwise a tolerant encoder could flip the intent to
        // 'submitted' with a garbage header and no funding ever executed.
        if (!state?.child || !state?.budget) {
          return reply.code(409).send({
            error:
              'This intent settles via EIP-3009 (funding leg) — sign it via POST ' +
              `/payments/${intent.id}/sign. /settle is for erc7710 direct settlement only.`,
          })
        }
        // #1053 review, finding 3: the shape check above accepts any hex —
        // '0x0' included — and the flip below burns the intent (a retry 409s
        // on the status guard). Unlike payments.ts, the child delegation's
        // typed data IS fully known server-side, so recover the signer and
        // refuse a signature that is not the delegate's BEFORE anything
        // becomes unrecoverable. 400, not 502: the client signed wrong and
        // can re-sign the same sign_data.
        let signer: string
        try {
          signer = await recoverDelegationSigner(state.child, intent.chain_id, signature as `0x${string}`)
        } catch {
          return reply.code(400).send({
            error: 'The signature is not a valid EIP-712 signature over sign_data.typed_data',
          })
        }
        if (signer.toLowerCase() !== agent.delegate_address.toLowerCase()) {
          return reply.code(400).send({
            error: 'The signature was not produced by this agent\'s delegate key over sign_data.typed_data',
          })
        }

        const payload = assembleSettlementPayload(
          intent.chain_id,
          state.child,
          signature as `0x${string}`,
          state.budget,
          state.delegateAccountAddress,
        )
        const header = encodeXPaymentHeader(state.network, payload, {
          amount: intent.amount_raw,
          payTo: intent.to_address as `0x${string}`,
          asset: intent.token_address as `0x${string}`,
          // Pre-#1064 intents stored no echo value; 300 is the same default
          // the child expiry was built with, so the echo stays consistent.
          maxTimeoutSeconds: state.maxTimeoutSeconds ?? 300,
          facilitatorAddresses: state.facilitatorAddresses,
        })

        // #976: the agent's own passport reference, so it can PRESENT rather
        // than have the merchant DISCOVER. Deliberately in Haven's response and
        // NOT inside `payment_header` — that header is parsed by a merchant
        // facilitator we do not control, and an unrecognised key is a rejection
        // risk. Null when there is no anchored passport; a lookup ERROR is
        // swallowed and yields null too.
        //
        // Computed BEFORE the UPDATE, and that ordering is the point (#976
        // review). Between the UPDATE and this reply, `payment_header` is
        // UNRECOVERABLE: it is emitted from this one place, and a retry hits
        // the `status !== 'pending_signature'` guard above and 409s. There is
        // no statement_timeout and no Fastify requestTimeout, so a wedged query
        // in that window would strand a signed, submitted intent with no way to
        // get its header. The reference needs nothing the UPDATE produces, so
        // the window simply should not exist. A lookup error cannot fail the
        // payment either way; a lookup HANG is what the ordering removes.
        const passport = await passportReferenceFor(agent.id, { log: request.log })

        await pool.query(
          `UPDATE payment_intents
           SET status = 'submitted', signature = $1, signed_at = NOW(), submitted_at = NOW()
           WHERE id = $2 AND agent_id = $3 AND status = 'pending_signature'`,
          [signature, id, agent.id],
        )
        return reply.code(200).send({
          payment_id: id,
          status: 'submitted',
          // Retry the merchant with this header; it settles directly from your
          // budget delegation (no funding leg).
          payment_header: header,
          resource_url: intent.x402_resource_url,
          passport,
        })
      } catch (err) {
        return reply.code(502).send({
          error: 'Could not assemble the settlement payload',
          details: redactVendorSecrets(err instanceof Error ? err.message : String(err)),
        })
      }
    },
  )
}
