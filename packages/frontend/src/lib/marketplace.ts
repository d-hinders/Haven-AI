/**
 * Marketplace — merchant-facing pure helpers (#3079, epic #3077).
 *
 * Moved out of `CatalogPanel.tsx` (deleted by that issue): `agentInstruction`
 * kept its exact contract, byte-identical output, so a merchant page's copy
 * button reads the same as the old catalog card's did. The old cap-only
 * budget check lived here too, until #4004 replaced it: a cap-only yes could
 * be a lie (it ignored what is LEFT, WHICH agent, recipient pins and
 * chains), so the hint is now `agentsThatCanPay`, a named, truthful
 * per-offer answer that mirrors how a payment picks its budget.
 * `networkToChainId`, `chainName` and `freshness` moved alongside because
 * every one of the new marketplace components needs at least one.
 *
 * NOT moved: the old card's `isVerified` (`source === 'ingestion'`). The
 * Verified marker now follows `verified_payable` — the epic's trust claim is
 * "domain controlled AND verified payable", and since #3078 the wire carries
 * that proof per entry and per merchant, so the badge reads the proof rather
 * than the row's provenance (an ingestion row is verified payable the moment
 * it is marked; an operator row can be too). Stated in PR #3087.
 */
import { getFaucetUrl, isRegisteredChain } from '@haven_ai/core'
import { ALL_CHAINS, getChainTokens, resolveChainOrNull } from '@/lib/chains'
import { getTokenDecimals } from '@/lib/allowance-format'
import type { CatalogEntry, Merchant, MerchantFundingTarget } from '@/hooks/useCatalog'
import type { Agent } from '@/hooks/useAgents'
import type { MerchantBudget } from '@/hooks/useMerchantBudgets'
import type { DashboardBudgetRemainingEntry } from '@/hooks/useBudgetRemaining'

/**
 * Resolve a catalog entry's `network` to a chain id. The field is heterogeneous
 * — it arrives as a CAIP-2 id (`eip155:8453`) or a chain short-name (`base`,
 * `base-sepolia`, and `gnosis` for history-only chain 100) — so handle both. Returns `undefined` for unknown /
 * null networks (those only ever show under "All networks").
 */
export function networkToChainId(network: string | null | undefined): number | undefined {
  if (!network) return undefined
  const caip = /^eip155:(\d+)$/.exec(network)
  if (caip) return Number(caip[1])
  return ALL_CHAINS.find((c) => c.shortName === network)?.chainId
}

/**
 * The per-offer tag for the mixed-merchant case, in place of "unpinned
 * budget" (#3981). #4005: the old offer-level NOTE paragraph above the table
 * is gone — the "How to buy" panel's step 2 carries that requirement in
 * plain words, next to the state that makes it matter. No "EIP-3009" and no
 * "unpinned" reaches the page.
 */
export const ANY_RECIPIENT_BUDGET_TAG = 'any-recipient budget'

/**
 * The Verified badge's meaning, spelled out where the badge is (epic #3077's
 * trust claim): Haven checked domain control and a confirmed payable
 * endpoint — never merchant honesty, quality or settlement reliability.
 * #4003: the sentence names the merchant, so the meaning is a function of
 * the merchant's name, not a constant.
 */
export function verifiedMeaning(merchantName: string): string {
  return `Verified: Haven checked that ${merchantName} controls this website and that its offers accept payment. It doesn't vouch for quality.`
}

/** Display label for a merchant category: acronyms stay acronyms (api → API, not "Api"). */
export function categoryLabel(category: string): string {
  const acronyms: Record<string, string> = { api: 'API', ai: 'AI', mcp: 'MCP', vpn: 'VPN' }
  const lower = category.toLowerCase()
  if (acronyms[lower]) return acronyms[lower]
  return category.charAt(0).toUpperCase() + category.slice(1)
}

export function chainName(chainId: number): string {
  return resolveChainOrNull(chainId)?.name ?? `Chain ${chainId}`
}

/**
 * A testnet is a registered chain with a faucet — `faucetUrl` is core's
 * testnet-only field (#2534), the same predicate the backend's marketplace
 * scope uses for the prospects gate. An unregistered id is NOT a testnet
 * (fail closed: the test-merchant toggle stays off for a chain we do not know).
 */
export function isTestnetChain(chainId: number): boolean {
  return isRegisteredChain(chainId) && getFaucetUrl(chainId) !== undefined
}

