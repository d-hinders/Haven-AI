import {
  AgentPaymentFailureCode,
  AgentPaymentNextAction,
  HavenApiError,
  HavenError,
  HavenSigningError,
  HavenUnsupportedSignerVersionError,
  type X402PaymentRequired,
} from '@haven_ai/sdk'
import { z } from 'zod/v3'
import { isSettlementChildTypedData } from './settlement-child.js'
import {
  appendSigningAuditEntry,
  createSigningAuditEntry,
  hashPayloadForAudit,
  type SigningAuditContext,
} from './audit.js'
import type {
  EdgeSigner,
  X402ExpectedPayment,
  X402FundingSignatureResult,
  X402FundingTypedData,
} from './core.js'
import {
  fetchX402SignContext,
  type HavenIdentity,
  type FetchedSignContext,
} from './sign-context.js'

/**
 * Local signer tool set. These run on the agent's machine, next to the key,
 * and pair with the hosted server's construct/relay tools (#183). They sign;
 * they never call the Haven API and never emit the key.
 */
export type SignerToolName =
  | 'haven_sign'
  | 'haven_x402_sign_header'
  | 'haven_sign_x402'
  | 'haven_sign_sweep_delegate'

const sweepAuthorizationSchema = z.object({
  from: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'from must be a 0x address'),
  to: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'to must be a 0x address'),
  value: z.string().regex(/^[0-9]+$/, 'value must be a decimal atomic amount'),
  validAfter: z.string().regex(/^[0-9]+$/, 'validAfter must be a decimal unix time'),
  validBefore: z.string().regex(/^[0-9]+$/, 'validBefore must be a decimal unix time'),
  nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'nonce must be a 0x-prefixed 32-byte hex string'),
  token: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'token must be a 0x address'),
  chainId: z.number().int().positive(),
})

/**
 * Binding version at the tool boundary (#1143).
 *
 * Open on purpose. A literal (or literal union) here is validated by the MCP
 * server *before* any handler runs, so a signer one release behind the backend
 * rejected the payment with `Invalid literal value, expected 1 at
 * x402_expected.auth.version` — a message that names neither the cause (your
 * signer is stale) nor the fix (update it), and which no Haven code wrote.
 * Accept any positive integer here and let the signer decide semantically:
 * `SUPPORTED_X402_EXPECTED_VERSIONS` / `SUPPORTED_SWEEP_BINDING_VERSIONS` in
 * `core.ts` still fail closed on anything they do not know, so this widens the
 * *error path*, never what can be signed.
 */
const bindingVersionSchema = z.number().int().positive()

const sweepExpectedAuthSchema = z.object({
  version: bindingVersionSchema,
  message: z.string().min(1),
  signature: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/, 'signature must be a 0x-prefixed hex string'),
  signer: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'signer must be a 0x address'),
})

const x402ExpectedShape = {
  payment_id: z.string().min(1),
  payload_hash: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/, 'payload_hash must be a 0x-prefixed hex string'),
  resource_url: z.string().url(),
  merchant_to: z.string().min(1),
  amount: z.string().min(1),
  asset: z.string().min(1),
  network: z.string().min(1),
  // Required: expires_at is folded into the Haven-signed binding message, so the
  // signer must receive the exact same value to reconstruct a matching message.
  // Omitting it used to fail downstream with a cryptic "authentication message is
  // invalid" — making it required surfaces a clear INVALID_INPUT at the boundary.
  expires_at: z.string().min(1),
  // #1138: present on a delegation-rail (v2) context. It commits to the EIP-712
  // typed data the account validates; the signer refuses to raw-sign the bare
  // hash when it is present, and refuses to sign typed data when it is absent.
  typed_data_hash: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/, 'typed_data_hash must be a 0x-prefixed hex string')
    .optional(),
  // #1690: present on a v3 context. The delegate this quote was created FOR —
  // the signer refuses to sign when it is not its own. Inside the Haven-signed
  // message, so stripping it here would only break the binding signature.
  payer_delegate: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'payer_delegate must be a 0x-prefixed address')
    .optional(),
  payer_agent_id: z.string().min(1).optional(),
  auth: z.object({
    // Open at the boundary, enforced in the signer — see bindingVersionSchema.
    version: bindingVersionSchema,
    message: z.string().min(1),
    signature: z
      .string()
      .regex(/^0x[0-9a-fA-F]+$/, 'signature must be a 0x-prefixed hex string'),
    signer: z.string().min(1),
  }),
}

