/**
 * Marketplace — merchant-facing pure helpers (#3079, epic #3077).
 *
 * Moved out of `CatalogPanel.tsx` (deleted by this issue) unchanged in
 * behaviour: `isVerified`, `agentInstruction` and `withinBudget` keep their
 * exact contracts, byte-identical output, so a merchant page's copy button
 * and per-agent budget hint read the same as the old catalog card's did.
 * `networkToChainId`, `chainName` and `freshness` moved alongside them
 * because every one of the new marketplace components needs at least one.
 */
import { ALL_CHAINS, getChainConfig } from '@/lib/chains'
import { getTokenDecimals, humanAmountToAtomic } from '@/lib/allowance-format'
import type { CatalogEntry } from '@/hooks/useCatalog'

/**
 * The epic trust claim, verbatim: "verified" only ever means domain
 * controlled AND verified payable — never merchant honesty, quality or
 * settlement reliability. The badge appears exactly when the row is a
 * self-submitted ingestion entry that passed both proofs.
 */
export function isVerified(entry: Pick<CatalogEntry, 'source'>): boolean {
  return entry.source === 'ingestion'
}

/**
 * Resolve a catalog entry's `network` to a chain id. The field is heterogeneous
 * — it arrives as a CAIP-2 id (`eip155:8453`) or a chain short-name (`base`,
 * `base-sepolia`, `gnosis`) — so handle both. Returns `undefined` for unknown /
 * null networks (those only ever show under "All networks").
 */
export function networkToChainId(network: string | null | undefined): number | undefined {
  if (!network) return undefined
  const caip = /^eip155:(\d+)$/.exec(network)
  if (caip) return Number(caip[1])
  return ALL_CHAINS.find((c) => c.shortName === network)?.chainId
}

export function chainName(chainId: number): string {
  try {
    return getChainConfig(chainId).name
  } catch {
    return `Chain ${chainId}`
  }
}

/**
 * The ready-to-paste instruction for an offer, phrased so the MCP tool set
 * routes it without extra prompting (mirrors the epic's acceptance phrasing:
 * "pay <url> via <tool> for ...").
 */
export function agentInstruction(entry: CatalogEntry): string {
  if (entry.protocol === 'mcp' && entry.tool_name) {
    return `Pay ${entry.resource_url} via ${entry.tool_name} for <what you want>`
  }
  if (entry.rail === 'mpp') {
    return `Pay the machine-payment resource at ${entry.resource_url} and return the result`
  }
  return `Pay ${entry.resource_url} and return the result`
}

/**
 * Budget check against configured agent allowances: an entry is "within
 * budget" when at least one active agent has an allowance for the entry's
 * asset that covers the price.
 *
 * ── The units, stated because getting them wrong was silent (#2295) ──────────
 *
 * `entry.price_atomic` is atomic. `allowance_amount` on `Agent.allowances` is
 * NOT — it is the human-decimal delegation projection (`"25.00"` for a 25 USDC
 * budget). The comparison is done in atomic units, with the human budget
 * scaled up by the token's decimals rather than the price scaled down — no
 * rounding. `null` means "cannot answer" (no price, no matching allowance,
 * unresolvable decimals, unparseable budget), never "over budget": this badge
 * is advisory, and the on-chain caveat enforcer is what actually refuses.
 */
export function withinBudget(
  entry: CatalogEntry,
  agents: Array<{ status: string; allowances: Array<{ token_symbol: string; allowance_amount: string }> }>,
): boolean | null {
  if (!entry.price_atomic || !entry.asset) return null
  const candidates = agents
    .filter((a) => a.status === 'active')
    .flatMap((a) => a.allowances)
    .filter((al) => al.token_symbol === entry.asset)
  if (candidates.length === 0) return null

  const chainId = networkToChainId(entry.network)
  const decimals = chainId != null ? getTokenDecimals(chainId, entry.asset) : undefined
  // Without decimals the two units cannot be reconciled, and guessing 18 for
  // a 6-decimal stablecoin would answer "within budget" by a factor of 10^12.
  if (decimals == null) return null

  let price: bigint
  try {
    price = BigInt(entry.price_atomic)
  } catch {
    // `price_atomic` is the merchant's own advertised value, so a malformed
    // one is a real possibility rather than a shape confusion.
    return null
  }
  const budgets = candidates.map((al) => humanAmountToAtomic(al.allowance_amount, decimals))
  if (budgets.some((budget) => budget != null && budget >= price)) return true
  // A budget we could not parse is not a budget we know to be too small.
  // Reporting `false` there would paint "over budget" on an agent that may
  // well cover the price — the misleading direction. Only a set of budgets we
  // fully understood, none of which covers the price, is an honest `false`.
  return budgets.every((budget) => budget != null) ? false : null
}

export function freshness(verifiedAt: string | null): string {
  if (!verifiedAt) return 'not yet verified'
  const ageMs = Date.now() - new Date(verifiedAt).getTime()
  const hours = Math.floor(ageMs / 3_600_000)
  if (hours < 1) return 'verified just now'
  if (hours < 24) return `verified ${hours}h ago`
  return `verified ${Math.floor(hours / 24)}d ago`
}

/**
 * True when an offer's advertised transfer methods do not include erc7710 —
 * the paying agent needs an open (unpinned) budget for the EIP-3009 bridge
 * (`CLAUDE.md` "x402" section). Null/empty is treated as "no erc7710 seen",
 * the same reading `catalog.ts` gives an unprobed row.
 */
export function needsUnpinnedBudget(assetTransferMethods: string | null): boolean {
  if (!assetTransferMethods) return true
  return !assetTransferMethods
    .split(',')
    .map((m) => m.trim())
    .includes('erc7710')
}

/**
 * Initials for a merchant with no logo — two letters from the first two
 * words of its name, or the first two letters of a one-word name. Same shape
 * as the `Initials` avatar on `/contacts`, the one other place Haven renders
 * a named-entity monogram.
 */
export function merchantInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const initials =
    parts.length >= 2 ? `${parts[0]![0]}${parts[parts.length - 1]![0]}` : (parts[0] ?? '?').slice(0, 2)
  return initials.toUpperCase()
}
