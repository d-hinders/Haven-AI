import { exact } from 'x402/schemes'
import { privateKeyToAccount } from 'viem/accounts'
import {
  AgentPaymentNextAction,
  HavenApiError,
  HavenSigningError,
  X402AlreadySettledError,
} from './types.js'
import type {
  PaymentStatusResult,
  RawSignResponse,
  RawX402AuthorizeResponse,
  SignData,
  X402PaymentOption,
  X402PaymentRequired,
  X402Receipt,
} from './types.js'
import {
  toStandardPaymentRequirements,
  x402AuthorizationAmount,
} from './x402.js'
import { paymentStateFromRaw, throwPaymentStateError } from './payment-state.js'
import { createErc20Contract, createJsonRpcProvider } from './provider.js'
import { decodeBase64Json, encodeBase64Json } from './base64.js'
import {
  buildX402Receipt,
  chainIdFromNetwork,
  decimalFromUsdcAtomic,
  explorerUrlOrEmpty,
} from './x402-protocol.js'

/**
 * The EIP-3009 funding-leg x402 lifecycle (#1618, epic #1613).
 *
 * This scheme moves money in TWO hops: Haven funds the agent's delegate EOA
 * from the account, and the delegate then signs a standard EIP-3009
 * authorization the merchant's facilitator settles. Everything peculiar to
 * that shape lives here — funding confirmation, the delegate's fundability
 * check, header minting from the local delegate key, and the receipt cache
 * keyed by the authorization's own expiry.
 *
 * What is NOT here is deliberate: the erc7710 direct-settlement path has no
 * funding leg at all, so it must not reach into this module. Anything both
 * schemes need is a free function in `x402-protocol.ts`.
 *
 * Non-custody is unchanged by the extraction. The delegate key never leaves
 * the caller's process, Haven never signs, and nothing here can widen what
 * the on-chain policy already permits.
 *
 * Internal to `HavenClient`. Exported for direct tests and composition only;
 * it is not part of the SDK's published entrypoint.
 */

export type PaymentPoster = <T>(path: string, body: Record<string, unknown>) => Promise<T>
export type DataSigner = (signData: SignData) => Promise<string>
export type AuthorizationStateAssertion = (label: string, raw: RawX402AuthorizeResponse) => void

export interface X402FundingLegOptions {
  /** The agent's local delegate key. Required to mint an EIP-3009 header. */
  delegateKey: string | undefined
  /** Derived from `delegateKey`; the address the funding leg pays into. */
  delegateAddress: string | undefined
  /** Payer override for clients without a local delegate key. */
  x402Wallet: string | undefined
  /** Chain id → RPC URL. Absent entries make on-chain reads unverifiable, never guessed. */
  chainRpcs: Record<number, string>
  post: PaymentPoster
  signForData: DataSigner
  assertSignableAuthorizationState: AuthorizationStateAssertion
}

export class X402FundingLeg {
  private readonly delegateKey: string | undefined
  private readonly delegateAddress: string | undefined
  private readonly x402Wallet: string | undefined
  private readonly chainRpcs: Record<number, string>
  private readonly post: PaymentPoster
  private readonly signForData: DataSigner
  private readonly assertSignableAuthorizationState: AuthorizationStateAssertion

  /**
   * Receipts keyed by idempotency key, held only as long as the underlying
   * EIP-3009 authorization is valid. The cache belongs to this module rather
   * than to the facade because its expiry is read out of the authorization
   * header itself — a 3009 artifact.
   */
  private readonly receiptCache = new Map<string, { expiresAt: number; receipt: X402Receipt }>()

  constructor(options: X402FundingLegOptions) {
    this.delegateKey = options.delegateKey
    this.delegateAddress = options.delegateAddress
    this.x402Wallet = options.x402Wallet
    this.chainRpcs = options.chainRpcs
    this.post = options.post
    this.signForData = options.signForData
    this.assertSignableAuthorizationState = options.assertSignableAuthorizationState
  }

  // ── Receipt cache ────────────────────────────────────────────────

  /** A still-valid cached receipt for this key, or undefined. */
  cachedReceipt(idempotencyKey: string): X402Receipt | undefined {
    const cached = this.receiptCache.get(idempotencyKey)
    if (cached && cached.expiresAt > Date.now()) return cached.receipt
    return undefined
  }

  cacheReceipt(idempotencyKey: string, paymentHeader: string, receipt: X402Receipt): void {
    const expiresAt = getPaymentHeaderValidBefore(paymentHeader)
    if (expiresAt > Date.now()) {
      this.receiptCache.set(idempotencyKey, { expiresAt, receipt })
    }
  }

  // ── Authorization ────────────────────────────────────────────────

