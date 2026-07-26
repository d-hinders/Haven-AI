/**
 * L0 Agent Passport — issuance (#972, epic #970).
 *
 * ## Opt-in, never automatic (owner decision 2026-07-24)
 *
 * Creating an agent does NOT issue a passport. Each one is an on-chain
 * attestation the relayer pays gas for — a real per-agent cost at scale — and
 * opt-in lets the owner choose what goes on-chain (a partial answer to the
 * epic's graph-privacy question). An agent with no passport row is the normal
 * case and behaves exactly as it did before this shipped.
 *
 * ## The EAS write NEVER blocks anything (v6 review point 2)
 *
 * Issuance is async, best-effort and retryable, mirroring
 * `feedSettledPaymentBestEffort` — the reporting feed's rule that a bookkeeping
 * push must never block settlement. Here: a failed, slow, or unfunded
 * attestation must never fail agent creation. Sponsorship exhaustion degrades
 * to "passport pending", never to a failed agent.
 *
 * ## Non-custody (invariant check)
 *
 * Haven signs the attestation as ISSUER, with the gas-only relayer. That is
 * governance metadata, not spend authority: the transaction targets the EAS
 * contract and nothing else, moves no value, and involves no user key. It does
 * not widen the relayer's role — it remains a key that pays gas and cannot move
 * user funds. See `docs/security/delegation-rail-security-model.md` §2 inv. 3.
 */

import * as repo from '../../infra/repositories/agent-passports.js'
import { redactVendorSecrets } from '../execution-rail.js'
import { computeHybridAccountAddress } from '../hybrid-provisioning.js'
import { getEasDeployment, isPassportConfigured } from './schema.js'
import { AssuranceLevel } from './schema.js'
import { buildAddressBinding, encodeAddressBinding } from './binding.js'
import { revokePassportBestEffort } from './revocation.js'

export type { PassportStatus, PassportRow } from '../../infra/repositories/agent-passports.js'
import type { PassportRow } from '../../infra/repositories/agent-passports.js'

/** What the attestation says. Assembled here, submitted by the anchor seam. */
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
export type Anchor = (chainId: number, claim: PassportClaim) => Promise<AnchorResult>

/** Default anchor — wired in `attestation.ts`; injectable for tests. */
let anchorImpl: Anchor | null = null
export function setAnchor(anchor: Anchor | null): void {
  anchorImpl = anchor
}

/** Read the passport row for an agent, or null when it has none. */
export async function getPassport(agentId: string): Promise<PassportRow | null> {
  return repo.findByAgent(agentId)
}


/**
 * Record the INTENT to issue. Returns false when a passport already exists —
 * issuance is idempotent, and a second request must not reset an anchored
 * passport or double-spend gas.
 */
export async function requestPassport(agentId: string, chainId: number): Promise<boolean> {
  return repo.insertRequested(agentId, chainId, AssuranceLevel.L0)
}

/**
 * Record the anchor together with the addresses that were ATTESTED (#974).
 *
 * They come from the claim, not from a fresh lookup: the receipt the verifier
 * hands a merchant must describe what is actually on-chain. A re-derived
 * address could silently disagree with the attestation while looking
 * authoritative — and the Hybrid account address has no reverse lookup, so
 * without storing it a merchant holding only that address could never verify.
 */
async function markAnchored(
  agentId: string,
  result: AnchorResult,
  claim: PassportClaim,
): Promise<void> {
  await repo.markAnchored(agentId, result.attestationUid, result.txHash, {
    agentEoa: claim.agentEoa,
    smartAccount: claim.smartAccount,
  })
}

/**
 * Record a failure, REDACTED.
 *
 * `last_error` holds a provider message, and a bundler/RPC URL routinely
 * carries `?apikey=...`. Persisting it raw would write a vendor secret into the
 * database and then surface it in any UI that shows why a passport failed —
 * the exact leak `redactVendorSecrets` exists for on the execution rail.
 */
async function markFailed(agentId: string, error: string): Promise<void> {
  await repo.markFailed(agentId, redactVendorSecrets(error))
}

/**
 * Do the issuance. Safe to call repeatedly: an already-anchored passport is a
 * no-op, so a retry sweep cannot mint a second attestation or re-spend gas.
 */
