import {
  HavenApiError,
  HavenSigningError,
} from './types.js'
import type {
  RawX402AuthorizeResponse,
  RawX402SettleResponse,
  SignData,
  X402Erc7710Settlement,
  X402McpCallContext,
  X402PaymentRequired,
} from './types.js'
import {
  selectX402SettlementScheme,
  x402AuthorizationAmount,
} from './x402.js'

/**
 * The erc7710 direct-settlement lifecycle (#1619, epic #1613).
 *
 * The defining property of this scheme is an ABSENCE. There is no funding
 * leg: the merchant redeems a delegation chain and pulls from the treasury
 * directly, so the delegate EOA never holds the money, no sweep can strand
 * it, and the #713 reconciliation class does not apply. Nothing in this
 * module checks a delegate balance or waits for a funding transaction,
 * because on this path there is neither — and a test pins that, since the
 * defects this epic exists to prevent (#1510, #1511, #1521) were all a
 * funding-leg assumption leaking into a path that has none.
 *
 * It builds no merchant header either. The backend assembles the MetaMask
 * erc7710 payload in `assembleSettlementPayload`, which is why this module is
 * so much smaller than `x402-funding-leg.ts`.
 *
 * Non-custody: `settle()` signs in-process with the caller's delegate key,
 * while `prepare()`/`submit()` exist precisely so the hosted topology can
 * drive the two halves with the LOCAL signer in between — hosted Haven has no
 * key and must not. Neither half can widen what the delegation already
 * permits; the caveat enforcers decide that on-chain.
 *
 * Internal to `HavenClient`. Exported for direct tests and composition only;
 * it is not part of the SDK's published entrypoint.
 */

export type PaymentPoster = <T>(path: string, body: Record<string, unknown>) => Promise<T>
export type DataSigner = (signData: SignData) => Promise<string>
export type RailReader = () => Promise<{ executionRail?: string }>

export interface X402Erc7710Options {
  /** Required only by `settle()`, which signs in-process. */
  delegateKey: string | undefined
  post: PaymentPoster
  signForData: DataSigner
  /** Reads the ACCOUNT's rail — a property no 402 response can carry. */
  getAgent: RailReader
}

export class X402Erc7710 {
  private readonly delegateKey: string | undefined
  private readonly post: PaymentPoster
  private readonly signForData: DataSigner
  private readonly getAgent: RailReader

  constructor(options: X402Erc7710Options) {
    this.delegateKey = options.delegateKey
    this.post = options.post
    this.signForData = options.signForData
    this.getAgent = options.getAgent
  }

  /**
   * Pay a merchant through **erc7710 direct settlement** (#1454, epic #1450).
   *
   * The whole point of this path is what it does NOT do. There is no funding
   * leg: the merchant redeems a delegation chain and pulls from the treasury
   * directly, so the delegate EOA never holds the money, no sweep can strand
   * it, and the #713 reconciliation class does not apply. It is also why this
   * method is SMALLER than the 3009 path — the backend assembles the merchant
   * `X-PAYMENT` header in `assembleSettlementPayload`, so the SDK builds no
   * header locally.
   *
   *     authorize (payTo = the MERCHANT) → sign the child → settle → header
   *
   * The caller then retries the merchant with that header. **Nothing has
   * settled when this returns** — that is why it does not return an
   * `X402Receipt`.
   *
   * Requires a delegation-rail account. The backend enforces that at the
   * rail seam — a non-delegation account gets the #1986 retired-rail 410 from
   * `POST /x402/authorize` whatever scheme it asks for (#2245) — and so does
   * this method, before building a request the backend would only reject: an
   * error a client can explain is worth more than a refusal it has to decode.
   *
   * **MCP callers must pass `options.resourceUrl`.** An in-band MCP 402
   * challenge frequently carries no `resource` object at all, so
   * `paymentRequired.resource?.url` is undefined and the backend answers
   * "Valid url is required". The QA scenario this path was ported from falls
   * back to the request URL for exactly that reason — the SDK cannot, because
   * it never saw the request. Pass it.
   */
  async settle(
    paymentRequired: X402PaymentRequired,
    options: { resourceUrl?: string } = {},
  ): Promise<X402Erc7710Settlement> {
    if (!this.delegateKey) {
      throw new HavenSigningError(
        'delegateKey is required for x402 payments. Pass it in the HavenClient config.',
      )
    }
    const prepared = await this.prepare(paymentRequired, options)
    const signature = await this.signForData(prepared.signData)
    const paymentHeader = await this.submit(prepared.paymentId, signature)
    return { ...prepared.settlement, paymentHeader }
  }

