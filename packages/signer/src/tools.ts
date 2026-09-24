import {
  AgentPaymentFailureCode,
  AgentPaymentNextAction,
  HavenApiError,
  HavenError,
  HavenSigningError,
  HavenUnsupportedSignerVersionError,
  HavenUserOpBindingError,
  assertUserOpTypedDataBinding,
  connectorRerunCommand,
  isPackedUserOperationTypedData,
  type X402PaymentRequired,
} from '@haven_ai/sdk/edge'
import { decodeFunctionData, encodeFunctionData, hashTypedData } from 'viem'
import { z } from 'zod/v3'
import { DELEGATION_MANAGER, isSettlementChildTypedData } from './settlement-child.js'
import { deriveDelegateAccountAddress } from './delegate-account.js'
import { assertRedeemsOwnBudgetDelegation } from './redemption-guard.js'
import { HavenBareHashRefusedError } from './bare-hash.js'
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
  fetchDirectSignContext,
  fetchX402SignContext,
  HavenSignContextError,
  type HavenIdentity,
  type FetchedDirectSignContext,
  type FetchedSignContext,
} from './sign-context.js'
import { nextStepWireFields, signerRefusalStep } from './next-step.js'

/**
 * #3271: structured refusal for a direct-payment `PackedUserOperation` whose
 * typed data does not recompute to its own `payload_hash` — the payload was
 * altered between the Haven result and this call (a language model relaying
 * multi-KB typed data by hand is the observed cause; #3271 was found live as
 * an `AA24 signature error` from the bundler, after a bad signature was
 * already produced). Modelled on `HavenBareHashRefusedError` (#3169) and the
 * `HavenSignContextError` family (#3001): a named `code`, a `next_action`,
 * and a typed next step. No tool can fix this from inside the call — the
 * remedy is signing by `payment_id` (this signer then fetches the exact
 * bytes) or passing the result's typed data unchanged — so the step names
 * none and says why. Never reaches `signer.signDelegationTypedData` and is
 * never audited: nothing was signed.
 */
export const USEROP_BINDING_MISMATCH = 'USEROP_BINDING_MISMATCH' as const

export class HavenUserOpBindingRefusedError extends HavenSigningError {
  declare readonly code: typeof USEROP_BINDING_MISMATCH
  readonly next_action = AgentPaymentNextAction.StopAndTellUser
  readonly step: ReturnType<typeof signerRefusalStep>

  /** `message`: the SDK's `HavenUserOpBindingError.message` verbatim — it already names the mismatch and the remedy. */
  constructor(message: string) {
    super(message)
    ;(this as { code: string }).code = USEROP_BINDING_MISMATCH
    this.name = 'HavenUserOpBindingRefusedError'
    this.step = signerRefusalStep({
      nextAction: AgentPaymentNextAction.StopAndTellUser,
      nextTool: null,
      nextToolOmittedReason:
        'call haven_sign again with payment_id alone (preferred), or with typed_data copied unchanged from the payment result',
    })
  }
}

/**
 * #3272: the unbound branch's allowlist. `assertUserOpTypedDataBinding`
 * (#3271) proves the typed data and its `payload_hash` describe the SAME
 * operation — necessary, never sufficient, because the caller supplies both
 * values, so a self-consistent forgery binds perfectly to itself. This is
 * the rest of the property: the operation described is the ONE shape this
 * branch may ever sign — a direct payment that redeems the agent's own
 * budget delegation, for its own account, on a chain the delegation rail
 * runs on. Everything else (another agent's account, a self-call such as
 * `transferOwnership`, a batch `execute`, a call to any contract other than
 * the DelegationManager) is refused here, before
 * `signer.signDelegationTypedData` ever sees it. Modelled on
 * `HavenUserOpBindingRefusedError`: no signature, no audit entry, ever, for
 * any refusal from this function.
 */
export const TYPED_DATA_NOT_ALLOWED = 'TYPED_DATA_NOT_ALLOWED' as const

export class HavenTypedDataNotAllowedError extends HavenSigningError {
  declare readonly code: typeof TYPED_DATA_NOT_ALLOWED
  readonly next_action = AgentPaymentNextAction.StopAndTellUser
  readonly step: ReturnType<typeof signerRefusalStep>

