export {
  createEdgeSigner,
  assertX402MatchesExpected,
  assertSupportedBindingVersion,
  SUPPORTED_SWEEP_BINDING_VERSIONS,
  SUPPORTED_X402_EXPECTED_VERSIONS,
  type EdgeSigner,
  type X402ExpectedPayment,
  type X402FundingSignatureResult,
  type X402HeaderResult,
} from './core.js'

export {
  signerCapabilityAdvertisement,
  signerCompatibility,
  signerInstructions,
  SIGNER_CAPABILITY_KEY,
  type SignerCompatibility,
} from './capabilities.js'

export {
  loadSignerCredentials,
  readAccountAddressEnv,
  readAccountAddressField,
  warnIfCredentialFilePermissive,
  type SignerCredentials,
} from './credentials.js'

export {
  buildSignerMcpServer,
  resolveEdgeSigner,
  resolveSignerRuntime,
  runSignerConsentGate,
  runSignerStdioServer,
  assertSupportedNodeVersion,
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
  AUDIT_ROTATE_BYTES,
  appendSigningAuditEntry,
  createSigningAuditEntry,
  defaultSigningAuditPath,
  hashPayloadForAudit,
  type AppendAuditOptions,
  type SigningAuditContext,
  type SigningAuditEntry,
} from './audit.js'
export {
  OWNER_ONLY_MODE,
  permissiveMode,
  tightenIfFilePermissive,
  warnIfFilePermissive,
  type PermissionLog,
  type PermissiveFile,
  type TightenOutcome,
} from './file-mode.js'

// #3103: the hosted tools this signer hands off to, declared here and pinned to the hosted schemas in the hosted server's suite.
export { SIGNER_HOSTED_HANDOFF_SHAPES } from './next-step.js'