/**
 * Whether any listed merchant serves a testnet — the "Show test merchants"
 * default (epic #3077 decision 10). Read off the served data: the backend
 * already scopes `GET /merchants` to the deployment's listed chains
 * (#3078), so a merchant's `networks` ARE the listed chains projected onto
 * merchants, and a staging env on any other testnet follows its chains.
 */
export function listsTestnet(merchants: ReadonlyArray<Pick<Merchant, 'networks'>>): boolean {
  return merchants.some((m) =>
    m.networks.some((n) => {
      const id = networkToChainId(n)
      return id !== undefined && isTestnetChain(id)
    }),
  )
}

/**
 * Whether an offer's instruction carries a placeholder the user must replace
 * before an agent can act on it — exactly the branch of `agentInstruction`
 * that writes `<what you want>` (#3998). The merchant page keeps such an
 * instruction printed in the row; every other instruction is copy-only.
 */
export function instructionNeedsEdit(entry: CatalogEntry): boolean {
  return entry.protocol === 'mcp' && Boolean(entry.tool_name)
}

/**
 * The ready-to-paste instruction for an offer, phrased so the MCP tool set
 * routes it without extra prompting (mirrors the epic's acceptance phrasing:
 * "pay <url> via <tool> for ...").
 */
export function agentInstruction(entry: CatalogEntry): string {
  if (instructionNeedsEdit(entry) && entry.tool_name) {
    return `Pay ${entry.resource_url} via ${entry.tool_name} for <what you want>`
  }
  if (entry.rail === 'mpp') {
    return `Pay the machine-payment resource at ${entry.resource_url} and return the result`
  }
  return `Pay ${entry.resource_url} and return the result`
}

// ── The per-offer budget answer (#4004) ─────────────────────────────────────
//
// ── The units, stated because getting them wrong was silent (#2295) ──────────
//
// `offer.price_atomic` is atomic. The remaining figures on both budget wires
// (`remaining_atomic` on `GET /dashboard/budget-remaining` and on
// `GET /merchants/{slug}/budgets`) are atomic too, so the comparison is a
// plain bigint one. `allowance_amount` on `Agent.allowances` is NOT — it is
// the human-decimal delegation projection — and is read here ONLY for the
// period word (its `reset_period_min`), never for a comparison; #4003's copy
// pass owns the wording around it.

/**
 * The spec-derived agent shape the budget answer reads — narrower than
 * `Agent`, and a replacement for `OffersTable`'s old hand-written
 * `{ status, allowances }` pair (#4004): the answer needs the agent's NAME
 * (the row names who can pay), its account CHAIN (an agent on another chain
 * cannot pay the offer), its liveness, the reset period of its budgets in
 * the offer's token (the period word) and whether it pays from a RECEIVED
 * sub-budget (`receivedSubBudgets[].open`, #3988 — a power this helper does
 * not model, so such an agent is never reported unable).
 */
export type BudgetAgent = Pick<
  Agent,
  'id' | 'name' | 'status' | 'account_chain_id' | 'allowances' | 'receivedSubBudgets'
>

export interface AgentsThatCanPayInput {
  offer: CatalogEntry
  agents: ReadonlyArray<BudgetAgent>
  /** `GET /dashboard/budget-remaining` (`useBudgetRemaining`). */
  budgets: ReadonlyArray<DashboardBudgetRemainingEntry>
  /** `GET /merchants/{slug}/budgets` (`useMerchantBudgets`, already on the page). */
  merchantBudgets: ReadonlyArray<MerchantBudget>
  /** The merchant's funding targets (`useMerchant`) — where a pinned budget may pay. */
  funding: ReadonlyArray<MerchantFundingTarget>
  /** Required for tests; defaults to now. */
  nowMs?: number
}

/** One agent's per-offer verdict. `unknown` is silent, never "can't pay" (#2295). */
export interface BudgetAgentAnswer {
  agentId: string
  agentName: string
  answer: 'can' | 'cannot' | 'unknown'
  /**
   * WHY a 'cannot' — the row names the agent only when the reason is about
   * the offer's token ('insufficient' / 'no-budget': the price is genuinely
   * more than what the agent has left in that token). A 'wrong-chain' or
   * 'inactive' no is not about any balance, so naming it as "more than
   * {agent} has left" would state a fact nobody measured — those render as
   * "No agent can pay this yet" (once every agent is a known no) or nothing.
   */
  reason: 'insufficient' | 'no-budget' | 'wrong-chain' | 'inactive' | null
  /**
   * The period word for a 'cannot' — "today", "this week" — from the
   * selected budget's period (the merchant-budgets wire) or the agent's
   * allowance projection in the offer's token. Null when neither carries it.
   */
  periodPhrase: string | null
  /**
   * The budget the payment would SELECT, with the figures the "How to buy"
   * panel's done line names (#4005) — remaining, cap, token and period word.
   * Populated whenever a live budget was selected AND its remaining was a
   * parseable, from-chain read — i.e. on every 'can' and on an
   * 'insufficient' no; null otherwise. Optional so #4004 call sites that
   * ignore it are untouched.
   */
  selected?: SelectedBudget | null
}

