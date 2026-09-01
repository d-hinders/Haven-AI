import { randomUUID } from 'node:crypto'
import { hashMessage, hashTypedData, recoverTypedDataAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { exact } from 'x402/schemes'
import {
  chainIdForNetwork,
  isSettlementChildTypedData,
  verifySettlementChild,
} from './settlement-child.js'
import {
  addressFromKey,
  buildX402ExpectedMessage,
  buildSweepAuthorizationMessage,
  buildSweepTypedData,
  signHash,
  verifySignature,
  selectStandardPaymentOption,
  toStandardPaymentRequirements,
  x402AuthorizationAmount,
  x402V2PaymentEnvelope,
  decodeBase64Json,
  encodeBase64Json,
  AgentPaymentFailureCode,
  HavenError,
  HavenSigningError,
  HavenApiError,
  HavenUnsupportedSignerVersionError,
  SignerRefusalCode,
  SIGNER_UPDATE_FALLBACK,
  type SweepAuthorization,
  type SweepExpectedAuth,
  type X402ExpectedAuth,
  type X402PaymentRequired,
  type X402PaymentOption,
} from '@haven_ai/sdk'

/**
 * The edge signer core.
 *
 * Holds the delegate key in this process and exposes the two signing
 * operations a hosted-MCP flow needs. It performs no network I/O and never
 * returns the key — only signatures and the standard x402 header. See
 * docs/architecture/07-edge-signer.md.
 */
export interface EdgeSigner {
  /** Address derived from the delegate key. */
  readonly delegateAddress: string
  /** Sign an AllowanceModule funding/transfer hash (raw ECDSA, 65 bytes). */
  signPaymentHash(hash: string): string
  /**
   * Sign a DIRECT delegation-rail payment's EIP-712 typed data (#1254) — the
   * non-x402 counterpart of `signX402FundingTypedData`. The Hybrid account
   * validates the typed data, not the bare ERC-4337 hash; raw-signing the
   * hash produced AA24 on-chain (found live, #908 mainnet canary). Signed
   * VERBATIM (#829): the exact structure the hosted result carried — and,
   * unlike a blind hash, a structure whose recipient/amount/account are
   * visible to this process's audit log.
   */
  signDelegationTypedData(typedData: Record<string, unknown>): Promise<string>
  /** Sign an x402 funding hash and remember the funded merchant-header context. */
  signX402FundingHash(hash: string, expected: X402ExpectedPayment): X402FundingSignatureResult
  /**
   * Sign a delegation-rail x402 funding intent's EIP-712 typed data (#1138) and
   * remember the funded merchant-header context, exactly as the hash path does.
   *
   * The account validates this typed data, NOT the bare ERC-4337 hash, so the
   * expected context must be v2 and commit to its digest — see
   * `assertExpectedBinding`.
   */
  signX402FundingTypedData(
    typedData: X402FundingTypedData,
    expected: X402ExpectedPayment,
  ): Promise<X402FundingSignatureResult>
  /** Build + sign the EIP-3009 X-PAYMENT header for the merchant leg of x402. */
  buildX402PaymentHeader(
    paymentRequired: X402PaymentRequired,
    x402Binding: string,
  ): Promise<X402HeaderResult>
  /**
   * Sign a Haven-prepared EIP-3009 sweep authorization (gasless USDC recovery
   * delegate → Safe). Verifies the authorization came from Haven and pays out to
   * the delegate's own Safe before signing; the relayer broadcasts it and pays
   * gas. Never broadcasts — pure signing.
   */
  signSweepAuthorization(input: SweepSignatureInput): Promise<SweepSignatureResult>
}

export interface SweepSignatureInput {
  /** The authorization fields prepared by the backend. */
  authorization: SweepAuthorization
  /** Haven's signature over the authorization context (binding). */
  expectedAuth: SweepExpectedAuth
  /** Optional Safe address from the local credential, cross-checked against `to`. */
  expectedSafe?: string
}

export interface SweepSignatureResult {
  /** EIP-712 signature over the TransferWithAuthorization, by the delegate key. */
  signature: string
}

/** EIP-712 payload the delegation-rail account validates (#1138). */
export interface X402FundingTypedData {
  domain: Record<string, unknown>
  types: Record<string, unknown>
  primaryType: string
  message: Record<string, unknown>
}

export interface X402ExpectedPayment {
  /** Haven payment id for the funding transfer. */
  paymentId: string
  /** Funding hash this expected context authenticates. */
  payloadHash: string
  /**
   * EIP-712 digest of the typed data the account validates (#1138). Present ⇒
   * the binding is v2 and the delegation-rail typed-data path is the ONLY
   * signing path allowed for this intent.
   */
  typedDataHash?: string
  /** Resource URL that was funded by hosted haven_x402_authorize. */
  resourceUrl: string
  /** Merchant recipient that was funded by hosted haven_x402_authorize. */
  merchantTo: string
  /** Atomic amount funded for the merchant header. */
  amount: string
  /** Token contract funded for the merchant header. */
  asset: string
  /** x402 network funded for the merchant header. */
  network: string
  /** ISO expiry for the funding/quote window. When present, the signer refuses stale merchant headers. */
  expiresAt?: string
  /**
   * The delegate address this quote was created FOR (#1690). Present ⇒ the
   * context is **version 3**, and the signer refuses to sign when it is not
   * its own delegate. Inside the Haven-signed message, so it cannot be
   * stripped or forged without breaking the binding signature.
   */
  payerDelegate?: string
  /** The paying agent's id — carried for the refusal's diagnosis (#1690). */
  payerAgentId?: string
  /** Haven signature over the expected funding context. */
  auth: X402ExpectedAuth
}

export interface X402HeaderResult {
  /** The merchant-verifiable X-PAYMENT header value. */
  paymentHeader: string
  /** The x402 option this header pays. */
  accepted: X402PaymentOption
}

export interface X402FundingSignatureResult {
  /** Raw ECDSA signature over the Haven funding hash. */
  signature: string
  /** Opaque process-local binding for the later merchant header signing step. */
  x402Binding: string
}

export interface EdgeSignerOptions {
  /** Address allowed to authenticate x402 expected-context messages from Haven. */
  x402BindingSigner?: string
  /**
   * This signer's OWN agent id, from the local credential (#1690). Used only
   * to make the payer-mismatch refusal name both sides; the guard itself
   * compares delegate addresses and works without it.
   */
  agentId?: string
}

export function createEdgeSigner(
  delegateKey: string,
  options: EdgeSignerOptions = {},
): EdgeSigner {
  let delegateAddress: string
  try {
    delegateAddress = addressFromKey(delegateKey)
  } catch (err) {
    throw new HavenSigningError(
      `Invalid delegate key: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const x402Bindings = new Map<string, X402ExpectedPayment>()
  /**
   * #2291: why a binding this process once held is gone. A binding is
   * single-use by design and `buildX402PaymentHeader` deletes it on every exit
   * path, so a re-use and a typo previously produced the SAME refusal — and
   * they need opposite remedies: a spent binding means the header was already
   * built (use it, or re-quote), while an unknown one means the signer never
   * held it (sign first, or the signer restarted).
   *
   * The reason is recorded, not just the fact, because the exit paths are not
   * equivalent: a binding retired by the WINDOW check produced no header at
   * all, so telling that caller to "retry with the header you already have"
   * would be a confident lie (review finding). Three outcomes, three remedies.
   *
   * Ids only. The payment context is still deleted with the map entry, so this
   * changes nothing about what the signer retains — a retired id is an opaque
   * UUID, not payment data. Bounded so a long-lived signer cannot grow it
   * without limit; the oldest ids fall off, which degrades a stale re-use back
   * to the unknown-binding message rather than to a wrong one.
   */
  type RetiredBindingReason = 'header_built' | 'window_expired'
  const retiredX402Bindings = new Map<string, RetiredBindingReason>()
  const RETIRED_BINDING_MEMORY = 64
  function retireX402Binding(id: string, reason: RetiredBindingReason): void {
    retiredX402Bindings.set(id, reason)
    if (retiredX402Bindings.size > RETIRED_BINDING_MEMORY) {
      const oldest = retiredX402Bindings.keys().next()
      if (!oldest.done) retiredX402Bindings.delete(oldest.value)
    }
  }

  function signAndVerify(hash: string): string {
    const signature = signHash(delegateKey, hash)
    // Verify locally before handing the signature back, mirroring the SDK.
    if (!verifySignature(hash, signature, delegateAddress)) {
      throw new HavenSigningError(
        'Local signature verification failed — recovered address does not match the delegate key.',
      )
    }
    return signature
  }

  return {
    delegateAddress,

    signPaymentHash(hash: string): string {
      return signAndVerify(hash)
    },

    async signDelegationTypedData(typedData: Record<string, unknown>): Promise<string> {
      const account = privateKeyToAccount(delegateKey as `0x${string}`)
      // Signed VERBATIM (#829/#1254): the exact structure Haven sent, never
      // one reconstructed from components — a re-derived payload is a
      // different payload, and the account validates the original.
      return account.signTypedData(typedData as Parameters<typeof account.signTypedData>[0])
    },

    signX402FundingHash(hash: string, expected: X402ExpectedPayment): X402FundingSignatureResult {
      assertExpectedBinding(hash, expected, options.x402BindingSigner, 'hash')
      assertPayerMatchesDelegate(expected, delegateAddress, options.agentId)
      const signature = signAndVerify(hash)
      const x402Binding = randomUUID()
      x402Bindings.set(x402Binding, { ...expected })
      return { signature, x402Binding }
    },

    async signX402FundingTypedData(
      typedData: X402FundingTypedData,
      expected: X402ExpectedPayment,
    ): Promise<X402FundingSignatureResult> {
      assertExpectedBinding(expected.payloadHash, expected, options.x402BindingSigner, 'typed-data')
      assertPayerMatchesDelegate(expected, delegateAddress, options.agentId)
      // Recompute the digest from the typed data actually in hand and require it
      // to equal Haven's commitment. Everything upstream is untrusted input; this
      // equality is what makes the binding cover the bytes being signed rather
      // than a hash that merely travels alongside them.
      const digest = hashTypedData(typedData as Parameters<typeof hashTypedData>[0])
      if (digest.toLowerCase() !== expected.typedDataHash?.toLowerCase()) {
        throw new HavenSigningError(
          'x402 typed data does not match the digest Haven committed to in the expected context. ' +
            'Refusing to sign — the payload was altered in transit or Haven declared a different one. ' +
            'The most common cause is the typed data being truncated or reshaped while being copied ' +
            'between tool calls (#1255): re-run the hosted quote and pass its typed_data_b64 string ' +
            'through UNCHANGED instead of re-emitting the nested JSON.',
        )
      }
      // #1455: the digest check above proves Haven DECLARED these bytes. It
      // says nothing about what they mean. When the payload is a delegation —
      // the erc7710 settlement child, whose signature lets a merchant pull from
      // the treasury — re-derive the meaning from the caveats and refuse if it
      // disagrees with the declaration. A backend could otherwise declare one
      // payee and pin another, and the pair would bind perfectly.
      if (isSettlementChildTypedData(typedData)) {
        // A network this signer cannot map is its OWN failure, not a chain
        // mismatch. Folding it into the comparison (as `?? -1` did) refused
        // correctly but reported "expected chain -1", sending a reader after a
        // phantom mismatch instead of the mapping gap (#1455 second review).
        const settlementChainId = chainIdForNetwork(expected.network)
        if (settlementChainId === undefined) {
          throw new HavenSigningError(
            `Refusing to sign the x402 settlement child: this signer cannot map the network ` +
              `'${expected.network}' to a chain id, so it cannot check which chain the child is ` +
              'scoped to. Update @haven_ai/signer.',
          )
        }
        verifySettlementChild(typedData, {
          merchantTo: expected.merchantTo,
          amount: expected.amount,
          asset: expected.asset,
          // From the SIGNED network, not the payload's own claim. Passing
          // Number(typedData.domain.chainId) here made the check compare a
          // value to itself — vacuous, and precisely the "declared one thing,
          // signed another" class this file exists to catch (#1455 review).
          chainId: settlementChainId,
          expiresAt: expected.expiresAt,
        })
      }
      const account = privateKeyToAccount(delegateKey as `0x${string}`)
      // Signed VERBATIM (#829): the exact structure Haven sent, never one
      // reconstructed from components — a re-derived payload is a different
      // payload, and the account validates the original.
      const signature = await account.signTypedData(
        typedData as Parameters<typeof account.signTypedData>[0],
      )
      const x402Binding = randomUUID()
      x402Bindings.set(x402Binding, { ...expected })
      return { signature, x402Binding }
    },

    async buildX402PaymentHeader(
      paymentRequired: X402PaymentRequired,
      x402Binding: string,
    ): Promise<X402HeaderResult> {
      const expected = x402Bindings.get(x402Binding)
      if (!expected) {
        // #2291: two different situations, two different remedies. Conflating
        // them sent a reporter hunting a binding-lookup bug that did not
        // exist — the caller HAD signed, seconds earlier, with a one-shot that
        // spends its own binding building the header inline.
        const retired = retiredX402Bindings.get(x402Binding)
        if (retired === 'header_built') {
          throw new HavenSigningError(
            'This x402 binding was already used to build a merchant header. Bindings are ' +
              'single-use. If you called haven_sign_x402, it already returned the ' +
              'payment_header — retry the merchant with THAT header instead of building ' +
              'another; haven_x402_sign_header is the follow-up to haven_sign, not to ' +
              'haven_sign_x402. If you no longer have the header, re-run the quote tool with ' +
              'the same idempotency_key.',
          )
        }
        if (retired === 'window_expired') {
          throw new HavenSigningError(
            'This x402 binding was retired because its payment window closed before a merchant ' +
              'header could be built — no header exists to retry with. Re-run the quote tool ' +
              'with the same idempotency_key to get a fresh window, then sign again.',
          )
        }
        throw new HavenSigningError(
          'x402 funding binding is required before signing a merchant header. Sign the ' +
            'hosted funding hash with x402_expected first (haven_sign returns a binding this ' +
            'tool can use). A binding is also lost when the signer process restarts, since ' +
            'bindings live in memory only — re-sign to mint a fresh one.',
        )
      }
      try {
        assertX402PaymentWindowOpen(expected)
      } catch (err) {
        x402Bindings.delete(x402Binding)
        // No header was built on this path — the window closed first.
        retireX402Binding(x402Binding, 'window_expired')
        throw err
      }
      const option = selectStandardPaymentOption(paymentRequired.accepts)
      if (!option) {
        throw new HavenApiError(
          'No compatible payment option found in x402 requirements. ' +
            'Haven supports standard x402 exact payments on Base USDC.',
          400,
        )
      }
      assertX402MatchesExpected(paymentRequired, option, expected)

      const account = privateKeyToAccount(delegateKey as `0x${string}`)
      const requirements = toStandardPaymentRequirements(paymentRequired, option)
      const header = await exact.evm.createPaymentHeader(
        account,
        paymentRequired.x402Version,
        requirements,
      )

      if (paymentRequired.x402Version < 2) {
        x402Bindings.delete(x402Binding)
        retireX402Binding(x402Binding, 'header_built')
        return { paymentHeader: header, accepted: option }
      }

      // Always delete the binding — even if encode/decode throws — to prevent the
      // in-process Map from accumulating stale X402ExpectedPayment entries (memory
      // leak + data-retention violation for user payment context).
      try {
        const payment = decodeBase64Json<{ payload: unknown }>(header)
        // #2361: the shared v2 envelope echoes the challenge's `resource` and
        // `extensions` verbatim when present — the extensions echo is a spec
        // MUST, and its absence was live-bisected as the CoinGecko rejection
        // cause (#2360). `paymentRequired` here is the caller's raw 402 JSON
        // (the tools layer passes it through unnormalized), so the echo is
        // byte-faithful to what the merchant advertised.
        const wrapped = encodeBase64Json(
          x402V2PaymentEnvelope(paymentRequired, option, payment.payload),
        )
        return { paymentHeader: wrapped, accepted: option }
      } finally {
        x402Bindings.delete(x402Binding)
        retireX402Binding(x402Binding, 'header_built')
      }
    },

    async signSweepAuthorization({
      authorization,
      expectedAuth,
      expectedSafe,
    }: SweepSignatureInput): Promise<SweepSignatureResult> {
      // 1. The authorization must have come from Haven (binding), so a malicious
      //    hosted server can't get the delegate to sign a transfer to an attacker.
      assertSweepBinding(authorization, expectedAuth, options.x402BindingSigner)

      // 2. Funds can only leave the delegate's OWN key — that half is
      //    unconditional. The DESTINATION half is not, and the difference
      //    matters here more than anywhere else in this file (#2247):
      //    `expectedSafe` is threaded from the local credential's account
      //    address, so it is absent whenever no such address reaches this
      //    process. Three ways that happens, all supported: `HAVEN_DELEGATE_KEY`
      //    set without `HAVEN_SAFE_ADDRESS` (the README quickstart — the
      //    credential IS loaded here, it just carries no account address); a
      //    credential file whose `safe_address` is null; or an embedder calling
      //    `resolveEdgeSigner({ delegateKey })`, whose fast path returns before
      //    credentials are read at all. With no local value there is nothing to
      //    re-derive `to` against, so the destination rests entirely on Haven's
      //    binding signature (step 1) plus the canonical-USDC token/chain
      //    assertion (step 3): AUTHENTICATED, but not independently verified by
      //    this signer. Supply the account address to get the local check.
      if (!sameAddress(authorization.from, delegateAddress)) {
        throw new HavenSigningError(
          'Sweep authorization `from` does not match this delegate address.',
        )
      }
      if (expectedSafe && !sameAddress(authorization.to, expectedSafe)) {
        throw new HavenSigningError(
          'Sweep authorization `to` does not match the Safe in the local credential.',
        )
      }

      // 3. Build the EIP-712 typed data (asserts token/chain are canonical USDC),
      //    sign it locally, and verify the recovered signer is the delegate.
      const typedData = buildSweepTypedData(authorization)
      // The SDK keeps addresses framework-neutral (`string`); viem wants its
      // `0x`-branded template type. Narrow at the call boundary only.
      const viemTypedData = {
        domain: {
          ...typedData.domain,
          verifyingContract: typedData.domain.verifyingContract as `0x${string}`,
        },
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: {
          ...typedData.message,
          from: typedData.message.from as `0x${string}`,
          to: typedData.message.to as `0x${string}`,
          nonce: typedData.message.nonce as `0x${string}`,
        },
      } as const
      const account = privateKeyToAccount(delegateKey as `0x${string}`)
      const signature = await account.signTypedData(viemTypedData)
      const recovered = await recoverTypedDataAddress({ ...viemTypedData, signature })
      if (!sameAddress(recovered, delegateAddress)) {
        throw new HavenSigningError(
          'Local sweep signature verification failed — recovered address does not match the delegate key.',
        )
      }
      return { signature }
    },
  }
}

/**
 * Verify Haven signed the sweep authorization context. Mirrors
 * `assertExpectedBinding` for x402: re-derive the canonical message from the
 * authorization fields, require it match the binding, require the binding signer
 * be the trusted Haven address, and verify the signature. Reuses the x402
 * binding signer — the message namespace differs so the two can't cross-replay.
 */
function assertSweepBinding(
  authorization: SweepAuthorization,
  expectedAuth: SweepExpectedAuth,
  trustedSigner: string | undefined,
): void {
  if (!expectedAuth || typeof expectedAuth !== 'object') {
    throw new HavenSigningError('Sweep authorization binding is required before signing.')
  }
  if (!trustedSigner) {
    throw new HavenSigningError(
      'Sweep binding verifier is not configured. Set HAVEN_X402_BINDING_SIGNER before signing sweep authorizations.',
    )
  }
  // Before any content comparison: an unrecognised version means we cannot
  // reason about this binding at all, so a mismatch below would be a symptom
  // reported as a cause (#1143).
  assertSupportedBindingVersion(
    expectedAuth.version,
    SUPPORTED_SWEEP_BINDING_VERSIONS,
    'sweep authorization binding',
  )
  const message = buildSweepAuthorizationMessage(authorization)
  if (expectedAuth.message !== message) {
    throw new HavenSigningError('Sweep authorization binding does not match the authorization being signed.')
  }
  if (!sameAddress(expectedAuth.signer, trustedSigner)) {
    throw new HavenSigningError('Sweep authorization binding was not signed by the configured Haven signer.')
  }
  if (!verifySignature(hashMessage(message), expectedAuth.signature, trustedSigner)) {
    throw new HavenSigningError('Sweep authorization binding signature could not be verified.')
  }
}

export function assertX402MatchesExpected(
  paymentRequired: X402PaymentRequired,
  option: X402PaymentOption,
  expected: X402ExpectedPayment,
): void {
  assertExpectedShape(expected)
  const headerResource = option.resource ?? paymentRequired.resource.url
  if (headerResource !== expected.resourceUrl) {
    throw new HavenSigningError('x402 payment_required resource does not match the funded intent.')
  }
  if (!sameAddress(option.payTo, expected.merchantTo)) {
    throw new HavenSigningError('x402 merchant recipient does not match the funded intent.')
  }
  if (x402AuthorizationAmount(option) !== expected.amount) {
    throw new HavenSigningError('x402 amount does not match the funded intent.')
  }
  if (!sameAddress(option.asset, expected.asset)) {
    throw new HavenSigningError('x402 asset does not match the funded intent.')
  }
  if (option.network !== expected.network) {
    throw new HavenSigningError('x402 network does not match the funded intent.')
  }
}

function assertExpectedShape(expected: X402ExpectedPayment): void {
  if (!expected || typeof expected !== 'object') {
    throw new HavenSigningError('x402 expected funding context is required before signing a merchant header.')
  }
}

/**
 * Expected-context binding versions THIS signer understands (#1143).
 *
 * The backend deploys continuously from `dev`; a signer reaches users only on a
 * merge to `main` (the publish workflow). So a signer that is one release behind
 * a context bump is a structural state, not an accident, and it needs to report
 * itself as one. These sets are the signer's authority on what it will sign —
 * the tool schemas deliberately accept any positive integer so an unknown
 * version arrives *here* instead of dying at the schema boundary with a raw
 * validation string.
 *
 * **Adding a version here is not sufficient to support it.** The mode rules in
 * `assertExpectedBinding` derive the expected version from the context's
 * *contents* (`typedDataHash` present ⇒ 2), not from `auth.version`, so a v3
 * that carries anything new needs that derivation extended in the same change.
 * Widening this array alone would admit a v3 context to the v1/v2 rule set:
 * the array announces what this signer can evaluate, it does not define it.
 */
export const SUPPORTED_X402_EXPECTED_VERSIONS: readonly number[] = [1, 2, 3]
export const SUPPORTED_SWEEP_BINDING_VERSIONS: readonly number[] = [1]

/**
 * Fail closed on a binding version this signer does not understand, with an
 * error that names the received version, the ceiling this signer supports, and
 * the fix — both as PROSE (`message`, unchanged since #1143) and, since #1309,
 * as MACHINE-READABLE fields on the thrown error itself
 * (`HavenUnsupportedSignerVersionError`): `code`, `supportedVersions`,
 * `receivedVersion`, `fallback`. The tool boundary (`normalizeError` in
 * `tools.ts`) relays those fields verbatim instead of leaving an agent to
 * regex-parse this prose, which is the diagnosability gap
 * `docs/operations/mcp-runtime-compatibility.md` documents.
 *
 * `supportedVersions`/`receivedVersion` are DERIVED from this call's own
 * arguments — never a second literal — so they cannot drift from
 * `SUPPORTED_X402_EXPECTED_VERSIONS` / `SUPPORTED_SWEEP_BINDING_VERSIONS`,
 * which is what the signing path always passes in.
 *
 * The version travels inside the Haven-signed binding message, so the message
 * also tells the caller not to "fix" it by rewriting the field — an agent that
 * does would invalidate the signature and misrepresent what Haven declared.
 * That instruction is NOT weakened by structuring the refusal: this function
 * still throws before any content check runs, and nothing is ever signed.
 *
 * #2347: that word was "authorised" until this change, and the reading was
 * always the correct one — Haven does sign this message. It is now "declared",
 * the word `settlement-child.ts` already uses for this exact binding ("proves
 * Haven *declared* a payload … it says nothing about what the payload MEANS"),
 * because on an agent-facing refusal inside a payment flow the broader word
 * invites the #2334 misreading that Haven is what authorises the spend. It is
 * not; the owner-signed delegation and its on-chain caveat are. The property
 * claimed is unchanged — only the verb naming it. Full argument in
 * `docs/regulatory/casp-changelog/2026-09-01-2347.md`.
 *
 * Exported so a test can pin the historical case (a v2 context against a signer
 * whose set was `{1}`) that this signer can no longer produce on its own. The
 * signing path always passes the module constants above.
 */
export function assertSupportedBindingVersion(
  received: number,
  supported: readonly number[],
  context: 'x402 expected context' | 'sweep authorization binding',
): void {
  if (supported.includes(received)) return
  const highest = Math.max(...supported)
  // The else-branch ("updating will not restore it") assumes versions retire
  // MONOTONICALLY from the oldest end — true for how SUPPORTED_* is maintained
  // (append new, drop old). If a future change ever makes the supported set
  // non-contiguous, a gap version would hit that branch and the wording needs
  // revisiting (#1322 review).
  const outOfDate = received > highest
  const code =
    context === 'x402 expected context'
      ? SignerRefusalCode.UnsupportedExpectedContextVersion
      : SignerRefusalCode.UnsupportedSweepBindingVersion
  const ceiling = outOfDate
    ? `This signer is out of date: it supports ${context} versions up to ${highest}, ` +
      `and Haven sent version ${received}. Update @haven_ai/signer — rerun the Haven ` +
      'connector (`npx @haven_ai/connect@alpha`), which reinstalls the pinned MCP runtime.'
    : `Unsupported ${context} version ${received}: this signer supports ` +
      `${supported.join(', ')}.`
  // Below-floor is the opposite skew (this signer is NEWER than what sent the
  // context, e.g. a retired version) — updating cannot fix it, so the shared
  // "update the signer" fallback would be actively wrong here. Only the
  // out-of-date branch, which is the case seen in the field (#1143), uses the
  // canonical single-source fallback shared with the hosted quote's advisory
  // signer_compatibility.fallback (#1155, #1309).
  const fallback = outOfDate
    ? SIGNER_UPDATE_FALLBACK
    : `This ${context} version (${received}) is older than what this signer enforces ` +
      `(${supported.join(', ')}) — updating @haven_ai/signer will not restore it. Nothing ` +
      'was signed or spent; stop and tell the user rather than retrying.'
  throw new HavenUnsupportedSignerVersionError(
    `${ceiling} Nothing was signed. Do not rewrite the version field to a supported ` +
      'value: it is part of the Haven-signed binding message, so changing it invalidates ' +
      'the signature and would misrepresent what Haven declared.',
    code,
    supported,
    received,
    fallback,
  )
}

/**
 * Verify Haven's expected-context binding before signing anything.
 *
 * `mode` is what closes the #1138 downgrade in BOTH directions, and neither
 * half is optional:
 *
 * - `'hash'` (legacy rail, raw ECDSA) refuses a **v2** context. A v2 binding
 *   means the account validates typed data; raw-signing its 4337 hash would
 *   produce a signature the account rejects on-chain, after the intent is
 *   claimed.
 * - `'typed-data'` (delegation rail) refuses a **v1** context. Without the
 *   `typedDataHash` commitment, Haven's declaration covers only a hash that is
 *   NOT what gets signed — the signer would be endorsing a payload it cannot
 *   check, which is the whole property this binding exists to provide.
 *
 * The version is derived from the context inside `buildX402ExpectedMessage`, so
 * a tampered `auth.version` cannot select a different rule than the signed
 * message encodes: the recomputed message simply stops matching.
 */
function assertExpectedBinding(
  payloadHash: string,
  expected: X402ExpectedPayment,
  trustedSigner: string | undefined,
  mode: 'hash' | 'typed-data' = 'hash',
): void {
  assertExpectedShape(expected)
  if (!trustedSigner) {
    throw new HavenSigningError(
      'x402 expected-context verifier is not configured. Set HAVEN_X402_BINDING_SIGNER before signing x402 funding hashes.',
    )
  }
  // Skew check first (#1143). Every content check below — the hash comparison,
  // the mode rules, the recomputed message — assumes we understand the context's
  // shape. Under an unknown version they are symptoms, and reporting one as the
  // cause is what sent a live debugging session after the wrong string. A missing
  // `auth` is left to the message check below, which already fails closed on it.
  if (expected.auth) {
    assertSupportedBindingVersion(
      expected.auth.version,
      SUPPORTED_X402_EXPECTED_VERSIONS,
      'x402 expected context',
    )
  }
  if (expected.payloadHash.toLowerCase() !== payloadHash.toLowerCase()) {
    throw new HavenSigningError('x402 expected context does not match the funding hash being signed.')
  }
  if (mode === 'hash' && expected.typedDataHash) {
    throw new HavenSigningError(
      'This x402 funding intent commits to EIP-712 typed data, so its bare hash must not be ' +
        'raw-signed — the account would reject that signature on-chain. Sign sign_data.typed_data instead.',
    )
  }
  if (mode === 'typed-data' && !expected.typedDataHash) {
    throw new HavenSigningError(
      'Refusing to sign typed data under an expected context that does not commit to it. ' +
        'Haven must return a v2 x402 expected context (with typedDataHash) for a delegation-rail intent.',
    )
  }
  const message = buildX402ExpectedMessage({
    paymentId: expected.paymentId,
    payloadHash: expected.payloadHash,
    resourceUrl: expected.resourceUrl,
    merchantTo: expected.merchantTo,
    amount: expected.amount,
    asset: expected.asset,
    network: expected.network,
    expiresAt: expected.expiresAt,
    typedDataHash: expected.typedDataHash,
    payerDelegate: expected.payerDelegate,
    payerAgentId: expected.payerAgentId,
  })
  // Contents-derived, mirroring the builder (#1138, #1690): a tampered
  // auth.version cannot select a different rule than the signed message
  // encodes — the recomputed message simply stops matching.
  const expectedVersion = expected.payerDelegate ? 3 : expected.typedDataHash ? 2 : 1
  if (expected.auth?.version !== expectedVersion || expected.auth.message !== message) {
    throw new HavenSigningError('x402 expected context authentication message is invalid.')
  }
  if (!sameAddress(expected.auth.signer, trustedSigner)) {
    throw new HavenSigningError('x402 expected context was not signed by the configured Haven signer.')
  }
  if (!verifySignature(hashMessage(message), expected.auth.signature, trustedSigner)) {
    throw new HavenSigningError('x402 expected context signature could not be verified.')
  }
}

/**
 * Refuse to sign another agent's quote (#1690), mirroring the sweep guard's
 * `authorization.from` check.
 *
 * Runs only AFTER `assertExpectedBinding` has verified the Haven signature —
 * an unverified payer claim is attacker input, and refusing on it would let a
 * forged context turn the guard into a denial-of-service. And only when the
 * context CARRIES a payer claim: a v1/v2 context claims nothing, so there is
 * nothing to mismatch (the characterization suite pins that).
 *
 * The message is the point. A payer mismatch in the field means a long-lived
 * host cached one agent's wiring while the disk holds another's (#1681), and
 * before this guard the operator discovered that as an on-chain revert three
 * layers later. Naming both identities IS the diagnosis.
 */
function assertPayerMatchesDelegate(
  expected: X402ExpectedPayment,
  delegateAddress: string,
  localAgentId: string | undefined,
): void {
  if (!expected.payerDelegate) return
  if (sameAddress(expected.payerDelegate, delegateAddress)) return
  const quoteAgent = expected.payerAgentId ?? 'unknown'
  const localAgent = localAgentId ?? 'unknown'
  throw new HavenSigningError(
    `This quote belongs to a DIFFERENT agent: the quote was created for agent ${quoteAgent} ` +
      `(delegate ${expected.payerDelegate}), but this signer holds agent ${localAgent} ` +
      `(delegate ${delegateAddress}). A long-lived host is holding stale credentials — its ` +
      'session authenticates as the old agent while the signer on disk belongs to the new ' +
      'one. Nothing was signed. Restart the host so it re-reads its wiring, then re-quote.',
  )
}

function assertX402PaymentWindowOpen(expected: X402ExpectedPayment): void {
  if (!expected.expiresAt) return
  const expiresAtMs = Date.parse(expected.expiresAt)
  if (Number.isNaN(expiresAtMs)) {
    throw new HavenSigningError('x402 expected context expiresAt is not a valid ISO timestamp.')
  }
  if (expiresAtMs <= Date.now()) {
    throw new HavenError(
      'The x402 payment window expired before the merchant header could be signed. Re-quote with haven_pay_mcp_tool using the same idempotency_key before trying again.',
      AgentPaymentFailureCode.PaymentWindowExpired,
      410,
      expected.paymentId,
    )
  }
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}