const x402ExpectedSchema = z.object(x402ExpectedShape)

export const toolSchemas: Record<SignerToolName, z.ZodRawShape> = {
  haven_sign_sweep_delegate: {
    // The authorization fields prepared by Haven's POST /sweep/prepare. Passed
    // through verbatim from the hosted haven_sweep_delegate tool — the signer
    // re-derives the binding message from these exact values.
    authorization: sweepAuthorizationSchema,
    // Haven's signature over the authorization context (the binding).
    expected_auth: sweepExpectedAuthSchema,
  },
  haven_sign: {
    // #1263: THE preferred x402 input — the signer fetches the exact signing
    // payload + expected context from Haven itself (authenticated with the
    // locally-stored agent credential), so no bulky bytes ever cross the
    // model. Pass payment_id ALONE for a delegation-rail x402 funding intent.
    payment_id: z.string().min(1).optional(),
    // The unsigned hash from haven_pay / haven_pay_x402_quote (payload_hash).
    // Optional when payment_id is supplied (the fetch carries it).
    payload_hash: z
      .string()
      .regex(/^0x[0-9a-fA-F]+$/, 'payload_hash must be a 0x-prefixed hex string')
      .optional(),
    // Pass x402.expected from hosted haven_pay_x402_quote when this hash funds
    // a standard x402 merchant retry. The signer records it locally and returns
    // an opaque x402_binding for the later header-signing step.
    x402_expected: x402ExpectedSchema.optional(),
    // #1138: delegation-rail intents sign THIS, not payload_hash. Object-typed
    // (not z.unknown()) so MCP clients embed it as JSON rather than a string.
    typed_data: z.record(z.string(), z.unknown()).optional(),
    // #1255: the same payload as ONE opaque base64 string, exactly as returned
    // by the hosted tools. Preferred over typed_data when both are present —
    // an agent re-emitting multi-KB nested JSON between tool calls is the
    // failure mode this field removes (a truncated/reshaped payload fails the
    // digest check and the payment refuses, correctly but pointlessly).
    // Bounded: a realistic redemption payload is ~10KB encoded; 256KB is
    // generous headroom while keeping the offline signer from materializing
    // arbitrarily large caller input.
    typed_data_b64: z.string().min(1).max(262144).optional(),
  },
  haven_x402_sign_header: {
    // The parsed HTTP 402 PaymentRequired from the merchant. Typed as an object
    // (not z.unknown(), which becomes empty JSON Schema `{}`) so MCP clients
    // embed it as JSON rather than serialising the object to a string.
    payment_required: z.record(z.string(), z.unknown()),
    // Opaque binding returned by haven_sign when x402_expected was supplied.
    x402_binding: z.string().min(1),
  },
  haven_sign_x402: {
    // #1263: preferred — pass payment_id (plus payment_required) and the
    // signer fetches the exact signing payload + expected context itself.
    payment_id: z.string().min(1).optional(),
    // One-shot x402 signing: funding hash + merchant header in one local call.
    // Both optional when payment_id is supplied (the fetch carries them).
    payload_hash: z
      .string()
      .regex(/^0x[0-9a-fA-F]+$/, 'payload_hash must be a 0x-prefixed hex string')
      .optional(),
    x402_expected: x402ExpectedSchema.optional(),
    // #1355: optional when payment_id is supplied — the signer's context fetch
    // carries the stored 402 PaymentRequired, so `{ payment_id }` alone is the
    // preferred call. Still required (via the runtime check in the handler)
    // for the quote-based fallback path without a payment_id.
    payment_required: z.record(z.string(), z.unknown()).optional(),
    // #1138: delegation-rail intents sign THIS, not payload_hash. Object-typed
    // (not z.unknown()) so MCP clients embed it as JSON rather than a string.
    typed_data: z.record(z.string(), z.unknown()).optional(),
    // #1255: see haven_sign.typed_data_b64 — the copy-through-safe form.
    typed_data_b64: z.string().min(1).max(262144).optional(),
  },
}

