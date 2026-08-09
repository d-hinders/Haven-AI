/**
 * Signer-floor classification for delegation-rail accounts.
 *
 * **This is no longer a gate (#1153).** It was: #908 refused provisioning,
 * grant activation, and owner removal on any value-bearing chain for accounts
 * below two signers, unblockable only by a recorded waiver. Nothing here
 * refuses anything now — the module classifies, and the surfaces recommend.
 *
 * **Owner decision (2026-08-07, recorded verbatim on #1153):**
 *
 * > "This is too hard, create a issue where this requirement is changed from
 * > being a hard one, to a soft recommendation of adding a backup, but this
 * > recommendation should only be displayed to the user after they have funded
 * > the account. I do not want users to have this in their face directly at
 * > onboarding."
 *
 * and, on owner removal:
 *
 * > "convert this from a block to a warning instead, the user should be able
 * > to move to a one signer set up."
 *
 * The reason the floor existed has NOT changed and is not softened by this:
 * a single-signer account has **no recovery**. Lose the device and the account
 * and everything in it is gone, with no path back through Haven or anyone
 * else. What changed is where that fact is delivered — after funding, when the
 * user has something to protect and a reason to care — rather than as a wall
 * in the first minute, where it blocked the one-Face-ID onboarding the
 * delegation rail exists to offer. See
 * `docs/security/delegation-rail-security-model.md` §6–7.
 *
 * The chain classification below stays FAIL-CLOSED (a chain is value-bearing
 * unless it is a KNOWN testnet) because it still decides whether the
 * recommendation is warranted at all — over-recommending on an unknown chain
 * is harmless; staying quiet on a real one is not.
 */

/** Two signers is what makes an account recoverable; below it, there is no path back. */
const RECOMMENDED_SIGNER_FLOOR = 2

/**
 * Known TESTNET chain ids — everything else is treated as value-bearing.
 * Sourced from viem's chain metadata but pinned here as data: the gate must
 * not throw (or silently pass) for a chain id nobody registered yet.
 */
const KNOWN_TESTNET_CHAIN_IDS: ReadonlySet<number> = new Set([
  84532, // Base Sepolia — the delegation rail's dev/QA chain
  11155111, // Ethereum Sepolia
  10200, // Gnosis Chiado
])

/** A chain where real funds move — fail-closed: unknown chains count. */
export function isValueBearingChain(chainId: number): boolean {
  return !KNOWN_TESTNET_CHAIN_IDS.has(chainId)
}

export interface SignerFloorCheck {
  chainId: number
  /** Enrolled signers: passkeys + the EOA owner if present. */
  signerCount: number
  /**
   * The owner's explicit, recorded acknowledgment of single-signer risk.
   * Retained on the type because provisioning still RECORDS it as history —
   * it no longer affects whether anything proceeds (#1153).
   */
  waiverAcknowledged?: boolean
}

/**
 * Would this account benefit from a backup signer?
 *
 * True when it holds real value and has fewer than two enrolled signers — the
 * exact condition that used to refuse the operation, now the condition that
 * makes the recommendation worth showing. Testnets are always false: a dev/QA
 * account has nothing to lose.
 *
 * A recorded waiver no longer changes the answer. It never made the account
 * recoverable; it only recorded that someone had been told. Keeping it in the
 * predicate would hide the recommendation from precisely the users who had
 * already said "I know" once — and the risk is ongoing, not a thing you
 * acknowledge away. The column is still written where an acknowledgement is
 * given (`user_safes.single_signer_waiver_at`), as history.
 */
export function needsBackupSignerRecommendation(check: SignerFloorCheck): boolean {
  if (!isValueBearingChain(check.chainId)) return false
  return check.signerCount < RECOMMENDED_SIGNER_FLOOR
}
