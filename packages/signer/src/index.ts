export {
  createEdgeSigner,
  assertX402MatchesExpected,
  type EdgeSigner,
  type X402ExpectedPayment,
  type X402FundingSignatureResult,
  type X402HeaderResult,
} from './core.js'

export {
  loadSignerCredentials,
  warnIfCredentialFilePermissive,
  type SignerCredentials,
} from './credentials.js'

export {
  buildSignerMcpServer,
  resolveEdgeSigner,
  resolveSignerRuntime,
  runSignerConsentGate,
  runSignerStdioServer,
  SIGNER_NAME,
  SIGNER_VERSION,
  type ResolvedSignerRuntime,
  type SignerOptions,
} from './server.js'

export {
  createToolHandlers,
  toolDescriptions,
  toolSchemas,
  type SignerToolName,
  type ToolFailure,
  type ToolPayload,
  type ToolSuccess,
} from './tools.js'

export {
  computeSignerConsentHash,
  ensureSignerConsent,
  renderSignerConsentBlock,
  SIGNER_ACK_ENV,
  type SignerConsentDecision,
  type SignerConsentInput,
  type SignerConsentOptions,
} from './consent.js'

export {
  appendSigningAuditEntry,
  createSigningAuditEntry,
  defaultSigningAuditPath,
  hashPayloadForAudit,
  type SigningAuditContext,
  type SigningAuditEntry,
} from './audit.js'