const SIGN_DESCRIPTION = [
  'Sign an unsigned Haven payment hash with the local delegate key. The delegate key never leaves',
  'this process. Pass the payload_hash returned by haven_pay or haven_pay_x402_quote.',
  'For x402, also pass x402_expected from haven_pay_x402_quote; the signer records it locally',
  'and returns { signature, x402_binding }. x402_expected includes expires_at; sign before that',
  'window closes. DELEGATION-RAIL x402 accounts (#1263): pass payment_id ALONE (preferred) — this',
  'signer fetches the exact signing payload and expected context from Haven itself, so nothing',
  'bulky ever crosses your context. Fallback: pass typed_data_b64 through UNCHANGED (never re-type',
  'the nested typed_data JSON); the account validates that EIP-712 payload, not payload_hash.',
  'Next: call mcp__haven__haven_submit with signature, then pass x402_binding',
  'to mcp__haven-signer__haven_x402_sign_header. For plain SafeTransfer payments, just pass payload_hash and',
  'relay the returned signature via mcp__haven__haven_submit.',
].join(' ')

const X402_SIGN_HEADER_DESCRIPTION = [
  'Build and sign the EIP-3009 merchant payment header for the merchant leg of an x402 payment.',
  'The delegate key stays local — only the signed header crosses any boundary.',
  'Pass the payment_required from the original merchant 402 response and the x402_binding',
  'returned by haven_sign. It must be haven_sign — NOT haven_sign_x402, which is a',
  'one-shot that builds the header itself and spends its own binding doing so. If you called',
  'haven_sign_x402, its result already carries payment_header; retry the merchant with that and',
  'do not call this tool. The signer validates the merchant, amount, resource, asset, and',
  'network against the recorded funding context before signing, checks expires_at when present,',
  'and rejects mismatches or expired payment windows.',
  'Returns { payment_header, accepted }. On your retry set BOTH PAYMENT-SIGNATURE (x402 v2) and',
  'X-PAYMENT (v1) to <payment_header>; a strict v2 merchant reads only the first.',
  'Only call after haven_submit has confirmed the funding step (nextAction=none or',
  'the funding tx has a confirmed status). Next for paid MCP tools: call mcp__haven__haven_complete_mcp_tool.',
].join(' ')

const SIGN_X402_DESCRIPTION = [
  'One-shot x402 signing for the fast 3-call flow: sign the funding hash AND build the EIP-3009',
  'merchant payment header in a single local call (equivalent to haven_sign followed by',
  'haven_x402_sign_header). The delegate key never leaves this process. From the haven_pay_mcp_tool',
  'result pass JUST payment_id — PREFERRED (#1263, #1355): this signer fetches the exact signing',
  'payload, expected context, and merchant payment_required from Haven itself, so nothing bulky',
  'crosses your context. If the signer reports the context carried no payment_required (older',
  'backend), re-call with payment_id plus payment_required verbatim from the pay result.',
  'Fallback for older backends: pass payload_hash, x402_expected (the nested x402.expected object —',
  'passing the whole x402 object is also accepted and unwrapped for you), and typed_data_b64',
  'through UNCHANGED; the signer',
  'signs the typed data instead of payload_hash and refuses the bare hash when the context commits to typed data.',
  'Returns',
  '{ signature, x402_binding, payment_header, accepted }; hand signature + payment_header to',
  'mcp__haven__haven_settle_mcp_tool to fund and settle in one hosted call. The header is built now (before',
  'funding confirms), so its short validity window starts here — call mcp__haven__haven_settle_mcp_tool promptly,',
  'and re-run mcp__haven__haven_pay_mcp_tool with the same idempotency_key if a tool returns PAYMENT_WINDOW_EXPIRED.',
  'The returned x402_binding is ALREADY SPENT — this tool consumed it building payment_header —',
  'so never pass it to mcp__haven-signer__haven_x402_sign_header; that tool is the follow-up to',
  'haven_sign, not to this one. payment_header IS the header to use.',
  'Next: for a paid MCP tool, call mcp__haven__haven_settle_mcp_tool. For a direct plain-HTTP x402',
  'merchant (the haven_pay_x402_quote path), relay signature via mcp__haven__haven_submit and then',
  'retry the original merchant URL YOURSELF, setting BOTH PAYMENT-SIGNATURE (x402 v2) and',
  'X-PAYMENT (v1) to payment_header — Haven never contacts that merchant.',
].join(' ')

