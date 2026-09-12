import type { AccountingEntry } from '../entry.js'
import { buildBookingLines } from './booking.js'
import { FortnoxError, FORTNOX_API_BASE } from '../fortnox.js'

/**
 * Fortnox VOUCHER push — the asserting leg (epic #462, P2 #465).
 *
 * Split out of `fortnox.ts` by #2859. A voucher asserts debit/credit BAS
 * accounts, so it belongs with the rest of the darkened #462 code behind
 * `HAVEN_LEGACY_BOOKKEEPING_ENABLED`, not beside the OAuth helpers the
 * non-asserting feed imports. Vouchers mirror the SIE booking exactly; see
 * `docs/research/bookkeeping-ready-export.md` §9.
 */
export const FORTNOX_VOUCHER_SERIES = 'A'

export interface FortnoxVoucherRow {
  Account: number
  Debit: number
  Credit: number
}

export interface FortnoxVoucher {
  VoucherSeries: string
  TransactionDate: string
  Description: string
  VoucherRows: FortnoxVoucherRow[]
}

/**
 * Map a settled entry to a balanced Fortnox voucher. Returns null when the entry
 * has no book-time SEK value (unbookable) — same rule as the SIE exporter.
 */
export function toFortnoxVoucher(entry: AccountingEntry): FortnoxVoucher | null {
  const lines = buildBookingLines(entry)
  if (!lines) return null

  const description =
    entry.counterparty.name ?? entry.counterparty.address ?? entry.resourceUrl ?? 'Agent payment'

  return {
    VoucherSeries: FORTNOX_VOUCHER_SERIES,
    TransactionDate: entry.settledAt.slice(0, 10),
    Description: description.slice(0, 200),
    VoucherRows: lines.map((line) => ({
      Account: Number(line.account),
      Debit: line.debit,
      Credit: line.credit,
    })),
  }
}

/** POST a single voucher to Fortnox. Throws FortnoxError on non-2xx. */
export async function pushVoucher(
  accessToken: string,
  voucher: FortnoxVoucher,
  fetchImpl: typeof fetch = fetch,
): Promise<{ voucherNumber: number | null }> {
  let res: Response
  try {
    res = await fetchImpl(`${FORTNOX_API_BASE}/vouchers`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ Voucher: voucher }),
    })
  } catch (err) {
    throw new FortnoxError(`Could not reach Fortnox: ${err instanceof Error ? err.message : String(err)}`, 0)
  }
  if (!res.ok) {
    throw new FortnoxError(`Fortnox voucher push failed (HTTP ${res.status}).`, res.status)
  }
  const data = (await res.json()) as { Voucher?: { VoucherNumber?: number } }
  return { voucherNumber: data.Voucher?.VoucherNumber ?? null }
}
