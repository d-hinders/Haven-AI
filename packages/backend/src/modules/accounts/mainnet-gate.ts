/**
 * Mainnet launch gate for delegation-rail accounts (#908, recorded by #890).
 *
 * The criterion, verbatim from the security model (§6–7): no mainnet
 * delegation-rail account may OPERATE with fewer than two enrolled signers,
 * unless the owner has explicitly acknowledged the single-signer risk — a
 * recorded, signed-off "I understand losing my only device loses this
 * account". The onboarding nudge alone is not sufficient for mainnet.
 *
 * This module is the mechanism. It is enforced at BOTH authority moments:
 *   - provisioning (POST /accounts/hybrid) — before the account row exists;
 *   - grant activation (POST /agents/:id/delegations/:hash/activate) — before
 *     any delegation becomes live, covering rows created by older code.
 *
 * Deliberately FAIL-CLOSED and registry-independent: the gate classifies
 * chains itself (a chain is value-bearing unless it is a KNOWN testnet), and
 * the routes run it BEFORE the pinned-contracts availability check — so
 * adding Base mainnet to the contract registry can never, on its own, open
 * mainnet without the signer floor.
 */

const SIGNER_FLOOR = 2

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
   * The owner's explicit, recorded acknowledgment of single-signer risk —
   * either sent with this request (provisioning) or previously recorded on
   * the account row (activation).
   */
  waiverAcknowledged: boolean
}

/**
 * Pure gate core: returns null when the operation may proceed, or the
 * user-facing error message when the mainnet signer floor blocks it.
 * Testnets always pass — the floor is a MAINNET launch criterion (#908);
 * dev/QA single-signer accounts stay exactly as cheap as today.
 */
export function signerFloorError(check: SignerFloorCheck): string | null {
  if (!isValueBearingChain(check.chainId)) return null
  if (check.signerCount >= SIGNER_FLOOR) return null
  if (check.waiverAcknowledged) return null
  return (
    `Mainnet accounts need at least ${SIGNER_FLOOR} enrolled signers (a backup passkey or wallet) ` +
    'so the account can be recovered if a device is lost. Add a second signer, or explicitly ' +
    'acknowledge the risk that losing your only device loses this account ' +
    '(single_signer_waiver: { acknowledged: true }).'
  )
}
