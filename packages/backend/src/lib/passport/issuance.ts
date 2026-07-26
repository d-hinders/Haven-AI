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
import { getEasDeployment, isPassportConfigured } from './schema.js'
import { AssuranceLevel } from './schema.js'
import { buildAddressBinding, encodeAddressBinding } from './binding.js'

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

async function markAnchored(agentId: string, result: AnchorResult): Promise<void> {
  await repo.markAnchored(agentId, result.attestationUid, result.txHash)
}

async function markFailed(agentId: string, error: string): Promise<void> {
  await repo.markFailed(agentId, error)
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
    const binding = encodeAddressBinding(
      buildAddressBinding({ delegateAddress: facts.delegate_address }),
    )
    if (!facts.safe_address) throw new Error('agent has no bound treasury account')
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

  try {
    getEasDeployment(chainId) // reject an unpinned chain before spending gas
    const result = await anchorImpl(chainId, claim)
    await markAnchored(agentId, result)
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