/**
 * The budget that would pay one offer, in display terms: what is LEFT, the
 * cap it is left OF, the token, the period word, and whether it is open
 * (`recipientAddress: null` — payable to anyone) or locked to one payee.
 */
export interface SelectedBudget {
  recipientAddress: string | null
  remainingAtomic: string
  budgetAtomic: string | null
  tokenSymbol: string
  tokenDecimals: number
  periodPhrase: string | null
}

/**
 * The period words the row speaks: the budget's own period, not a
 * re-derivation. `budgetPeriodWords` ("per week") is the meter's adverbial
 * form; the row needs the left-over form. Unknown periods render without a
 * phrase rather than guessing one.
 */
const PERIOD_PHRASES: Record<number, string> = {
  0: 'in total',
  3_600: 'this hour',
  86_400: 'today',
  604_800: 'this week',
  2_592_000: 'this month',
}

export function budgetPeriodPhrase(periodSeconds: number | null | undefined): string | null {
  if (periodSeconds == null) return null
  return PERIOD_PHRASES[periodSeconds] ?? null
}

interface BudgetReading {
  delegationHash: string
  recipientAddress: string | null
  remainingAtomic: string | null
  /** The budget's cap from the same wire row — the "of $1.00" half of the panel's done line (#4005). */
  budgetAtomic: string | null
  fromChain: boolean
  /** Unix seconds — a future-dated row is the dormant half of a re-key (#3802). */
  startSec: number | null
  periodSeconds: number | null
}

/**
 * Per agent and offer, the verdict for the budget a payment would SELECT:
 * a budget locked to the offer's verified pay-to always wins over the open
 * one, whatever is left on it (`SELECT_DELEGATION_FOR_PAYMENT_SQL`'s
 * `ORDER BY (recipient_address IS NULL)`); for a bridge-only offer —
 * `needsUnpinnedBudget` — only the open budget is eligible (the EIP-3009
 * bridge path). The #3802 future-dated re-key row is skipped here, not at
 * the route: the wire still carries it on purpose.
 *
 * Unknown is silent, never "can't pay": an unreadable remaining
 * (`remaining_atomic` null, or either wire's from-chain flag false), missing
 * decimals, or an agent that pays from a received sub-budget all answer
 * 'unknown' — the #2295 misleading-direction rule.
 *
 * The slot invariant (#3933 — one live budget per (agent, token, recipient)
 * slot) means at most one locked and one open row exist per token, so
 * "the" locked / open budget is a lookup, not a reduction.
 */