  async authorize(
    paymentRequired: X402PaymentRequired,
    option: X402PaymentOption,
    idempotencyKey: string,
  ): Promise<X402Receipt> {
    // 2. Standard x402 settles from an EOA, so the SDK uses the agent-owned
    // delegate EOA for the merchant-facing EIP-3009 authorization. Haven does
    // not control this EOA or its private key.
    //
    // The only automated funding path is a separate Safe AllowanceModule
    // transfer signed by the agent key and constrained by the user's on-chain
    // allowance. Haven's backend relays that signed top-up; it is not the source
    // of payment authority.
    // #1521: the authorization is minted AFTER the backend's answer is
    // classified, never before. Signing first meant that when the idempotency
    // key resolved to an already-settled payment, a brand-new authorization
    // had already been created against a delegate whose USDC was gone — and
    // it was handed back paired with the FIRST payment's tx_hash. Within one
    // authorize call the header is still created once and reused, which is
    // all the original "reuse one EIP-3009 nonce" note ever meant. If funding
    // fails later, the unused authorization simply expires via validBefore.
    const raw = await this.post<RawX402AuthorizeResponse>('/x402', {
      url: paymentRequired.resource.url,
      payTo: this.delegateAddress,
      merchantPayTo: option.payTo,
      amount: x402AuthorizationAmount(option),
      asset: option.asset,
      network: option.network,
      description: paymentRequired.resource.description,
      idempotencyKey,
      // #1360: same explicit funding-leg declaration as createX402Intent —
      // this local-key path derives payTo from the key (never stale), but the
      // declaration keeps both writers of the 3009 shape loud-by-default.
      settlementScheme: 'eip3009',
    })

    // The backend can report an ALREADY-EXECUTED payment in two different
    // shapes, and #1521 is reachable through both — the guard is therefore on
    // the meaning, not on one response shape:
    //
    //   1. `success` + `tx_hash` — the delegation rail's confirmed-intent
    //      replay (`modules/x402/replay.ts`). Reached only by an idempotency
    //      collision; the caller did not ask for THIS payment.
    //   2. `nextAction: retry_original_x402_request` — the legacy rail's
    //      approval-queue replay (`modules/x402/legacy-authorize.ts` returns
    //      `getAgentPaymentStatus`'s body, which carries no `success` field
    //      at all). This is the DOCUMENTED post-approval retry loop, so the
    //      caller is deliberately resuming a payment they know about.
    //
    // In both, "executed" means the FUNDING leg executed, which is ambiguous:
    //
    //   (a) funding confirmed, merchant never paid  → the delegate still
    //       holds the money and minting a header is correct;
    //   (b) funding confirmed, merchant already paid → the delegate is
    //       empty and any authorization minted here is unfundable.
    //
    // Only the delegate's on-chain balance separates them. The two shapes
    // differ in what an UNVERIFIABLE balance should mean, and they differ for
    // the same reason the explicit `resumeAuthorizedX402` path does: shape 1
    // is an accident, so "can't tell" refuses rather than mint a header we
    // cannot vouch for; shape 2 is the caller following documented steps, so
    // "can't tell" proceeds and only a balance verified ABSENT refuses —
    // otherwise every approval resume without a `chainRpcs` entry would break.
    const state = paymentStateFromRaw('x402 payment', raw)
    const executedReplay = raw.success && raw.tx_hash
      ? 'idempotency-collision' as const
      : state?.nextAction === AgentPaymentNextAction.RetryOriginalX402Request
        ? 'approval-resume' as const
        : null

    if (executedReplay) {
      const canFund = await this.delegateCanFund(
        raw.chain_id ?? state?.chainId ?? chainIdFromNetwork(option.network),
        option.asset,
        x402AuthorizationAmount(option),
      )
      const refuse = executedReplay === 'idempotency-collision'
        ? canFund !== true
        : canFund === false
      if (refuse) {
        const settledReceipt = state && executedReplay === 'approval-resume'
          ? this.receiptFromStatus(paymentRequired, option, undefined, state)
          : this.receiptFromAuthorization(paymentRequired, option, undefined, raw)
        throw new X402AlreadySettledError(
          canFund === false
            ? 'This x402 payment already settled — the delegate no longer holds the funds to ' +
              'authorize it again. To buy the same item a second time, pass a distinct ' +
              '`idempotencyKey`; the synthesised key intentionally collapses repeat calls for ' +
              'the same product within a 5-minute window so a retried request cannot pay twice.'
            : 'This x402 payment already settled, and whether the delegate can still fund a new ' +
              'authorization could not be verified (no `chainRpcs` entry for this chain). Refusing ' +
              'rather than issue an authorization that may be unfundable. To buy the same item a ' +
              'second time, pass a distinct `idempotencyKey`; to finish an interrupted payment, ' +
              'resume it by `paymentId`.',
          settledReceipt,
          canFund === false ? 'settled' : 'unverifiable',
        )
      }
    }

    const paymentHeader = await this.createPaymentHeader(paymentRequired, option)

    if (raw.success && raw.tx_hash) {
      const receipt = this.receiptFromAuthorization(paymentRequired, option, paymentHeader, raw)
      this.cacheReceipt(idempotencyKey, paymentHeader, receipt)
      return receipt
    }

    if (state?.nextAction === AgentPaymentNextAction.RetryOriginalX402Request) {
      const receipt = this.receiptFromStatus(paymentRequired, option, paymentHeader, state)
      this.cacheReceipt(idempotencyKey, paymentHeader, receipt)
      return receipt
    }

    this.assertSignableAuthorizationState('x402 payment', raw)

    // 3. Sign the hash
    if (!raw.sign_data?.hash) {
      throw new HavenApiError('No sign_hash returned from x402/authorize', 500, raw)
    }
    const sig = await this.signForData(raw.sign_data)

    // 4. Submit signature (reuse existing payments/:id/sign endpoint)
    const execResult = await this.post<RawSignResponse>(
      `/payments/${raw.payment_id}/sign`,
      { signature: sig },
    )

    if (execResult.status !== 'confirmed') {
      throwPaymentStateError('x402 payment', execResult)
    }

    // Wait for ≥1 on-chain confirmation before retrying the merchant so the
    // merchant's balanceOf(delegate) check sees the funded balance.
    await this.waitForFundingTx(
      execResult.tx_hash,
      execResult.chain_id ?? chainIdFromNetwork(option.network),
    )

    const receipt = this.receiptFromAuthorization(paymentRequired, option, paymentHeader, raw, execResult)
    this.cacheReceipt(idempotencyKey, paymentHeader, receipt)
    return receipt
  }

