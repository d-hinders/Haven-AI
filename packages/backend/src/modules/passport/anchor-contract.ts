/**
 * The anchor seam's contract types (#3294) — a leaf both sides of the seam
 * import, so neither side imports the other.
 *
 * These lived in `issuance.ts` until #3294. They cannot stay there: dep-lint
 * counts type-only imports, and the #3294 repair gave `issuance.ts` a VALUE
 * import of `attestation.ts` (the repair call sits next to the anchor call it
 * mirrors) while `attestation.ts` had always typed its inputs from here — a
 * cycle, and `no-circular` can never be waived
 * (`docs/architecture/10-module-boundaries.md`, rule 7). Moving the contract
 * to its own leaf keeps the seam's shape exactly as it was: `issuance.ts`
 * still owns the setters and re-exports these types, `attestation.ts` still
 * implements them, and this module imports nothing from the passport module
 * beyond the `AssuranceLevel` enum from the already-leaf `schema.js`.
 */

import { AssuranceLevel } from './schema.js'

/** What the attestation says. Assembled in issuance, submitted by the anchor seam. */
export interface PassportClaim {
  agentEoa: string
  smartAccount: string
  treasury: string
  assuranceLevel: AssuranceLevel
  policyUri: string
  issuedAt: number
  expiresAt: number
}

/**
 * The on-chain write, isolated behind one function so issuance logic is
 * testable without a chain — and so the ONLY place that touches the relayer is
 * small enough to audit.
 */
export interface AnchorResult {
  attestationUid: string
  txHash: string
}
export type Anchor = (
  chainId: number,
  claim: PassportClaim,
  onBroadcast?: (txHash: string) => Promise<void>,
) => Promise<AnchorResult>

/**
 * A recovered anchor carries what the mined transaction ACTUALLY attested
 * (#1847). Recovery can cross a re-key: the broadcast was built from the
 * facts of its day, and by the time its receipt is read the agent may hold a
 * different key. `attested` is decoded from the transaction's own bytes so
 * `markAnchored` can record the chain's truth — the fresh claim would blind
 * `STALE_ANCHOR_PREDICATE` forever, silencing the #1699 re-anchor sweep and
 * its alarm for exactly the attestation that most needs them.
 */
export interface RecoveredAnchor extends AnchorResult {
  attested: { agentEoa: string; smartAccount: string }
}

export type AnchorRecovery = (chainId: number, txHash: string) => Promise<RecoveredAnchor | null>

/**
 * Can a previously broadcast attest still mine? (#1745)
 *
 * Separate from {@link AnchorRecovery} on purpose. Recovery answers "did it
 * succeed", and its null means "no answer yet". This answers the different
 * question the re-mint actually depends on — "can it still succeed" — and only
 * `'dead'` may unlock a second attest. See `classifyAnchorTxLiveness`.
 */
export type AnchorLivenessProbe = (chainId: number, txHash: string) => Promise<'live' | 'dead'>
