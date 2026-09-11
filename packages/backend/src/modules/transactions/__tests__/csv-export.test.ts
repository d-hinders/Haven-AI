/**
 * The CSV projection and the export row cap (#2871).
 *
 * The route test (`routes/__tests__/transactions-export-csv.test.ts`) proves
 * the wiring end to end; this file pins the two things it cannot reach — the
 * per-column mapping of an enriched row, and the row-cap boundary, which no
 * request can cross while the explorer window is 50 rows per source.
 */
import { describe, it, expect } from 'vitest'
import {
  EXPORT_ROW_CAP,
  TRANSACTION_CSV_COLUMNS,
  buildTransactionCsvFilename,
  exceedsExportRowCap,
  transactionCsvRow,
  transactionsToCsv,
} from '../csv-export.js'
import type { EnrichedTransaction } from '../types.js'

const NEVER_NAMED = { resolveName: () => null }

function tx(overrides: Partial<EnrichedTransaction> = {}): EnrichedTransaction {
  return {
    hash: '0xabc',
    type: 'erc20',
    from: '0xsender',
    to: '0xrecipient',
    value: '1000000',
    valueFormatted: '1.5',
    asset: 'USDC',
    decimals: 6,
    direction: 'out',
    timestamp: 1_778_240_999,
    blockNumber: 45_725_826,
    isError: false,
    chainId: 8453,
    safeId: 'safe-1',
    safeAddress: '0xsafe',
    safeName: 'Main',
    ...overrides,
  }
}

describe('exceedsExportRowCap', () => {
  it('admits a count at the cap and refuses one above it', () => {
    expect(exceedsExportRowCap(EXPORT_ROW_CAP - 1)).toBe(false)
    expect(exceedsExportRowCap(EXPORT_ROW_CAP)).toBe(false)
    expect(exceedsExportRowCap(EXPORT_ROW_CAP + 1)).toBe(true)
  })

  it('admits an empty export', () => {
    expect(exceedsExportRowCap(0)).toBe(false)
  })
})

describe('transactionCsvRow', () => {
  it('maps an outbound agent payment across every column', () => {
    const row = transactionCsvRow(
      tx({
        source: 'x402',
        agentName: 'Buyer',
        paymentId: 'pi-1',
        amountSek: '10.50',
        fxRateSek: '10.500000000000',
        fxSource: 'riksbank',
        initiatedBy: 'agent',
        tokenSymbol: 'USDC',
        tokenAddress: '0xusdc',
      }),
      { resolveName: () => 'Merchant Ltd' },
    )

    expect(row).toEqual({
      settled_at: '2026-05-08T11:49:59.000Z',
      type: 'x402',
      status: 'executed',
      direction: 'out',
      counterparty_name: 'Merchant Ltd',
      counterparty_address: '0xrecipient',
      token_symbol: 'USDC',
      token_address: '0xusdc',
      amount: '1.5',
      amount_sek: '10.50',
      fx_rate: '10.500000000000',
      fx_source: 'riksbank',
      fee_sek: '',
      chain_id: '8453',
      tx_hash: '0xabc',
      payment_id: 'pi-1',
      agent_name: 'Buyer',
      safe_address: '0xsafe',
      initiator: 'agent',
    })
  })

  it('takes the counterparty from the sender on an inbound row', () => {
    const row = transactionCsvRow(tx({ direction: 'in' }), NEVER_NAMED)

    expect(row.counterparty_address).toBe('0xsender')
    expect(row.type).toBe('receive')
    expect(row.initiator).toBe('')
  })

  it('reports a failed transaction and a sweep by their own labels', () => {
    expect(transactionCsvRow(tx({ isError: true }), NEVER_NAMED).status).toBe('failed')
    expect(
      transactionCsvRow(tx({ activityType: 'delegate_sweep' }), NEVER_NAMED).type,
    ).toBe('allowance funding')
  })

  it('carries the lifecycle states the dashboard shows', () => {
    expect(
      transactionCsvRow(tx({ paymentFlowStatus: 'confirming_merchant' }), NEVER_NAMED).status,
    ).toBe('pending')
    expect(
      transactionCsvRow(tx({ paymentFlowStatus: 'needs_attention' }), NEVER_NAMED).status,
    ).toBe('needs attention')
  })

  it('leaves an unpriced row blank rather than inventing a rate', () => {
    const row = transactionCsvRow(tx(), NEVER_NAMED)

    expect(row.amount_sek).toBe('')
    expect(row.fx_rate).toBe('')
    expect(row.fx_source).toBe('')
    // No fee ledger exists yet (#386) — reserved, always empty.
    expect(row.fee_sek).toBe('')
  })
})

describe('transactionsToCsv', () => {
  it('writes the declared header even with no rows', () => {
    expect(transactionsToCsv([], NEVER_NAMED)).toBe(TRANSACTION_CSV_COLUMNS.join(','))
  })

  it('writes one CRLF-separated record per transaction', () => {
    const csv = transactionsToCsv([tx(), tx({ hash: '0xdef' })], NEVER_NAMED)

    expect(csv.split('\r\n')).toHaveLength(3)
  })
})

describe('buildTransactionCsvFilename', () => {
  it('stamps the UTC date, so two timezones name the same export alike', () => {
    expect(buildTransactionCsvFilename(new Date('2026-01-05T23:30:00.000Z'))).toBe(
      'haven-transactions-20260105.csv',
    )
  })
})