const SIGN_SWEEP_DELEGATE_DESCRIPTION = [
  'Sign a Haven-prepared gasless USDC sweep that recovers stranded funds from the delegate',
  'wallet back to your Haven wallet. The delegate key never leaves this process and this tool',
  'never broadcasts — it returns only an EIP-3009 signature that Haven\'s relayer submits and',
  'pays gas for. Pass the authorization and expected_auth returned by the hosted',
  'haven_sweep_delegate tool. The signer verifies Haven authored the authorization and that it',
  'pays out to your own Safe before signing, then returns { signature } to hand back to',
  'mcp__haven__haven_sweep_delegate to complete recovery.',
].join(' ')

export const toolDescriptions: Record<SignerToolName, string> = {
  haven_sign: SIGN_DESCRIPTION,
  haven_x402_sign_header: X402_SIGN_HEADER_DESCRIPTION,
  haven_sign_x402: SIGN_X402_DESCRIPTION,
  haven_sign_sweep_delegate: SIGN_SWEEP_DELEGATE_DESCRIPTION,
}

/** Map the wire-shaped x402_expected (snake_case) to the EdgeSigner's camelCase context. */
/**
 * Sign the x402 funding leg on whichever rail the Haven-signed context declares
 * (#1138).
 *
 * The **context** selects the path, never the caller's arguments: a v2 context
 * (one that commits to a typed-data digest) requires typed data, a v1 context
 * requires the bare hash, and `assertExpectedBinding` rejects the mismatch. So
 * an agent that passes `typed_data` on a legacy-rail intent — or omits it on a
 * delegation-rail one — gets a clear refusal here rather than a signature the
 * chain rejects later.
 */
async function signFundingLeg(
  signer: EdgeSigner,
  expected: X402ExpectedPayment,
  payloadHash: string,
  typedData: Record<string, unknown> | undefined,
): Promise<X402FundingSignatureResult> {
  if (!expected.typedDataHash) {
    return signer.signX402FundingHash(payloadHash, expected)
  }
  if (!typedData) {
    throw new HavenSigningError(
      'This x402 funding intent is on the delegation rail: it commits to EIP-712 typed data, ' +
        'which was not supplied. Pass typed_data_b64 from haven_pay_mcp_tool / ' +
        'haven_pay_x402_quote through unchanged (or typed_data verbatim) — the bare ' +
        'payload_hash is not what the account validates.',
    )
  }
  return signer.signX402FundingTypedData(typedData as unknown as X402FundingTypedData, expected)
}

function toExpectedX402(raw: {
  payment_id: string
  payload_hash: string
  resource_url: string
  merchant_to: string
  amount: string
  asset: string
  network: string
  // Required at the tool boundary (see x402ExpectedSchema): it's folded into the
  // Haven-signed binding message. The EdgeSigner's internal type keeps it
  // optional because it skips the window check when absent.
  expires_at: string
  typed_data_hash?: string
  payer_delegate?: string
  payer_agent_id?: string
  auth: X402ExpectedPayment['auth']
}): X402ExpectedPayment {
  return {
    paymentId: raw.payment_id,
    payloadHash: raw.payload_hash,
    typedDataHash: raw.typed_data_hash,
    payerDelegate: raw.payer_delegate,
    payerAgentId: raw.payer_agent_id,
    resourceUrl: raw.resource_url,
    merchantTo: raw.merchant_to,
    amount: raw.amount,
    asset: raw.asset,
    network: raw.network,
    expiresAt: raw.expires_at,
    auth: raw.auth,
  }
}

