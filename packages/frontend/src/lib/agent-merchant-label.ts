import { isAddress } from '@haven_ai/core'
import { parseX402Hostname } from './transaction-labels'

/**
 * The fields of an agent's last counterparty the label reads — the
 * dashboard overview's `stats.lastCounterparty` (#3803), structurally.
 */
export interface AgentLastCounterparty {
  merchantName: string | null
  x402ResourceUrl: string | null
  to?: string | null
}

/**
 * Where the `/agents` card's footer says an agent last paid (#4209):
 * "Last paid 20h ago · api.bitrefill.com".
 *
 * The merchant's name, else the host of the x402 resource it paid, else
 * nothing. NEVER the recipient address: a hex string is not a merchant name,
 * and on a card footer it reads as an identifier the owner should recognise.
 * `to` is accepted (it is on the wire) and deliberately ignored.
 *
 * The card only: the dashboard and account rows keep #3989's "Last paid"
 * with no merchant at all.
 */
export function agentMerchantLabel(counterparty: AgentLastCounterparty | null | undefined): string | null {
  if (!counterparty) return null
  const name = counterparty.merchantName?.trim()
  // A name that is itself an address is still an address.
  if (name && !isAddress(name)) return name
  return parseX402Hostname(counterparty.x402ResourceUrl)
}
