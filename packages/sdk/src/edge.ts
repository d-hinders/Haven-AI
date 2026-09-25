/**
 * `@haven_ai/sdk/edge` — the ethers-free subset the edge signer imports (#3173).
 *
 * The package barrel (`./index.ts`) pulls in ethers, the `x402` package and the
 * HTTP client; the local signer used none of that at startup yet paid ~1 s of
 * module init for it on every session. This entry re-exports only the pure
 * helpers, error classes and types the signer needs, plus viem-based key
 * helpers (`edge-signing.ts`). `edge-imports.test.ts` walks this module's
 * import graph and fails if it ever reaches `ethers`, `x402` or the client.
 *
 * Public, semver-governed like the barrel: a symbol here is a symbol a
 * published signer resolves against a published SDK.
 */
export {
  AgentPaymentFailureCode,
  AgentPaymentNextAction,
  HavenApiError,
  HavenError,
  HavenSigningError,
  HavenUnsupportedSignerVersionError,
  SIGNER_UPDATE_FALLBACK,
  SignerRefusalCode,
  type X402ExpectedAuth,
  type X402PaymentOption,
  type X402PaymentRequired,
} from './types.js'
export { createNextStepBuilder, type NextStep, type NextStepHandoff, type NextStepTarget } from './next-step.js'
export { HAVEN_CONNECTOR_CHANNEL, connectorRerunCommand } from './connector-channel.js'
export {
  HAVEN_CLIENT_HEADER,
  havenClientIdentity,
  readClientUpdate,
  type HavenClientUpdate,
} from './client-identity.js'
export { HAVEN_MINIMUM_NODE_VERSION, isSupportedNodeVersion, unsupportedNodeVersionMessage } from './node-version.js'
export { decodeBase64Json, encodeBase64Json } from './base64.js'
export {
  buildX402ExpectedMessage,
  selectStandardPaymentOption,
  toStandardPaymentRequirements,
  x402AuthorizationAmount,
  x402V2PaymentEnvelope,
} from './x402.js'
export {
  buildSweepAuthorizationMessage,
  buildSweepTypedData,
  type SweepAuthorization,
  type SweepExpectedAuth,
} from './sweep.js'
export { addressFromKey, signHash, verifySignature } from './edge-signing.js'
export {
  DIRECT_SIGN_CONTEXT_VERSION,
  ENTRY_POINT_V07,
  HavenUserOpBindingError,
  assertUserOpTypedDataBinding,
  isPackedUserOperationTypedData,
  packedUserOperationHash,
} from './userop-binding.js'
// #3283 (epic #3284): ONE signing-surface guard for the signer and the SDK.
export { deriveDelegateAccountAddress, SIMPLE_FACTORY_ADDRESS, HYBRID_DELEGATOR_IMPLEMENTATION } from './delegate-account.js'
export {
  DELEGATION_TUPLE_COMPONENTS,
  REDEEM_DELEGATIONS_ABI,
  SINGLE_DEFAULT_MODE,
  assertRedeemsOwnBudgetDelegation,
} from './redemption-guard.js'
export {
  CAVEAT_ENFORCERS,
  DELEGATION_MANAGER,
  MAX_SETTLEMENT_WINDOW_SECONDS,
  ROOT_AUTHORITY,
  chainIdForNetwork,
  isSettlementChildTypedData,
  verifySettlementChild,
  type SettlementChildExpectation,
  type SettlementChildTypedData,
} from './settlement-child.js'
export {
  DIRECT_PAYMENT_CHAIN_IDS,
  EXECUTE_ABI,
  HavenTypedDataRefusedError,
  TYPED_DATA_NOT_ALLOWED,
  assertBoundDirectPaymentUserOp,
  assertFundingLegPaysDelegate,
  assertOwnSettlementChild,
} from './direct-payment-guard.js'
