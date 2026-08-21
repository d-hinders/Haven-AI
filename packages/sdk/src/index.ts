export { HavenClient } from './client.js'
export { havenTools } from './tools.js'
export { signHash,
  signUserOpTypedDataForDelegation, addressFromKey, verifySignature } from './signer.js'

export { verifyPaymentReceipt, RECEIPT_VERSION } from './receipt.js'
export type { PaymentReceipt, ReceiptVerification } from './receipt.js'

export { toolDescriptions, composeDescription } from './tool-descriptions.js'
export type { ToolDescription, SharedToolKey } from './tool-descriptions.js'

export { HAVEN_SKILL_MD, HAVEN_SKILL_BODY_MD, SKILL_FOLDER_NAME } from './skill-content.js'

// The Node.js floor every published Haven package enforces (#1161). Shared here
// because connect (at setup), signer and mcp (at startup) all need the same
// number, and a copy per package is how it drifted to begin with.
export {
  HAVEN_MINIMUM_NODE_VERSION,
  compareNodeVersions,
  isSupportedNodeVersion,
  unsupportedNodeVersionMessage,
  type UnsupportedNodeVersionMessageOptions,
} from './node-version.js'

export {
  AgentPaymentPhase,
  AgentPaymentNextAction,
  AgentPaymentFailureCode,
  AgentPaymentRail,
  AGENT_PAYMENT_PHASE_VALUES,
  AGENT_PAYMENT_NEXT_ACTION_VALUES,
  AGENT_PAYMENT_FAILURE_CODE_VALUES,
  AGENT_PAYMENT_RAIL_VALUES,
  AgentPaymentPhaseDescriptions,
  AgentPaymentNextActionDescriptions,
  AgentPaymentFailureCodeDescriptions,
  AgentPaymentRailDescriptions,
  AgentPaymentPhaseSchema,
  AgentPaymentNextActionSchema,
  AgentPaymentFailureCodeSchema,
  AgentPaymentRailSchema,
  DEFAULT_CONFIRMATION_TIMEOUT_MS,
} from './types.js'

export type {
  AgentPaymentEnumSchema,
  HavenClientConfig,
  PaymentRequest,
  PaymentIntent,
  PaymentResult,
  PaymentFee,
  PaymentStatus,
  PendingApproval,
  PaymentStatusResult,
  PaymentNextAction,
  PaymentPhase,
  SignData,
  X402PaymentRequired,
  X402PaymentOption,
  X402McpTransport,
  X402McpCallContext,
  X402MerchantCallContext,
  X402Receipt,
  X402AuthorizationOptions,
  X402Intent,
  X402ExpectedAuth,
  X402ExpectedContext,
  X402RequestSnapshot,
  X402Quote,
  AgentNextStep,
  AgentPurchaseSummary,
  AgentPaymentSummary,
  AgentPaymentWarning,
  X402ResumeState,
  PaymentResumeState,
  ResumeAuthorizedX402Input,
  ResumeX402PaymentInput,
  MachinePaymentRail,
  HavenAgent,
  HavenAgentSummary,
  HavenAgentAllowanceSummary,
  HavenAgentReadiness,
  HavenAllowance,
  HavenAllowanceSummary,
  PostPurchaseAllowanceSummary,
  HavenPaymentReceipt,
  SweepResult,
  SweepEntry,
  SweepConfirmation,
  HavenCatalogEntry,
} from './types.js'

export type { ClaudeTool, OpenAITool } from './tools.js'

export {
  HavenError,
  HavenApiError,
  AgentPaymentWarningCode,
  MerchantTimeoutError,
  X402UnexpectedStatusError,
  X402AlreadySettledError,
  HavenPaymentStateError,
  HavenSigningError,
  HavenTimeoutError,
  HavenUnsupportedSignerVersionError,
  SignerRefusalCode,
  SIGNER_UPDATE_FALLBACK,
} from './types.js'

export {
  parsePaymentRequired,
  normalizePaymentRequired,
  parsePaymentRequiredResponse,
  selectPaymentOption,
  selectStandardPaymentOption,
  selectErc7710PaymentOption,
  selectX402SettlementScheme,
  isErc7710Option,
  x402AssetTransferMethod,
  x402FacilitatorAddresses,
  ERC7710_ASSET_TRANSFER_METHOD,
  toStandardPaymentRequirements,
  x402AuthorizationAmount,
  validateStandardX402PaymentHeader,
  X402PaymentHeaderValidationError,
  X402_MAX_AUTHORIZATION_WINDOW_SECONDS,
  X402_SETTLEMENT_FORWARD_MARGIN_SECONDS,
  buildX402ExpectedMessage,
  encodePaymentProof,
  // #1351: the address→{symbol,decimals} binding behind X402Quote.decimals.
  // Exported so a consumer holding only a payment OPTION (not a built quote)
  // resolves decimals through exactly the same table the quote used.
  resolveTokenFromAddress,
} from './x402.js'

export type { X402PaymentHeaderContext, X402SchemeSelection } from './x402.js'
export type { X402Erc7710Settlement } from './types.js'

export {
  SWEEP_BASE_CHAIN_ID,
  SWEEP_BASE_USDC_ADDRESS,
  SWEEP_BASE_SEPOLIA_CHAIN_ID,
  SWEEP_BASE_SEPOLIA_USDC_ADDRESS,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  sweepUsdcAddress,
  sweepUsdcDomain,
  isSweepableChain,
  buildSweepTypedData,
  buildSweepAuthorizationMessage,
} from './sweep.js'

export type {
  SweepEip712Domain,
  SweepAuthorization,
  SweepExpectedAuth,
  SweepPreparation,
  SweepPrepareResponse,
  SweepSubmitResponse,
  SweepSubmitResult,
  SweepTypedData,
} from './sweep.js'

// #1328: mpp.ts's demo challenge/proof helpers (parseMachinePaymentChallenge,
// parseMachinePaymentChallengeResponse, buildMachinePaymentIdempotencyKey,
// encodeMachinePaymentProof) are retired with the mpp_demo client surface.

export {
  encodeBase64Utf8,
  decodeBase64Utf8,
  encodeBase64Json,
  decodeBase64Json,
} from './base64.js'

export {
  MERCHANT_DISCOVERY_PATHS,
  DISCOVERY_MAX_BYTES,
  discoverMerchantMcpUrl,
  sameUrl,
} from './merchant-discovery.js'
