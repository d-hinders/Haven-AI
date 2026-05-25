export { HavenClient } from './client.js'
export { havenTools } from './tools.js'
export { signHash, addressFromKey, verifySignature } from './signer.js'

export {
  AgentPaymentPhase,
  AgentPaymentNextAction,
  AgentPaymentRail,
  AGENT_PAYMENT_PHASE_VALUES,
  AGENT_PAYMENT_NEXT_ACTION_VALUES,
  AGENT_PAYMENT_RAIL_VALUES,
  AgentPaymentPhaseDescriptions,
  AgentPaymentNextActionDescriptions,
  AgentPaymentRailDescriptions,
  AgentPaymentPhaseSchema,
  AgentPaymentNextActionSchema,
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
  X402Receipt,
  X402AuthorizationOptions,
  X402RequestSnapshot,
  X402Quote,
  X402ResumeState,
  ResumeAuthorizedX402Input,
  ResumeX402PaymentInput,
  MachinePaymentRail,
  MachinePaymentChallenge,
  MachinePaymentReceipt,
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
  encodePaymentProof,
} from './x402.js'

export {
  parseMachinePaymentChallenge,
  parseMachinePaymentChallengeResponse,
  buildMachinePaymentIdempotencyKey,
  encodeMachinePaymentProof,
} from './mpp.js'