  // ── Header minting ───────────────────────────────────────────────

  async createPaymentHeader(
    paymentRequired: X402PaymentRequired,
    option: X402PaymentOption,
  ): Promise<string> {
    if (!this.delegateKey) {
      throw new HavenSigningError('delegateKey is required to sign x402 payment headers.')
    }

    const account = privateKeyToAccount(this.delegateKey as `0x${string}`)
    const requirements = toStandardPaymentRequirements(paymentRequired, option)

    const header = await exact.evm.createPaymentHeader(
      account,
      paymentRequired.x402Version,
      requirements,
    )
    if (paymentRequired.x402Version < 2) return header

    const payment = decodeBase64Json<{ payload: unknown }>(header)
    return encodeBase64Json({
      x402Version: paymentRequired.x402Version,
      accepted: option,
      payload: payment.payload,
    })
  }

  // ── Receipt mapping ──────────────────────────────────────────────

  receiptFromAuthorization(
    paymentRequired: X402PaymentRequired,
    option: X402PaymentOption,
    // #1521: `undefined` builds the receipt for a payment that already
    // settled. A settled payment has no live authorization to carry, and
    // minting one to fill this slot is precisely the defect that issue names.
    paymentHeader: string | undefined,
    raw: RawX402AuthorizeResponse,
    execResult?: RawSignResponse,
  ): X402Receipt {
    const txHash = execResult?.tx_hash ?? raw.tx_hash ?? ''
    const chainId = execResult?.chain_id ?? raw.chain_id ?? chainIdFromNetwork(option.network)
    const token = execResult?.token ?? raw.token ?? 'USDC'
    const amount = execResult?.amount ?? raw.amount ?? decimalFromUsdcAtomic(x402AuthorizationAmount(option))
    const to = execResult?.to ?? raw.to ?? this.delegateAddress ?? ''
    const explorerUrl = execResult?.explorer_url ?? raw.explorer_url ?? explorerUrlOrEmpty(chainId, txHash)
    const merchantTo = execResult?.merchant_to ?? raw.merchant_to ?? option.payTo
    const payer = raw.payer ?? raw.safe_address ?? raw.sign_data?.components.safe

    return buildX402Receipt({
      paymentId: raw.payment_id,
      txHash,
      token,
      amount,
      to,
      resourceUrl: paymentRequired.resource.url,
      explorerUrl,
      accepted: option,
      paymentHeader,
      merchantTo,
      payer,
      chainId,
    })
  }

