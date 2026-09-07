/**
 * Shared chain-read helpers that outlived the AllowanceModule rail.
 *
 * **The execution half is deleted (#1987, epic #1440 slice 4.)** The Safe /
 * AllowanceModule rail is retired: #1986 made every agent-payment entry point
 * fail closed with HTTP 410, and this slice removed the code those entry
 * points used to reach — `executeAllowanceTransfer`, `generateTransferHash`
 * and `recoverSigner`, together with the `executeAllowanceTransfer` ABI
 * fragment and the relayer spend-guard / send-lock / allowance-nonce wiring
 * they needed. Nothing in this module can move a token any more.
 *
 * **Why the file survives rather than going with the rail.** Three of its
 * exports are not AllowanceModule code at all — `getProvider` and
 * `getRelayerWallet` are one-line delegations to `infra/relayer.ts` (#1533,
 * one nonce view per chain) and `getTokenBalance` is a generic native/ERC-20
 * balance read. They are shared with machinery the owner decision in #834
 * keeps alive while any funding-leg rail lives: sweep, the delegate-balance
 * monitor, and the #946 EIP-3009 bridge. Deliberately NOT re-homed here: that
 * is a refactor of live shared infrastructure, not a deletion, and it does
 * not belong in a money-path deletion slice. It is residue for #1993 once the
 * remaining read consumers go with #1989/#1992.
 *
 * **No AllowanceModule contract read survives (#2259).** `getTokenAllowance`
 * and `getTokensForDelegate` were the last two, backing
 * `routes/agent-connection-setups.ts`'s legacy wallet-approval authority
 * check; that route is deleted and they went with it, along with the
 * `getContract` binding and the ABI fragment. #2020 had already deleted
 * `getLatestBlockTimeSec` and `computeEffectiveAllowance` with their own last
 * consumer (`GET /machine-payments/allowances` answers 410 on this rail).
 * What is left is exactly the three shared, rail-agnostic exports named above
 * — `getProvider`, `getRelayerWallet`, `getTokenBalance` — which is what
 * CLAUDE.md has claimed all along and what is now true. The module no longer
 * constructs the AllowanceModule contract at all, and
 * `contracts.allowanceModule` has been removed from the shared registry (#2260).
 *
 * All functions accept a chainId to select the correct RPC and contract addresses.
 */

import { ethers } from 'ethers'
import { getRelayer, getProvider as getRelayerProvider } from '../infra/relayer.js'

// ── Constants ─────────────────────────────────────────────────────

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

// ── ABI Fragments ─────────────────────────────────────────────────

// Minimal ABI for the pre-flight balance read. Pulled out of any
// IERC20 import so this module stays dependency-light.
const ERC20_BALANCE_OF_ABI = [
  'function balanceOf(address) view returns (uint256)',
]


// ── Provider / Relayer Setup — DELEGATED, deliberately (#1533) ────
//
// This module used to keep its own `Map` of providers and relayer wallets,
// parallel to `infra/relayer.ts`'s. Same key, same EOA — two provider
// instances, each with an independent view of that EOA's pending nonce.
// `withRelayerSendLock` (shared) serialises submissions, but ethers takes
// each transaction's nonce from the provider its signing wallet is bound to,
// so the wallet bound to the less-trafficked provider submitted a nonce six
// behind the chain on 2026-08-18 (`nonce too low: next nonce 781, tx nonce
// 775` — the on-chain sequence was strictly sequential, so the stale view
// was ours, not the RPC's). The exports stay because eight modules import
// them; the instances they return are now the ONLY ones per chain.

export function getProvider(chainId: number): ethers.JsonRpcProvider {
  return getRelayerProvider(chainId)
}

/** The same instance `infra/relayer.ts` signs with — one nonce view per chain. */
export function getRelayerWallet(chainId: number): ethers.Wallet {
  return getRelayer(chainId)
}

// ── Read Functions ────────────────────────────────────────────────

/**
 * Read an on-chain token balance for an arbitrary holder.
 *
 * Used by the x402 pre-flight check to decide whether the delegate EOA
 * already holds enough of the requested token to pay the merchant. Native
 * balances (`token === ZERO_ADDRESS`) are read directly from the provider;
 * ERC-20 balances use a minimal `balanceOf` ABI to avoid pulling in a heavy
 * IERC20 import for what is otherwise a single read.
 */
export async function getTokenBalance(
  chainId: number,
  holder: string,
  token: string,
): Promise<bigint> {
  const provider = getProvider(chainId)
  if (!token || token === ZERO_ADDRESS) {
    return await provider.getBalance(holder)
  }
  const contract = new ethers.Contract(token, ERC20_BALANCE_OF_ABI, provider)
  const balance: bigint = await contract.balanceOf(holder)
  return balance
}
