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
} from './types.js'

export type { ClaudeTool, OpenAITool } from './tools.js'

export {
  HavenError,
  HavenApiError,
  HavenSigningError,
  HavenTimeoutError,
} from './types.js'