export async function issuePassport(agentId: string, userId: string): Promise<PassportRow | null> {
  const existing = await getPassport(agentId)
  if (!existing) return null // never requested — nothing to do
  if (existing.status === 'anchored') return existing // idempotent

  const facts = await repo.findAgentFacts(agentId, userId)
  if (!facts) {
    await markFailed(agentId, 'agent not found for this user')
    return getPassport(agentId)
  }

  const chainId = existing.chain_id
  if (!isPassportConfigured(chainId)) {
    // Not a defect — the schema is simply not registered on this chain yet
    // (#971's operator step). Stays retryable; no attestation is attempted.
    await markFailed(agentId, `passport schema not registered on chain ${chainId}`)
    return getPassport(agentId)
  }

  let claim: PassportClaim
  try {
    if (!facts.safe_address) throw new Error('agent has no bound treasury account')

    // The agent's OWN smart account — the erc7710 delegator, derived from the
    // delegate EOA. NOT `safe_address`, which is the treasury it spends from.
    // Delegation-rail only; EOA-only agents legitimately have none.
    //
    // If this cannot be derived we FAIL (retryably) rather than issue a
    // half-bound passport: #946 made settlement a per-payment choice, so a
    // delegation-rail passport bound to the EOA alone would simply not verify
    // for a merchant who settled via erc7710 — a silently wrong credential is
    // worse than a missing one.
    let smartAccountAddress: string | null = null
    if (facts.execution_rail === 'delegation' || facts.account_type === 'delegator_hybrid') {
      smartAccountAddress = await computeHybridAccountAddress(existing.chain_id, {
        ownerAddress: facts.delegate_address as `0x${string}`,
      })
    }

    const binding = encodeAddressBinding(
      buildAddressBinding({
        delegateAddress: facts.delegate_address,
        smartAccountAddress,
      }),
    )
    const now = Math.floor(Date.now() / 1000)
    claim = {
      ...binding,
      treasury: facts.safe_address,
      assuranceLevel: AssuranceLevel.L0,
      policyUri: `haven:agent:${agentId}`,
      issuedAt: now,
      expiresAt: 0, // 0 = no expiry; revocation is the live control (#973)
    }
  } catch (err) {
    await markFailed(agentId, err instanceof Error ? err.message : String(err))
    return getPassport(agentId)
  }

  if (!anchorImpl) {
    await markFailed(agentId, 'no anchor configured')
    return getPassport(agentId)
  }

  // Win the right to anchor, atomically. A loser returns the current row
  // untouched rather than submitting a second attest() — see claimForAnchoring.
  if (!(await repo.claimForAnchoring(agentId))) return getPassport(agentId)

  try {
    getEasDeployment(chainId) // reject an unpinned chain before spending gas
    const result = await anchorImpl(chainId, claim)
    await markAnchored(agentId, result, claim)
    // Close the anchor race (#973). Anchoring takes seconds, and the owner can
    // revoke the agent during them. The revoke hook is a no-op in that window —
    // its enqueue requires an ALREADY-anchored passport — so without this the
    // attestation that lands a moment later stays live on-chain, for a revoked
    // agent, until someone notices. `reconcileRevocation` re-checks the
    // invariant atomically, so for a live agent this is a cheap no-op.
    revokePassportBestEffort(agentId)
  } catch (err) {
    await markFailed(agentId, err instanceof Error ? err.message : String(err))
  }
  return getPassport(agentId)
}

/**
 * Fire-and-forget hook for the agent-creation path.
 *
 * Returns `void` and swallows everything ON PURPOSE — this is the line that
 * guarantees a slow or failing EAS write can never fail agent creation. The
 * state machine in `agent_passports` is what makes that safe: the work is
 * recorded before this returns, so a swallowed error is still visible as
 * `failed` and still retryable.
 */
export function issuePassportBestEffort(agentId: string, userId: string): void {
  void issuePassport(agentId, userId).catch(() => {})
}

/** Retry sweep — every non-anchored passport, oldest first. Idempotent. */
export async function retryPendingPassports(limit = 50): Promise<{ attempted: number }> {
  const rows = await repo.listRetryable(limit)
  for (const row of rows) await issuePassport(row.agent_id, row.user_id)
  return { attempted: rows.length }
}