  constructor(message: string) {
    super(message)
    ;(this as { code: string }).code = TYPED_DATA_NOT_ALLOWED
    this.name = 'HavenTypedDataNotAllowedError'
    this.step = signerRefusalStep({
      nextAction: AgentPaymentNextAction.StopAndTellUser,
      nextTool: null,
      nextToolOmittedReason:
        'sign only Haven-prepared payloads: call haven_sign with payment_id (preferred), or pass ' +
        'typed_data / typed_data_b64 copied unchanged from a haven_send / haven_pay result, or ' +
        'x402_expected from a Haven quote',
    })
  }
}

/**
 * Chains the delegation rail has PINNED delegation contracts for
 * (`packages/backend/src/rails/delegation-contracts.ts`) — the only chains a
 * direct-payment UserOp may be scoped to. Gnosis (100) has no pinned
 * DelegationManager/enforcer set, so it is deliberately excluded even though
 * the delegate account itself could exist there.
 */
const DIRECT_PAYMENT_CHAIN_IDS: ReadonlySet<number> = new Set([8453, 84532])

/** The DeleGator's single-execution `execute((address,uint256,bytes))` — selector `0x5c1c6dcd`. */
const EXECUTE_ABI = [
  {
    type: 'function',
    name: 'execute',
    inputs: [
      {
        name: '_execution',
        type: 'tuple',
        components: [
          { name: 'target', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [],
    stateMutability: 'payable',
  },
] as const

/**
 * The content + provenance allowlist (#3272 criteria 1–2). Call ONLY after
 * `assertUserOpTypedDataBinding` has already proven `typedData` is a
 * well-formed `PackedUserOperation` matching its own `payload_hash` — this
 * function trusts `typedData.domain`/`message` are shaped correctly and
 * checks only what they SAY.
 */
function assertBoundDirectPaymentUserOp(
  typedData: Record<string, unknown>,
  delegateAddress: string,
): void {
  const domain = (typedData.domain ?? {}) as Record<string, unknown>
  const message = (typedData.message ?? {}) as Record<string, unknown>

  // (N1) chainId must already be a number/bigint. `Number(domain.chainId)`
  // below would happily parse a numeric STRING, but viem's own EIP-712
  // domain encoding does not accept a string chainId the same way — passing
  // one through to `signDelegationTypedData` can silently drop it from the
  // domain the digest actually covers, producing a different signed payload
  // than this check evaluated. Refuse before that gap can matter.
  if (typeof domain.chainId !== 'number' && typeof domain.chainId !== 'bigint') {
    throw new HavenTypedDataNotAllowedError(
      `This UserOperation's domain.chainId is ${typeof domain.chainId} (${String(domain.chainId)}), ` +
        'not a number — refusing rather than risk signing a different EIP-712 domain than this ' +
        'check evaluated.',
    )
  }

  // (c) chain: only where the delegation rail has pinned contracts.
  const chainId = Number(domain.chainId)
  if (!DIRECT_PAYMENT_CHAIN_IDS.has(chainId)) {
    throw new HavenTypedDataNotAllowedError(
      'This signer only signs direct payments on chains the delegation rail has pinned ' +
        `contracts for (${[...DIRECT_PAYMENT_CHAIN_IDS].join(', ')}); this typed data names ` +
        `chain ${String(domain.chainId)}. Refusing.`,
    )
  }

  // (d) sender: only this signer's OWN counterfactual delegate account —
  // `assertUserOpTypedDataBinding` already proved `sender === verifyingContract`.
  const ownAccount = deriveDelegateAccountAddress(delegateAddress as `0x${string}`)
  const sender = typeof message.sender === 'string' ? message.sender : ''
  if (sender.toLowerCase() !== ownAccount.toLowerCase()) {
    throw new HavenTypedDataNotAllowedError(
      `This UserOperation's account (${sender || 'unknown'}) is not this signer's own delegate ` +
        `account (${ownAccount}) — signing it would authorize a DIFFERENT account's operation. ` +
        'Sign only your own agent\'s Haven-prepared payloads.',
    )
  }

  // (e) callData: a single execute(DelegationManager, 0, redeemDelegations(...)) —
  // never a batch execute (ERC-7579 `execute(bytes32,bytes)`, selector
  // `0xe9ae5c53`), an executeFromExecutor, a self-call, or a call to any
  // other contract.
  const callData = message.callData as `0x${string}`
  let decoded: { target: `0x${string}`; value: bigint; callData: `0x${string}` }
  try {
    const { args } = decodeFunctionData({
      abi: EXECUTE_ABI,
      data: callData,
    })
    decoded = args[0] as unknown as typeof decoded
  } catch {
    throw new HavenTypedDataNotAllowedError(
      "This UserOperation's callData is not a single execute((address,uint256,bytes)) call " +
        '— a batch execute, executeFromExecutor, or any other selector is refused. This ' +
        'signer only signs direct payments.',
    )
  }
  // Canonical encoding: re-encoding the decoded call must reproduce the EXACT
  // bytes, or `decodeFunctionData`'s tolerance of trailing/non-canonical
  // padding would let calldata smuggle bytes past every check below.
  const reEncodedExecute = encodeFunctionData({
    abi: EXECUTE_ABI,
    functionName: 'execute',
    args: [decoded],
  })
  if (reEncodedExecute.toLowerCase() !== callData.toLowerCase()) {
    throw new HavenTypedDataNotAllowedError(
      "This UserOperation's execute() call does not re-encode to the exact callData bytes " +
        '(trailing or non-canonical bytes). Refusing.',
    )
  }
  if (decoded.target.toLowerCase() !== DELEGATION_MANAGER.toLowerCase()) {
    throw new HavenTypedDataNotAllowedError(
      `This UserOperation's execute() calls ${decoded.target}, not the DelegationManager ` +
        `(${DELEGATION_MANAGER}). A direct payment only ever redeems the agent's own budget ` +
        'delegation — refusing what looks like a self-call (e.g. transferOwnership, ' +
        'updateSigners, upgradeToAndCall) or a call to an unrelated contract.',
    )
  }
  if (decoded.value !== 0n) {
    throw new HavenTypedDataNotAllowedError(
      `This UserOperation's execute() sends ${decoded.value} wei of native value alongside the ` +
        'DelegationManager call — a direct payment never does. Refusing.',
    )
  }
  // #3272 (B1): decode the redemption ARGUMENTS, not just the selector — an
  // empty (or otherwise not-this-signer's) delegation chain is a capture
  // vector, not a shape the redeemDelegations selector alone rules out. Any
  // HavenSigningError this throws is a refusal like the others; converted
  // below via the same `try`.
  try {
    assertRedeemsOwnBudgetDelegation(decoded.callData, ownAccount as `0x${string}`)
  } catch (err) {
    throw new HavenTypedDataNotAllowedError(
      err instanceof Error ? err.message : String(err),
    )
  }
}

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
    .regex(/^0x[0-9a-fA-F]{64}$/, 'payload_hash must be a 0x-prefixed 32-byte hex string'),
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
    .regex(/^0x[0-9a-fA-F]{64}$/, 'typed_data_hash must be a 0x-prefixed 32-byte hex string')
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

export const toolSchemas = {
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
      .regex(/^0x[0-9a-fA-F]{64}$/, 'payload_hash must be a 0x-prefixed 32-byte hex string')
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
      .regex(/^0x[0-9a-fA-F]{64}$/, 'payload_hash must be a 0x-prefixed 32-byte hex string')
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
// #3101: keys survive on the type (see the hosted server's contracts.ts).
} as const satisfies Record<SignerToolName, z.ZodRawShape>

const SIGN_DESCRIPTION = [
  'Sign an unsigned Haven payment with the local delegate key. The delegate key never leaves',
  'this process. Pass payment_id (preferred), or the payload_hash from haven_pay / haven_pay_x402_quote',
  'TOGETHER WITH typed_data / typed_data_b64 or x402_expected — never a payload_hash alone.',
  'For x402, also pass x402_expected from haven_pay_x402_quote; the signer records it locally',
  'and returns { signature, x402_binding }. x402_expected includes expires_at; sign before that',
  'window closes. DELEGATION-RAIL x402 accounts (#1263): pass payment_id ALONE (preferred) — this',
  'signer fetches the exact signing payload and expected context from Haven itself, so nothing',
  'bulky ever crosses your context. DIRECT payments (#3271, haven_send / haven_pay): payment_id',
  'ALONE also works here — the signer fetches the exact PackedUserOperation typed data and its',
  'payload_hash from Haven and checks them against each other before signing, so a payload corrupted',
  'in transit is refused (USEROP_BINDING_MISMATCH) instead of producing a bad signature. Fallback for',
  'either flow: pass typed_data_b64 through UNCHANGED (never re-type the nested typed_data JSON); the',
  'account validates that EIP-712 payload, not payload_hash. On a direct payment the same binding',
  'check runs on the relayed payload too. This tool signs ONLY Haven-prepared payloads (#3272): a',
  'direct-payment UserOp that redeems your own budget delegation for your own account, or an x402',
  'intent against a Haven-signed context — never an arbitrary typed_data payload, however it is shaped.',
  'Next: call mcp__haven__haven_submit with signature, then pass x402_binding',
  'to mcp__haven-signer__haven_x402_sign_header. A bare payload_hash with no payment_id, typed_data',
  'or x402_expected is REFUSED (BARE_HASH_REFUSED): a hash carries nothing this signer can verify.',
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
 * Sign the x402 funding leg (#1138). Every x402 funding intent is now
 * delegation-rail typed data (#3272 criterion 8: the bare-hash v1 rail and
 * `signX402FundingHash` are retired) — `signX402FundingTypedData` itself
 * refuses a v1 context (no `typedDataHash`) with the structured
 * version-mismatch error, whether or not `typedData` was supplied, so this
 * function does no rail selection of its own.
 */
async function signFundingLeg(
  signer: EdgeSigner,
  expected: X402ExpectedPayment,
  typedData: Record<string, unknown> | undefined,
): Promise<X402FundingSignatureResult> {
  return signer.signX402FundingTypedData(typedData as unknown as X402FundingTypedData | undefined, expected)
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
  /** #3101 (epic #3105, decision 7): the typed next-step family, additive; `next_tool` never null. */
  next_tool?: string
  next_tool_server?: string
  next_tool_name?: string
  next_tool_server_role?: 'hosted' | 'signer'
  next_arguments?: Record<string, unknown>
  next_tool_omitted_reason?: string
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
   * carries when the refusal is an out-of-date signer. #3001 reuses this same
   * field for every sign-context refusal (`'typed_data_b64'`).
   */
  fallback?: string
  /**
   * #3001: present on `SIGN_CONTEXT_REFUSED` — the HTTP status the backend
   * answered the sign-context fetch with (404, 410, …) — the x402 fetch, or
   * the direct `/payments/:id/sign-context` fetch since #3271.
   */
  http_status?: number
  /** #3001: the backend's own `error_code` on `SIGN_CONTEXT_REFUSED` (`expired`, `already_executed`, `not_signable`, `sign_context_unavailable`). */
  backend_error_code?: string
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
 * #1255 failure was exactly that: the payload arrived altered, the x402 digest
 * check refused it (correctly), and the purchase died with no defect anywhere
 * in the chain. The decoded object goes through the SAME verification as a
 * plain typed_data downstream — this changes the transport, never the trust
 * model. On the x402 funding leg that verification was already a digest check
 * against the Haven-signed expected context (#1138); on the DIRECT-payment
 * `PackedUserOperation` path it is #3271's binding check against the payment's
 * own `payload_hash` — before #3271 that path had no digest check at all, so
 * an altered direct-payment payload signed silently instead of refusing.
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
  function checkPayloadHashMatch(
    suppliedHash: string | undefined,
    fetchedHash: string,
    paymentId: string,
  ): void {
    if (suppliedHash && suppliedHash.toLowerCase() !== fetchedHash.toLowerCase()) {
      throw new HavenSigningError(
        'The supplied payload_hash does not match the signing context Haven serves for ' +
          `payment ${paymentId}. Pass payment_id alone, or check which quote the ` +
          'hash came from.',
      )
    }
  }

  /**
   * #1263 / #3271: resolve the signing inputs for a payment_id call by
   * fetching the exact bytes from Haven. Returns null when the caller did not
   * use the payment_id path. The fetched payload is untrusted input like any
   * tool argument — it still goes through the binding verification and digest
   * re-derivation downstream; this only changes HOW the bytes arrive.
   *
   * Tries the x402 sign-context first, always — x402 behaviour is unchanged.
   * `haven_sign` (never `haven_sign_x402`) additionally falls back to the
   * direct-payment sign-context (`GET /payments/:id/sign-context`) when the
   * backend refuses the x402 fetch with its 409 `sign_context_unavailable` —
   * the shape this payment_id names a direct payment, not an x402 intent.
   */
  async function resolveSignContext(
    args: { payment_id?: string; payload_hash?: string },
    opts: { allowDirectFallback: boolean },
  ): Promise<
    | { kind: 'x402'; ctx: FetchedSignContext }
    | { kind: 'direct'; ctx: FetchedDirectSignContext }
    | null
  > {
    if (!args.payment_id) return null
    const identity = (await options.signContext?.loadIdentity()) ?? null
    if (!identity) {
      throw new HavenSigningError(
        'payment_id signing needs the agent identity (identity.json next to the signer ' +
          `credentials), which this signer could not load. Re-run \`${connectorRerunCommand()}\` ` +
          'to restore it, or pass typed_data_b64 from the quote result instead.',
      )
    }
    try {
      const ctx = await fetchX402SignContext(identity, args.payment_id, options.signContext?.fetchImpl)
      checkPayloadHashMatch(args.payload_hash, ctx.payloadHash, args.payment_id)
      return { kind: 'x402', ctx }
    } catch (err) {
      if (
        opts.allowDirectFallback &&
        err instanceof HavenSignContextError &&
        err.http_status === 409 &&
        err.backend_error_code === 'sign_context_unavailable'
      ) {
        let ctx: FetchedDirectSignContext
        try {
          ctx = await fetchDirectSignContext(identity, args.payment_id, options.signContext?.fetchImpl)
        } catch (directErr) {
          // The x402 route also answers 409 `sign_context_unavailable` for an
          // x402 row it cannot serve (legacy rail). The direct route then
          // 409s back with the same code, pointing at the x402 route: the
          // x402 refusal is the real reason, so surface that one.
          if (
            directErr instanceof HavenSignContextError &&
            directErr.http_status === 409 &&
            directErr.backend_error_code === 'sign_context_unavailable'
          ) {
            throw err
          }
          throw directErr
        }
        checkPayloadHashMatch(args.payload_hash, ctx.payloadHash, args.payment_id)
        return { kind: 'direct', ctx }
      }
      throw err
    }
  }

  return {
    haven_sign: async (input) =>
      runTool(async () => {
        const args = parse('haven_sign', coerceX402Expected(input))
        // #3271: only haven_sign falls back to the direct-payment
        // sign-context; haven_sign_x402 never does (below).
        const resolved = await resolveSignContext(args, { allowDirectFallback: true })
        const typedData = resolved?.ctx.typedData ?? resolveTypedData(args)
        const payloadHash = resolved?.ctx.payloadHash ?? args.payload_hash
        if (!payloadHash) {
          throw new HavenSigningError(
            'Pass payment_id (preferred for delegation-rail x402 or direct payments) or payload_hash.',
          )
        }
        // A direct-payment fetch (`resolved.kind === 'direct'`) carries no
        // x402 expected context at all — it must not reach
        // parseFetchedExpected, which assumes the x402 shape.
        const expectedRaw =
          resolved?.kind === 'x402'
            ? parseFetchedExpected(resolved.ctx)
            : resolved?.kind === 'direct'
              ? null
              : args.x402_expected
        const x402Expected = expectedRaw ? toExpectedX402(expectedRaw) : null
        const result = x402Expected
          ? await signFundingLeg(signer, x402Expected, typedData)
          : null
        if (!result) {
          // #1254: a DIRECT delegation-rail payment carries typed_data and no
          // x402 context — the account validates the TYPED DATA, and a raw
          // signature over payload_hash is rejected on-chain (AA24, found
          // live). When typed_data is present it is what gets signed. There is
          // no raw-hash path any more (#3169): the AllowanceModule rail it
          // served is retired, and signing caller-supplied bytes with no
          // shape to inspect was a blind-signing oracle for the delegate key.
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
            // #3272: the allowlist. This branch signs EXACTLY ONE shape — a
            // direct-payment PackedUserOperation — and nothing else, however
            // it is dressed up (a probe with an invented domain, a delegate
            // TransferWithAuthorization, a USDC Permit, …). Everything that
            // is not that shape is refused before either check below runs.
            if (resolved?.kind !== 'direct' && !isPackedUserOperationTypedData(typedData)) {
              throw new HavenTypedDataNotAllowedError(
                'This signer signs only Haven-prepared payloads: a direct-payment ' +
                  'PackedUserOperation that redeems your own budget delegation for your own ' +
                  'account, or a Haven-signed x402 context. Call haven_sign with payment_id ' +
                  '(preferred), or pass x402_expected for an x402 funding leg.',
              )
            }
            // #3271: the digest check that binds this exact typed data to its
            // own payload_hash, in the HybridDeleGator domain of its own
            // sender, against the v0.7 EntryPoint. Runs whether the bytes
            // arrived by tool argument or by the payment_id fetch above; a
            // corrupted payload is refused here, before a signature over the
            // wrong digest is produced. Necessary, never sufficient — a
            // self-consistent forgery binds perfectly to itself, which is
            // exactly what #3272's allowlist below closes.
            try {
              assertUserOpTypedDataBinding(typedData, payloadHash)
            } catch (err) {
              if (err instanceof HavenUserOpBindingError) {
                throw new HavenUserOpBindingRefusedError(err.message)
              }
              throw err
            }
            // #3272: content + provenance — the ONE operation this branch may
            // ever sign: redeeming the agent's own budget delegation, for its
            // own account, on a chain the delegation rail runs on.
            assertBoundDirectPaymentUserOp(typedData, signer.delegateAddress)
            const signature = await signer.signDelegationTypedData(typedData)
            // #3272 (criterion 4): audit the digest actually signed — the
            // EIP-712 hash of this typed data — never the caller-supplied
            // payload_hash (the ERC-4337 UserOp hash, a DIFFERENT value the
            // #3271 check above merely cross-checked this typed data against).
            await auditSigning('haven_sign', hashTypedData(typedData as Parameters<typeof hashTypedData>[0]))
            return { signature }
          }
          // #3169: bare hash, nothing to verify against — refused, never signed.
          // Not audited as a signing operation: nothing was signed.
          throw new HavenBareHashRefusedError()
        }
        // #3272 (criterion 4): audit the digest actually signed. `result`
        // only exists here because signFundingLeg succeeded, which requires
        // `typedData` to be present and hashed — never the caller-supplied
        // payload_hash, a different value the expected-context binding
        // merely cross-checks this typed data against.
        await auditSigning('haven_sign', hashTypedData(typedData as Parameters<typeof hashTypedData>[0]))
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
        // #3271: haven_sign_x402 NEVER falls back to the direct-payment
        // sign-context — a payment_id that names a direct payment has no
        // x402 context to fund a merchant retry with, so it is refused here
        // exactly as an unreachable/malformed fetch already was.
        const resolved = await resolveSignContext(args, { allowDirectFallback: false })
        const fetched = resolved?.kind === 'x402' ? resolved.ctx : undefined
        const payloadHash = fetched?.payloadHash ?? args.payload_hash
        const expectedRaw = fetched ? parseFetchedExpected(fetched) : args.x402_expected
        if (!payloadHash || !expectedRaw) {
          throw new HavenSigningError(
            'Pass payment_id (preferred — the signer fetches the signing context itself) ' +
              'or payload_hash + x402_expected from the quote result.',
          )
        }
        // 1. Sign the funding leg (records the binding + checks expiry/context).
        const fundingTypedData = fetched?.typedData ?? resolveTypedData(args)
        const funding = await signFundingLeg(signer, toExpectedX402(expectedRaw), fundingTypedData)
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
        // #3272 (criterion 4): the funding entry records the digest actually
        // signed — `fundingTypedData` is guaranteed present here, since
        // `signFundingLeg` above would otherwise have refused.
        await auditSigning(
          'haven_sign_x402',
          hashTypedData(fundingTypedData as Parameters<typeof hashTypedData>[0]),
        )
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
          expectedSafe: options.audit?.accountAddress,
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
    try {
      await appendSigningAuditEntry(
        createSigningAuditEntry(tool, payloadHash, {
          ...context,
          delegateAddress: signer.delegateAddress,
        }),
        auditPath,
      )
    } catch (err) {
      // #3172 review: the audit is written AFTER the key has signed. A
      // filesystem failure here (disk full, read-only, a rotation race) must
      // not turn a produced signature into a failed tool call — the agent
      // would re-quote and re-sign for nothing. Say so on stderr instead.
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`haven-signer: warning: audit entry for ${tool} could not be written to ${auditPath}: ${message}\n`)
    }
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
      // #3103: no tool can fix a version skew from inside the call.
      ...nextStepWireFields(signerRefusalStep({
        nextAction: AgentPaymentNextAction.StopAndTellUser,
        nextTool: null,
        nextToolOmittedReason: 'update @haven_ai/signer by re-running the connector, then repeat the same call',
      })),
    }
  }
  if (err instanceof HavenBareHashRefusedError) {
    // #3169: the bare-hash refusal, structured like the others. Checked BEFORE
    // the `HavenSigningError` branch below since this class extends it.
    return {
      success: false,
      code: err.code,
      message: err.message,
      next_action: err.next_action,
      ...nextStepWireFields(err.step),
    }
  }
  if (err instanceof HavenUserOpBindingRefusedError) {
    // #3271: the UserOp binding-mismatch refusal, structured like the others.
    // Checked BEFORE the `HavenSigningError` branch below since this class
    // extends it.
    return {
      success: false,
      code: err.code,
      message: err.message,
      next_action: err.next_action,
      ...nextStepWireFields(err.step),
    }
  }
  if (err instanceof HavenTypedDataNotAllowedError) {
    // #3272: the unbound-branch allowlist refusal, structured like the
    // others. Checked BEFORE the `HavenSigningError` branch below since this
    // class extends it.
    return {
      success: false,
      code: err.code,
      message: err.message,
      next_action: err.next_action,
      ...nextStepWireFields(err.step),
    }
  }
  if (err instanceof HavenSignContextError) {
    // #3001: every fetchX402SignContext refusal (timeout, unreachable, a
    // non-ok backend response, a malformed body) — structured the same way as
    // the version-mismatch refusal below, instead of the generic
    // `{ code: 'SIGNING_ERROR' }` a plain HavenSigningError produces. Checked
    // BEFORE the `HavenSigningError` branch below since this class extends it.
    return {
      success: false,
      code: err.code,
      message: err.message,
      next_action: err.next_action,
      ...(err.fallback !== undefined ? { fallback: err.fallback } : {}),
      ...(err.retry_with_new_quote ? { retry_with_new_quote: true } : {}),
      ...(err.http_status !== undefined ? { http_status: err.http_status } : {}),
      ...(err.backend_error_code !== undefined ? { backend_error_code: err.backend_error_code } : {}),
      // #3103: the typed step the error decided beside its action.
      ...(err.next_tool ? { next_tool: err.next_tool } : {}),
      ...(err.next_tool_server ? { next_tool_server: err.next_tool_server } : {}),
      ...(err.next_tool_name ? { next_tool_name: err.next_tool_name } : {}),
      ...(err.next_tool_server_role ? { next_tool_server_role: err.next_tool_server_role } : {}),
      ...(err.next_arguments ? { next_arguments: err.next_arguments } : {}),
      ...(err.next_tool_omitted_reason ? { next_tool_omitted_reason: err.next_tool_omitted_reason } : {}),
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
            // #3103: same omission as the hosted window-expired helper.
            ...nextStepWireFields(signerRefusalStep({
              nextAction: AgentPaymentNextAction.PaymentWindowExpired,
              nextTool: null,
              nextToolOmittedReason: 're-run the hosted quote tool you called with the same idempotency_key; which one depends on the flow (suggested_tool names the MCP one)',
            })),
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