/**
 * Validate a FETCHED expected context (#1263) against the same boundary schema
 * a tool argument passes through — provenance does not skip validation. A
 * malformed response names the fallback instead of leaking a Zod stack.
 */
function parseFetchedExpected(
  fetched: FetchedSignContext,
): Parameters<typeof toExpectedX402>[0] {
  const parsed = z.object(x402ExpectedShape).safeParse(fetched.x402Expected)
  if (!parsed.success) {
    throw new HavenSigningError(
      'The Haven sign-context response carried a malformed x402_expected — the backend may ' +
        'predate #1263. Pass payload_hash + x402_expected from the quote result instead. ' +
        `Underlying: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`,
    )
  }
  return parsed.data as Parameters<typeof toExpectedX402>[0]
}

export interface ToolSuccess<T> {
  success: true
  data: T
}

export interface ToolFailure {
  success: false
  code: string
  message: string
  statusCode?: number
  paymentId?: string
  next_action?: string
  retry_with_new_quote?: boolean
  suggested_tool?: string
  /**
   * #1309: present on `UNSUPPORTED_EXPECTED_CONTEXT_VERSION` /
   * `UNSUPPORTED_SWEEP_BINDING_VERSION` refusals — the exact version set this
   * signer install enforces, derived from `SUPPORTED_X402_EXPECTED_VERSIONS` /
   * `SUPPORTED_SWEEP_BINDING_VERSIONS` at the throw site.
   */
  supported_versions?: number[]
  /** #1309: the version Haven sent that triggered the refusal above. */
  received_version?: number
  /**
   * #1309: precise recovery guidance as DATA, not just prose inside `message`
   * — the same text the hosted quote's advisory `signer_compatibility.fallback`
   * carries when the refusal is an out-of-date signer.
   */
  fallback?: string
}

export type ToolPayload<T = unknown> = ToolSuccess<T> | ToolFailure

export interface ToolHandlerOptions {
  audit?: SigningAuditContext & { auditPath: string }
  /**
   * #1263: how the payment_id signing path reaches Haven. Lives at the MCP
   * server layer (the core stays network-free); absent → payment_id calls
   * refuse with a message naming the typed_data_b64 fallback.
   */
  signContext?: {
    loadIdentity: () => Promise<HavenIdentity | null>
    fetchImpl?: typeof fetch
  }
}

/**
 * Resolve the delegation-rail signing payload from the tool arguments (#1255).
 *
 * `typed_data_b64` wins over `typed_data`: it is the copy-through-safe form —
 * one opaque string the agent relays unchanged, instead of re-emitting multi-KB
 * nested JSON (a redemption UserOp's callData) between two tool calls. The live
 * #1255 failure was exactly that: the payload arrived altered, the digest check
 * refused (correctly), and the purchase died with no defect anywhere in the
 * chain. The decoded object goes through the SAME digest verification as a
 * plain typed_data — this changes the transport, never the trust model.
 */
