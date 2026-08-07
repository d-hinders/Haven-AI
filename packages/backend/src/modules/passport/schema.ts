/**
 * L0 Agent Passport — EAS schema definition and registry pinning (#971, epic #970).
 *
 * The passport is a signed, on-chain-anchored, revocable credential attesting an
 * agent's **provenance, enforced controls, and live status**. Naming discipline
 * from the epic, restated here because this file is where the fields are fixed:
 * L0 attests **governance, not identity** — issued-by-Haven, bound-to-treasury,
 * enforced-policy, live-revocation. It does NOT attest who is accountable. Say
 * *issued / governed / revocable*; never *verified*.
 *
 * ## Address binding (owner decision 2026-07-24, load-bearing)
 *
 * The schema binds BOTH agent addresses, because #946 made settlement a
 * PER-PAYMENT choice and a merchant sees a different address on each path:
 *
 * - `agentEoa` — REQUIRED. `agents.delegate_address`. Universal: every agent has
 *   one, including legacy/import-only agents that have nothing else. This is the
 *   `from` a merchant sees in an **EIP-3009** header.
 * - `smartAccount` — OPTIONAL. The Hybrid delegator derived from the EOA; exists
 *   only on the delegation rail. This is the delegator in **erc7710** redemption.
 *
 * Bind only one and verification breaks depending on which path the payment took.
 *
 * EAS has no nullable field type, so "absent" is encoded as the zero address.
 * That sentinel is load-bearing and dangerous if handled loosely: a lookup BY
 * the zero address must never resolve to a passport. See `binding.ts`, which is
 * the only place allowed to interpret it.
 */

import type { Address } from 'viem'

/**
 * The EAS schema string, in registration order. Changing ANY of this — field
 * order, names, or types — produces a different schema UID and orphans every
 * passport already attested against the old one. Treat it as immutable once
 * registered; a change is a new schema plus a migration plan, never an edit.
 *
 * `revocable` is a registration flag, not a field: the passport is registered
 * revocable=true because live revocation is the whole point of L0 (#973).
 */
export const PASSPORT_SCHEMA =
  'address agentEoa,' +
  'address smartAccount,' +
  'address treasury,' +
  'uint8 assuranceLevel,' +
  'string policyUri,' +
  'uint64 issuedAt,' +
  'uint64 expiresAt'

/** Registered revocable — live revocation is the core L0 claim (#973). */
export const PASSPORT_SCHEMA_REVOCABLE = true

/**
 * Assurance ladder (#975 defines the framework; only L0 is issuable now).
 * Encoded as uint8 so later tiers slot in without a schema change — which is
 * the entire reason the ladder is in the schema from day one.
 */
export enum AssuranceLevel {
  /** Governance: issued by Haven, bound to a treasury, policy enforced on-chain, revocable. */
  L0 = 0,
  /** Reserved — sanctions screening (#977). NOT issuable; needs regulatory review first. */
  L1 = 1,
  /** Reserved — ZK-anchored KYC. NOT issuable. The only tier that may say "verified". */
  L2 = 2,
}

/** The only level this codebase may attest today. */
export const ISSUABLE_ASSURANCE_LEVELS: ReadonlySet<AssuranceLevel> = new Set([AssuranceLevel.L0])

/**
 * EAS deployment per chain.
 *
 * ⚠️ PROVENANCE: these are the standard OP-Stack EAS predeploys that Base and
 * Base Sepolia inherit. They were NOT verified on-chain from the environment
 * this file was written in (no RPC egress), so they are treated as UNPROVEN
 * until an operator runs `npm run ops:register-passport-schema -w packages/backend`,
 * which asserts both addresses have code and that SchemaRegistry answers a read
 * before it will register anything. Follow `delegation-contracts.ts`'s posture:
 * an address that has not been exercised is not yet pinned, it is proposed.
 */
export interface EasDeployment {
  schemaRegistry: Address
  eas: Address
}

const EAS_DEPLOYMENTS: Record<number, EasDeployment> = {
  // Base Sepolia (dev/QA) — the only chain L0 issues on until the epic's DoD passes.
  84532: {
    schemaRegistry: '0x4200000000000000000000000000000000000020',
    eas: '0x4200000000000000000000000000000000000021',
  },
  // Base mainnet is deliberately ABSENT. Adding it is a mainnet decision that
  // rides with #908, with its own verification run — never by copying this block.
}

/** Chains the passport may be issued on. Fail-closed: absent chain = no issuance. */
export const PASSPORT_CHAIN_IDS: ReadonlySet<number> = new Set(
  Object.keys(EAS_DEPLOYMENTS).map(Number),
)

export function getEasDeployment(chainId: number): EasDeployment {
  const deployment = EAS_DEPLOYMENTS[chainId]
  if (!deployment) {
    throw new Error(
      `agent passport: no pinned EAS deployment for chain ${chainId}. ` +
        `Issuance is limited to: ${[...PASSPORT_CHAIN_IDS].join(', ')}.`,
    )
  }
  return deployment
}

const SCHEMA_UID_RE = /^0x[0-9a-fA-F]{64}$/

/**
 * The registered schema UID for a chain, read from
 * `AGENT_PASSPORT_SCHEMA_UID_<chainId>`.
 *
 * FAIL-CLOSED BY DESIGN. The UID cannot exist before an operator registers the
 * schema on-chain, so this throws rather than defaulting. Nothing can attest a
 * passport against an unregistered — or malformed — schema, and a
 * half-configured deployment refuses loudly instead of writing attestations
 * nobody can verify.
 */
export function getPassportSchemaUid(chainId: number, env: NodeJS.ProcessEnv = process.env): `0x${string}` {
  getEasDeployment(chainId) // reject unsupported chains before reading config
  const key = `AGENT_PASSPORT_SCHEMA_UID_${chainId}`
  const uid = env[key]
  if (!uid) {
    throw new Error(
      `agent passport: ${key} is not set — the schema has not been registered on chain ${chainId}. ` +
        `Run \`npm run ops:register-passport-schema -w packages/backend\` and record the UID.`,
    )
  }
  if (!SCHEMA_UID_RE.test(uid)) {
    throw new Error(`agent passport: ${key} is not a 32-byte hex UID (got ${uid.length} chars)`)
  }
  return uid as `0x${string}`
}

/** True when a chain is fully configured for issuance. Never throws. */
export function isPassportConfigured(chainId: number, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    getPassportSchemaUid(chainId, env)
    return true
  } catch {
    return false
  }
}
