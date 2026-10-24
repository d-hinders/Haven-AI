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

/**
 * Refuse an RPC that serves another chain. Both chains use the same manager
 * address, so a Base Sepolia RPC with Base selected would answer every read —
 * from the wrong chain. ethers' `staticNetwork` never asks, so ask directly.
 */
export async function assertChain(provider, expectedId) {
  let answer
  try {
    answer = await provider.send('eth_chainId', [])
  } catch (err) {
    throw new Error(`Could not read this RPC's chain id (${err?.message ?? err}); nothing was checked.`)
  }
  const actual = Number(BigInt(answer))
  if (actual !== expectedId) {
    const name = CHAINS[actual]?.name ?? 'another chain'
    throw new Error(
      `This RPC serves chain ${actual} (${name}), not ${CHAINS[expectedId].name} (${expectedId}). Nothing was checked: choose the matching network or RPC.`,
    )
  }
}

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

/** What the owner sees for each status: pill label, pill class, note. */
export const STATUS_VIEW = {
  active: {
    label: 'Not revoked',
    cls: 'active',
    note: 'Still has authority: it can be redeemed within its caveats (budget, recipient, expiry).',
  },
  revoked: {
    label: 'Revoked',
    cls: 'revoked',
    note: 'disabledDelegations(hash) is true: any further redemption reverts. Only the delegator account can undo this (enableDelegation).',
  },
  unknown: {
    label: 'Status unknown',
    cls: 'unknown',
    note: 'The status read failed. Check disabledDelegations(hash) on the explorer.',
  },
}

/** The view for a status; anything unrecognised is shown as unknown. */
export function statusView(status) {
  return Object.hasOwn(STATUS_VIEW, status) ? STATUS_VIEW[status] : STATUS_VIEW.unknown
}

export const ROOT_AUTHORITY = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

/**
 * 'root' for a budget the account itself issued (it can revoke it), 'child'
 * for one issued under a budget by another account — the agent's settlement,
 * task and sub-budget delegations. The manager emits RedeemedDelegation for
 * every link of a chain with the root's delegator, so a scan by account finds
 * both. A child is revoked by revoking its root budget: redemption checks every
 * link, and only a child's own delegator can disable it.
 */
export function delegationKind(del, account) {
  if (/^0x[0-9a-fA-F]{40}$/.test(account ?? '')) {
    return del.delegator.toLowerCase() === account.toLowerCase() ? 'root' : 'child'
  }
  return del.authority.toLowerCase() === ROOT_AUTHORITY ? 'root' : 'child'
}

