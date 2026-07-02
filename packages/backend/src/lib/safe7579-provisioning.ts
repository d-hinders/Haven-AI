/**
 * Safe7579 provisioning — upgrade an existing vanilla Safe to an ERC-7579
 * account with ONE owner transaction (ADR #719 Stage 2, foundation #739).
 *
 * This is the backend port of the pilot's `provision-lib.ts`, which was
 * live-verified on Base Sepolia (migration tx upgraded a vanilla Safe v1.4.1,
 * additive check passed). Pure construction — no network, no signing — so it is
 * unit-testable and Haven never holds a key: the returned payload is a Safe
 * self-executed MultiSend the *owner* signs.
 *
 * The one owner tx is a MultiSendCallOnly batch (delegatecalled by the Safe, so
 * every inner call runs with msg.sender = the Safe), in dependency order:
 *   1. safe.enableModule(safe7579)        — adapter may execute via module path
 *   2. safe.setFallbackHandler(safe7579)  — EntryPoint/7579 calls route to it
 *   3. safe7579.initializeAccount(...)     — installs the Smart Sessions validator
 *
 * Live-run lessons baked in (#721), do not "simplify" away:
 * - initializeAccount is called on THE SAFE, not the adapter directly. The
 *   adapter uses ERC-2771 HandlerContext for access control, so the call must
 *   route through the Safe's fallback handler (installed one step earlier in
 *   this same batch). A direct call reads garbage calldata as the sender and
 *   reverts (surfaced as GS013).
 * - ERC-7484 registry gating is DISABLED here (zero registry, no attesters):
 *   no attestation exists yet for this Smart Sessions deployment, so any
 *   threshold > 0 reverts the install. Re-enabling it is gate #735; do not turn
 *   it on until an attestation is verified for the target chain.
 */

import {
  Contract,
  Interface,
  getAddress,
  solidityPacked,
  dataLength,
  concat,
  ZeroAddress,
} from 'ethers'
import { getChain } from './chains.js'

/**
 * Canonical, deterministic CREATE2 deployments — the same address on every
 * chain. Pinned here (not in `chains.ts`) because they are chain-independent
 * and because promoting them into the per-chain registry would force asserting
 * Gnosis addresses that Stage 2 has not yet verified (#733: Gnosis waits on its
 * own run). Verify against the Safe7579 / Rhinestone docs before overriding.
 */
export const SAFE7579_ADAPTER = getAddress('0x7579EE8307284F293B1927136486880611F20002')
/** Safe7579 launchpad — used by permissionless' Safe account derivation. */
export const ERC7579_LAUNCHPAD = getAddress('0x7579011aB74c46090561ea277Ba79D510c6C00ff')
/** Smart Sessions validator (module-sdk `SMART_SESSIONS_ADDRESS`). */
export const SMART_SESSIONS_VALIDATOR = getAddress('0x00000000008bDABA73cD9815d79069c247Eb4bDA')

const SAFE_MODULE_ABI = [
  'function enableModule(address module)',
  'function setFallbackHandler(address handler)',
]

// Deployed safe7579 v1.0.2 interface (5-array initializeAccount, 2-field
// ModuleInit). ABI pinned to the DEPLOYED artifact — the adapter repo's `main`
// has diverged (single ModuleInit[] with a moduleType field); do NOT refresh
// this without confirming what the canonical address actually runs.
const SAFE7579_ABI = [
  'function initializeAccount((address module, bytes initData)[] validators, (address module, bytes initData)[] executors, (address module, bytes initData)[] fallbacks, (address module, bytes initData)[] hooks, (address registry, address[] attesters, uint8 threshold) registryInit)',
]

const MULTI_SEND_ABI = ['function multiSend(bytes transactions) payable']

/** ERC-7579 surface the Safe exposes once the adapter is its fallback handler. */
const ERC7579_ACCOUNT_ABI = [
  'function accountId() view returns (string)',
  'function isModuleInstalled(uint256 moduleTypeId, address module, bytes additionalContext) view returns (bool)',
]

export const ERC7579_MODULE_TYPE_VALIDATOR = 1n

const safeModuleIface = new Interface(SAFE_MODULE_ABI)
const safe7579Iface = new Interface(SAFE7579_ABI)
const multiSendIface = new Interface(MULTI_SEND_ABI)

