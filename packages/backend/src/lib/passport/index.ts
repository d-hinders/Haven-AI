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
  type PassportStatus,
  type PassportRow,
  type PassportClaim,
  type Anchor,
  type AnchorResult,
} from './issuance.js'

// The real on-chain anchor. Imported here (not inside issuance.ts) so the
// issuance state machine stays testable without ethers or a relayer.
export { anchorOnChain, revokeOnChain, buildAttestCall, buildRevokeCall, encodeClaim } from './attestation.js'

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
  setRevoker,
  type Standing,
  type AnchorState,
  type PassportStanding,
  type Revoker,
} from './revocation.js'
