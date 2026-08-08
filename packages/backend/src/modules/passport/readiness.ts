/**
 * Passport deployment readiness (#1151).
 *
 * Issuance and verification are configured by two INDEPENDENT env vars —
 * `AGENT_PASSPORT_SCHEMA_UID_<chainId>` (per chain, `schema.ts`) and
 * `PASSPORT_RECEIPT_SIGNING_KEY` (deployment-wide, `receipt.ts`). Every
 * combination of the two is representable, and one of them is a trap:
 *
 * > **issuance on, verification off** — the deployment anchors real, revocable
 * > passports on-chain that **no merchant can verify**. `GET /passport/verify`
 * > and `GET /passport/issuer` 503, and on the EIP-3009 settlement path the
 * > verifier is the ONLY delivery mechanism (`x402-delivery.ts`), so a 3009
 * > merchant has no way to learn the passport exists at all.
 *
 * That state was live on dev for days (three anchored passports, #1151) and
 * nothing reported it: no health field, no boot warning, no runbook. It took an
 * ad-hoc EAS GraphQL query to notice. The gap was never that the combination is
 * *possible* — it is deliberately representable, and the architecture doc names
 * it — but that nothing SAID so.
 *
 * This module is the saying. It is pure and dependency-injectable: it reads
 * configuration state and computes a summary, and never touches the chain, the
 * database, or the clock. `logPassportReadiness` is the boot warning, kept here
 * rather than inline in the composition root so the thing that must fire in
 * exactly one of four cases is unit-testable.
 *
 * **Nothing here may leak secrets.** The summary carries booleans plus the
 * already-published issuer address (`GET /passport/issuer` serves it for
 * merchants to pin) — never key material, and never the schema UID, which is
 * operator configuration with no business on an unauthenticated probe.
 */

import { PASSPORT_CHAIN_IDS, isPassportConfigured } from './schema.js'
import { isReceiptSigningConfigured, receiptIssuerAddress } from './receipt.js'

/**
 * The four states a passport-serving chain can be in. Named rather than left
 * for a reader to infer from two booleans — `issuance_only` is the one that is
 * a problem, and a state machine with a bad state should say which one it is.
 */
export type PassportChainState =
  /** Issues and verifies. The only fully-operational state. */
  | 'ready'
  /** ⚠️ Anchors passports no merchant can verify. The #1151 trap. */
  | 'issuance_only'
  /** Verifies passports anchored elsewhere (or previously); issues nothing here. */
  | 'verification_only'
  /** Passports are off on this chain. A normal, quiet state. */
  | 'unconfigured'

export interface PassportChainReadiness {
  chainId: number
  /** `AGENT_PASSPORT_SCHEMA_UID_<chainId>` is set and well-formed. */
  issuanceConfigured: boolean
  /**
   * `PASSPORT_RECEIPT_SIGNING_KEY` is set. Deployment-wide, so it repeats
   * across chains — the verifier is DB-authoritative and answers for any chain
   * the deployment holds rows for. Repeated per chain anyway, because the
   * question an operator asks is "can chain X be verified?" and an answer that
   * requires joining two parts of the response is an answer people get wrong.
   */
  verificationConfigured: boolean
  state: PassportChainState
}

export interface PassportReadiness {
  verification: {
    configured: boolean
    /** The published issuer address merchants pin, or null when unconfigured. */
    issuer: string | null
  }
  chains: PassportChainReadiness[]
  /**
   * Chains in `issuance_only` — anchoring passports nothing can verify. Empty
   * is the healthy answer; non-empty is what the boot warning names.
   */
  unverifiableChainIds: number[]
}

export interface PassportReadinessInputs {
  /** Defaults to the chains passports may be issued on (`PASSPORT_CHAIN_IDS`). */
  chainIds?: Iterable<number>
  env?: NodeJS.ProcessEnv
  /** Defaults to the live receipt-signer state. Injected in tests. */
  verificationConfigured?: boolean
  /** Defaults to the live receipt-signer address. Injected in tests. */
  issuerAddress?: string | null
}

function chainState(issuance: boolean, verification: boolean): PassportChainState {
  if (issuance && verification) return 'ready'
  if (issuance) return 'issuance_only'
  if (verification) return 'verification_only'
  return 'unconfigured'
}

/**
 * Summarise passport configuration for `/health` and the boot warning.
 *
 * Chains outside `PASSPORT_CHAIN_IDS` are absent rather than reported
 * unconfigured: a chain that serves no passports has nothing to be ready for,
 * and listing it would turn "Base mainnet is deliberately not a passport chain"
 * into a permanent red row nobody can clear.
 */
export function passportReadiness(inputs: PassportReadinessInputs = {}): PassportReadiness {
  const {
    chainIds = PASSPORT_CHAIN_IDS,
    env = process.env,
    verificationConfigured = isReceiptSigningConfigured(),
    issuerAddress = receiptIssuerAddress(),
  } = inputs

  const chains: PassportChainReadiness[] = [...chainIds]
    .sort((a, b) => a - b)
    .map((chainId) => {
      const issuanceConfigured = isPassportConfigured(chainId, env)
      return {
        chainId,
        issuanceConfigured,
        verificationConfigured,
        state: chainState(issuanceConfigured, verificationConfigured),
      }
    })

  return {
    verification: {
      configured: verificationConfigured,
      // Null when unconfigured rather than omitted, so a consumer reading the
      // field cannot mistake "no signer" for "field not implemented here".
      issuer: verificationConfigured ? issuerAddress : null,
    },
    chains,
    unverifiableChainIds: chains.filter((c) => c.state === 'issuance_only').map((c) => c.chainId),
  }
}

interface ReadinessLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void
}

/**
 * Log the boot warning, and ONLY in the half-configured case.
 *
 * Silent when both halves are on, both are off, or the deployment serves no
 * passport chains. A warning that fires in the normal case is a warning
 * operators learn to scroll past, which would put this right back where #1151
 * found it.
 */
export function logPassportReadiness(
  log: ReadinessLogger,
  readiness: PassportReadiness = passportReadiness(),
): void {
  if (readiness.unverifiableChainIds.length === 0) return
  log.warn(
    { chainIds: readiness.unverifiableChainIds },
    'Agent passport issuance is configured without verification — passports anchored on ' +
      `chain(s) ${readiness.unverifiableChainIds.join(', ')} cannot be verified by any merchant ` +
      '(GET /passport/verify and /passport/issuer will 503). Set PASSPORT_RECEIPT_SIGNING_KEY — ' +
      'see docs/operations/passport-verification-setup.md',
  )
}
