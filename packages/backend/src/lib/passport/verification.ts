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
import { AssuranceLevel, ISSUABLE_ASSURANCE_LEVELS } from './schema.js'
import { standingForStatus, anchorForPassport } from './revocation.js'
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
  | { found: false; reason: 'no_passport' | 'unsupported_assurance_level' }

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
 * The passport's assurance level, READ from the row rather than assumed (#975).
 *
 * The verifier used to hardcode `AssuranceLevel.L0`. That was correct only
 * because `agent_passport_level_issuable` pins the column to 0 — an invariant
 * enforced in a different layer, for a value this function is the sole author
 * of on the wire. The ladder exists so later tiers need no re-architecture; a
 * verifier that hardcodes the field the ladder communicates would silently
 * report L0 for an L1 passport the day the CHECK widens, which is precisely
 * the "premature verified" failure the ladder's naming discipline guards.
 *
 * Returns null for a level this build cannot issue. Clamping to L0 was the
 * tempting alternative and is worse: it UNDERSTATES a higher tier, and a
 * merchant's screening logic branches on this field, so reporting a screened
 * agent as merely governed is a wrong answer presented as a right one.
 *
 * "Fails closed" is deliberately NOT claimed for the system here — only for
 * this function. Whether a merchant then denies is its own error handling,
 * which this endpoint elsewhere assumes cannot be relied on. That is exactly
 * why the caller turns this into a 200 `found: false` rather than an error
 * status; see `verifyPassport`.
 *
 * EXPORTED for testing, and that is not incidental. While L0 is the only
 * issuable level, "read the row" and "hardcode L0" produce identical output
 * for every VALID input, so no behavioural test can tell them apart — reverting
 * this function's use to a literal left the whole suite green. The unit tests
 * below plus a source-level guard are what actually pin it; see
 * passport-assurance.test.ts.
 */
export function assuranceLevelOf(row: VerificationRow): AssuranceLevel | null {
  // Explicit per type rather than a bare `Number()`. Coercion kept finding new
  // ways to DEFAULT: `Number(null)` is 0 and `Number('')` is 0, and 0 is
  // issuable — so each attempt silently reported an absent level as L0, the
  // exact failure this function exists to prevent. Both were caught by its own
  // unit tests. A permissive cast is not a safe default here; naming the
  // accepted shapes is.
  //
  // The string branch exists because `Set.has` is identity-based: if a driver
  // ever returned int2 as a string, '0' would not match 0 and every lookup
  // would refuse — a total outage from a type change, not a policy change.
  const raw = row.assurance_level as unknown
  let level: AssuranceLevel
  if (typeof raw === 'number') level = raw as AssuranceLevel
  else if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) level = Number(raw) as AssuranceLevel
  else return null
  return ISSUABLE_ASSURANCE_LEVELS.has(level) ? level : null
}

/**
 * Build the receipt for a resolved agent. Always reflects CURRENT standing —
 * a revocation shows up in a freshly fetched receipt immediately, whatever the
 * EAS anchor is doing.
 *
 * Returns null when the stored assurance level is one this build cannot issue,
 * so the caller can answer `found: false` rather than error. See below.
 */
export async function buildReceipt(row: VerificationRow): Promise<SignedPassportReceipt | null> {
  const issuer = receiptIssuerAddress()
  if (!issuer) {
    throw new Error('passport receipt signing is not configured (PASSPORT_RECEIPT_SIGNING_KEY)')
  }
  const assuranceLevel = assuranceLevelOf(row)
  if (assuranceLevel === null) return null
  const now = Math.floor(Date.now() / 1000)
  const receipt: PassportReceipt = {
    version: RECEIPT_VERSION,
    issuer,
    agentId: row.agent_id,
    agentEoa: row.agent_eoa,
    smartAccount: row.smart_account,
    assuranceLevel,
    // Shared with `passportStanding()`, not re-implemented: a copy would be
    // free to drift, and the failure mode is the receipt a merchant holds
    // disagreeing with Haven's own answer for the same agent.
    standing: standingForStatus(row.agent_status),
    anchor: anchorForPassport(row.passport_status, row.revocation_status),
    evidenceUid: row.attestation_uid,
    chainId: row.chain_id,
    controls: controlsOf(row),
    standingEpoch: row.record_updated_at ? new Date(row.record_updated_at).getTime() : 0,
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

  const signed = await buildReceipt(row)
  if (!signed) {
    // Deliberately the SAME 200 `found: false` shape as `no_passport`, not an
    // error status (#975). This endpoint states twice — in its route doc and in
    // the architecture doc — that an error status is what makes an integration
    // treat a lookup failure as a pass. A 500 here would have contradicted the
    // file's own doctrine, and the documented merchant snippet destructures
    // `receipt`/`signature` straight off the body, so it would THROW on a 500
    // and whether that denies is the merchant's catch block. `found: false` is
    // closed by construction: every integrator already handles it.
    //
    // Unreachable while `agent_passport_level_issuable` pins the column to 0.
    return { found: false, reason: 'unsupported_assurance_level' }
  }
  return { found: true, signed }
}