  /**
   * The AUTHORIZE half of erc7710 settlement (#1456): select the scheme, build
   * the request, and return the child to be signed — without signing it.
   *
   * Split out because the hosted topology cannot use `settleX402Erc7710()`:
   * that method signs in-process with `delegateKey`, and hosted Haven does not
   * have one and must not. The hosted MCP server drives these two halves with
   * the LOCAL signer in between, so the key stays where it belongs and the
   * request shaping stays in one place rather than being reimplemented.
   */
  async prepare(
    paymentRequired: X402PaymentRequired,
    options: {
      resourceUrl?: string
      /**
       * The account's rail, when the caller has ALREADY read it from
       * `GET /machine-payments/agent` — passing it skips a duplicate fetch
       * (#1456: the hosted tool reads the agent for the delegate address
       * anyway, and #1348 pins that path to exactly one agent round-trip).
       *
       * This is an optimisation, not a trust boundary: omit it and the rail is
       * read here, and either way the backend independently refuses a
       * non-delegation account at the rail seam (the #1986 410; #2245 removed
       * the separate scheme-level 400). A caller that asserted the wrong rail
       * would build a request the backend rejects.
       */
      delegationRail?: boolean
      /**
       * #1547: the merchant MCP-tool call this authorization was quoted
       * against, persisted so the settle leg can rehydrate it by payment_id
       * (#1307) — the same option `createX402Intent` already carries. Without
       * it an erc7710 settle needs merchant_url/tool_name/arguments
       * re-threaded, which the guided catalog path (#1305) exists to remove.
       */
      mcpCallContext?: X402McpCallContext
      /**
       * #2041: replay key for this authorization, exactly as the 3009 path's
       * `createX402Intent` already sends one.
       *
       * The backend has supported full replay dedup on THIS branch all along —
       * `runDelegationAuthorize` looks an existing intent up by key before it
       * ever branches on the funding shape, and the erc7710 insert carries
       * `conflictTarget: 'x402_idempotency_key'`. The dedup was simply never
       * invoked, because this options bag had no way to say the key. A retried
       * call therefore minted a SECOND independently-signable settlement child
       * for the same purchase — a double-authorize hazard on the one scheme
       * whose signed artifact is spend authority rather than a funding step.
       *
       * Omitted, the backend behaves exactly as before (no key, no dedup).
       */
      idempotencyKey?: string
    } = {},
  ): Promise<{
    paymentId: string
    signData: SignData
    settlement: Omit<X402Erc7710Settlement, 'paymentHeader'>
  }> {

    // The rail half of the #1450 preference rule is not visible in a 402
    // response — it is a property of the ACCOUNT, so read it rather than let a
    // caller assert it. #1453's selector takes it as input for exactly this
    // reason, and this is the one place that input is sourced from truth.
    const delegationRail =
      options.delegationRail ?? (await this.getAgent()).executionRail === 'delegation'

    // Rail first, and BEFORE selection — the two failures have different
    // remedies and the caller needs the one that applies. Checking selection
    // first made a legacy-rail agent at an erc7710-only merchant get "no
    // compatible payment option", which is true and useless: the option is
    // there, the account cannot use it. (Found by this method's own tests.)
    if (!delegationRail) {
      throw new HavenApiError(
        'erc7710 settlement requires a delegation-rail account; this one is not on it. ' +
          'Use authorizeX402() for the standard EIP-3009 path.',
        400,
      )
    }

    const selection = selectX402SettlementScheme(paymentRequired.accepts, { delegationRail })

    if (!selection || selection.scheme !== 'erc7710') {
      // Never silently reroute to the other scheme (#1454 AC). On a delegation
      // rail the only remaining reason is the merchant, so name that.
      throw new HavenApiError(
        'This merchant does not advertise an erc7710 settlement option ' +
          "(no accepts[] entry carries extra.assetTransferMethod: 'erc7710'). " +
          'Use authorizeX402() for the standard EIP-3009 path.',
        400,
      )
    }

    const option = selection.option
    const merchantPayTo = option.payTo
    const amountAtomic = x402AuthorizationAmount(option)

    const raw = await this.post<RawX402AuthorizeResponse>('/x402', {
      url: options.resourceUrl ?? paymentRequired.resource?.url,
      // #2373: the full 402 challenge, persisted verbatim by the backend
      // (#1355) so the settle handoff can echo its resource/extensions into
      // the X-PAYMENT envelope (#2361). This scheme decomposes the challenge
      // into the fields below for AUTHORITY; the stored copy exists for the
      // echo, which cannot be reconstructed from the decomposition — omitting
      // it is how every erc7710 payment failed a merchant that enforces the
      // spec's extensions-echo MUST. Same ≤64KB guard and omission behaviour
      // as the 3009 path (client.ts): an oversized challenge omits the field
      // rather than failing the payment, and the settle echo then omits too.
      ...(new TextEncoder().encode(JSON.stringify(paymentRequired)).length <= 65536
        ? { paymentRequired }
        : {}),
      // payTo = the MERCHANT is what selects direct settlement server-side.
      // The explicit settlementScheme must AGREE with that shape (#1360) —
      // disagreement is a 400 by design, so that a stale delegate address
      // becomes a loud mismatch instead of a silent reroute to the 3009 leg.
      payTo: merchantPayTo,
      settlementScheme: 'erc7710',
      // #2041: sent only when the caller supplied one, so an omitting caller's
      // request body is byte-identical to the pre-#2041 shape.
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      amount: amountAtomic,
      asset: option.asset,
      network: option.network,
      // The v2 header echoes the accepted entry field-for-field, so the quoted
      // timeout must round-trip or the merchant rejects the echo (#1064).
      maxTimeoutSeconds: option.maxTimeoutSeconds,
      // #1058: forward the advertised facilitators verbatim — the child becomes
      // redeemable ONLY by them. `null` here means the merchant advertised none
      // (or an empty array, which the backend 400s on), so the field is OMITTED
      // rather than sent empty. See x402FacilitatorAddresses.
      ...(selection.facilitatorAddresses
        ? { facilitatorAddresses: selection.facilitatorAddresses }
        : {}),
      // #1307/#1547: persisted so the settle leg can rehydrate the merchant
      // call by payment_id on this scheme too, not only on the 3009 bridge.
      ...(options.mcpCallContext ? { mcpCallContext: options.mcpCallContext } : {}),
    })

    if (!raw.payment_id) {
      throw new HavenApiError('No payment_id returned from x402/authorize', 500, raw)
    }
    const signData = raw.sign_data
    if (signData?.signature_scheme !== 'eip712_delegation' || !signData.typed_data) {
      // The backend chose a different scheme than the shape asked for. Refuse
      // loudly: signing whatever came back would be exactly the "silent
      // reroute" this path exists to make impossible.
      throw new HavenApiError(
        'x402/authorize did not return an erc7710 settlement child ' +
          `(signature_scheme was ${JSON.stringify(signData?.signature_scheme)}). ` +
          'Refusing to sign a payload this path did not ask for.',
        500,
        raw,
      )
    }

    return {
      paymentId: raw.payment_id,
      signData,
      settlement: {
        paymentId: raw.payment_id,
        merchantPayTo,
        amountAtomic,
        asset: option.asset,
        network: option.network,
        facilitatorAddresses: selection.facilitatorAddresses,
      },
    }
  }

  /**
   * The SETTLE half (#1456): exchange the signed child for the merchant header.
   *
   * The SDK builds no header on this path — the backend assembles the MetaMask
   * erc7710 payload in `assembleSettlementPayload`. Whoever produced the
   * signature (an in-process delegate key, or the local edge signer over the
   * hosted boundary) is irrelevant here.
   */
  async submit(paymentId: string, signature: string): Promise<string> {
    const settled = await this.post<RawX402SettleResponse>(
      `/x402/${paymentId}/settle`,
      { signature },
    )
    if (!settled.payment_header) {
      throw new HavenApiError(
        'x402 settle returned no payment_header — the merchant cannot be retried.',
        500,
        settled,
      )
    }
    return settled.payment_header
  }
}
