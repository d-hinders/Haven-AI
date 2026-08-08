/**
 * The watermark repository's two contracts (#718): it normalises the address
 * triple itself, and it never lets a database problem reach the caller.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  FIND_ALLOWANCE_NONCE_WATERMARK_SQL,
  UPSERT_ALLOWANCE_NONCE_WATERMARK_SQL,
  findAllowanceNonceWatermark,
  raiseAllowanceNonceWatermark,
} from '../allowance-nonce-watermarks.js'

const db = (impl: (sql: string, params: unknown[]) => unknown) => ({
  query: vi.fn(async (sql: string, params: unknown[]) => impl(sql, params) as never),
})

describe('allowance-nonce watermark repository (#718)', () => {
  it('lower-cases the triple on the WRITE — the PK splits on casing otherwise', async () => {
    const stub = db(() => ({ rows: [] }))
    await raiseAllowanceNonceWatermark(84532, '0xSAFE', '0xDeLeGaTe', '0xTOKEN', 7, stub)

    expect(stub.query.mock.calls[0][1]).toEqual([84532, '0xsafe', '0xdelegate', '0xtoken', 7])
  })

  it('lower-cases the triple on the READ, so a mis-cased lookup still finds the row', async () => {
    const stub = db(() => ({ rows: [{ nonce: '9' }] }))
    expect(await findAllowanceNonceWatermark(84532, '0xSAFE', '0xDELEGATE', '0xTOKEN', stub)).toBe(9)

    expect(stub.query.mock.calls[0][1]).toEqual([84532, '0xsafe', '0xdelegate', '0xtoken'])
  })

  it('only ever RAISES the watermark — GREATEST, never a plain assignment', () => {
    // A lower incoming value can only be a late write from a replica that fell
    // behind; honouring it would re-open the window this table closes.
    expect(UPSERT_ALLOWANCE_NONCE_WATERMARK_SQL).toMatch(
      /GREATEST\(allowance_nonce_watermarks\.nonce, EXCLUDED\.nonce\)/,
    )
  })

  it('IGNORES a stale row — a too-high watermark must not be permanent', () => {
    // GREATEST means a bad row can never come down. Backed by one confirmation,
    // a reorg can persist a nonce the chain never reaches, and every later
    // authorize for that triple would poll to the full timeout forever. The
    // window this tier closes is seconds-scale, so an old row carries no
    // information anyway.
    expect(FIND_ALLOWANCE_NONCE_WATERMARK_SQL).toMatch(/updated_at > NOW\(\) - INTERVAL '5 minutes'/)
  })

  it('returns null instead of throwing when the read fails', async () => {
    const broken = { query: vi.fn(async () => { throw new Error('db down') }) }
    expect(await findAllowanceNonceWatermark(84532, '0xa', '0xb', '0xc', broken as never)).toBeNull()
  })

  it('swallows a failing write — a lost watermark costs a retry, not money', async () => {
    const broken = { query: vi.fn(async () => { throw new Error('db down') }) }
    await expect(
      raiseAllowanceNonceWatermark(84532, '0xa', '0xb', '0xc', 5, broken as never),
    ).resolves.toBeUndefined()
  })

  it('returns null for an unknown triple rather than 0 — absent is not zero', async () => {
    const stub = db(() => ({ rows: [] }))
    expect(await findAllowanceNonceWatermark(84532, '0xa', '0xb', '0xc', stub)).toBeNull()
  })
})
