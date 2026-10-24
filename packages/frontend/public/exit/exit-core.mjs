// Haven independent exit tool — the page's logic, kept out of index.html so it
// can be tested (#4390). Same rules as the page: no Haven server, only a public
// RPC (or one you choose) and the pinned MetaMask DelegationManager.
//
// ethers is vendored next to this file (vendor/ethers-6.16.0.min.js, the npm
// build byte for byte) so the page loads no third-party script.
import { TypedDataEncoder } from './vendor/ethers-6.16.0.min.js'

// Pinned, audited contracts. They must match Haven's
// packages/backend/src/rails/delegation-contracts.ts (a test checks this).
// A different address here would be a red flag — verify against Haven's docs.
export const CHAINS = {
  8453: {
    name: 'Base',
    manager: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3',
    rpc: 'https://mainnet.base.org',
    explorer: 'https://basescan.org',
    // First block with the manager's code (eth_getCode, 2026-10-24). No
    // RedeemedDelegation event can be older, so a scan never needs to start
    // earlier.
    deployBlock: 28207787,
  },
  84532: {
    name: 'Base Sepolia',
    manager: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3',
    rpc: 'https://sepolia.base.org',
    explorer: 'https://sepolia.basescan.org',
    deployBlock: 23680354,
  },
}
export const DEFAULT_CHAIN_ID = 8453

const DELEGATION_TUPLE =
  'tuple(address delegate, address delegator, bytes32 authority, tuple(address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature)'
export const MANAGER_ABI = [
  `function disableDelegation(${DELEGATION_TUPLE} _delegation)`,
  'function disabledDelegations(bytes32 delegationHash) view returns (bool)',
  `event RedeemedDelegation(address indexed rootDelegator, address indexed redeemer, ${DELEGATION_TUPLE} delegation)`,
]

// The DelegationManager's EIP-712 struct. `disabledDelegations` is keyed by
// the struct hash of exactly these fields: `args` and `signature` are not part
// of it. This is the hash `hashDelegation` from @metamask/smart-accounts-kit
// computes, which Haven's backend uses (a test checks they agree).
const DELEGATION_TYPES = {
  Delegation: [
    { name: 'delegate', type: 'address' },
    { name: 'delegator', type: 'address' },
    { name: 'authority', type: 'bytes32' },
    { name: 'caveats', type: 'Caveat[]' },
    { name: 'salt', type: 'uint256' },
  ],
  Caveat: [
    { name: 'enforcer', type: 'address' },
    { name: 'terms', type: 'bytes' },
  ],
}

/** The delegation's identity on the DelegationManager (its struct hash). */
export function delegationHash(del) {
  return TypedDataEncoder.hashStruct('Delegation', DELEGATION_TYPES, {
    delegate: del.delegate,
    delegator: del.delegator,
    authority: del.authority,
    caveats: del.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms })),
    salt: BigInt(del.salt),
  })
}

/**
 * Read a delegation's status from the manager: 'active' (still spendable,
 * within its caveats), 'revoked', or 'unknown' when the read failed. Never a
 * guess: anything other than a boolean answer is 'unknown'.
 */
export async function readStatus(manager, hash) {
  try {
    const disabled = await manager.disabledDelegations(hash)
    if (disabled === true) return 'revoked'
    if (disabled === false) return 'active'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Normalise a delegation from an event or a pasted object into plain JSON. */
export function toPlainDelegation(d) {
  return {
    delegate: d.delegate,
    delegator: d.delegator,
    authority: d.authority,
    caveats: d.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: c.args ?? '0x' })),
    salt: d.salt.toString(),
    signature: d.signature ?? '0x',
  }
}

// Providers cap eth_getLogs ranges and say so in the error ("eth_getLogs is
// limited to a 200 range", "maximum block range: 50000", "up to a 10,000
// block range"). The same wording Haven's backend reads (infra/chain/log-range-limit.ts).
const RANGE_PATTERNS = [
  /limited to an? ([\d,]+)\s*(k)?\s*(?:block)?\s*range/i,
  /up to an? ([\d,]+)\s*(k)?\s*block range/i,
  /maximum block range(?: is| of|:)?\s*([\d,]+)\s*(k)?/i,
  /block range limit\s*[(:]?\s*([\d,]+)\s*(k)?/i,
]

/** The block range a provider's error names, or null. */
export function rangeLimitFromError(err) {
  const text = String(err?.error?.message ?? err?.info?.error?.message ?? err?.message ?? err ?? '')
  for (const re of RANGE_PATTERNS) {
    const m = text.match(re)
    if (m) {
      const n = Number(m[1].replace(/,/g, '')) * (m[2] ? 1000 : 1)
      if (Number.isFinite(n) && n > 0) return n
    }
  }
  return null
}

/**
 * Scan [fromBlock, toBlock] in chunks with `queryRange(from, to)`, narrowing
 * the chunk when the provider names a smaller limit. Stops (and says so)
 * instead of sending more than `maxRequests` queries: a public endpoint that
 * allows 200 blocks per query cannot scan a chain's history from a browser.
 *
 * Returns { events, complete, scannedTo, requests, chunk, reason }.
 */
export async function scanEvents({ queryRange, fromBlock, toBlock, chunk = 50_000, maxRequests = 300 }) {
  const events = []
  let cursor = fromBlock
  let requests = 0
  let size = chunk
  while (cursor <= toBlock) {
    if (requests >= maxRequests) {
      return { events, complete: false, scannedTo: cursor - 1, requests, chunk: size, reason: 'request-cap' }
    }
    const end = Math.min(cursor + size - 1, toBlock)
    requests++
    try {
      events.push(...(await queryRange(cursor, end)))
      cursor = end + 1
    } catch (err) {
      const limit = rangeLimitFromError(err)
      if (limit !== null && limit < size) {
        size = limit
        continue
      }
      return { events, complete: false, scannedTo: cursor - 1, requests, chunk: size, reason: 'error', error: String(err?.message ?? err) }
    }
  }
  return { events, complete: true, scannedTo: toBlock, requests, chunk: size, reason: null }
}

/** ABI-encode the disableDelegation call for the owner's UserOp (`account.execute`). */
export function disableDelegationCalldata(iface, del) {
  return iface.encodeFunctionData('disableDelegation', [{
    delegate: del.delegate,
    delegator: del.delegator,
    authority: del.authority,
    caveats: del.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: c.args ?? '0x' })),
    salt: BigInt(del.salt),
    signature: del.signature ?? '0x',
  }])
}

