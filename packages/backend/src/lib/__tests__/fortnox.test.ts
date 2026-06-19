import { describe, expect, it, vi } from 'vitest'
import {
  buildFortnoxAuthorizeUrl,
  exchangeCodeForTokens,
  pushVoucher,
  refreshTokens,
  toFortnoxVoucher,
  FortnoxError,
  FORTNOX_TOKEN_URL,
  FORTNOX_API_BASE,
} from '../fortnox.js'
import type { AccountingEntry } from '../accounting-entry.js'

const CREDS = { clientId: 'cid', clientSecret: 'secret', redirectUri: 'https://app/cb' }

function entry(over: Partial<AccountingEntry> = {}): AccountingEntry {
  return {
    paymentId: 'pi1',
    txHash: '0xabc',
    chainId: 8453,
    settledAt: '2026-06-19T10:00:00.000Z',
    direction: 'out',
    counterparty: { address: '0xmerchant', name: 'Soundside', country: null },
    token: 'USDC',
    amountAtomic: '12500000',
    amountSek: '132.50',
    fxRate: '10.60',
    fxSource: 'coingecko_spot',
    fxAt: '2026-06-19T10:00:00.000Z',
    feeSek: null,
    category: 'media',
    vatTreatment: 'reverse_charge',
    resourceUrl: 'https://api.example/resource',
    receiptRef: 'ev1',
    ...over,
  }
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response
}

describe('buildFortnoxAuthorizeUrl', () => {
  it('includes client id, scope, state and offline access', () => {
    const url = new URL(buildFortnoxAuthorizeUrl(CREDS, 'state123'))
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('redirect_uri')).toBe('https://app/cb')
    expect(url.searchParams.get('scope')).toBe('bookkeeping')
    expect(url.searchParams.get('state')).toBe('state123')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('access_type')).toBe('offline')
  })
})

describe('toFortnoxVoucher', () => {
  it('maps to a balanced voucher (debit expense / credit settlement)', () => {
    const v = toFortnoxVoucher(entry())
    expect(v).not.toBeNull()
    expect(v!.TransactionDate).toBe('2026-06-19')
    expect(v!.Description).toBe('Soundside')
    expect(v!.VoucherRows).toEqual([
      { Account: 6540, Debit: 132.5, Credit: 0 },
      { Account: 1930, Debit: 0, Credit: 132.5 },
    ])
    const net = v!.VoucherRows.reduce((s, r) => s + r.Debit - r.Credit, 0)
    expect(net).toBe(0)
  })

  it('returns null for an entry with no book-time SEK', () => {
    expect(toFortnoxVoucher(entry({ amountSek: null }))).toBeNull()
  })
})

describe('token exchange / refresh', () => {
  it('exchanges a code and computes an absolute expiry with Basic auth', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'bookkeeping' }),
    )
    const tokens = await exchangeCodeForTokens(CREDS, 'code1', fetchImpl as unknown as typeof fetch)
    expect(tokens.accessToken).toBe('at')
    expect(tokens.refreshToken).toBe('rt')
    expect(tokens.expiresAt.getTime()).toBeGreaterThan(Date.now())

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(FORTNOX_TOKEN_URL)
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('cid:secret').toString('base64')}`,
    )
    expect(init.body).toContain('grant_type=authorization_code')
  })

  it('refreshes with the refresh grant', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 }),
    )
    const tokens = await refreshTokens(CREDS, 'rt', fetchImpl as unknown as typeof fetch)
    expect(tokens.accessToken).toBe('at2')
    expect(fetchImpl.mock.calls[0][1].body).toContain('grant_type=refresh_token')
  })

  it('throws FortnoxError on a non-2xx token response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false, 401))
    await expect(exchangeCodeForTokens(CREDS, 'bad', fetchImpl as unknown as typeof fetch)).rejects.toBeInstanceOf(
      FortnoxError,
    )
  })
})

describe('pushVoucher', () => {
  it('posts the voucher and returns the voucher number', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ Voucher: { VoucherNumber: 42 } }))
    const v = toFortnoxVoucher(entry())!
    const result = await pushVoucher('at', v, fetchImpl as unknown as typeof fetch)
    expect(result.voucherNumber).toBe(42)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${FORTNOX_API_BASE}/vouchers`)
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer at')
    expect(JSON.parse(init.body as string)).toEqual({ Voucher: v })
  })

  it('throws FortnoxError on a failed push', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false, 400))
    await expect(
      pushVoucher('at', toFortnoxVoucher(entry())!, fetchImpl as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(FortnoxError)
  })
})
