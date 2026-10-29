/**
 * The counterparty-name module (#4332, epic #4330 analytics 2/4).
 *
 * ONE definition of how a merchant is NAMED on `GET /analytics/overview`:
 * the `/transactions` order plus one analytics-only step, settled as option
 * (b) in the partner review and written into the issue's Scope §2 —
 *
 *   1. the x402 resource host (`COALESCE(pi.payment_resource_url,
 *      pi.x402_resource_url)`, as `infra/repositories/agent-activity.ts`
 *      reads it), from the merchant's most recent payment IN THE WINDOW;
 *   2. one of the user's own accounts → that account's name;
 *   3. a contact → the contact name;
 *   4. the receipt's `merchant_name` (`RECEIPT_MERCHANT_NAMES_SQL`) — the
 *      analytics-only EXTENSION: `/transactions` rows have no receipt step;
 *   5. otherwise `null` — the client renders "Unknown recipient" (#4333),
 *      where `/transactions` says "New recipient".
 *
 * The route (not this module) fetches the candidate values; this module owns
 * the ORDER and the nullability, so the response cannot disagree with itself
 * about which name wins. `label: null` is a WIRE change: the response's
 * `label` is nullable and every row carries a `kind`.
 *
 * The own-account match is ADDRESS-ONLY by owner decision: merchants are
 * keyed by address across chains while own-account names are chain-keyed
 * (`modules/transactions/search.ts`), so an address that is ANY of the
 * user's accounts on ANY chain names from that account. When several
 * accounts share an address (the same counterfactual address on two
 * chains), the OLDEST account's name wins — the caller passes the accounts
 * in `created_at ASC` order and the first match takes it.
 */
import { parseX402Hostname } from '@haven_ai/core'

export type CounterpartyKind = 'x402' | 'own_account' | 'contact' | 'receipt' | 'unknown'

/** The candidates the route fetched for one merchant. Each is null when that step does not apply. */
export interface CounterpartyNameInputs {
  /** The x402 resource URL of the merchant's most recent payment in the window. */
  x402ResourceUrl: string | null
  /** The name of the user's own account at this address (address-only rule), if any. */
  ownAccountName: string | null
  /** The contact name at this address, if any. */
  contactName: string | null
  /** The receipt's `merchant_name` for this address, if any. */
  receiptName: string | null
}

export interface CounterpartyName {
  /** `null` when nothing resolved — the client renders "Unknown recipient". */
  label: string | null
  kind: CounterpartyKind
}

export function resolveCounterpartyName(inputs: CounterpartyNameInputs): CounterpartyName {
  // Step 1 — the x402 resource HOST. An unparseable URL yields no hostname,
  // so it does not claim the step: the next candidate names the merchant.
  const host = parseX402Hostname(inputs.x402ResourceUrl)
  if (host) return { label: host, kind: 'x402' }

  if (inputs.ownAccountName) return { label: inputs.ownAccountName, kind: 'own_account' }
  if (inputs.contactName) return { label: inputs.contactName, kind: 'contact' }
  if (inputs.receiptName) return { label: inputs.receiptName, kind: 'receipt' }
  return { label: null, kind: 'unknown' }
}

/**
 * The address-only own-account lookup. `accounts` is the user's accounts in
 * `created_at ASC` order (`LIST_ACCOUNTS_FOR_USER_SQL`), across ALL chains —
 * the FIRST account whose address matches wins, which is the oldest when
 * several share one address. Chain keys are ignored by design: a merchant is
 * keyed by address across chains, so a chain-keyed miss would name nothing.
 */
export function ownAccountNameForAddress(
  accounts: ReadonlyArray<{ account_address: string; name: string }>,
  address: string,
): string | null {
  const key = address.toLowerCase()
  const match = accounts.find((a) => a.account_address.toLowerCase() === key)
  return match?.name ?? null
}