function resolveTypedData(args: {
  typed_data?: Record<string, unknown>
  typed_data_b64?: string
}): Record<string, unknown> | undefined {
  if (!args.typed_data_b64) return args.typed_data
  try {
    const decoded = JSON.parse(
      Buffer.from(args.typed_data_b64, 'base64').toString('utf8'),
    ) as unknown
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new Error('decoded value is not an object')
    }
    return decoded as Record<string, unknown>
  } catch (err) {
    throw new HavenSigningError(
      'typed_data_b64 did not decode to a JSON object. Pass the exact string returned by the ' +
        'hosted Haven tool, unchanged — do not re-encode, trim, or reformat it. ' +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

export function createToolHandlers(
  signer: EdgeSigner,
  options: ToolHandlerOptions = {},
): Record<SignerToolName, (input: unknown) => Promise<ToolPayload>> {
  /**
   * #1263: resolve the signing inputs for a payment_id call by fetching the
   * exact bytes from Haven. Returns null when the caller did not use the
   * payment_id path. The fetched payload is untrusted input like any tool
   * argument — it still goes through the binding verification and digest
   * re-derivation downstream; this only changes HOW the bytes arrive.
   */
  async function resolveSignContext(args: {
    payment_id?: string
    payload_hash?: string
  }): Promise<FetchedSignContext | null> {
    if (!args.payment_id) return null
    const identity = (await options.signContext?.loadIdentity()) ?? null
    if (!identity) {
      throw new HavenSigningError(
        'payment_id signing needs the agent identity (identity.json next to the signer ' +
          'credentials), which this signer could not load. Re-run `npx @haven_ai/connect@alpha` ' +
          'to restore it, or pass typed_data_b64 from the quote result instead.',
      )
    }
    const ctx = await fetchX402SignContext(
      identity,
      args.payment_id,
      options.signContext?.fetchImpl,
    )
    if (
      args.payload_hash &&
      args.payload_hash.toLowerCase() !== ctx.payloadHash.toLowerCase()
    ) {
      throw new HavenSigningError(
        'The supplied payload_hash does not match the signing context Haven serves for ' +
          `payment ${args.payment_id}. Pass payment_id alone, or check which quote the ` +
          'hash came from.',
      )
    }
    return ctx
  }

  return {
    haven_sign: async (input) =>
      runTool(async () => {
        const args = parse('haven_sign', coerceX402Expected(input))
        const fetched = await resolveSignContext(args)
        const typedData = fetched?.typedData ?? resolveTypedData(args)
        const payloadHash = fetched?.payloadHash ?? args.payload_hash
        if (!payloadHash) {
          throw new HavenSigningError(
            'Pass payment_id (preferred for delegation-rail x402) or payload_hash.',
          )
        }
        const expectedRaw = fetched
          ? parseFetchedExpected(fetched)
          : args.x402_expected
        const x402Expected = expectedRaw ? toExpectedX402(expectedRaw) : null
        const result = x402Expected
          ? await signFundingLeg(signer, x402Expected, payloadHash, typedData)
          : null
        if (!result) {
          // #1254: a DIRECT delegation-rail payment carries typed_data and no
          // x402 context — the account validates the TYPED DATA, and a raw
          // signature over payload_hash is rejected on-chain (AA24, found
          // live). When typed_data is present it is what gets signed; the
          // raw-hash path below is the legacy AllowanceModule rail only.
          if (typedData) {
            // #1476: a DELEGATION payload is an authority grant to a third
            // party — the erc7710 settlement child, whose signature lets a
            // merchant's facilitator pull from the treasury. It must never be
            // signed without a Haven-signed expected context to verify against
            // (#1455), and until now nothing stopped that: whether the child
            // got verified depended on WHICH TOOL the caller happened to use,
            // which is a convention, not a boundary.
            //
            // Keyed off the payload's own shape rather than the caller's
            // choice, so #1254's direct-payment UserOp case is untouched: that
            // is the account validating its OWN operation, not a grant.
            if (isSettlementChildTypedData(typedData)) {
              throw new HavenSigningError(
                'Refusing to sign a delegation payload with no expected context. This typed data ' +
                  'is a DELEGATION — signing it grants a third party authority to move funds — so ' +
                  'it is only ever signed against a Haven-signed context that the caveats are ' +
                  'verified against. Call this tool with { payment_id } instead (the signer then ' +
                  'fetches and verifies the context itself), or use haven_sign_x402.',
              )
            }
            const signature = await signer.signDelegationTypedData(typedData)
            await auditSigning('haven_sign', payloadHash)
            return { signature }
          }
          const signature = signer.signPaymentHash(payloadHash)
          await auditSigning('haven_sign', payloadHash)
          return { signature }
        }
        await auditSigning('haven_sign', payloadHash)
        return { signature: result.signature, x402_binding: result.x402Binding }
      }),

    haven_x402_sign_header: async (input) =>
      runTool(async () => {
        // Defensive: the object-typed schema makes conformant MCP clients embed
        // payment_required as JSON, but some transports still serialise it to a
        // string. Coerce it back to an object BEFORE Zod validation so the
        // tightened schema doesn't reject it (else `.accepts` would be undefined
        // → "No compatible payment option found").
        const args = parse('haven_x402_sign_header', coercePaymentRequired(input))
        const result = await signer.buildX402PaymentHeader(
          args.payment_required as X402PaymentRequired,
          args.x402_binding,
        )
        await auditSigning(
          'haven_x402_sign_header',
          hashPayloadForAudit(args.payment_required),
        )
        return { payment_header: result.paymentHeader, accepted: result.accepted }
      }),

    haven_sign_x402: async (input) =>
      runTool(async () => {
        // Coerce a stringified payment_required (same transport guard as
        // haven_x402_sign_header) and unwrap a whole-`x402`-object x402_expected
        // before validation.
        const args = parse('haven_sign_x402', coerceX402Expected(coercePaymentRequired(input)))
        const fetched = await resolveSignContext(args)
        const payloadHash = fetched?.payloadHash ?? args.payload_hash
        const expectedRaw = fetched ? parseFetchedExpected(fetched) : args.x402_expected
        if (!payloadHash || !expectedRaw) {
          throw new HavenSigningError(
            'Pass payment_id (preferred — the signer fetches the signing context itself) ' +
              'or payload_hash + x402_expected from the quote result.',
          )
        }
        // 1. Sign the funding leg (records the binding + checks expiry/context).
        //    Which payload that is — bare hash or the account's typed data — is
        //    decided by the Haven-signed context, not by the caller (#1138).
        const funding = await signFundingLeg(
          signer,
          toExpectedX402(expectedRaw),
          payloadHash,
          fetched?.typedData ?? resolveTypedData(args),
        )
        // 2. Build the merchant EIP-3009 header against that binding — local, no network.
        //    #1355: prefer the PaymentRequired the context fetch carried (same
        //    Haven read the signing bytes came from — one less blob an agent
        //    relays); the caller-supplied copy is the fallback for pre-#1355
        //    backends. Either copy passes the SAME expected-context
        //    verification inside buildX402PaymentHeader — provenance is not
        //    what makes it safe (#1263 discipline).
        const paymentRequired = (fetched?.paymentRequired ?? args.payment_required) as
          | X402PaymentRequired
          | undefined
        if (!paymentRequired) {
          throw new HavenSigningError(
            fetched
              ? 'The Haven sign-context for this payment_id carried no payment_required ' +
                '(backend predates #1355). Pass payment_required from the pay result ' +
                'explicitly, verbatim.'
              : 'payment_required is required on the quote-based path (no payment_id to fetch ' +
                'it by). Pass it verbatim from the quote result.',
          )
        }
        const header = await signer.buildX402PaymentHeader(
          paymentRequired,
          funding.x402Binding,
        )
        // Two audit entries — one per signing operation — matching the
        // decomposed haven_sign + haven_x402_sign_header trail, so the funding
        // signature and the merchant header remain distinguishable in the log.
        await auditSigning('haven_sign_x402', payloadHash)
        await auditSigning('haven_sign_x402', hashPayloadForAudit(paymentRequired))
        return {
          signature: funding.signature,
          x402_binding: funding.x402Binding,
          payment_header: header.paymentHeader,
          accepted: header.accepted,
        }
      }),

    haven_sign_sweep_delegate: async (input) =>
      runTool(async () => {
        const args = parse('haven_sign_sweep_delegate', input)
        const result = await signer.signSweepAuthorization({
          authorization: args.authorization,
          expectedAuth: args.expected_auth,
          // Cross-check `to` against the Safe in the local credential when present.
          expectedSafe: options.audit?.safeAddress,
        })
        await auditSigning(
          'haven_sign_sweep_delegate',
          hashPayloadForAudit(args.authorization),
        )
        return { signature: result.signature }
      }),
  }

  async function auditSigning(tool: SignerToolName, payloadHash: string): Promise<void> {
    if (!options.audit) return
    const { auditPath, ...context } = options.audit
    await appendSigningAuditEntry(
      createSigningAuditEntry(tool, payloadHash, {
        ...context,
        delegateAddress: signer.delegateAddress,
      }),
      auditPath,
    )
  }
}

function parse<TName extends SignerToolName>(name: TName, input: unknown): Record<string, any> {
  return z.object(toolSchemas[name]).parse(input ?? {})
}

/**
 * Tolerate the agent passing the whole `x402` object from haven_pay_mcp_tool /
 * haven_pay_x402_quote where only the nested `x402.expected` signing context is
 * wanted. The wrapper looks like `{ accepted, resource_url, merchant_to,
 * funding_to, expected: {...} }` and lacks the top-level `auth` binding the
 * schema requires — so when `x402_expected.auth` is absent but
 * `x402_expected.expected` is an object, unwrap to `.expected`. Also parses a
 * JSON-stringified value back to an object first (some transports stringify
 * object args). This removes the easiest-to-make handoff mistake without a
 * breaking parameter rename.
 */
function coerceX402Expected(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input
  const record = input as Record<string, unknown>
  let value: unknown = record.x402_expected
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return input
    }
  }
  if (!value || typeof value !== 'object') return input
  const obj = value as Record<string, unknown>
  if (obj.auth === undefined && obj.expected && typeof obj.expected === 'object') {
    return { ...record, x402_expected: obj.expected }
  }
  // Parsed-from-string but already the right shape: keep the parsed object.
  if (value !== record.x402_expected) return { ...record, x402_expected: value }
  return input
}

