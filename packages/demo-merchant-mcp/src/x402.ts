import {
  BaseError,
  ContractFunctionRevertedError,
  ExecutionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseSignature,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, baseSepolia } from 'viem/chains'
import { createHash } from 'node:crypto'
import {
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http'
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from '@x402/core/types'
import {
  HAVEN_PASSPORT_EXTENSION,
  type PassportReference,
} from '@haven_ai/sdk'
import {
  AuthorizationAlreadyUsedError,
  CHECKOUT_DETAILS_EXTENSION,
  ERC7710_TRANSFER_METHOD,
  MAX_TIMEOUT_SECONDS,
  NONCE_RE,
  PaymentError,
  SettlementRevertedError,
  ZERO_TX_HASH,
  assertExtensionsEchoed,
  assertPaymentOptionMatches,
  assertResourceMatches,
  assertSettlementConsistent,
  buildSettledPayment as buildCoreSettledPayment,
  checkoutDetailsExtensionEntry,
  clampReason,
  createInMemoryConsumedPaymentStore,
  createSettleOnce,
  decodePayment,
  isPlainRecord,
  paymentMethod,
  parseExactEvmPayload,
  recoverUsedAuthorization,
  sameAddress,
  selectQuotedPaymentOption,
  settleThroughCdp,
  verifyAuthorization,
  verifyCdpAuthorization,
  type CheckoutDetailsRequest,
  type ConsumedPaymentStore,
  type DecisionReasonCode,
  type Eip3009Authorization,
  type PaymentAsset,
  type SettledPayment as CoreSettledPayment,
  type SettlementState,
  type VerifiedPayment as CoreVerifiedPayment,
} from '@haven_ai/merchant-payments'
import {
  DEFAULT_SETTLEMENT_METHOD,
  SUPPORTED_SETTLEMENT_METHODS,
  USDC_ADDRESS,
  CHAIN_ID,
  USDC_DOMAIN_NAME,
  USDC_DOMAIN_VERSION,
  isSettlementMethod,
  type SettlementKind,
  type SettlementMethod,
} from './products.js'
import type { ProductId } from './products.js'
import type { CdpSettlementConfig } from './cdp.js'

export { DEFAULT_SETTLEMENT_METHOD, SUPPORTED_SETTLEMENT_METHODS, USDC_ADDRESS }
export type { SettlementMethod }

// #4890: the checks, the CDP settle path, the settle-once coordinator and the
// error classes live in `@haven_ai/merchant-payments`. They are re-exported
// from here — the SAME classes, never redefined — so an `instanceof
// PaymentError` holds in every module and every test.
export {
  AuthorizationAlreadyUsedError,
  ERC7710_TRANSFER_METHOD,
  PaymentError,
  SettlementRevertedError,
  assertSettlementConsistent,
}
export type { DecisionReasonCode, Eip3009Authorization, SettlementState }

/** What this merchant accepts payment in: its chain and its USDC contract. */
const PAYMENT_ASSET: PaymentAsset = {
  chainId: CHAIN_ID,
  network: `eip155:${CHAIN_ID}`,
  usdcAddress: USDC_ADDRESS,
  usdcDomainName: USDC_DOMAIN_NAME,
  usdcDomainVersion: USDC_DOMAIN_VERSION,
}
const NETWORK = PAYMENT_ASSET.network
/**
 * #2361: the extensions block every 402 challenge advertises, exported so
 * tests build echo-compliant payments from the same object the merchant
 * advertises rather than a hand-copied twin.
 *
 * #4723: this is the BASE block — `haven-demo` only. A merchant that has both
 * passport env values set advertises `haven-passport` as well, through
 * `demoMerchantExtensions` below. Keeping the base constant separate is what
 * lets the no-env case be pinned to a literal (`['haven-demo']`) instead of to
 * whatever the code happens to emit.
 */
export const DEMO_MERCHANT_EXTENSIONS = {
  'haven-demo': {
    version: '1',
    echoRule: 'x402 v2: clients must echo this extensions object in PaymentPayload',
  },
} as const

/**
 * #4723: where the merchant resolves a payment's passport reference, and which
 * issuer it pins. BOTH values come from env and BOTH must be set — with either
 * missing the merchant advertises only `haven-demo`, exactly as before.
 */
export interface PassportVerifierConfig {
  /** Haven base URL, e.g. `https://api.haven.dev`. */
  baseUrl: string
  /** The issuer address pinned from `GET /passport/issuer`. */
  issuer: string
}

/**
 * #4723: the extensions block a challenge advertises.
 *
 * `haven-passport` is `{ info: {} }` — the #4722 convention: the merchant
 * advertises the KEY and an empty `info`, and the client adds
 * `attestation_uid` + `chain_id` inside `info`. The merchant never advertises
 * a reference of its own.
 *
 * ## The echo contract, stated correctly (#4723 spec review, finding 2)
 *
 * `assertExtensionsEchoed` refuses unless EVERY advertised key is present and
 * deep-equal — the merchant is not append-only, the CLIENTS are. It is safe
 * only because every in-repo client echoes the whole object verbatim (SDK
 * `x402.ts`, signer `core.ts`, backend `settle.ts`). So flipping this on is a
 * real window: a 402 quoted before the env flip and paid after it is refused,
 * and on the EIP-3009 bridge that happens AFTER funding, so funds strand until
 * a sweep. Set both env values on a service that is not mid-quote; the
 * operator step is named in `docs/operations/railway-services.md`.
 */
export function demoMerchantExtensions(
  passport?: PassportVerifierConfig | null,
  checkoutDetails?: CheckoutDetailsRequest | null,
): Record<string, unknown> {
  const base: Record<string, unknown> = passport
    ? {
        ...DEMO_MERCHANT_EXTENSIONS,
        [HAVEN_PASSPORT_EXTENSION]: { info: {} },
      }
    : DEMO_MERCHANT_EXTENSIONS
  // #4873: a product that asks for checkout details advertises the request in
  // its challenge. Every other product's challenge is unchanged, and the
  // client echoes this entry verbatim like every other extension (#2361).
  if (!checkoutDetails) return base
  return {
    ...base,
    [CHECKOUT_DETAILS_EXTENSION]: checkoutDetailsExtensionEntry(checkoutDetails),
  }
}
const HEX_BYTES_RE = /^0x(?:[0-9a-fA-F]{2})+$/

// Verify-without-settle test hook (#603). Product ids listed here are verified
// but not settled on-chain — used by the QA sweep-recovery scenario to strand the
// delegate deterministically. Off (empty) by default; set on the dev merchant only.
//
// TESTNET-ONLY, enforced in code: on any other chain a
// listed product would hand out goods against a merely well-FORMED authorization
// — no settlement runs, and the only balance check lives inside the settlement
// call this hook skips, so an authorization signed from an EMPTY wallet passes.
// A copy-pasted env var must not be able to turn that on for mainnet; refuse to
// start rather than silently ignore the flag.
const SKIP_SETTLE_PRODUCTS = new Set(
  (process.env.MERCHANT_SKIP_SETTLE_PRODUCT ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
)
if (SKIP_SETTLE_PRODUCTS.size > 0 && CHAIN_ID !== 84532) {
  console.error(
    'MERCHANT_SKIP_SETTLE_PRODUCT is a QA-only hook that skips on-chain settlement and is ' +
      'testnet-only.\n' +
      `Set MERCHANT_CHAIN_ID=84532 (Base Sepolia) to use it, or unset the flag. Got chain ${CHAIN_ID}.`,
  )
  process.exit(1)
}

/**
 * #2979: whether `productId` is the MERCHANT_SKIP_SETTLE_PRODUCT QA fixture —
 * exported so `http.ts`'s settlement-readiness gate can exempt it. The fixture
 * settles nothing on-chain (see the `verifyAndSettle` branch below), so a
 * drained settlement wallet cannot block it: there is no settlement to block.
 */
export function isSkipSettleProduct(productId: ProductId): boolean {
  return SKIP_SETTLE_PRODUCTS.has(productId)
}

/**
 * #2989: appended to a skip-settle product's 402 `description` (what the
 * hosted quote/prepare surfaces to the agent) and to its `list_products` text
 * line, so an agent sees — at QUOTE TIME, before signing — that this specific
 * product's receipt will not confirm on-chain settlement. The exact receipt
 * wording ("Delivered — not confirmed on-chain") is produced by
 * `deliveredUnsettled` in server.ts (#2969/#2970); quoted here so the two
 * texts describe the same fact rather than two independent guesses at it.
 */
export const QA_FIXTURE_DESCRIPTION_SUFFIX =
  ' QA fixture: verified but never settled on-chain — the receipt will read "Delivered — not confirmed on-chain".'

export const PAYMENT_REQUIRED_HEADER = 'PAYMENT-REQUIRED'
export const PAYMENT_SIGNATURE_HEADER = 'PAYMENT-SIGNATURE'
export const LEGACY_PAYMENT_SIGNATURE_HEADER = 'X-PAYMENT'
export const PAYMENT_RESPONSE_HEADER = 'PAYMENT-RESPONSE'

const USDC_TRANSFER_WITH_AUTHORIZATION_ABI = [
  {
    type: 'function',
    name: 'transferWithAuthorization',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const

/**
 * Read-only USDC views used to explain a settlement BEFORE submitting it
 * (#1519). `authorizationState` is EIP-3009's own replay flag; `balanceOf` is
 * the only other thing `transferWithAuthorization` can fail on once the
 * signature has been verified off-chain.
 */
const USDC_VIEW_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'authorizationState',
    stateMutability: 'view',
    inputs: [
      { name: 'authorizer', type: 'address' },
      { name: 'nonce', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

// ── Experimental ERC-7710 rail (#747, epic #452) ─────────────────────────────
// x402 exact-EVM `assetTransferMethod: 'erc7710'`: the payer is a smart account
// that signed an ERC-7710 delegation; verification is by *simulating*
// `delegationManager.redeemDelegations(...)` (no ECDSA recovery), and settlement
// submits that same call from the settlement key — so the settlement key is the
// redeemer and any redeemer caveat in the delegation must name it. The
// composition root pins the DelegationManager per configured Base chain and
// omits ERC-7710 from accepts unless that pin is configured.

// ERC-7579 "simple single call" execution mode (callType 0x00, execType 0x00).
const ERC7579_SINGLE_CALL_MODE = `0x${'0'.repeat(64)}` as Hex

const ERC20_TRANSFER_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const

// ERC-7710: redeemDelegations(bytes[] _permissionContexts, ModeCode[] _modes,
// bytes[] _executionCallDatas) where ModeCode is an ERC-7579 bytes32 mode.
const DELEGATION_MANAGER_ABI = [
  {
    type: 'function',
    name: 'redeemDelegations',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_permissionContexts', type: 'bytes[]' },
      { name: '_modes', type: 'bytes32[]' },
      { name: '_executionCallDatas', type: 'bytes[]' },
    ],
    outputs: [],
  },
  // #1515: pure delegation hashing, answered by the manager itself so this
  // merchant never re-implements the framework's EIP-712 struct hashing.
  {
    type: 'function',
    name: 'getDelegationHash',
    stateMutability: 'pure',
    inputs: [
      {
        name: '_input',
        type: 'tuple',
        components: [
          { name: 'delegate', type: 'address' },
          { name: 'delegator', type: 'address' },
          { name: 'authority', type: 'bytes32' },
          {
            name: 'caveats',
            type: 'tuple[]',
            components: [
              { name: 'enforcer', type: 'address' },
              { name: 'terms', type: 'bytes' },
              { name: 'args', type: 'bytes' },
            ],
          },
          { name: 'salt', type: 'uint256' },
          { name: 'signature', type: 'bytes' },
        ],
      },
    ],
    outputs: [{ type: 'bytes32' }],
  },
] as const

// #1515: `spentMap` as exposed by `ERC20TransferAmountEnforcer` — how much an
// exact delegation hash has already transferred through a given manager.
const CAVEAT_SPENT_MAP_ABI = [
  {
    type: 'function',
    name: 'spentMap',
    stateMutability: 'view',
    inputs: [
      { name: 'delegationManager', type: 'address' },
      { name: 'delegationHash', type: 'bytes32' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const

/** Parsed erc7710 payment payload (x402 exact-EVM, assetTransferMethod 'erc7710'). */
export interface Erc7710Payment {
  delegator: Address
  delegationManager: Address
  permissionContext: Hex
}

/** One redeemDelegations invocation — shared by verification (simulate) and settlement (submit). */
export interface Erc7710RedeemCall {
  delegationManager: Address
  permissionContext: Hex
  mode: Hex
  executionCallData: Hex
}

export interface Erc7710SettlementClient {
  /** Verify by simulation per the x402 spec: must reject (throw) when the
   *  delegation does not authorize the transfer or the delegator cannot fund it. */
  simulateRedeemDelegations(call: Erc7710RedeemCall): Promise<void>
  submitRedeemDelegations(call: Erc7710RedeemCall): Promise<Hex>
  /** #1058: the account that actually calls redeemDelegations. When set it is
   *  advertised as `extra.facilitatorAddresses` (MetaMask's erc7710 shape) so
   *  payers can pin their settlement child's redeemer caveat to it. */
  redeemerAddress?: Address
  /** #1515: `DelegationManager.getDelegationHash` — pure, so it answers even
   *  when the redemption simulation reverts. Optional: absent, the
   *  already-redeemed check is skipped and a post-restart retry is refused
   *  (the pre-#1515 behaviour) rather than mis-served. */
  getDelegationHash?(delegationManager: Address, delegation: DecodedDelegation): Promise<Hex>
  /** #1515: `spentMap(delegationManager, delegationHash)` on a caveat
   *  enforcer. Resolve `null` for an enforcer that does not expose it —
   *  only the transfer-amount enforcer does, and which caveat that is can
   *  only be discovered by asking. */
  spentOnDelegation?(
    enforcer: Address,
    delegationManager: Address,
    delegationHash: Hex,
  ): Promise<bigint | null>
}

/** One decoded ERC-7710 delegation, in the DelegationManager's own struct shape. */
export interface DecodedDelegation {
  delegate: Address
  delegator: Address
  authority: Hex
  caveats: readonly { enforcer: Address; terms: Hex; args: Hex }[]
  salt: bigint
  signature: Hex
}

/**
 * The Delegation struct, mirrored from `@metamask/delegation-abis`'
 * `DelegationManager.getDelegationHash` input. Mirrored rather than derived at
 * runtime so the decode parameter is statically typed; the pin test
 * (`erc7710.test.ts`) fails if the package's struct ever diverges from this
 * literal.
 */
export const DELEGATION_STRUCT_COMPONENTS = [
  { name: 'delegate', type: 'address' },
  { name: 'delegator', type: 'address' },
  { name: 'authority', type: 'bytes32' },
  {
    name: 'caveats',
    type: 'tuple[]',
    components: [
      { name: 'enforcer', type: 'address' },
      { name: 'terms', type: 'bytes' },
      { name: 'args', type: 'bytes' },
    ],
  },
  { name: 'salt', type: 'uint256' },
  { name: 'signature', type: 'bytes' },
] as const

const PERMISSION_CONTEXT_PARAMS = [
  { name: 'delegations', type: 'tuple[]', components: DELEGATION_STRUCT_COMPONENTS },
] as const

/**
 * Decode an erc7710 `permissionContext` (abi-encoded `Delegation[]`, leaf
 * first) and return the LEAF — the settlement child whose exact-amount caveat
 * meters the payment. Null when the bytes are not a delegation chain; the
 * caller falls back to refusing the payment, never to accepting it.
 */
export function decodeLeafDelegation(permissionContext: Hex): DecodedDelegation | null {
  try {
    const [delegations] = decodeAbiParameters(PERMISSION_CONTEXT_PARAMS, permissionContext)
    const leaf = delegations[0]
    return leaf ? (leaf as DecodedDelegation) : null
  } catch {
    return null
  }
}

/**
 * The committed spend cap of an `ERC20TransferAmountEnforcer` caveat: its
 * `terms` are `20-byte token ‖ 32-byte maxTokens` (the same layout the signer
 * decodes in `settlement-child.ts`). Returns the `maxTokens` word, or null if
 * the terms are too short to be that shape. Local decode, not an on-chain
 * `getTermsInfo` call — the layout is stable and this keeps the check to two
 * reads.
 */
export function decodeTransferAmountCap(terms: Hex): bigint | null {
  const body = terms.startsWith('0x') ? terms.slice(2) : terms
  // 20-byte token + 32-byte amount = 52 bytes = 104 hex chars.
  if (body.length < 104) return null
  try {
    return BigInt(`0x${body.slice(40, 104)}`)
  } catch {
    return null
  }
}

/**
 * #4890: the settled payment as this merchant types it — its own product ids
 * and settlement methods on the core's shape (see `SettledPayment` in
 * `@haven_ai/merchant-payments`, which documents every field).
 */
export type SettledPayment = CoreSettledPayment<ProductId, SettlementMethod>

export interface SettlementClient {
  submit(authorization: Eip3009Authorization, signature: Hex): Promise<Hex>
  waitForReceipt(txHash: Hex): Promise<void>
  /** Present only when the experimental ERC-7710 rail is configured. */
  erc7710?: Erc7710SettlementClient
  /**
   * Operational readiness of the wallet that PAYS for settlement (#1530).
   *
   * The merchant is the only component that can answer this: the address
   * derives from `SETTLEMENT_PRIVATE_KEY`, which lives in the merchant's own
   * environment and is visible to nothing else. On 2026-08-17 this wallet ran
   * down to 255 gwei and every settlement-requiring x402 leg failed with a
   * merchant-side error that named none of it; the QA harness had no way to
   * see the cause, so a day went into diagnosing the symptom.
   *
   * Reporting it is not a disclosure: the address is already public — it is
   * advertised as `redeemerAddress` in erc7710 challenges — and a balance is
   * public on-chain by construction. The KEY is never exposed.
   */
  readiness?(): Promise<SettlementReadiness>
}

/**
 * What the settlement wallet can still pay for, expressed in units of work
 * rather than raw wei. `255 gwei` reads as a number; `0 settlements of
 * headroom` reads as a cause.
 */
export interface SettlementReadiness {
  address: Address
  balanceWei: bigint
  /** Observed cost of one `redeemDelegations` on Base Sepolia, 2026-08-17. */
  costPerSettlementWei: bigint
  /** `balanceWei / costPerSettlementWei`, floored. Zero means the next one fails. */
  settlementsRemaining: number
  /**
   * #2490: which band the wallet is in — `usable` (at or above the warn
   * floor), `warn` (below the warn floor: a slow drain, top up soon, the run
   * still proceeds) or `fail` (below the fail floor: a run cannot complete,
   * refuse it — the #1530 class).
   */
  status: SettlementBand
  /** The warn floor {@link SettlementReadiness.status} was measured against. Shipped so the harness renders the band instead of restating it (#2490). */
  warnFloor: number
  /** The fail floor {@link SettlementReadiness.status} was measured against. Shipped so the harness renders the band instead of restating it (#2490). */
  failFloor: number
}

/** #2490: the three bands the settlement wallet's gas headroom can occupy. */
export type SettlementBand = 'usable' | 'warn' | 'fail'

/**
 * Observed cost of one settlement, measured from the 2026-08-17 Basescan fee
 * data: 0.00000216 ETH per `redeemDelegations`. Rounded up, because a floor
 * that under-estimates is worse than one that nags.
 */
export const SETTLEMENT_COST_WEI = 2_500_000_000_000n

/**
 * #2490: below this many settlements of headroom a QA run is REFUSED.
 *
 * Anchored on what one full run consumes: eight 0.001-USDC settling merchant
 * legs (including `merchant-locked-budget`, #3505) plus the 0.010 direct
 * settle — the same derivation `TREASURY_RUN_COST_ATOMIC` documents in the QA
 * harness — which is ~9 settlements. Not 9: that would admit a run that spends the wallet to zero
 * with no margin for a retry leg or a fee drift. Not 16: at 24 the old single
 * floor produced #2485 (three qa-dev failures while ~3 runs of real capacity
 * sat unused), so a fail floor anywhere near that re-creates the same
 * incident at a smaller scale. 12 is one full run plus half a run of
 * headroom: a run admitted at the floor still ends with >= 3 settlements
 * left. Must still catch the condition #1530 was built for — at the
 * 2026-08-17 outage balance (255 gwei) the wallet holds 0 settlements, far
 * below this floor, exactly as the fail band requires.
 */
export const MIN_SETTLEMENT_HEADROOM_FAIL = 12

/**
 * How many settlements of headroom the wallet must hold to stay out of the
 * warn band.
 *
 * A warning threshold for a slow drain, NOT an incident: below it the
 * merchant reports the band on every read and the QA harness prints a
 * top-up line on every run, but the run proceeds (#2490). Kept at 25 — the
 * pre-#2490 single-floor value. #2485 (three consecutive qa-dev failures at
 * 24 settlements, one below this number) is precisely the cost of this
 * threshold acting as a block; as a warning it occupies its documented role:
 * ~3 runs of headroom, where a top-up is still a routine action.
 */
export const MIN_SETTLEMENT_HEADROOM_WARN = 25

/** Pure, so the band logic is testable without a chain. */
export function settlementReadiness(
  address: Address,
  balanceWei: bigint,
  costPerSettlementWei: bigint = SETTLEMENT_COST_WEI,
): SettlementReadiness {
  const settlementsRemaining =
    costPerSettlementWei > 0n ? Number(balanceWei / costPerSettlementWei) : 0
  const status: SettlementBand =
    settlementsRemaining < MIN_SETTLEMENT_HEADROOM_FAIL
      ? 'fail'
      : settlementsRemaining < MIN_SETTLEMENT_HEADROOM_WARN
        ? 'warn'
        : 'usable'
  return {
    address,
    balanceWei,
    costPerSettlementWei,
    settlementsRemaining,
    status,
    warnFloor: MIN_SETTLEMENT_HEADROOM_WARN,
    failFloor: MIN_SETTLEMENT_HEADROOM_FAIL,
  }
}

export interface X402PaymentProcessorOptions {
  /** Advertise + accept the experimental erc7710 assetTransferMethod. */
  erc7710?: {
    /** The only DelegationManager contract this merchant will simulate against
     *  and settle through. The payload's delegationManager is attacker-supplied;
     *  without pinning it, a no-op contract at that address would "verify" and
     *  "settle" successfully while moving zero USDC. */
    delegationManager: Address
    /**
     * The only `ERC20TransferAmountEnforcer` whose `spentMap` this merchant
     * trusts as the record of "did this settlement child already spend"
     * (#1515). MUST be pinned: the caveat enforcer address inside a
     * `permissionContext` is attacker-chosen, so a forged enforcer returning a
     * large `spentMap` would otherwise let an UNPAID buyer be served after a
     * restart. Absent, the already-redeemed check is disabled and a
     * post-restart retry falls back to the pre-#1515 refusal.
     */
    erc20TransferAmountEnforcer?: Address
  }
  settlementMethods?: readonly SettlementMethod[]
  /**
   * #4851: Coinbase's hosted facilitator, for products whose settlement kind is
   * `cdp`. Absent, such a product is refused here (and is not offered at all —
   * the HTTP layer filters it out before a challenge is ever built).
   */
  cdp?: CdpSettlementConfig
  /**
   * #4853: receiving addresses this merchant quoted BEFORE the current one and
   * still honours for a payment that already settled to them — a redeploy that
   * moves the Stripe deposit address.
   *
   * Operator-supplied, never read from the payment. That is the whole point:
   * the payment's own `payTo` is attacker-chosen, so serving a used
   * authorization addressed to it would hand goods to anyone who paid an
   * address of their own. Only an address this merchant actually quoted before
   * can be honoured.
   */
  previousReceivingAddresses?: readonly Address[]
  /**
   * #4723: when set, every challenge advertises `haven-passport` and a payment
   * that carries a reference is checked against this Haven verifier. Advisory
   * only — the settle path never consults it.
   */
  passport?: PassportVerifierConfig
  /**
   * #4890: where settled payments are recorded. Defaults to a fresh in-memory
   * store, so nothing is persisted and a restart forgets settled payments.
   */
  consumedPaymentStore?: ConsumedPaymentStore
}

export interface X402PaymentProcessor {
  buildPaymentRequired(params: {
    /**
     * #4850: the receiving address of the PRODUCT being bought
     * (`productReceivingAddress`), not a merchant-wide global — the 402's
     * `payTo`. Callers resolve it per product; the name is kept because every
     * verification step compares the payment against it as "this merchant".
     */
    merchantAddress: Address
    amountUsdc: bigint
    resource: string
    description: string
    settlementMethod?: SettlementMethod
    /**
     * The PRODUCT's advertised methods (#1441), already intersected with what
     * this merchant has enabled. Omitting it falls back to the merchant-wide
     * set — which is what the challenge did before, so a product restricting
     * its settlement methods was honoured in the catalogue metadata and
     * IGNORED in the 402 it actually served. The 402 is the one that decides.
     */
    settlementMethods?: readonly SettlementMethod[]
    /**
     * #4873: the product's checkout-details request, when it asks for one.
     * Absent, the challenge advertises no `haven-checkout-details` entry.
     */
    checkoutDetails?: CheckoutDetailsRequest
  }): PaymentRequired
  paymentRequiredHeader(paymentRequired: PaymentRequired): string
  paymentResponseHeader(response: SettleResponse): string
  verifyAndSettle(params: {
    productId: ProductId
    paymentHeader: string
    /** #4850: the purchased product's receiving address — the same value the
     *  challenge it is checked against was built with. The EIP-3009 `to`, the
     *  quoted option's `payTo` and the ERC-7710 transfer target must all equal it. */
    merchantAddress: Address
    expectedAmount: bigint
    paymentRequired: PaymentRequired
    /** #4851: the purchased product's settlement kind (`productSettlementKind`).
     *  Absent, `self` — the merchant settles with its own key. */
    settlement?: SettlementKind
  }): Promise<SettledPayment>
}

/**
 * Rail-agnostic description of one verified payment, ready to settle exactly
 * once (the core's `VerifiedPayment`, less the digest `verifyAndSettle` adds
 * from the payment header it was given).
 */
type VerifiedPayment = Omit<CoreVerifiedPayment<SettlementMethod>, 'authorizationDigest'>

export function createX402PaymentProcessor(
  settlementClient: SettlementClient,
  options: X402PaymentProcessorOptions = {},
): X402PaymentProcessor {
  const settlementMethods = options.settlementMethods?.length
    ? [...new Set(options.settlementMethods)]
    : options.erc7710
      ? [...SUPPORTED_SETTLEMENT_METHODS]
      : (['eip3009'] as SettlementMethod[])
  if (settlementMethods.includes(ERC7710_TRANSFER_METHOD) && !options.erc7710) {
    throw new PaymentError('ERC-7710 is enabled but no trusted delegation manager was configured')
  }
  // #4890: the settle-exactly-once coordinator is the core's, recording each
  // payment in a consumed-payment store (in memory unless one is injected).
  const settleOnce = createSettleOnce<ProductId, SettlementMethod>({
    store: options.consumedPaymentStore ?? createInMemoryConsumedPaymentStore(),
    chainId: CHAIN_ID,
    waitForReceipt: (txHash) => settlementClient.waitForReceipt(txHash),
  })

  function buildSettledPayment(
    params: { productId: ProductId; verified: VerifiedPayment; expectedAmount: bigint },
    txHash: Hex,
    settlement: SettlementState,
  ): SettledPayment {
    return buildCoreSettledPayment({ ...params, network: NETWORK }, txHash, settlement)
  }

  async function verifyEip3009Payment(params: {
    payload: PaymentPayload
    merchantAddress: Address
    expectedAmount: bigint
    paymentRequired: PaymentRequired
    passportReference: PassportReference | null
  }): Promise<VerifiedPayment> {
    const { authorization, signature } = parseExactEvmPayload(params.payload.payload)
    assertPaymentOptionMatches(
      params.payload.accepted,
      selectQuotedPaymentOption(params.payload.accepted, params.paymentRequired),
      params.merchantAddress,
      params.expectedAmount,
      'eip3009',
      PAYMENT_ASSET,
    )
    assertResourceMatches(params.payload, params.paymentRequired)
    await verifyAuthorization(authorization, signature, params.merchantAddress, params.expectedAmount, PAYMENT_ASSET)
    return {
      payer: getAddress(authorization.from),
      payTo: getAddress(authorization.to),
      nonce: authorization.nonce as Hex,
      validBefore: Number(authorization.validBefore),
      settlementMethod: 'eip3009',
      passportReference: params.passportReference,
      submit: () => settlementClient.submit(authorization, signature),
    }
  }

  /**
   * #4851: a payment for a `cdp` product. Every check this merchant makes
   * about its OWN quote — the extensions echo and x402 version (before the
   * dispatch, in `verifyAndSettle`), the quoted option, the resource, the
   * recipient, the amount, the signature and the validity window — runs here,
   * before Coinbase's facilitator is called at all.
   *
   * One exception to the window: an EXPIRED authorization is not refused yet.
   * A settle that timed out may have landed after all, and a buyer retrying
   * the same header after `validBefore` must be served if the chain says the
   * money moved. `settleThroughCdp` reads the chain first and refuses the
   * expired header only when it is unused.
   */
  async function verifyCdpPayment(params: {
    payload: PaymentPayload
    merchantAddress: Address
    expectedAmount: bigint
    paymentRequired: PaymentRequired
    passportReference: PassportReference | null
  }): Promise<VerifiedPayment> {
    const cdp = options.cdp
    if (!cdp) {
      throw new PaymentError(
        "This product is settled through Coinbase's facilitator, which is not configured on this merchant",
      )
    }
    // The merchant's own checks, in order, before Coinbase is called at all.
    const { authorization, quoted, expired } = await verifyCdpAuthorization({
      payload: params.payload,
      paymentRequired: params.paymentRequired,
      merchantAddress: params.merchantAddress,
      expectedAmount: params.expectedAmount,
      asset: PAYMENT_ASSET,
    })
    const payer = getAddress(authorization.from)
    const nonce = authorization.nonce as Hex
    return {
      payer,
      payTo: getAddress(authorization.to),
      nonce,
      validBefore: Number(authorization.validBefore),
      settlementMethod: 'eip3009',
      passportReference: params.passportReference,
      submit: () =>
        settleThroughCdp({
          cdp,
          payload: params.payload,
          requirements: quoted,
          authorization,
          expired,
        }),
    }
  }

  /**
   * Review of #4853 (S7): recover a CDP payment whose quote no longer matches
   * this merchant's current receiving address.
   *
   * A redeploy with new Stripe variables moves the joke's deposit address. A
   * buyer that was quoted the old address, paid it, and lost the answer then
   * retries the same header — and the quote checks refuse it before any chain
   * read. The epic's invariant is that a buyer whose money moved is never
   * refused, so the chain decides here: if the authorization is used and its
   * transaction paid the address the payment was quoted for, this amount, the
   * buyer is served with that hash.
   *
   * Only a payment addressed to an address this merchant quoted BEFORE the
   * current one is considered (`previousReceivingAddresses`, operator-supplied).
   * Every other refusal is the original one, unchanged. A chain read that fails
   * leaves the original refusal standing rather than serving on a guess.
   */
  async function recoverCdpPaymentAfterQuoteChange(params: {
    payload: PaymentPayload
    expectedAmount: bigint
    passportReference: PassportReference | null
  }): Promise<VerifiedPayment | undefined> {
    const cdp = options.cdp
    if (!cdp) return undefined
    let authorization: Eip3009Authorization
    try {
      authorization = parseExactEvmPayload(params.payload.payload).authorization
    } catch {
      return undefined
    }
    if (!isAddress(authorization.from) || !isAddress(authorization.to)) return undefined
    if (!NONCE_RE.test(authorization.nonce)) return undefined
    // The payment must have been quoted for an address this merchant used to
    // quote. The payment's own `payTo` is attacker-chosen, so it cannot be the
    // test: serving on it would hand goods to anyone who paid an address of
    // their own choosing.
    const previous = options.previousReceivingAddresses ?? []
    if (!previous.some((address) => sameAddress(address, authorization.to))) return undefined
    // And for this product's price: a transfer of another amount is not this
    // purchase, whatever the chain says.
    let value: bigint
    try {
      value = BigInt(authorization.value)
    } catch {
      return undefined
    }
    if (value !== params.expectedAmount) return undefined
    const payer = getAddress(authorization.from)
    const nonce = authorization.nonce as Hex
    let used: boolean
    try {
      used = await cdp.chain.authorizationUsed(payer, nonce)
    } catch {
      return undefined
    }
    if (!used) return undefined
    return {
      payer,
      payTo: getAddress(authorization.to),
      nonce,
      validBefore: Number(authorization.validBefore),
      settlementMethod: 'eip3009',
      passportReference: params.passportReference,
      // The chain is the truth: `recoverUsedAuthorization` searches USDC's
      // events for this authorization and serves only when its transaction
      // paid the quoted address this amount.
      submit: () => recoverUsedAuthorization({ cdp, authorization }),
    }
  }

  async function verifyErc7710Payment(params: {
    payload: PaymentPayload
    merchantAddress: Address
    expectedAmount: bigint
    paymentRequired: PaymentRequired
    passportReference: PassportReference | null
  }): Promise<VerifiedPayment> {
    if (!options.erc7710) {
      throw new PaymentError('ERC-7710 payments are not enabled on this merchant')
    }
    const erc7710Client = settlementClient.erc7710
    if (!erc7710Client) {
      throw new PaymentError('ERC-7710 settlement is not configured on this merchant')
    }
    const expectedOption = params.paymentRequired.accepts.find(
      (option) => option.extra?.assetTransferMethod === ERC7710_TRANSFER_METHOD,
    )
    if (!expectedOption) {
      throw new PaymentError('This merchant did not offer an erc7710 payment option')
    }
    assertPaymentOptionMatches(
      params.payload.accepted,
      expectedOption,
      params.merchantAddress,
      params.expectedAmount,
      ERC7710_TRANSFER_METHOD,
      PAYMENT_ASSET,
    )
    assertResourceMatches(params.payload, params.paymentRequired)
    const payment = parseErc7710Payload(params.payload.payload)
    if (!sameAddress(payment.delegationManager, options.erc7710.delegationManager)) {
      throw new PaymentError('Payment delegationManager is not the delegation manager trusted by this merchant')
    }
    const redeemCall = buildRedeemCall(payment, params.merchantAddress, params.expectedAmount)
    const contextHash = keccak256(payment.permissionContext)
    const verified: VerifiedPayment = {
      payer: payment.delegator,
      payTo: getAddress(params.merchantAddress),
      nonce: contextHash,
      validBefore: 0,
      settlementMethod: ERC7710_TRANSFER_METHOD,
      passportReference: params.passportReference,
      // #3170: explain a submit-time revert the way the EIP-3009 rail explains
      // its pre-submit failures (#1519). `writeContract` raises viem's
      // `ContractFunctionExecutionError` on a revert, which is not a
      // `PaymentError`, so `handlePaymentGate` reported every such revert as a
      // merchant-side FAULT — "this merchant is broken" — when the likeliest
      // causes are facts about the PAYER: the settlement child's exact-amount
      // caveat exhausted, the delegator's account short of the price, the
      // child redeemed elsewhere between simulate and submit. The chain-truth
      // check runs first (the money may already have moved: #1515's
      // already-settled decision, served rather than refused); a genuine RPC
      // or gas fault keeps its fault classification (#2979's reason codes).
      submit: async () => {
        try {
          return await erc7710Client.submitRedeemDelegations(redeemCall)
        } catch (err) {
          if (
            await erc7710AlreadyRedeemed(
              erc7710Client,
              options.erc7710?.erc20TransferAmountEnforcer,
              payment,
              params.expectedAmount,
            )
          ) {
            throw new AuthorizationAlreadyUsedError(
              `ERC-7710 settlement child ${contextHash} was already redeemed on-chain for ` +
                `${payment.delegator}. This purchase already settled — do not resubmit it.`,
            )
          }
          if (isContractRevert(err)) {
            // The next action comes BEFORE the cause list: the hosted relay
            // keeps the first 500 characters of this body (paid-mcp-completion.ts),
            // and the revert reason is capped so the instruction always fits.
            throw new PaymentError(
              `ERC-7710 delegation redemption reverted at submit: ${revertReason(err)}. Nothing ` +
                `settled here — re-quote and pay with a fresh authorization. The revert is a fact ` +
                `about the payer's delegation, not about this merchant: the settlement child's ` +
                `transfer-amount caveat is exhausted, the delegator ${payment.delegator} holds less ` +
                `than the price, or the child was redeemed elsewhere.`,
            )
          }
          throw err
        }
      },
    }
    try {
      await erc7710Client.simulateRedeemDelegations(redeemCall)
    } catch (err) {
      // #1515: an exact-amount settlement child that ALREADY moved the money
      // fails this simulation too — its transfer-amount caveat is exhausted —
      // and before this check, a merchant restart between submit and the
      // buyer's retry turned that into "simulation failed": charged, no goods.
      // The chain is the store that survives restarts (#1519's move, applied
      // to this rail): if the leaf delegation's own spent counter covers the
      // price, this purchase settled. Route it through `settleOnce`'s
      // already-used branch so the buyer is served, not refused.
      if (
        await erc7710AlreadyRedeemed(
          erc7710Client,
          options.erc7710?.erc20TransferAmountEnforcer,
          payment,
          params.expectedAmount,
        )
      ) {
        return {
          ...verified,
          submit: async () => {
            throw new AuthorizationAlreadyUsedError(
              `ERC-7710 settlement child ${contextHash} was already redeemed on-chain for ` +
                `${payment.delegator}. This purchase already settled — do not resubmit it.`,
            )
          },
        }
      }
      throw new PaymentError(
        `ERC-7710 delegation redemption simulation failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    return verified
  }

  /**
   * Chain-truth check for a restarted merchant (#1515). Answers "did THIS
   * settlement child already move THIS payment's amount", reading only trusted,
   * pinned contracts — never anything the attacker-supplied payload names.
   *
   * Three binds, all required, because the payload is unauthenticated here (it
   * reached this path precisely because the real simulation against the pinned
   * manager already failed):
   *
   *  1. The caveat enforcer must be the PINNED `ERC20TransferAmountEnforcer`.
   *     A forged enforcer at an attacker address could return any `spentMap`;
   *     iterating over the payload's caveats and trusting whichever answers was
   *     a free-goods bypass (the review's finding 1).
   *  2. That caveat's own committed cap (`getTermsInfo → maxTokens`) must EQUAL
   *     `expectedAmount`. A settlement child is minted exact-amount per payment,
   *     so cap == price; without this, a child spent for an expensive product
   *     satisfies `spent >= price` for any cheaper product after a restart wiped
   *     the in-memory cross-product guard (the review's finding 2).
   *  3. The enforcer's `spentMap` for this delegation hash must be at least the
   *     amount — i.e. the child actually redeemed, not merely authorized.
   *
   * Every failure mode resolves false: refusing a genuinely unredeemed payment
   * stays possible, serving goods against unmoved money must not be.
   */
  async function erc7710AlreadyRedeemed(
    client: Erc7710SettlementClient,
    trustedEnforcer: Address | undefined,
    payment: Erc7710Payment,
    expectedAmount: bigint,
  ): Promise<boolean> {
    if (!trustedEnforcer || !client.getDelegationHash || !client.spentOnDelegation) return false
    const leaf = decodeLeafDelegation(payment.permissionContext)
    if (!leaf) return false

    // Bind 1 + 2: the child must carry the PINNED transfer-amount caveat, and
    // its committed cap must be exactly this payment's amount.
    const caveat = leaf.caveats.find((c) => sameAddress(c.enforcer, trustedEnforcer))
    if (!caveat) return false
    const cap = decodeTransferAmountCap(caveat.terms)
    if (cap === null || cap !== expectedAmount) return false

    // Bind 3: and it must actually have been spent, per the pinned enforcer.
    let leafHash: Hex
    try {
      leafHash = await client.getDelegationHash(payment.delegationManager, leaf)
    } catch {
      return false
    }
    try {
      const spent = await client.spentOnDelegation(trustedEnforcer, payment.delegationManager, leafHash)
      return spent !== null && spent >= expectedAmount
    } catch {
      return false
    }
  }

  return {
    buildPaymentRequired: (params) =>
      buildPaymentRequired({
        ...params,
        // INTERSECTION, not precedence (#1441). The two lists mean different
        // things and neither may simply win:
        //   - the merchant-wide set is a HARD GATE — erc7710 absent here means
        //     it is unconfigured, and must never be advertised whatever a
        //     product claims;
        //   - the caller's list is the PRODUCT's own restriction, which may
        //     narrow the gate further but never widen it.
        // Written as `...params, settlementMethods` this sat after the spread
        // and silently discarded the product's list, so a 3009-only product
        // still advertised erc7710 in its 402 — the catalogue and the
        // challenge disagreed, and the challenge is the one that decides.
        settlementMethods: params.settlementMethods
          ? settlementMethods.filter((method) => params.settlementMethods?.includes(method))
          : settlementMethods,
        facilitatorAddresses: settlementClient.erc7710?.redeemerAddress
          ? [settlementClient.erc7710.redeemerAddress]
          : undefined,
        // #4723: the merchant-wide passport config, never a per-call one — the
        // advertised extension and the verifier the purchase response uses
        // must be the same decision.
        passport: options.passport,
      }),
    paymentRequiredHeader: encodePaymentRequiredHeader,
    paymentResponseHeader: encodePaymentResponseHeader,

    async verifyAndSettle(params) {
      const payload = decodePayment(params.paymentHeader)
      // #2361: the echo rule is method-independent — enforce it before the
      // scheme dispatch so both erc7710 and eip3009 payments are covered.
      assertExtensionsEchoed(payload, params.paymentRequired)
      const method = paymentMethod(payload.accepted)
      // #4723: read the passport reference the client echoed. Advisory only —
      // it is carried on the settled payment for the purchase response and is
      // never consulted by the settle path.
      const passportReference = readPassportReference((payload as { extensions?: unknown }).extensions)

      let unsealed: VerifiedPayment
      if (params.settlement === 'cdp') {
        // #4851: a CDP product is quoted with EIP-3009 only, so anything else
        // was never offered; refuse it before any other work.
        if (method !== 'eip3009') {
          throw new PaymentError(`This product is paid with EIP-3009 only, not ${method}`)
        }
        try {
          unsealed = await verifyCdpPayment({ ...params, payload, passportReference })
        } catch (err) {
          // Review of #4853 (S7): the merchant's receiving address can change
          // between a quote and its retry (a redeploy with new Stripe
          // variables). The quote checks would then refuse the retried header
          // before any chain read — refusing a buyer whose money already moved
          // to the address they were quoted. The epic's invariant is that a
          // buyer whose money moved is never refused, so the chain gets the
          // last word before the refusal stands.
          const recovered = await recoverCdpPaymentAfterQuoteChange({
            payload,
            expectedAmount: params.expectedAmount,
            passportReference,
          })
          if (!recovered) throw err
          unsealed = recovered
        }
      } else if (method === ERC7710_TRANSFER_METHOD) {
        unsealed = await verifyErc7710Payment({ ...params, payload, passportReference })
      } else if (method === 'eip3009') {
        unsealed = await verifyEip3009Payment({ ...params, payload, passportReference })
      } else {
        throw new PaymentError(`Unsupported x402 assetTransferMethod: ${method}`)
      }

      // Verify-without-settle test hook (#603 sweep-recovery QA). For products in
      // MERCHANT_SKIP_SETTLE_PRODUCT, verify the payment but do NOT submit the
      // on-chain transfer — leaving the payer's funds stranded so the sweep path
      // can be exercised deterministically. Off by default; per-product so the
      // normal x402 settle path is unaffected. Testnet/dev only.
      if (SKIP_SETTLE_PRODUCTS.has(params.productId)) {
        return buildSettledPayment(
          { productId: params.productId, verified: unsealed, expectedAmount: params.expectedAmount },
          ZERO_TX_HASH,
          'settlement_unknown',
        )
      }

      // #4890: the consumed-payment record carries a digest of the payment
      // as presented (the whole header, signature included).
      const verified: CoreVerifiedPayment<SettlementMethod> = {
        ...unsealed,
        authorizationDigest: createHash('sha256').update(params.paymentHeader).digest('hex'),
      }
      return settleOnce({
        productId: params.productId,
        verified,
        expectedAmount: params.expectedAmount,
      })
    },
  }
}

export function createViemSettlementClient(params: {
  baseRpcUrl: string
  settlementPrivateKey: Hex
}): SettlementClient {
  const account = privateKeyToAccount(params.settlementPrivateKey) as PrivateKeyAccount
  const transport = http(params.baseRpcUrl)
  // viem validates the chain id against the RPC before submitting, so this must
  // match BASE_RPC_URL's chain (Base mainnet vs Base Sepolia per MERCHANT_CHAIN_ID).
  const chain = CHAIN_ID === 84532 ? baseSepolia : base
  const publicClient = createPublicClient({ chain, transport })
  const walletClient = createWalletClient({ account, chain, transport })

  return {
    // #1530: the settlement wallet's own gas is a consumable resource that
    // nothing outside this process can observe. Report it.
    async readiness() {
      return settlementReadiness(
        account.address,
        await publicClient.getBalance({ address: account.address }),
      )
    },

    async submit(authorization, signature) {
      const parsed = parseSignature(signature)
      if (parsed.v === undefined) {
        throw new PaymentError('Payment signature is missing v value')
      }

      // Explain the settlement BEFORE submitting it (#1519).
      //
      // Once the signature has verified off-chain, `transferWithAuthorization`
      // has exactly two remaining on-chain failure modes, and viem reports both
      // as an unwrapped `ContractFunctionExecutionError` raised during gas
      // estimation — which the caller could only surface as a merchant-side
      // FAULT, i.e. "this merchant is broken". Neither is a merchant fault:
      // both are facts about the payer that the payer needs told plainly.
      //
      // This cost a full day of triage on 2026-08-17: the demo merchant settled
      // a payment successfully, was asked to settle the same purchase again,
      // and reported `ERC20: transfer amount exceeds balance` as a fault. The
      // money had moved correctly; only the report was wrong.
      const [payerBalance, authorizationUsed] = (await Promise.all([
        publicClient.readContract({
          address: USDC_ADDRESS,
          abi: USDC_VIEW_ABI,
          functionName: 'balanceOf',
          args: [getAddress(authorization.from)],
        }),
        publicClient.readContract({
          address: USDC_ADDRESS,
          abi: USDC_VIEW_ABI,
          functionName: 'authorizationState',
          args: [getAddress(authorization.from), authorization.nonce as Hex],
        }),
      ])) as [bigint, boolean]

      console.log('[x402] pre-submit', {
        from: authorization.from,
        to: authorization.to,
        value: authorization.value,
        nonce: authorization.nonce,
        payerBalance: payerBalance.toString(),
        authorizationUsed,
      })

      if (authorizationUsed) {
        // EIP-3009 nonces are single-use. Re-submitting is guaranteed to revert
        // and would misreport an ALREADY-SETTLED payment as a failure.
        throw new AuthorizationAlreadyUsedError(
          `Payment authorization ${authorization.nonce} has already been used on-chain by ` +
            `${authorization.from}. This purchase already settled — do not resubmit it.`,
        )
      }
      if (payerBalance < BigInt(authorization.value)) {
        throw new PaymentError(
          `Payer ${authorization.from} holds ${payerBalance} USDC units but the authorization ` +
            `requires ${authorization.value}. The payment was not funded, or its funds were ` +
            'already spent by an earlier settlement of the same purchase.',
        )
      }

      return walletClient.writeContract({
        address: USDC_ADDRESS,
        abi: USDC_TRANSFER_WITH_AUTHORIZATION_ABI,
        functionName: 'transferWithAuthorization',
        args: [
          getAddress(authorization.from),
          getAddress(authorization.to),
          BigInt(authorization.value),
          BigInt(authorization.validAfter),
          BigInt(authorization.validBefore),
          authorization.nonce as Hex,
          Number(parsed.v),
          parsed.r,
          parsed.s,
        ],
      })
    },

    async waitForReceipt(txHash) {
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations: 1,
      })
      if (receipt.status !== 'success') {
        throw new SettlementRevertedError(`USDC settlement transaction reverted on-chain: ${txHash}`)
      }
    },

    erc7710: {
      redeemerAddress: account.address,
      // Verification-by-simulation from the settlement (redeemer) account; a
      // delegation that does not cover the transfer, or a delegator that cannot
      // fund it, makes the simulated USDC transfer revert.
      async simulateRedeemDelegations(call) {
        await publicClient.simulateContract({
          account,
          address: call.delegationManager,
          abi: DELEGATION_MANAGER_ABI,
          functionName: 'redeemDelegations',
          args: [[call.permissionContext], [call.mode], [call.executionCallData]],
        })
      },

      async submitRedeemDelegations(call) {
        return walletClient.writeContract({
          address: call.delegationManager,
          abi: DELEGATION_MANAGER_ABI,
          functionName: 'redeemDelegations',
          args: [[call.permissionContext], [call.mode], [call.executionCallData]],
        })
      },

      async getDelegationHash(delegationManager, delegation) {
        return (await publicClient.readContract({
          address: delegationManager,
          abi: DELEGATION_MANAGER_ABI,
          functionName: 'getDelegationHash',
          args: [delegation],
        })) as Hex
      },

      async spentOnDelegation(enforcer, delegationManager, delegationHash) {
        try {
          return (await publicClient.readContract({
            address: enforcer,
            abi: CAVEAT_SPENT_MAP_ABI,
            functionName: 'spentMap',
            args: [delegationManager, delegationHash],
          })) as bigint
        } catch {
          // Not every caveat enforcer keeps a spent counter; only the
          // transfer-amount one answers, and the caller tries each caveat.
          return null
        }
      },
    },
  }
}

export function buildPaymentRequired(params: {
  merchantAddress: Address
  amountUsdc: bigint
  resource: string
  description: string
  erc7710?: boolean
  settlementMethod?: SettlementMethod
  settlementMethods?: readonly SettlementMethod[]
  /** #1058: advertised on the erc7710 option only — payers pin their child
   *  delegation's redeemer caveat to these, and must echo them verbatim. */
  facilitatorAddresses?: Address[]
  /** #4723: when set, the challenge also advertises `haven-passport`. */
  passport?: PassportVerifierConfig | null
  /**
   * #4873: when set, the challenge also advertises `haven-checkout-details`
   * with this request. Absent, the challenge is unchanged.
   */
  checkoutDetails?: CheckoutDetailsRequest | null
}): PaymentRequired {
  const methods = orderedSettlementMethods(params.settlementMethod, params.settlementMethods)
  const eip3009Option: PaymentRequirements = {
    scheme: 'exact',
    network: NETWORK,
    amount: params.amountUsdc.toString(),
    payTo: params.merchantAddress,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    asset: USDC_ADDRESS,
    extra: { name: USDC_DOMAIN_NAME, version: USDC_DOMAIN_VERSION },
  }
  const erc7710Option: PaymentRequirements = {
    ...eip3009Option,
    extra: {
      name: USDC_DOMAIN_NAME,
      version: USDC_DOMAIN_VERSION,
      assetTransferMethod: ERC7710_TRANSFER_METHOD,
      ...(params.facilitatorAddresses && params.facilitatorAddresses.length > 0
        ? { facilitatorAddresses: params.facilitatorAddresses }
        : {}),
    },
  }
  const accepts = methods.map((method) => method === ERC7710_TRANSFER_METHOD ? erc7710Option : eip3009Option)
  return {
    x402Version: 2,
    resource: {
      url: params.resource,
      description: params.description,
      mimeType: 'application/json',
      serviceName: 'Haven Demo Merchant',
    },
    accepts,
    // #2361: advertised so the echo rule below is EXERCISED, not just
    // implemented. The v2 spec makes the extensions echo a client MUST, a
    // live facilitator (CoinGecko's) rejects payments that drop it, and this
    // merchant validating only what Haven happens to send is how two envelope
    // defects reached mainnet (#2288's header name, #2360's missing echoes).
    // Kept deliberately small: the whole challenge rides an HTTP header, and
    // the echo doubles it back.
    extensions: demoMerchantExtensions(params.passport, params.checkoutDetails),
    error: 'Payment required',
  }
}

function parseErc7710Payload(payload: Record<string, unknown>): Erc7710Payment {
  const { delegator, delegationManager, permissionContext } = payload
  if (typeof delegator !== 'string' || !isAddress(delegator)) {
    throw new PaymentError('Invalid erc7710 payment field: delegator must be an address')
  }
  if (typeof delegationManager !== 'string' || !isAddress(delegationManager)) {
    throw new PaymentError('Invalid erc7710 payment field: delegationManager must be an address')
  }
  if (typeof permissionContext !== 'string' || !HEX_BYTES_RE.test(permissionContext)) {
    throw new PaymentError('Invalid erc7710 payment field: permissionContext must be 0x-prefixed bytes')
  }
  return {
    delegator: getAddress(delegator),
    delegationManager: getAddress(delegationManager),
    permissionContext: permissionContext as Hex,
  }
}

function buildRedeemCall(
  payment: Erc7710Payment,
  merchantAddress: Address,
  amount: bigint,
): Erc7710RedeemCall {
  const transferData = encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: 'transfer',
    args: [getAddress(merchantAddress), amount],
  })
  // ERC-7579 single-call execution calldata: packed (target, value, callData).
  const executionCallData = encodePacked(
    ['address', 'uint256', 'bytes'],
    [USDC_ADDRESS, 0n, transferData],
  )
  return {
    delegationManager: payment.delegationManager,
    permissionContext: payment.permissionContext,
    mode: ERC7579_SINGLE_CALL_MODE,
    executionCallData,
  }
}

function orderedSettlementMethods(
  selected?: SettlementMethod,
  availableMethods: readonly SettlementMethod[] = SUPPORTED_SETTLEMENT_METHODS,
): SettlementMethod[] {
  const available = [...new Set(availableMethods)]
  const first = selected ?? (available.includes(DEFAULT_SETTLEMENT_METHOD) ? DEFAULT_SETTLEMENT_METHOD : available[0])
  if (!first || !available.includes(first)) {
    throw new PaymentError(`Settlement method ${selected ?? DEFAULT_SETTLEMENT_METHOD} is not enabled for this merchant`)
  }
  return [first, ...available.filter((method) => method !== first)]
}

/**
 * #4723: read the `haven-passport` reference a payment echoed.
 *
 * `null` means there is no reference to check: the key was absent (the merchant
 * did not advertise it), or it was present but empty — which is the normal
 * shape for an agent with no passport, because the #4722 client only adds
 * fields when it has one. `{}` means the key was present but not a plain
 * object: the reference is malformed, and the check answers `subject_mismatch`
 * rather than pretending it was absent. A reference carrying only ONE of the
 * two fields is likewise passed through as-is and refused by the check.
 *
 * The values are passed through UNVALIDATED on purpose — `verifyPassportReceipt`
 * is the one place that validates them, so the merchant and any other consumer
 * cannot disagree about what a valid reference is.
 */
function readPassportReference(extensions: unknown): PassportReference | null {
  if (!isPlainRecord(extensions)) return null
  if (!Object.prototype.hasOwnProperty.call(extensions, HAVEN_PASSPORT_EXTENSION)) return null
  const entry = extensions[HAVEN_PASSPORT_EXTENSION]
  if (!isPlainRecord(entry)) return {}
  const info = isPlainRecord(entry.info) ? entry.info : entry
  const hasUid = Object.prototype.hasOwnProperty.call(info, 'attestation_uid')
  const hasChain = Object.prototype.hasOwnProperty.call(info, 'chain_id')
  if (!hasUid && !hasChain) return null
  return { attestation_uid: info.attestation_uid, chain_id: info.chain_id }
}

/**
 * #3170: is this failure the CHAIN refusing the transaction (a revert — a fact
 * about the payer's delegation or balance), as opposed to the merchant failing
 * to reach, pay for or correctly address the chain (an RPC, gas, nonce, fee or
 * key fault)? viem's `writeContract` wraps EVERY failure in
 * `ContractFunctionExecutionError`, so that outer class proves nothing; a
 * revert is proven only by a `ContractFunctionRevertedError` that carries
 * decoded revert data, an undecodable error signature or a reason matching
 * /execution reverted/i (viem also wraps a bare JSON-RPC -32603 "internal
 * error" in that class, with none of the three — its reason names an internal
 * error, not an execution revert), or by the node's `ExecutionRevertedError` — except geth's
 * "gas required exceeds allowance", which viem files under that class although
 * it means the MERCHANT's settlement key cannot pay for gas (#2979's
 * `settlement_wallet_out_of_gas` band). The reason guard is written to
 * op-geth's wording ("execution reverted"); a hardhat/anvil-style "VM
 * Exception … revert" under -32603 stays a fault, the pre-#3170 behaviour. A
 * custom client may throw a plain `Error` whose message names the revert or
 * the enforcer.
 * Everything else a viem client throws — nonce too low, fee cap, "already
 * known", rate limit, chain mismatch, HTTP or timeout — is the merchant's
 * fault and keeps #2979's fault reason code.
 */
export function isContractRevert(err: unknown): boolean {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null
    if (reverted && (reverted.data !== undefined || reverted.signature !== undefined || /execution reverted/i.test(reverted.reason ?? ''))) {
      return true
    }
    const executionReverted = err.walk((e) => e instanceof ExecutionRevertedError) as ExecutionRevertedError | null
    if (executionReverted && !/gas required exceeds allowance/i.test(executionReverted.message)) return true
    return false
  }
  const haystack = `${err instanceof Error ? err.name : ''} ${err instanceof Error ? err.message : String(err)}`.toLowerCase()
  if (haystack.includes('insufficient funds') || haystack.includes('fetch failed') || haystack.includes('econnrefused') || haystack.includes('timeout')) {
    return false
  }
  return /revert|enforcer|allowance-exceeded/.test(haystack)
}

function revertReason(err: unknown): string {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null
    const reason = reverted?.reason ?? reverted?.data?.errorName ?? reverted?.shortMessage ?? err.shortMessage
    if (reason) return clampReason(reason)
  }
  return clampReason(err instanceof Error ? err.message : String(err))
}
