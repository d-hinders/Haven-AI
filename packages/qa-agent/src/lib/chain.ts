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

/**
 * The RPC node the harness OBSERVES through — the endpoint every on-chain
 * assertion in this suite reads (#2511).
 *
 * Default: the Base Sepolia public endpoint. Overridable with
 * `QA_RPC_URL_BASE_SEPOLIA` so an operator can move the observer to a
 * dedicated provider node when the public endpoint degrades.
 *
 * This is deliberately a SEPARATE knob from the backend's
 * `RPC_URL_BASE_SEPOLIA`: the harness deliberately reads a SECOND node (the
 * backend writes through its own `RPC_URL_BASE_SEPOLIA`), so an on-chain
 * assertion verified on the node the backend wrote through would only prove
 * the backend agrees with itself. Pointing both at the same endpoint would
 * quietly delete that independence — if you set this variable, set it to a
 * node the backend does NOT write through.
 */
export const BASE_SEPOLIA_RPC =
  process.env.QA_RPC_URL_BASE_SEPOLIA?.trim() || 'https://sepolia.base.org'

/** Base Sepolia USDC — the asset every money-flow leg moves. */
export const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'

/** Base Sepolia chain id. */
export const BASE_SEPOLIA_CHAIN_ID = 84532

/** Read-only ERC-20 surface; the harness never writes through this. */
export const ERC20_BALANCE_ABI = ['function balanceOf(address) view returns (uint256)'] as const

/** USDC has 6 decimals; kept here so no caller re-derives it. */
export const USDC_DECIMALS = 6