export function agentsThatCanPay(input: AgentsThatCanPayInput): BudgetAgentAnswer[] {
  const { offer, agents, budgets, merchantBudgets, funding, nowMs = Date.now() } = input
  if (!offer.price_atomic || !offer.asset) {
    // No price to check against — nobody's answer is known.
    return agents.map((agent) => ({
      agentId: agent.id,
      agentName: agent.name,
      answer: 'unknown',
      reason: null,
      periodPhrase: null,
    }))
  }
  const chainId = networkToChainId(offer.network)
  const decimals = chainId != null ? getTokenDecimals(chainId, offer.asset) : undefined
  let price: bigint | null = null
  try {
    price = BigInt(offer.price_atomic)
  } catch {
    // `price_atomic` is the merchant's own advertised value, so a malformed
    // one is a real possibility rather than a shape confusion.
    price = null
  }
  const isErc7710 = !needsUnpinnedBudget(offer.asset_transfer_methods)
  const payTo =
    isErc7710 && chainId != null
      ? (funding.find((f) => f.chain_id === chainId && f.pay_to_status === 'verified' && f.erc7710)?.pay_to ?? null)?.toLowerCase() ?? null
      : null
  // The merchant-budgets wire names tokens by ADDRESS; the offer names its
  // asset by SYMBOL. Resolve once — an unregistered symbol simply matches
  // nothing on that wire (the budget-remaining wire carries the symbol).
  const tokenAddress = chainId != null ? (getChainTokens(chainId)[offer.asset]?.address ?? null) : null

  return agents.map((agent) => {
    const base = { agentId: agent.id, agentName: agent.name }

    // 1. Liveness and network. A paused or revoked agent cannot pay — a known
    //    no (the payment path refuses before any budget is read). An agent
    //    whose account chain we do not know is unknown, not unable.
    if (agent.status !== 'active') {
      return { ...base, answer: 'cannot' as const, reason: 'inactive' as const, periodPhrase: null }
    }
    if (chainId == null) return { ...base, answer: 'unknown' as const, reason: null, periodPhrase: null }
    if (agent.account_chain_id == null) {
      return { ...base, answer: 'unknown' as const, reason: null, periodPhrase: null }
    }
    if (agent.account_chain_id !== chainId) {
      return { ...base, answer: 'cannot' as const, reason: 'wrong-chain' as const, periodPhrase: null }
    }
    if (decimals == null || price == null) {
      return { ...base, answer: 'unknown' as const, reason: null, periodPhrase: null }
    }

    // 2. The budgets in the offer's token, from both wires, deduped by
    //    delegation hash (a merchant-locked budget rides both).
    const readings: BudgetReading[] = []
    const seen = new Map<string, BudgetReading>()
    for (const row of budgets) {
      if (row.agent_id !== agent.id || row.token_symbol !== offer.asset) continue
      const reading: BudgetReading = {
        delegationHash: row.delegation_hash,
        recipientAddress: row.recipient_address ?? null,
        remainingAtomic: row.remaining_atomic,
        budgetAtomic: row.budget_atomic,
        fromChain: row.remaining_from_chain,
        startSec: row.start_date ? Date.parse(row.start_date) / 1000 : null,
        periodSeconds: null,
      }
      readings.push(reading)
      if (reading.delegationHash) seen.set(reading.delegationHash, reading)
    }
    for (const row of merchantBudgets) {
      if (row.agent_id !== agent.id) continue
      if (!tokenAddress || row.token_address.toLowerCase() !== tokenAddress.toLowerCase()) continue
      const dup = seen.get(row.delegation_hash)
      if (dup) {
        dup.fromChain = dup.fromChain || row.remaining_is_from_chain
        if (row.remaining_is_from_chain) dup.remainingAtomic = row.remaining_atomic
        if (dup.periodSeconds == null) dup.periodSeconds = row.period_seconds
        continue
      }
      const reading: BudgetReading = {
        delegationHash: row.delegation_hash,
        recipientAddress: row.recipient_address,
        remainingAtomic: row.remaining_atomic,
        budgetAtomic: row.budget_atomic,
        fromChain: row.remaining_is_from_chain,
        startSec: null,
        periodSeconds: row.period_seconds,
      }
      readings.push(reading)
      if (reading.delegationHash) seen.set(reading.delegationHash, reading)
    }

    // 3. The budget the payment would select. The #3802 future-dated row is
    //    skipped here — it is the dormant half of a re-key, not spendable.
    const nowSec = nowMs / 1000
    const live = readings.filter((r) => r.startSec == null || r.startSec <= nowSec)
    const locked = payTo ? live.find((r) => r.recipientAddress?.toLowerCase() === payTo) : undefined
    const selected = locked ?? live.find((r) => r.recipientAddress == null)

    // 4. A received sub-budget (#3988) is spending power this helper does not
    //    model — so a budget-level no would be the misleading direction.
    const holdsOpenSubBudget = agent.receivedSubBudgets?.some((s) => s.open) ?? false

    if (selected == null) {
      // No budget in the token the payment would select — the payment would
      // be declined. Unless the agent pays from a received sub-budget, which
      // would make this a guess; then it is unknown.
      return {
        ...base,
        answer: holdsOpenSubBudget ? ('unknown' as const) : ('cannot' as const),
        reason: holdsOpenSubBudget ? null : ('no-budget' as const),
        periodPhrase: null,
      }
    }
    if (!selected.fromChain || selected.remainingAtomic == null) {
      return { ...base, answer: 'unknown' as const, reason: null, periodPhrase: null }
    }
    let remaining: bigint
    try {
      remaining = BigInt(selected.remainingAtomic)
    } catch {
      // A figure we cannot parse is not a figure we know to be too small.
      return { ...base, answer: 'unknown' as const, reason: null, periodPhrase: null }
    }
    // The period word: the selected budget's own period when the
    // merchant-budgets wire carries it, else the agent's allowance projection
    // in the offer's token (#4004's rule, now shared with the panel).
    const allowancePeriodSeconds =
      agent.allowances.find((al) => al.token_symbol === offer.asset)?.reset_period_min
    const periodSeconds = selected.periodSeconds ?? (allowancePeriodSeconds != null ? allowancePeriodSeconds * 60 : null)
    const periodPhrase = budgetPeriodPhrase(periodSeconds ?? null)
    if (remaining >= price) {
      return {
        ...base,
        answer: 'can' as const,
        reason: null,
        periodPhrase: null,
        selected: selectedInfo(),
      }
    }
    if (holdsOpenSubBudget) {
      return { ...base, answer: 'unknown' as const, reason: null, periodPhrase: null }
    }
    return {
      ...base,
      answer: 'cannot' as const,
      reason: 'insufficient' as const,
      periodPhrase,
      selected: selectedInfo(),
    }

    function selectedInfo(): SelectedBudget | null {
      if (!selected!.fromChain || selected!.remainingAtomic == null || decimals == null || !offer.asset) return null
      return {
        recipientAddress: selected!.recipientAddress,
        remainingAtomic: selected!.remainingAtomic,
        budgetAtomic: selected!.budgetAtomic,
        tokenSymbol: offer.asset,
        tokenDecimals: decimals!,
        periodPhrase,
      }
    }
  })
}