/**
 * If a caller's transport serialised `payment_required` to a JSON string,
 * parse it back to an object before schema validation. Leaves a real object
 * (or anything that isn't valid JSON) untouched.
 */
function coercePaymentRequired(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input
  const record = input as Record<string, unknown>
  if (typeof record.payment_required !== 'string') return input
  try {
    return { ...record, payment_required: JSON.parse(record.payment_required) }
  } catch {
    return input
  }
}

async function runTool<T>(fn: () => Promise<T>): Promise<ToolPayload<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (err) {
    return normalizeError(err)
  }
}

function normalizeError(err: unknown): ToolFailure {
  if (err instanceof z.ZodError) {
    return {
      success: false,
      code: 'INVALID_INPUT',
      message: err.errors.map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`).join('; '),
      statusCode: 400,
    }
  }
  if (err instanceof HavenUnsupportedSignerVersionError) {
    // #1309: the structured signer refusal. `code` is one of
    // SignerRefusalCode's two values (not the generic 'SIGNING_ERROR'
    // HavenSigningError hard-codes), so an agent can route on it directly
    // instead of matching prose. next_action reuses the EXISTING
    // AgentPaymentNextAction taxonomy (StopAndTellUser) rather than inventing
    // a parallel vocabulary — this refusal is exactly that: stop, don't retry
    // as-is, tell the user what fallback says.
    return {
      success: false,
      code: err.code,
      message: err.message,
      supported_versions: [...err.supportedVersions],
      received_version: err.receivedVersion,
      fallback: err.fallback,
      next_action: AgentPaymentNextAction.StopAndTellUser,
    }
  }
  if (err instanceof HavenSigningError) {
    return { success: false, code: err.code, message: err.message }
  }
  if (err instanceof HavenApiError) {
    return { success: false, code: err.code, message: err.message, statusCode: err.statusCode }
  }
  if (err instanceof HavenError) {
    return {
      success: false,
      code: err.code,
      message: err.message,
      statusCode: err.statusCode,
      paymentId: err.paymentId,
      ...(err.code === AgentPaymentFailureCode.PaymentWindowExpired
        ? {
            next_action: AgentPaymentNextAction.PaymentWindowExpired,
            retry_with_new_quote: true,
            suggested_tool: 'haven_pay_mcp_tool',
          }
        : {}),
    }
  }
  return {
    success: false,
    code: 'UNKNOWN_ERROR',
    message: err instanceof Error ? err.message : String(err),
  }
}
