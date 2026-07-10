/**
 * Pinned MetaMask Delegation Framework contract addresses (#825, epic #821).
 *
 * PINNED IN-REPO ON PURPOSE: Haven's security posture depends on exact,
 * immutable, audited bytecode — never on whatever a package upgrade resolves
 * to. The addresses below were extracted from @metamask/smart-accounts-kit
 * 1.6.0's environment for each chain and are cross-checked against the kit at
 * test time (a kit upgrade that moves an address FAILS the build instead of
 * silently retargeting the money path). This is the contracts half of the
 * anti-lock-in policy; the SDK fork-and-pin half lives in #826's runbook.
 *
 * Audit provenance (Consensys Diligence):
 * - delegation-framework Aug 2024 — DelegationManager, DeleGator accounts,
 *   core enforcer set
 * - delegation-framework Apr 2025 — incl. MultiTokenPeriodEnforcer and the
 *   period-transfer enforcers used for Haven budgets
 * Both reports are linked from RFC #791 §16 and the #820 spike report.
 *
 * Live verification: every address below was exercised on Base Sepolia by the
 * #820 matrix (docs/research/delegation-budget-rail-spike.md, tx links).
 */

export interface DelegationContracts {
  delegationManager: `0x${string}`
  entryPoint: `0x${string}`
  simpleFactory: `0x${string}`
  hybridDeleGatorImpl: `0x${string}`
  enforcers: {
    erc20PeriodTransfer: `0x${string}`
    multiTokenPeriod: `0x${string}`
    allowedTargets: `0x${string}`
    allowedCalldata: `0x${string}`
    allowedMethods: `0x${string}`
    timestamp: `0x${string}`
    limitedCalls: `0x${string}`
    erc20TransferAmount: `0x${string}`
  }
}

/**
 * Per-chain registry. Base Sepolia only until the epic's DoD passes; Base
 * mainnet is added by the (separate) mainnet gate with its own verification
 * run — never by copying.
 */
const CONTRACTS: Record<number, DelegationContracts> = {
  84532: {
    delegationManager: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3',
    entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
    simpleFactory: '0x69Aa2f9fe1572F1B640E1bbc512f5c3a734fc77c',
    hybridDeleGatorImpl: '0x48dBe696A4D990079e039489bA2053B36E8FFEC4',
    enforcers: {
      erc20PeriodTransfer: '0x474e3Ae7E169e940607cC624Da8A15Eb120139aB',
      multiTokenPeriod: '0xFB2f1a9BD76d3701B730E5d69C3219D42D80eBb7',
      allowedTargets: '0x7F20f61b1f09b08D970938F6fa563634d65c4EeB',
      allowedCalldata: '0xc2b0d624c1c4319760C96503BA27C347F3260f55',
      allowedMethods: '0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5',
      timestamp: '0x1046bb45C8d673d4ea75321280DB34899413c069',
      limitedCalls: '0x04658B29F6b82ed55274221a06Fc97D318E25416',
      erc20TransferAmount: '0xf100b0819427117EcF76Ed94B358B1A5b5C6D2Fc',
    },
  },
}

/** Chains the delegation rail may touch — the #829 routing gate reads this. */
export const DELEGATION_RAIL_CHAIN_IDS: ReadonlySet<number> = new Set(
  Object.keys(CONTRACTS).map(Number),
)

export function getDelegationContracts(chainId: number): DelegationContracts {
  const contracts = CONTRACTS[chainId]
  if (!contracts) {
    throw new Error(`delegation rail: no pinned contracts for chain ${chainId}`)
  }
  return contracts
}