/**
 * The row's one line, from the agents' answers:
 *  - any 'can' → "{Name} can pay this" / "{Name} and {n} other agents can pay this";
 *  - exactly one known no, and it is about the offer's token ('insufficient'
 *    or 'no-budget') → "More than {Name} has left {period word}";
 *  - every agent a known no → "No agent can pay this yet" (naming each would
 *    be a sentence no one reads);
 *  - anything else → null: the hint is absent, not a warning (#2295). A
 *    wrong-chain or inactive no beside an unknown agent supports neither
 *    line, so it renders nothing rather than a claim nobody measured.
 */
export function budgetAnswerLine(answers: ReadonlyArray<BudgetAgentAnswer>): string | null {
  const cans = answers.filter((a) => a.answer === 'can')
  if (cans.length > 0) {
    const [first, ...rest] = cans
    return rest.length === 0
      ? `${first!.agentName} can pay this`
      : `${first!.agentName} and ${rest.length} other agent${rest.length === 1 ? '' : 's'} can pay this`
  }
  const knownNos = answers.filter((a) => a.answer === 'cannot')
  if (knownNos.length === 0) return null
  const aboutTheToken = knownNos.filter((a) => a.reason === 'insufficient' || a.reason === 'no-budget')
  if (aboutTheToken.length === 1 && knownNos.length === 1) {
    const phrase = aboutTheToken[0]!.periodPhrase
    return phrase
      ? `More than ${aboutTheToken[0]!.agentName} has left ${phrase}`
      : `More than ${aboutTheToken[0]!.agentName} has left`
  }
  if (answers.every((a) => a.answer === 'cannot')) return 'No agent can pay this yet'
  return null
}

// ── The "How to buy" panel (#4005) ──────────────────────────────────────────

export interface HowToBuyInput {
  merchantName: string
  offers: ReadonlyArray<CatalogEntry>
  agents: ReadonlyArray<BudgetAgent>
  /** `GET /dashboard/budget-remaining` (`useBudgetRemaining`). */
  budgets: ReadonlyArray<DashboardBudgetRemainingEntry>
  /** `GET /merchants/{slug}/budgets` (`useMerchantBudgets`, already on the page). */
  merchantBudgets: ReadonlyArray<MerchantBudget>
  /** The merchant's funding targets (`useMerchant`). */
  funding: ReadonlyArray<MerchantFundingTarget>
  /** Required for tests; defaults to now. */
  nowMs?: number
}

