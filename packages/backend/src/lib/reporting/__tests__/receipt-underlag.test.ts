/**
 * #498 receipt underlag: the dependency-free PDF renderer and the user-scoped
 * loader. The PDF's content stream is uncompressed, so assertions can grep the
 * bytes directly.
 */
import { describe, expect, it, vi } from 'vitest'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))
vi.mock('../../../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))

const { receiptPdf, underlagFromData, loadReceiptUnderlag } = await import('../receipt-underlag.js')

const DATA = {
  paymentId: 'pay-123',
  settledAt: '2026-07-15T09:30:00.000Z',
  token: 'USDC',
  amountAtomic: '1000',
  amountSek: '10.42',
  fxRate: '10.42',
  fxSource: 'riksbank',
  fxAt: '2026-07-15T09:30:00.000Z',
  merchantName: 'NordShield VPN',
  merchantAddress: '0x' + 'ab'.repeat(20),
  resourceUrl: 'https://merchant.example/vpn',
  chainId: 84532,
  txHash: '0x' + 'cd'.repeat(32),
  delegate: '0x' + 'ef'.repeat(20),
  signHash: '0x' + '12'.repeat(32),
  signature: '0x' + '34'.repeat(65),
}

const TX = {
  paymentId: 'pay-123',
  settledAt: '2026-07-15T09:30:00.000Z',
  direction: 'out' as const,
  counterparty: { address: DATA.merchantAddress, name: 'NordShield VPN' },
  resourceUrl: 'https://merchant.example/vpn',
  token: 'USDC',
  amountAtomic: '1000',
  amountSek: '10.42',
  fxRate: '10.42',
  fxSource: 'riksbank',
  fxAt: '2026-07-15T09:30:00.000Z',
  receiptRef: 'evidence-1',
  suggestedAccount: null,
}

describe('receiptPdf', () => {
  it('produces a structurally valid, deterministic PDF', () => {
    const pdf = receiptPdf(['Hello underlag'])
    const s = pdf.toString('latin1')
    expect(s.startsWith('%PDF-1.4')).toBe(true)
    expect(s).toContain('(Hello underlag) Tj')
    expect(s).toContain('startxref')
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true)
    // Deterministic: same input, identical bytes.
    expect(receiptPdf(['Hello underlag']).equals(pdf)).toBe(true)
  })

  it('escapes PDF string delimiters and strips non-ASCII', () => {
    const s = receiptPdf(['(paren) back\\slash', 'ellipsis … dot ·']).toString('latin1')
    expect(s).toContain('(\\(paren\\) back\\\\slash) Tj')
    expect(s).toContain('(ellipsis ? dot ?) Tj')
  })

  it('wraps long values instead of overflowing the page', () => {
    const long = 'x'.repeat(200)
    const s = receiptPdf([long]).toString('latin1')
    expect(s).not.toContain(`(${long})`)
    expect(s).toContain(`(${'x'.repeat(88)}) Tj`)
  })
})

describe('underlagFromData', () => {
  it('renders the receipt fields and a safe ASCII filename', () => {
    const { filename, pdf } = underlagFromData(DATA)
    expect(filename).toBe('haven-receipt-pay-123.pdf')
    const s = pdf.toString('latin1')
    for (const needle of ['pay-123', '10.42 SEK', 'NordShield VPN', 'ON-CHAIN SETTLEMENT', '84532', 'verifyPaymentReceipt']) {
      expect(s).toContain(needle)
    }
  })

  it('sanitizes exotic payment ids in the filename', () => {
    const { filename } = underlagFromData({ ...DATA, paymentId: 'a/b:c d' })
    expect(filename).toBe('haven-receipt-a_b_c_d.pdf')
  })
})

describe('loadReceiptUnderlag', () => {
  it('joins evidence + intent and renders the underlag, scoped to the user', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        tx_hash: DATA.txHash,
        chain_id: 84532,
        merchant_address: DATA.merchantAddress,
        sign_hash: DATA.signHash,
        signature: DATA.signature,
        delegate_address: DATA.delegate,
      }],
    })
    const underlag = await loadReceiptUnderlag('u1', TX)
    expect(underlag?.filename).toBe('haven-receipt-pay-123.pdf')
    expect(underlag?.pdf.toString('latin1')).toContain(DATA.txHash)
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('mpe.user_id = $2')
    expect(params).toEqual(['evidence-1', 'u1'])
  })

  it('returns null (never throws) when the evidence row is missing or the query fails', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    expect(await loadReceiptUnderlag('u1', TX)).toBeNull()
    mockQuery.mockRejectedValueOnce(new Error('db down'))
    expect(await loadReceiptUnderlag('u1', TX)).toBeNull()
  })
})