  receiptFromStatus(
    paymentRequired: X402PaymentRequired,
    option: X402PaymentOption,
    // See `receiptFromAuthorization` — `undefined` is the settled case.
    paymentHeader: string | undefined,
    status: PaymentStatusResult,
  ): X402Receipt {
    if (!status.txHash) {
      throw new HavenApiError(
        `x402 payment ${status.paymentId} is ready to retry but has no Haven transaction hash.`,
        502,
        status,
        status.paymentId,
      )
    }

    return buildX402Receipt({
      paymentId: status.paymentId,
      txHash: status.txHash,
      token: status.token || 'USDC',
      amount: status.amount || decimalFromUsdcAtomic(x402AuthorizationAmount(option)),
      to: this.delegateAddress ?? '',
      resourceUrl: paymentRequired.resource.url,
      explorerUrl: explorerUrlOrEmpty(status.chainId, status.txHash),
      accepted: option,
      paymentHeader,
      merchantTo: status.merchantAddress ?? option.payTo,
      payer: this.x402Wallet,
      chainId: status.chainId || chainIdFromNetwork(option.network),
    })
  }

  // ── On-chain reads ───────────────────────────────────────────────

  /**
   * Wait for a funding tx to be mined with ≥1 confirmation before the
   * merchant retry, eliminating the race where the merchant's
   * `balanceOf(delegate)` runs before the funding block propagates.
   *
   * Skipped when `chainRpcs` does not include the chain; in that case Haven's
   * backend has already confirmed on-chain submission and callers accept the
   * small propagation window as a trade-off for not configuring an RPC URL.
   */
  async waitForFundingTx(
    txHash: string | undefined,
    chainId: number | undefined,
    timeoutMs = 30_000,
  ): Promise<void> {
    if (!txHash || !chainId) return
    const rpcUrl = this.chainRpcs[chainId]
    if (!rpcUrl) return
    const provider = createJsonRpcProvider(rpcUrl)
    const onChainReceipt = await provider.waitForTransaction(txHash, 1, timeoutMs)
    if (!onChainReceipt || onChainReceipt.status !== 1) {
      throw new HavenApiError(
        'Funding tx did not confirm on-chain within the timeout window.',
        500,
        { txHash, chainId },
      )
    }
  }

  /**
   * Can the delegate EOA still fund an authorization for `amountAtomic`?
   *
   * #1521: the only question that separates a legitimate resume (funding
   * confirmed, merchant never paid — the delegate still holds the money) from
   * a replayed settled payment (funding confirmed, merchant paid, delegate
   * spent). The intent's own `status: 'confirmed'` is identical in both.
   *
   * The balance is asked of the CHAIN rather than of Haven's bookkeeping on
   * purpose: the merchant-settlement evidence record is written by this SDK
   * *after* the merchant call, so a client that dies between the two leaves
   * the backend believing the merchant was never paid — the exact case the
   * discriminator has to get right. The chain cannot be behind in that way.
   *
   * Returns `null` — never a guess — when `chainRpcs` has no entry for the
   * chain or the read fails. Callers must treat that as "unverifiable", not
   * as "funded".
   */
  async delegateCanFund(
    chainId: number | undefined,
    tokenAddress: string,
    amountAtomic: string,
    timeoutMs = 10_000,
  ): Promise<boolean | null> {
    if (!chainId || !this.delegateAddress) return null
    const rpcUrl = this.chainRpcs[chainId]
    if (!rpcUrl) return null
    try {
      const provider = createJsonRpcProvider(rpcUrl)
      const token = createErc20Contract(
        tokenAddress,
        ['function balanceOf(address) view returns (uint256)'] as const,
        provider,
      )
      // Bounded like `waitForFundingTx` above. This sits on a money
      // authorization path with no way for a caller to route around a stall,
      // so an unresponsive RPC must degrade to "unverifiable" rather than
      // hang the payment: a slow answer is worth less than a prompt refusal.
      const balance = await Promise.race([
        token.balanceOf(this.delegateAddress) as Promise<bigint>,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs).unref?.()),
      ])
      if (balance === null) return null
      return balance >= BigInt(amountAtomic)
    } catch {
      // An RPC that is down, or an amount that will not parse, tells us
      // nothing about the delegate's balance. Saying so is the whole point of
      // the tri-state — and on the accidental-replay path it fails toward
      // refusing, never toward minting.
      return null
    }
  }
}

/**
 * The authorization's own `validBefore`, in milliseconds — the only honest
 * expiry for a cached receipt, since the header stops being usable then
 * whatever the SDK believes.
 */
export function getPaymentHeaderValidBefore(paymentHeader: string): number {
  try {
    const payment = decodeBase64Json<{ payload?: { authorization?: { validBefore?: string } } }>(
      paymentHeader,
    )
    const payload = payment.payload as { authorization?: { validBefore?: string } }
    const validBeforeSeconds = Number(payload.authorization?.validBefore)
    if (Number.isFinite(validBeforeSeconds)) return validBeforeSeconds * 1000
  } catch {
    // If the header cannot be decoded, skip caching rather than hiding errors.
  }

  return 0
}
