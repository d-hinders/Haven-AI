/**
 * The chain facts the harness reads directly, in one place (#1530).
 *
 * These were duplicated across six scenario files. That is the same defect
 * #1526 fixed twice in one day — a rule kept by hand in N places has drifted
 * in at least one of them — and the preflight needed them too, so the choice
 * was to consolidate or to add a seventh copy.
 *
 * Testnet only. The harness runs against Base Sepolia by construction; a
 * mainnet address here would be a bug, not a configuration option.
 */

/** Base Sepolia public RPC. */
export const BASE_SEPOLIA_RPC = 'https://sepolia.base.org'

/** Base Sepolia USDC — the asset every money-flow leg moves. */
export const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'

/** Base Sepolia chain id. */
export const BASE_SEPOLIA_CHAIN_ID = 84532

/** Read-only ERC-20 surface; the harness never writes through this. */
export const ERC20_BALANCE_ABI = ['function balanceOf(address) view returns (uint256)'] as const

/** USDC has 6 decimals; kept here so no caller re-derives it. */
export const USDC_DECIMALS = 6
