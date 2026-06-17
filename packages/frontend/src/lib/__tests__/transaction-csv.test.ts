import { describe, expect, it } from 'vitest'
import {
  buildCsvFilename,
  transactionsToCsv,
  type TransactionCsvLookups,
} from '@/lib/transaction-csv'
import type { AggregatedTransaction } from '@/types/transactions'

function tx(overrides: Partial<AggregatedTransaction> = {}): AggregatedTransaction {
  return {
    hash: '0xabc',
    type: 'erc20',
    from: '0x1111111111111111111111111111111111111111',
    to: '0x2222222222222222222222222222222222222222',
    value: '1000000',
    valueFormatted: '1.00',
    asset: 'USDC',
    decimals: 6,
    direction: 'out',
    timestamp: 1_700_000_000,
    blockNumber: 100,
    isError: false,
    tokenAddress: '0x3333333333333333333333333333333333333333',
    tokenSymbol: 'USDC',
    chainId: 8453,
    safeId: 'safe-1',
    safeAddress: '0x4444444444444444444444444444444444444444',
    safeName: 'Main',
    ...overrides,
  }
}

const noNames: TransactionCsvLookups = { resolveName: () => null }

function rows(csv: string): string[] {
  return csv.split('\r\n')
}

function cells(line: string): string[] {
  // Test inputs have no embedded commas/quotes except where asserted explicitly,
  // so a naive split is adequate for the header and simple rows.
  return line.split(',')
}

describe('transactionsToCsv', () => {
  it('emits the header in the documented column order', () => {
    const csv = transactionsToCsv([], noNames)
    expect(rows(csv)[0]).toBe(
      'date,type,status,direction,amount,token_symbol,token_address,' +
        'counterparty_address,counterparty_name,safe_address,agent_name,tx_hash,chain_id',
    )
  })

  it('uses CRLF line endings', () => {
    const csv = transactionsToCsv([tx()], noNames)
    expect(csv).toContain('\r\n')
    expect(csv.split('\r\n')).toHaveLength(2)
  })

  it('formats the date as ISO 8601 UTC from a unix-seconds timestamp', () => {
    const csv = transactionsToCsv([tx({ timestamp: 1_700_000_000 })], noNames)
    expect(csv).toContain('2023-11-14T22:13:20.000Z')
  })

  it('derives type from source, sweep activity, then direction', () => {
    const t = (o: Partial<AggregatedTransaction>) =>
      cells(rows(transactionsToCsv([tx(o)], noNames))[1])[1].replace(/"/g, '')
    expect(t({ source: 'x402' })).toBe('x402')
    expect(t({ source: 'mpp_demo' })).toBe('mpp')
    expect(t({ activityType: 'delegate_sweep' })).toBe('allowance funding')
    expect(t({ direction: 'in', source: 'direct' })).toBe('receive')
    expect(t({ direction: 'out', source: 'direct' })).toBe('send')
  })

  it('derives status from error and payment flow state', () => {
    const s = (o: Partial<AggregatedTransaction>) =>
      cells(rows(transactionsToCsv([tx(o)], noNames))[1])[2].replace(/"/g, '')
    expect(s({ isError: true })).toBe('failed')
    expect(s({ paymentFlowStatus: 'confirming_merchant' })).toBe('pending')
    expect(s({})).toBe('executed')
  })

  it('picks the counterparty by direction and resolves its name', () => {
    const lookups: TransactionCsvLookups = {
      resolveName: (addr) =>
        addr === '0x1111111111111111111111111111111111111111' ? 'Alice' : null,
    }
    const incoming = transactionsToCsv([tx({ direction: 'in' })], lookups)
    const cols = cells(rows(incoming)[1]).map((c) => c.replace(/"/g, ''))
    expect(cols[7]).toBe('0x1111111111111111111111111111111111111111') // counterparty_address = from
    expect(cols[8]).toBe('Alice') // counterparty_name
  })

  it('leaves token_address empty for native transfers and falls back to asset for symbol', () => {
    const csv = transactionsToCsv(
      [tx({ tokenAddress: undefined, tokenSymbol: undefined, asset: 'ETH' })],
      noNames,
    )
    const cols = cells(rows(csv)[1]).map((c) => c.replace(/"/g, ''))
    expect(cols[5]).toBe('ETH') // token_symbol falls back to asset
    expect(cols[6]).toBe('') // token_address empty
  })

  it('escapes embedded quotes and neutralises spreadsheet formula injection', () => {
    const lookups: TransactionCsvLookups = {
      resolveName: () => '=SUM(A1:A2)',
    }
    const csv = transactionsToCsv([tx()], lookups)
    // Leading = is prefixed with a single quote, wrapped and quote-escaped.
    expect(csv).toContain('"\'=SUM(A1:A2)"')
  })

  it('quotes a counterparty name that contains a comma so columns stay aligned', () => {
    const lookups: TransactionCsvLookups = { resolveName: () => 'Acme, Inc.' }
    const csv = transactionsToCsv([tx()], lookups)
    expect(csv).toContain('"Acme, Inc."')
  })
})

describe('buildCsvFilename', () => {
  it('stamps the local date as haven-transactions-YYYYMMDD.csv', () => {
    expect(buildCsvFilename(new Date(2026, 5, 8))).toBe('haven-transactions-20260608.csv')
  })
})