/** Normalise a delegation from an event or a pasted object into plain JSON. */
export function toPlainDelegation(d) {
  // Events give a bigint; a pasted salt must be a string. A JSON number above
  // 2^53 has already lost precision, and with it the hash.
  if (typeof d.salt !== 'string' && typeof d.salt !== 'bigint') {
    throw new Error('salt must be a string (Haven salts are 0x-hex)')
  }
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
 * Scan [fromBlock, toBlock] newest first, in chunks, with `queryRange(from, to)`,
 * narrowing the chunk when the provider names a smaller limit. Stops (and says
 * so) instead of sending more than `maxRequests` queries: a public endpoint
 * that allows 200 blocks per query cannot scan a chain's history from a
 * browser, so the cap is spent on the most recent blocks, where live budgets
 * are redeemed.
 *
 * Returns { events, complete, scannedFrom, requests, chunk, reason }: blocks
 * scannedFrom..toBlock were covered (scannedFrom = toBlock + 1 when none were).
 */
export async function scanEvents({ queryRange, fromBlock, toBlock, chunk = 50_000, maxRequests = 300 }) {
  const events = []
  let cursor = toBlock
  let requests = 0
  let size = chunk
  while (cursor >= fromBlock) {
    if (requests >= maxRequests) {
      return { events, complete: false, scannedFrom: cursor + 1, requests, chunk: size, reason: 'request-cap' }
    }
    const start = Math.max(cursor - size + 1, fromBlock)
    requests++
    try {
      events.push(...(await queryRange(start, cursor)))
      cursor = start - 1
    } catch (err) {
      const limit = rangeLimitFromError(err)
      if (limit !== null && limit < size) {
        size = limit
        continue
      }
      return { events, complete: false, scannedFrom: cursor + 1, requests, chunk: size, reason: 'error', error: String(err?.message ?? err) }
    }
  }
  return { events, complete: true, scannedFrom: fromBlock, requests, chunk: size, reason: null }
}

/** Root budgets first (the ones the account can revoke), then children. */
export function rootFirst(dels, account) {
  return [...dels].sort((a, b) => (delegationKind(a, account) === 'root' ? 0 : 1) - (delegationKind(b, account) === 'root' ? 0 : 1))
}

export const CHILD_NOTE =
  'Issued by your agent under one of your budgets — revoke that budget. A child stops working once the budget it was issued under is revoked; only its own delegator (your agent) could disable it directly.'

/**
 * One delegation row. Every delegation field goes in as text, never as HTML:
 * a pasted object or an RPC answer is untrusted.
 */
export function delegationRow(doc, del, { hash, kind }) {
  const row = doc.createElement('div')
  row.className = 'del'
  row.dataset.kind = kind
  const top = doc.createElement('div')
  top.className = 'row'
  top.style.justifyContent = 'space-between'
  const who = doc.createElement('div')
  who.className = 'mono'
  who.dataset.delegate = ''
  who.textContent = `delegate ${del.delegate}`
  const pill = doc.createElement('span')
  pill.className = 'pill'
  pill.dataset.pill = ''
  pill.textContent = 'checking…'
  top.append(who, pill)
  const line = (key, text) => {
    const el = doc.createElement('div')
    el.className = 'muted mono'
    el.dataset[key] = ''
    el.textContent = text
    return el
  }
  const note = doc.createElement('div')
  note.className = 'muted'
  note.dataset.note = ''
  row.append(
    top,
    line('delegator', `delegator ${del.delegator}${kind === 'child' ? ' (not your account)' : ''}`),
    line('hash', `hash ${hash}`),
    line('salt', `salt ${del.salt} · ${del.caveats.length} caveat(s)`),
    note,
  )
  if (kind === 'child') {
    const child = doc.createElement('div')
    child.className = 'muted'
    child.dataset.child = ''
    child.textContent = CHILD_NOTE
    row.append(child)
  } else {
    const actions = doc.createElement('div')
    actions.className = 'row'
    actions.style.marginTop = '8px'
    const button = doc.createElement('button')
    button.className = 'ghost'
    button.dataset.revoke = ''
    button.textContent = 'Revocation details'
    const st = doc.createElement('span')
    st.className = 'muted'
    st.dataset.st = ''
    actions.append(button, st)
    row.append(actions)
  }
  return row
}

/** Show a status on a row: the pill and note come from statusView alone. */
export function applyStatus(row, status) {
  const view = statusView(status)
  const pill = row.querySelector('[data-pill]')
  pill.textContent = view.label
  pill.className = `pill ${view.cls}`
  row.querySelector('[data-note]').textContent = view.note
}

/**
 * Hash a delegation, read its status from the manager and render it into
 * `container`. Revocation details are offered only for a root budget: for a
 * child, disableDelegation from the owner's account reverts.
 */
export async function showDelegation(container, del, { manager, account, onDetails }) {
  const hash = delegationHash(del)
  const kind = delegationKind(del, account)
  const row = delegationRow(container.ownerDocument, del, { hash, kind })
  container.appendChild(row)
  applyStatus(row, await readStatus(manager, hash))
  const button = row.querySelector('[data-revoke]')
  if (button) button.onclick = () => onDetails(del, hash, row.querySelector('[data-st]'))
  return row
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