/**
 * The merchant-level answer the panel's step 2 renders — the same
 * `agentsThatCanPay` verdicts the offers show, reduced to one state:
 *
 *  - `done` — an active agent can pay at least one offer. `selected` is the
 *    budget that pays (the figures the done line names); `partial` is true
 *    when that agent cannot pay EVERY offer (a mixed merchant, or offers on
 *    more than one chain) and the line says "for some offers".
 *  - `budget-fix` — no agent can pay and the fix is a budget: name the first
 *    agent with a budget-shaped no. `selected` is non-null exactly when the
 *    agent's budget here is real but SHORT for every offer ("nothing left
 *    this period"); null means no budget in the offers' token can pay —
 *    including one locked to another recipient, which is unusable here just
 *    the same. The panel offers the fund action when it may (its own
 *    `fundActionAvailable` prop), else links to the agent's budget.
 *  - `wrong-network` — no agent can pay and every known no is a chain no:
 *    the agent's account is on another network and there is no in-app fix.
 *  - `uncertain` — nothing can be claimed (unknowns everywhere, or no active
 *    agent / no offers — states the panel does not reach).
 *
 * Ordering when agents disagree: a budget fix beats a chain no (it is
 * actionable), and any unknown beats both (the panel never claims what the
 * data cannot support). The per-offer rows stay the source of truth per
 * offer; this is the one-line merchant summary only.
 */
export type HowToBuyAnswer =
  | { kind: 'done'; agentName: string; selected: SelectedBudget; partial: boolean }
  | {
      kind: 'budget-fix'
      agentName: string
      agentId: string
      periodPhrase: string | null
      selected: SelectedBudget | null
    }
  | { kind: 'wrong-network'; agentName: string; agentChainId: number; offerChainIds: number[] }
  | { kind: 'uncertain' }

export function howToBuy(input: HowToBuyInput): HowToBuyAnswer {
  const { merchantName: _merchantName, offers, agents, budgets, merchantBudgets, funding, nowMs = Date.now() } = input
  const activeAgents = agents.filter((a) => a.status === 'active')
  if (offers.length === 0 || activeAgents.length === 0) return { kind: 'uncertain' }

  const perOffer = offers.map((offer) =>
    agentsThatCanPay({ offer, agents: activeAgents, budgets, merchantBudgets, funding, nowMs }),
  )
  const answerFor = (offerIndex: number, agentId: string): BudgetAgentAnswer =>
    perOffer[offerIndex]!.find((a) => a.agentId === agentId)!

  // 1. Done — the first active agent that can pay at least one offer.
  for (const agent of activeAgents) {
    const canIndex = perOffer.findIndex((answers) => answers.find((a) => a.agentId === agent.id)?.answer === 'can')
    if (canIndex === -1) continue
    const answer = answerFor(canIndex, agent.id)
    // A 'can' is only ever returned from a parsed, from-chain read, so the
    // selected figures ride on it — the non-null assertion mirrors the
    // helper's own invariant.
    const selected = answer.selected!
    const partial = !perOffer.every((answers) => answers.find((a) => a.agentId === agent.id)?.answer === 'can')
    return { kind: 'done', agentName: agent.name, selected, partial }
  }

  // 2. Unknown anywhere → the panel claims nothing. This runs BEFORE the
  //    budget-fix reduction, so an unknown answer beside a budget-shaped no
  //    is 'uncertain', not a named fix — any unknown beats both (the panel
  //    never claims what the data cannot support). An agent that cannot be
  //    measured on one offer cannot be said to be fixable on another.
  if (perOffer.some((answers) => answers.some((a) => a.answer === 'unknown'))) {
    return { kind: 'uncertain' }
  }

  // 3. No one can pay — the first budget-shaped no names the fix.
  for (const agent of activeAgents) {
    for (let i = 0; i < offers.length; i++) {
      const answer = answerFor(i, agent.id)
      if (answer.answer !== 'cannot') continue
      if (answer.reason === 'insufficient' || answer.reason === 'no-budget') {
        return {
          kind: 'budget-fix',
          agentName: agent.name,
          agentId: agent.id,
          periodPhrase: answer.periodPhrase,
          selected: answer.selected ?? null,
        }
      }
    }
  }

  // 4. Every answer is a known no and none is about a budget: the agents'
  //    accounts are on other networks. (An agent whose chain is unknown
  //    answers unknown, so account_chain_id is known here.)
  const first = activeAgents[0]!
  return {
    kind: 'wrong-network',
    agentName: first.name,
    agentChainId: first.account_chain_id!,
    offerChainIds: Array.from(
      new Set(offers.map((o) => networkToChainId(o.network)).filter((id): id is number => id != null)),
    ),
  }
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
 *
 * #3839: agents get the same fact as `funding_leg_expected` on discovery, from
 * the SDK's `catalogFundingLegExpected`. The frontend keeps no `@haven_ai/sdk`
 * runtime dependency, so the two are reconciled by a parity test
 * (`marketplace.test.ts`): this is `catalogFundingLegExpected(x) !== false`
 * — "unknown" counts as needing an unpinned budget, the conservative reading.
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
