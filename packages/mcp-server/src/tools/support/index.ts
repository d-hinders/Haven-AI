/**
 * Shared hosted-MCP support — public surface for the #2807 facade and the
 * later capability slices (#2809–#2812).
 *
 * Import from HERE, never deep: `capability modules import shared support`
 * is a one-direction rule policed by `shared-helper-ownership.test.ts`, and a
 * barrel keeps that rule checkable against one path.
 */
export {
  atomicToDisplay,
  assertWithinMaxAmount,
  CAP_WARNING_TEXT,
  humanToAtomic,
  priceSelectedOption,
  QUOTE_EXPIRES_SOON_MS,
  quoteWarnings,
  readMaxAmountCap,
  requireSettleableSelection,
  resolveCapAtomic,
  type MaxAmountCap,
} from './cap-price.js'
export { getUsableCatalogMcpEntry } from './catalog-entry.js'
export {
  HostedToolError,
  isX402PaymentWindowExpired,
  normalizeError,
  paymentWindowExpiredError,
  paymentWindowExpiredErrorFor,
  runTool,
} from './errors.js'
export { buildAgentGuidance, buildPurchaseSummary } from './guidance.js'
export {
  buildX402SigningContext,
  coerceJsonField,
  delegationSignFields,
  deliverMerchantPayment,
  isMerchantEndpointMiss,
  parseMcpTransport,
  preflightMcpPaymentHeader,
  quoteMcpToolCall,
  resolveMerchantCallContext,
  ResolvedMerchantCallContext,
  serializeMcpTransport,
  submitErc7710WithExpiryMapping,
  submitSignatureWithExpiryMapping,
  withDiscoveryGuidance,
} from './mcp-context.js'
export {
  buildMcpToolQuoteResponse,
  isPendingApproval,
  resolveResumeState,
  wrongTool,
} from './quote-response.js'
export { SIGNER_CAPABILITY_KEY, signerCompatibilityNotice } from './signer-compat.js'
