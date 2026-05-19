export { HavenClient } from './client.js'
export { havenTools } from './tools.js'
export { signHash, addressFromKey, verifySignature } from './signer.js'

export type {
  HavenClientConfig,
  PaymentRequest,
  PaymentIntent,
  PaymentResult,
  PaymentStatus,
  SignData,
  X402PaymentRequired,
  X402PaymentOption,
  X402Receipt,
  MachinePaymentRail,
  MachinePaymentChallenge,
  MachinePaymentReceipt,
} from './types.js'

export type { ClaudeTool, OpenAITool } from './tools.js'

export {
  HavenError,
  HavenApiError,
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
