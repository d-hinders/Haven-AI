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
import { redactVendorSecrets } from '../../rails/execution-rail.js'
import { computeHybridAccountAddress } from '../../rails/hybrid-provisioning.js'
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
export type Anchor = (
  chainId: number,
  claim: PassportClaim,
  onBroadcast?: (txHash: string) => Promise<void>,
) => Promise<AnchorResult>

export type AnchorRecovery = (chainId: number, txHash: string) => Promise<AnchorResult | null>

let recoveryImpl: AnchorRecovery | null = null
export function setAnchorRecovery(recovery: AnchorRecovery | null): void {
  recoveryImpl = recovery
}

/**
 * Can a previously broadcast attest still mine? (#1745)
 *
 * Separate from {@link AnchorRecovery} on purpose. Recovery answers "did it
 * succeed", and its null means "no answer yet". This answers the different
 * question the re-mint actually depends on — "can it still succeed" — and only
 * `'dead'` may unlock a second attest. See `classifyAnchorTxLiveness`.
 */
export type AnchorLivenessProbe = (chainId: number, txHash: string) => Promise<'live' | 'dead'>

let livenessImpl: AnchorLivenessProbe | null = null
export function setAnchorLiveness(probe: AnchorLivenessProbe | null): void {
  livenessImpl = probe
}

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
  await repo.markAnchored(agentId, {
    attestationUid: result.attestationUid,
    txHash: result.txHash,
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
  if (facts.agent_status === 'revoked') {
    // #1043 finding 3: anchoring for a revoked agent just to immediately queue
    // its revocation is wasted gas and a transient live credential. The row
    // stays failed; listRetryable excludes revoked agents so it stops churning.
    await markFailed(agentId, 'agent is revoked — not anchoring')
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
  // The claim also refuses while ANOTHER agent's anchored, unrevoked passport
  // binds the same delegate EOA (#1042): `delegate_address` is client-supplied
  // and only unique per-user among non-revoked agents, so without this a
  // second anchor for the same EOA would let the verifier hand a merchant an
  // arbitrary credential for that address.
  if (!facts.delegate_address) {
    // Binding requires the EOA (#971: EOA-required, smart-account-optional);
    // a factless claim would also make the #1042 duplicate check vacuous.
    await markFailed(agentId, 'agent has no delegate address to bind')
    return getPassport(agentId)
  }
  const claimOutcome = await repo.claimForAnchoring(agentId, facts.delegate_address)
  if (claimOutcome === 'eoa_already_bound') {
    await markFailed(
      agentId,
      `delegate EOA ${facts.delegate_address} is already bound by another anchored passport (#1042)`,
    )
    return getPassport(agentId)
  }
  if (claimOutcome !== 'claimed') return getPassport(agentId)

  try {
    getEasDeployment(chainId) // reject an unpinned chain before spending gas

    // Recover-before-re-mint (#1043): a prior attempt that broadcast but lost
    // its result (wait timeout, crash, failed anchored-write) left tx_hash set
    // with no UID. Re-minting would create a second real attestation with the
    // first permanently invisible to Haven — read the receipt instead.
    //
    // A null from recovery is NOT permission to re-mint (#1745). It means the
    // receipt read had no answer, and `getTransactionReceipt` is equally
    // silent about a transaction still sitting in the mempool and one that was
    // genuinely dropped. This used to presume dropped — and because markFailed
    // clears `anchoring_started_at` (making the 600 s claim window vacuous)
    // and the retry backoff is 60 s at attempt 1, that presumption fired
    // ~180 s after the original broadcast. A fee-stuck attest would then be
    // duplicated at the next relayer nonce, and if the original ever mined,
    // both mined: two live credentials for one agent.
    //
    // So the re-mint now requires POSITIVE evidence that the prior
    // transaction can never mine — its nonce burned by something else — and
    // refuses on anything less. The asymmetry is the whole argument: a
    // wrongly withheld re-mint stalls ONE issuance, retryably and with the
    // attention counter alarming; a wrongly permitted one mints a second
    // real, revocable credential that no later tick can take back.
    let result: AnchorResult | null = null
    if (existing.tx_hash && !existing.attestation_uid) {
      if (recoveryImpl) result = await recoveryImpl(chainId, existing.tx_hash)
      if (!result) {
        // Fail-safe when no probe is wired: absent a way to prove death, the
        // answer is "do not re-mint", never "assume dropped".
        const liveness = livenessImpl ? await livenessImpl(chainId, existing.tx_hash) : 'live'
        if (liveness !== 'dead') {
          // Retryable, not terminal: markFailed clears the claim, so the next
          // due tick re-reads the receipt and re-probes. Whichever way the
          // chain eventually answers — mined, reverted, or nonce burned by an
          // operator's cancel — a later tick resolves this row without ever
          // having risked a duplicate.
          await markFailed(
            agentId,
            `prior attestation ${existing.tx_hash} may still mine — not re-anchoring (#1745)`,
          )
          return getPassport(agentId)
        }
      }
    }
    if (!result) {
      result = await anchorImpl(chainId, claim, (txHash) => repo.recordBroadcast(agentId, txHash))
    }
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

/**
 * Retry sweep — every non-anchored passport, oldest first. Idempotent.
 *
 * **Each row is isolated**, for the same reason as the revocation sweep:
 * `issuePassport` leaves `getPassport`, `findAgentFacts` and `claimForAnchoring`
 * outside its try block, so one bad row or a transient pool error throws out of
 * the loop. Oldest-first ordering then puts that same row first on every tick,
 * and the batch dies on item 1 forever. Worse, this sweep runs BEFORE the
 * revocation half — so an unisolated failure here would take the safety-critical
 * half down with it.
 */
/** Attempts past this need eyes — the backoff has hit its cap by then. */
export const ISSUANCE_ATTENTION_ATTEMPTS = 10

export async function retryPendingPassports(
  limit = 50,
): Promise<{ attempted: number; failed: number; needingAttention: number }> {
  const rows = await repo.listRetryable(limit)
  // A row past the attention threshold has been failing for hours (the
  // backoff caps at 1h by then) — that is an operational signal, not routine
  // churn. Counted and logged by the sweep so it alarms instead of retrying
  // in silence forever (#1043); the retry itself still proceeds.
  const needingAttention = rows.filter((r) => r.attempts >= ISSUANCE_ATTENTION_ATTEMPTS).length
  let failed = 0
  for (const row of rows) {
    try {
      await issuePassport(row.agent_id, row.user_id)
    } catch {
      // Still non-anchored, so it stays in the queue for the next tick — and
      // the rows behind it are not punished for it.
      failed++
    }
  }
  return { attempted: rows.length, failed, needingAttention }
}
