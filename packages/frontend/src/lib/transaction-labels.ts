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
 * This string is `counterpartyLabel`'s fallback title for a row with no
 * resource hostname (the dashboard, the ledgers and the detail panel, #4266,
 * #4267) — so it follows
 * `docs/product/copy-guidelines.md` § Core principle: write for users, not for
 * the protocol. It is deliberately NOT the same call as
 * `settlementSchemeLabel` in `transaction-presentation.tsx`, which returns raw
 * scheme names ("EIP-3009", "ERC-7710") and is right to: its only consumer is
 * the "Settlement method" row inside the detail panel's Technical details,
 * which is exactly where the guidelines allow technical vocabulary.
 *
 * - `x402` → "Agent payment". The row already carries the protocol's useful
 *   half elsewhere: the ledger row's title is the resource hostname
 *   (`counterpartyLabel`, #4266), and the detail panel calls it a "Paid
 *   request" and keeps the scheme and merchant under Technical details
 *   (#4267).
 * - `mpp_demo` → "Machine payment". "Demo" has no place in the primary title
 *   of a real payment in a user's own money history. The flow is retired
 *   (#1328 — `POST /machine-payments/authorize` answers 410, so no new row can
 *   acquire this source), but historical rows stay readable by design and
 *   render this title indefinitely. "Machine payment" is not new vocabulary
 *   invented here: it is what `TransactionDetailPanel`'s own section for these
 *   rows was called until #4267.
 *
 * Returns null for every other source — the caller supplies the generic copy.
 */
export function paymentSourceTitle(source?: string | null): string | null {
  if (source === 'x402') return 'Agent payment'
  if (source === 'mpp_demo') return 'Machine payment'
  return null
}
