/**
 * L0 Agent Passport — the verifier (#974, epic #970).
 *
 * ## This is the authority, not the chain
 *
 * A merchant asking "is this agent real, funded, authorized?" gets its answer
 * here, from Haven's database — never from an EAS read. That is the whole point
 * of #973's consistency model: an EAS revoke is a transaction and can lag, so
 * during that window the on-chain attestation still reads as valid while Haven
 * has already revoked the agent. The attestation UID travels in the receipt as
 * an **evidence pointer**, not as the decision.
 *
 * ## Regulatory perimeter
 *
 * This endpoint answers a question about an AGENT'S GOVERNANCE STATUS. It
 * verifies no payment, settles nothing, holds nothing, and takes no fee — none
 * of the merchant-acquiring surface `docs/regulatory/casp-risk-guardrails.md`
 * puts out of scope. Do not grow it into payment verification or receipts for
 * settled merchant transactions; that is a different question with a different
 * perimeter.
 *
 * ## Minimal disclosure
 *
 * The response is deliberately thin: standing, assurance level, the bound
 * addresses (already public on-chain), and a boolean control summary. No owner
 * identity, no budget amounts, no balances, no counterparties. A merchant needs
 * to know an agent is governed — not how much its owner lets it spend.
 */

import * as repo from '../../infra/repositories/agent-passports.js'
import type { VerificationRow } from '../../infra/repositories/agent-passports.js'
import { AssuranceLevel } from './schema.js'
import type { AnchorState, Standing } from './revocation.js'
import {
  RECEIPT_TTL_SECONDS,
  RECEIPT_VERSION,
  receiptIssuerAddress,
  signReceipt,
  type ControlSummary,
  type PassportReceipt,
  type SignedPassportReceipt,
} from './receipt.js'

/** How the subject was looked up. */
export type PassportQuery = { address: string } | { attestationUid: string }

/**
 * An agent with no passport is a NORMAL answer, not an error.
 *
 * Most agents have none — issuance is opt-in — and a merchant asking about an
 * anonymous agent deserves a clean "no passport", not a 404 it has to
 * special-case. Collapsing "unknown" into an error is how integrations end up
 * treating a lookup failure as a pass.
 */
export type VerificationResult =
  | { found: true; signed: SignedPassportReceipt }
  | { found: false; reason: 'no_passport' }

/**
 * Standing, from the agent's status alone.
 *
 * Same allow-list as `passportStanding()` and for the same reason: only the
 * literal 'active' is active, so a status added by a later migration cannot
 * become a permission by default. Duplicated deliberately rather than shared
 * through a second query — the verifier reads one row, and this is the seam
 * where a merchant-facing answer is decided.
 */
function standingOf(agentStatus: string): Standing {
  if (agentStatus === 'revoked') return 'revoked'
  if (agentStatus === 'active') return 'active'
  return 'suspended'
}

function anchorOf(row: VerificationRow): AnchorState {
  if (row.passport_status !== 'anchored') return 'not_anchored'
  if (row.revocation_status === 'confirmed') return 'revoked_onchain'
  if (row.revocation_status === 'pending') return 'revocation_pending'
  return 'anchored'
}

/**
 * The enforced-controls summary — booleans only.
 *
 * `policyEnforcedOnchain` is the claim that actually matters to a merchant and
 * it is true on both live rails: the delegation rail's caveat enforcers revert
 * during gas estimation, and the legacy rail's AllowanceModule enforces the
 * per-token allowance in the Safe. Neither is an off-chain rules DSL, which is
 * precisely what "governed" means at L0.
 */
function controlsOf(row: VerificationRow): ControlSummary | null {
  if (!row.execution_rail) return null
  return {
    rail: row.execution_rail,
    policyEnforcedOnchain: row.execution_rail === 'delegation' || row.execution_rail === 'allowance',
    treasuryBound: row.safe_address !== null,
  }
}

/**
 * Build the receipt for a resolved agent. Always reflects CURRENT standing —
 * a revocation shows up in a freshly fetched receipt immediately, whatever the
 * EAS anchor is doing.
 */
export async function buildReceipt(row: VerificationRow): Promise<SignedPassportReceipt> {
  const issuer = receiptIssuerAddress()
  if (!issuer) {
    throw new Error('passport receipt signing is not configured (PASSPORT_RECEIPT_SIGNING_KEY)')
  }
  const now = Math.floor(Date.now() / 1000)
  const receipt: PassportReceipt = {
    version: RECEIPT_VERSION,
    issuer,
    agentId: row.agent_id,
    agentEoa: row.agent_eoa,
    smartAccount: row.smart_account,
    assuranceLevel: AssuranceLevel.L0,
    standing: standingOf(row.agent_status),
    anchor: anchorOf(row),
    evidenceUid: row.attestation_uid,
    chainId: row.chain_id,
    controls: controlsOf(row),
    standingEpoch: row.standing_changed_at ? new Date(row.standing_changed_at).getTime() : 0,
    issuedAt: now,
    expiresAt: now + RECEIPT_TTL_SECONDS,
  }
  return signReceipt(receipt)
}

/** Resolve and verify. The one call the route makes. */
export async function verifyPassport(query: PassportQuery): Promise<VerificationResult> {
  const row =
    'address' in query
      ? await repo.findByAgentAddress(query.address)
      : await repo.findByAttestationUid(query.attestationUid)
  if (!row) return { found: false, reason: 'no_passport' }
  return { found: true, signed: await buildReceipt(row) }
}
