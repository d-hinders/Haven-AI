import { formatFiat } from '@/lib/format'

/**
 * The dashboard's 7-day summary sentence (#3807, epic #3801).
 *
 * FIXED TEMPLATES, never model-written: the sentence is assembled from the
 * overview's own 7-day figures, and every branch here has a unit test that
 * asserts the EXACT sentence. Three rules bind the wording:
 *
 * 1. **At most two agents and one merchant are named.** A spread-out week
 *    reads as a count ("3 agents spent …"), a dominant agent is named beside
 *    the total it dominates (≥ 40 % of the week's spend), and the merchant is
 *    named only when it is the week's ONE merchant — a figure the wire's
 *    `distinctMerchants` owns, never a client-side guess.
 * 2. **Budget stops are neutral.** A stopped payment is a fact about the
 *    attempt, not a verdict about the user: the sentence says a payment
 *    attempt "was stopped by a budget limit" and nothing more. It NEVER says
 *    "within budget" — an over-budget payment cannot execute, so the phrase
 *    carries no information.
 * 3. **No raw address is ever named.** The merchant renders through #3810's
 *    counterparty rules (`merchantDisplayName`): contact name, else receipt
 *    name, else the x402 resource HOST. A bare recipient address has no
 *    displayable name — the sentence falls back to a count, not the address.
 *
 * The spend figures are #3803's NET definition (booked-or-repriced fiat with
 * the #3755 delegate_sweeps netting applied), the same one `spend.d30` and
 * the analytics page use, so the summary cannot disagree with the section
 * below it.
 */

export type DashboardSummaryCurrency = 'USD' | 'EUR' | 'SEK'

export interface DashboardSummaryAgent {
  id: string
  name: string
  /** The agent's 7-day NET spend, already in the display currency. */
  netSpend: number
}

export interface DashboardSummaryMerchant {
  /** The merchant identity: the x402 resource host, else the recipient address. */
  key: string
  x402ResourceUrl: string | null
  to: string | null
  merchantName: string | null
}

export interface DashboardSummaryInput {
  currency: DashboardSummaryCurrency
  /** The user's 7-day NET spend total, already in the display currency. */
  netSpend: number
  /** Confirmed payment rows in the 7-day window. */
  payments: number
  /** Refusal rows whose reason was a budget stop (#3803's `budget` bucket). */
  budgetStops: number
  /** DISTINCT merchants over the 7-day window — a wire figure, never summed client-side. */
  distinctMerchants: number
  /** Every delegation-rail agent with its 7-day figures (`overview.agents`). */
  agents: DashboardSummaryAgent[]
  /** The 7-day top merchant with raw identity fields; null on a no-spend window. */
  topMerchant: DashboardSummaryMerchant | null
}

/**
 * The #3810 counterparty name for the summary's one merchant slot, or null
 * when the merchant has no displayable name (a bare address with no contact
 * and no receipt name). A hostname is a name; a hex address is not.
 */
export function merchantDisplayName(
  merchant: DashboardSummaryMerchant,
): string | null {
  if (merchant.merchantName) return merchant.merchantName
  if (merchant.x402ResourceUrl) {
    try {
      return new URL(merchant.x402ResourceUrl).host
    } catch {
      // An unparseable resource URL has no name to show — fall through.
    }
  }
  // `key` is the host when the merchant is an x402 resource and the recipient
  // address otherwise. A hex address renders as no name at all.
  if (!merchant.key.startsWith('0x') && merchant.key.includes('.')) {
    return merchant.key
  }
  return null
}

function budgetStopClause(stops: number): string {
  const attempt = stops === 1 ? '1 payment attempt was' : `${stops} payment attempts were`
  return `${attempt} stopped by a budget limit.`
}

/**
 * The one- or two-sentence 7-day summary under the "Dashboard" heading.
 * Every branch's exact output is pinned by `lib/__tests__/dashboard-summary.test.ts`.
 */
export function buildDashboardSummary(input: DashboardSummaryInput): string {
  const money = (value: number): string => formatFiat(value, input.currency)

  if (input.payments === 0 && input.budgetStops === 0) {
    return 'No agent payments in the last 7 days.'
  }

  if (input.payments === 0) {
    return `No agent payments went through in the last 7 days. ${budgetStopClause(input.budgetStops)}`
  }

  const spenders = input.agents
    .filter((agent) => agent.netSpend > 0)
    .sort((a, b) => b.netSpend - a.netSpend)

  let sentence: string
  if (spenders.length === 0) {
    // Defensive: payments > 0 always leaves at least one spending agent on
    // the wire. If a future wire change breaks that, say the true thing —
    // a total — rather than naming a phantom agent.
    sentence = `Agents spent ${money(input.netSpend)} in the last 7 days.`
  } else if (spenders.length === 1) {
    const merchantName =
      input.distinctMerchants === 1 && input.topMerchant
        ? merchantDisplayName(input.topMerchant)
        : null
    const merchant =
      merchantName !== null
        ? `at ${merchantName}`
        : `across ${input.distinctMerchants} ${input.distinctMerchants === 1 ? 'merchant' : 'merchants'}`
    sentence = `${spenders[0].name} spent ${money(input.netSpend)} ${merchant} in the last 7 days.`
  } else if (spenders[0].netSpend / input.netSpend >= 0.4) {
    const rest = spenders.slice(1)
    const otherCount = rest.length - 1
    const restClause =
      otherCount === 0
        ? `${rest[0].name} spent the rest`
        : `${rest[0].name} and ${otherCount} other agent${otherCount === 1 ? '' : 's'} spent the rest`
    sentence = `${spenders[0].name} spent ${money(spenders[0].netSpend)} of ${money(input.netSpend)} in the last 7 days; ${restClause}.`
  } else {
    sentence = `${spenders.length} agents spent ${money(input.netSpend)} in the last 7 days.`
  }

  if (input.budgetStops > 0) {
    sentence = `${sentence} ${budgetStopClause(input.budgetStops)}`
  }
  return sentence
}
