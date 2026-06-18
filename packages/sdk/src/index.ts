export { HavenClient } from './client.js'
export { havenTools } from './tools.js'
export { signHash, addressFromKey, verifySignature } from './signer.js'

export { toolDescriptions, composeDescription } from './tool-descriptions.js'
export type { ToolDescription, SharedToolKey } from './tool-descriptions.js'

export { HAVEN_SKILL_MD, SKILL_FOLDER_NAME } from './skill-content.js'

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
} from './types.js'

export type {
  AgentPaymentEnumSchema,
  HavenClientConfig,
  PaymentRequest,
  PaymentIntent,
  PaymentResult,
  PaymentStatus,
  PendingApproval,
  PaymentStatusResult,
  PaymentNextAction,
  PaymentPhase,
  SignData,
  X402PaymentRequired,
  X402PaymentOption,
  X402McpTransport,
  X402Receipt,
  X402AuthorizationOptions,
  X402Intent,
  X402ExpectedAuth,
  X402ExpectedContext,
  X402RequestSnapshot,
  X402Quote,
  X402ResumeState,
  PaymentResumeState,
  ResumeAuthorizedX402Input,
  ResumeX402PaymentInput,
  MppAuthorizationOptions,
  MppQuote,
  MppResumeState,
  ResumeAuthorizedMppInput,
  ResumeMppPaymentInput,
  MachinePaymentRail,
  MachinePaymentChallenge,
  MachinePaymentReceipt,
  HavenAgent,
  HavenAgentSummary,
  HavenAgentAllowanceSummary,
  HavenAgentReadiness,
  HavenAllowance,
  HavenAllowanceSummary,
  HavenPaymentReceipt,
  SweepResult,
  SweepEntry,
  HavenCatalogEntry,
} from './types.js'

export type { ClaudeTool, OpenAITool } from './tools.js'

export {
  HavenError,
  HavenApiError,
  HavenPaymentStateError,
  HavenSigningError,
  HavenTimeoutError,
} from './types.js'

export {
  parsePaymentRequired,
  parsePaymentRequiredResponse,
  selectPaymentOption,
  selectStandardPaymentOption,
  toStandardPaymentRequirements,
  x402AuthorizationAmount,
  buildX402ExpectedMessage,
  encodePaymentProof,
} from './x402.js'

export {
  SWEEP_BASE_CHAIN_ID,
  SWEEP_BASE_USDC_ADDRESS,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  sweepUsdcAddress,
  sweepUsdcDomain,
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

export {
  parseMachinePaymentChallenge,
  parseMachinePaymentChallengeResponse,
  buildMachinePaymentIdempotencyKey,
  encodeMachinePaymentProof,
} from './mpp.js'

export {
  encodeBase64Utf8,
  decodeBase64Utf8,
  encodeBase64Json,
  decodeBase64Json,
} from './base64.js'
