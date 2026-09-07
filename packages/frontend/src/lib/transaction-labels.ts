export function parseX402Hostname(resourceUrl?: string | null): string | null {
  if (!resourceUrl) return null

  try {
    return new URL(resourceUrl).hostname
  } catch {
    return null
  }
}

export function isMachinePaymentSource(source?: string | null): boolean {
  return source === 'x402' || source === 'mpp_demo'
}

/**
 * Primary title for a machine-payment transaction row (#2357).
 *
 * This string leads the row people scan — the dashboard activity list
 * (`DashboardClient.tsx`), the transactions table (`TransactionsTable.tsx`),
 * the side panel heading (`TransactionDetailPanel.tsx`) and the agent detail
 * activity feed (`AgentDetailClient.tsx`) — so it follows
 * `docs/product/copy-guidelines.md` § Core principle: write for users, not for
 * the protocol. It is deliberately NOT the same call as
 * `settlementSchemeLabel` in `transaction-presentation.tsx`, which returns raw
 * scheme names ("EIP-3009", "ERC-7710") and is right to: its only consumer is
 * a labelled row inside the advanced detail drawer, which is exactly where the
 * guidelines allow technical vocabulary.
 *
 * - `x402` → "Agent payment". The row already carries the protocol's useful
 *   half elsewhere: the movement column resolves to the resource hostname
 *   (`counterpartyLabel`), and the detail drawer names the protocol in its
 *   "x402 payment" section heading and shows Resource / Merchant / Settlement.
 *   The branch is kept rather than folded into `transactionTitle`'s generic
 *   `Agent payment by <name>` fallback, as defence against the TYPE contract:
 *   `agentName` is optional on `AggregatedTransaction`, and without this
 *   branch an x402 row that arrived without one would render the anonymous
 *   "Payment sent". Do not read that as an observed case — it is not one.
 *   Both backend write paths for `source: 'x402'` INNER JOIN `agents`, whose
 *   `name` is NOT NULL, so no live x402 row can reach here without a name
 *   (traced by `haven-reviewer` on #2357). This is cheap insurance against the
 *   optional type, not a scenario to go looking for.
 * - `mpp_demo` → "Machine payment". "Demo" has no place in the primary title
 *   of a real payment in a user's own money history. The flow is retired
 *   (#1328 — `POST /machine-payments/authorize` answers 410, so no new row can
 *   acquire this source), but historical rows stay readable by design and
 *   render this title indefinitely. "Machine payment" is not new vocabulary
 *   invented here: it is what `TransactionDetailPanel`'s own section for these
 *   rows has always been called, so the two surfaces now agree.
 *
 * Returns null for every other source — the caller supplies the generic copy.
 */
export function paymentSourceTitle(source?: string | null): string | null {
  if (source === 'x402') return 'Agent payment'
  if (source === 'mpp_demo') return 'Machine payment'
  return null
}
