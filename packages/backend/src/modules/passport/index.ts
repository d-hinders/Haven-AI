/**
 * `lib/passport` — L0 Agent Passport (epic #970).
 *
 * Public entry point. Per `docs/architecture/10-module-boundaries.md` rule 6,
 * callers import from here, never from a private file inside this directory.
 *
 * L0 attests **governance, not identity**: issued-by-Haven, bound-to-treasury,
 * enforced-policy, live-revocation. Say *issued / governed / revocable*;
 * *verified* is reserved for L2.
 */

export {
  PASSPORT_SCHEMA,
  PASSPORT_SCHEMA_REVOCABLE,
  PASSPORT_CHAIN_IDS,
  AssuranceLevel,
  ISSUABLE_ASSURANCE_LEVELS,
  getEasDeployment,
  getPassportSchemaUid,
  isPassportConfigured,
  type EasDeployment,
} from './schema.js'

export {
  NO_SMART_ACCOUNT,
  buildAddressBinding,
  encodeAddressBinding,
  decodeAddressBinding,
  bindingMatches,
  type PassportAddressBinding,
} from './binding.js'

export {
  getPassport,
  requestPassport,
  issuePassport,
  issuePassportBestEffort,
  retryPendingPassports,
  setAnchor,
  setAnchorRecovery,
  setAnchorLiveness,
  type PassportStatus,
  type PassportRow,
  type PassportClaim,
  type Anchor,
  type AnchorResult,
  type AnchorLivenessProbe,
} from './issuance.js'

// The real on-chain anchor. Imported here (not inside issuance.ts) so the
// issuance state machine stays testable without ethers or a relayer.
export {
  anchorOnChain,
  revokeOnChain,
  recoverAnchorFromReceipt,
  classifyAnchorTxLiveness,
  readRevocationAnchor,
  buildAttestCall,
  buildRevokeCall,
  encodeClaim,
  PASSPORT_REVOKE_SUBMITTER,
} from './attestation.js'

// The merchant-facing verifier (#974). Haven's DB is the authority here; the
// attestation UID rides along as an evidence pointer, never as the decision.
export {
  verifyPassport,
  buildReceipt,
  type PassportQuery,
  type VerificationResult,
} from './verification.js'

export {
  RECEIPT_TTL_SECONDS,
  RECEIPT_VERSION,
  canonicalize,
  setReceiptSigningKey,
  isReceiptSigningConfigured,
  receiptIssuerAddress,
  signReceipt,
  verifyReceipt,
  type ControlSummary,
  type PassportReceipt,
  type SignedPassportReceipt,
  type ReceiptVerification,
} from './receipt.js'

// Deployment readiness (#1151): the half-configured state — issuance on,
// verification off — anchors passports no merchant can verify. Reported on
// /health and warned at boot so it can never again be found by hand.
export {
  passportReadiness,
  logPassportReadiness,
  type PassportChainState,
  type PassportChainReadiness,
  type PassportReadiness,
  type PassportReadinessInputs,
} from './readiness.js'

// Revocation + live standing (#973). `passportStanding` is THE answer to
// "is this agent authorized right now?" — DB-authoritative, chain-eventual.
export {
  passportStanding,
  enqueuePassportRevocation,
  revokePassportBestEffort,
  reconcileRevocation,
  reconcilePendingRevocations,
  listStuckRevocations,
  revocationBackoffSeconds,
  isStaleAnchor,
  setRevoker,
  setRevocationProbe,
  type Standing,
  type AnchorState,
  type PassportStanding,
  type Revoker,
  type RevocationAnchorProbe,
  type RevocationAnchorReading,
  type RevocationAnchorState,
} from './revocation.js'

// Re-anchoring after a re-key (#1699, epic #1694). EAS attestations are
// immutable and the schema's first field is the delegate EOA, so a rotated key
// means retire-and-reissue — with the DB's `standing` running unbroken across
// it, because standing was never a column of this table.
export {
  reconcileReanchor,
  reanchorPassportBestEffort,
  reconcilePendingReanchors,
  listStuckReanchors,
} from './reanchor.js'

// x402 passport-reference delivery (#976, `X-Agent-Passport` header) — #998
// added this re-export so `modules/x402/settle.ts` (the only external
// consumer) stops reaching past the barrel into a private file.
export { passportReferenceFor, type PassportReference } from './x402-delivery.js'
