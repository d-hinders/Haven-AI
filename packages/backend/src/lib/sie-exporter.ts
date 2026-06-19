import type { AccountingEntry } from './accounting-entry.js'
import type { ExportOptions, ExportResult, LedgerExporter } from './ledger-exporter.js'
import { basAccountName } from './bas-accounts.js'
import { buildBookingLines } from './booking.js'
import { VAT_ACCOUNT_NAMES } from './vat.js'

/**
 * SIE 4I writer (epic #462, P1 #464) — the Swedish standard import format for
 * transactions (verifikationer). One file imports into Fortnox/Visma/Bokio etc.
 * See `docs/research/bookkeeping-ready-export.md` §7.
 *
 * Each settled agent payment becomes a balanced verifikation:
 *   debit  expense account (BAS, from merchant category)
 *   credit settlement/clearing account
 * Reverse-charge VAT lines are intentionally NOT emitted here — VAT handling is
 * P3 (#466); P1 books the cost and the cash, balanced, for the accountant to
 * refine. Amounts are SEK at book time (frozen at settlement, P0).
 *
 * SIE is tagged text (not XML). The standard specifies PC8/CP437 encoding;
 * callers that need strict compliance should transcode the returned UTF-8
 * string. Modern importers (Fortnox) accept UTF-8.
 */

/** YYYY-MM-DD…T… ISO → SIE `YYYYMMDD`. */
function sieDate(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, '')
}

/** SIE amounts: decimal point, 2 places; debit positive, credit negative. */
function sieAmount(value: number): string {
  return value.toFixed(2)
}

/** Account display name across BAS + VAT accounts. */
function accountName(account: string): string {
  return VAT_ACCOUNT_NAMES[account] ?? basAccountName(account)
}

/** Quote a SIE field and escape embedded quotes/backslashes. */
function sieField(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function verificationText(entry: AccountingEntry): string {
  return (
    entry.counterparty.name ??
    entry.counterparty.address ??
    entry.resourceUrl ??
    'Agent payment'
  )
}

export const sieExporter: LedgerExporter = {
  format: 'sie',
  export(entries: AccountingEntry[], opts: ExportOptions): ExportResult {
    const generatedAt = opts.generatedAt ?? new Date()
    const usedAccounts = new Set<string>()
    const verifications: string[] = []

    let entryCount = 0
    let skipped = 0
    let series = 1

    for (const entry of entries) {
      const lines = buildBookingLines(entry)
      // Unbookable without a SEK value — surface as skipped rather than book a zero.
      if (!lines) {
        skipped += 1
        continue
      }

      const date = sieDate(entry.settledAt)
      const text = sieField(verificationText(entry))

      const trans = lines.map((line) => {
        usedAccounts.add(line.account)
        // SIE signs the amount: debit positive, credit negative.
        return `   #TRANS ${line.account} {} ${sieAmount(line.debit - line.credit)} ${date}`
      })

      verifications.push(`#VER "A" ${series} ${date} ${text}`, '{', ...trans, '}')
      series += 1
      entryCount += 1
    }

    const header = [
      '#FLAGGA 0',
      '#PROGRAM "Haven" "0.1"',
      '#FORMAT PC8',
      `#GEN ${sieDate(generatedAt.toISOString())}`,
      '#SIETYP 4',
      `#FNAMN ${sieField(opts.companyName)}`,
    ]

    const accountDecls = Array.from(usedAccounts)
      .sort()
      .map((account) => `#KONTO ${account} ${sieField(accountName(account))}`)

    const content = [...header, ...accountDecls, ...verifications].join('\r\n') + '\r\n'

    return {
      format: 'sie',
      filename: `haven-${sieDate(generatedAt.toISOString())}.si`,
      mimeType: 'text/plain; charset=utf-8',
      content,
      entryCount,
      skipped,
    }
  },
}