export interface InnerTx {
  to: string
  value: bigint
  data: string
  /** 0 = CALL. MultiSendCallOnly rejects delegatecalls, so this is always 0 here. */
  operation: 0
}

/** The single owner transaction that performs the migration. */
export interface ProvisionMigrationPayload {
  /** MultiSendCallOnly for the chain. */
  to: string
  value: string
  /** `multiSend(bytes)` calldata. */
  data: string
  /** 1 = delegatecall into MultiSendCallOnly; the inner calls are plain CALLs. */
  operation: 1
}

/**
 * Pack inner txs into MultiSend's byte layout:
 * operation (1) ++ to (20) ++ value (32) ++ data.length (32) ++ data.
 */
export function encodeMultiSendTransactions(txs: readonly InnerTx[]): string {
  const packed = txs.map((tx) =>
    solidityPacked(
      ['uint8', 'address', 'uint256', 'uint256', 'bytes'],
      [tx.operation, tx.to, tx.value, dataLength(tx.data), tx.data],
    ),
  )
  return concat(packed)
}

/**
 * The three inner calls of the migration batch, in dependency order: the
 * adapter must be an enabled module before initializeAccount runs. All three
 * target the Safe itself (see the 2771 note in the file header).
 */
export function buildProvisionBatch(safeAddress: string): InnerTx[] {
  const safe = getAddress(safeAddress)
  return [
    {
      to: safe,
      value: 0n,
      data: safeModuleIface.encodeFunctionData('enableModule', [SAFE7579_ADAPTER]),
      operation: 0,
    },
    {
      to: safe,
      value: 0n,
      data: safeModuleIface.encodeFunctionData('setFallbackHandler', [SAFE7579_ADAPTER]),
      operation: 0,
    },
    {
      // Routed via the Safe's fallback handler — see the 2771 note above.
      to: safe,
      value: 0n,
      data: safe7579Iface.encodeFunctionData('initializeAccount', [
        // validators: Smart Sessions installed with no initial sessions (#744 adds them)
        [{ module: SMART_SESSIONS_VALIDATOR, initData: '0x' }],
        [], // executors
        [], // fallbacks
        [], // hooks
        // registry gating disabled — see the attestation note above (#735).
        { registry: ZeroAddress, attesters: [], threshold: 0 },
      ]),
      operation: 0,
    },
  ]
}

/**
 * Assemble the single owner transaction that upgrades `safeAddress` to
 * ERC-7579 on `chainId`. The owner signs this as a Safe `execTransaction`
 * (operation 1, delegatecall into MultiSendCallOnly). Haven constructs the
 * calldata; it never signs.
 */
export function buildProvisionMigrationPayload(
  safeAddress: string,
  chainId: number,
): ProvisionMigrationPayload {
  const chain = getChain(chainId)
  const multiSendData = multiSendIface.encodeFunctionData('multiSend', [
    encodeMultiSendTransactions(buildProvisionBatch(safeAddress)),
  ])
  return {
    to: getAddress(chain.contracts.multiSendCallOnly),
    value: '0',
    data: multiSendData,
    operation: 1,
  }
}

export interface Erc7579Surface {
  accountId: string
  smartSessionsInstalled: boolean
}

/**
 * Read the post-migration ERC-7579 surface to confirm the upgrade landed and is
 * additive. `provider` is any ethers Provider (kept as a thin structural type
 * to avoid coupling this pure module to a concrete provider class).
 */
export async function readErc7579Surface(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provider: any,
  safeAddress: string,
): Promise<Erc7579Surface> {
  const account = new Contract(getAddress(safeAddress), ERC7579_ACCOUNT_ABI, provider)
  const [accountId, smartSessionsInstalled] = await Promise.all([
    account.accountId() as Promise<string>,
    account.isModuleInstalled(
      ERC7579_MODULE_TYPE_VALIDATOR,
      SMART_SESSIONS_VALIDATOR,
      '0x',
    ) as Promise<boolean>,
  ])
  return { accountId, smartSessionsInstalled }
}

// Re-exported so the migration slice (#745) and tests can decode/inspect.
export { SAFE7579_ABI, SAFE_MODULE_ABI }
