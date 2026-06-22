import { describe, it, expect, vi } from 'vitest'

// resolvePaymentToken is pure over static chain config, but machine-payments.ts
// imports the db pool at module load — stub it so this unit test needs no DB.
vi.mock('../../db.js', () => ({ default: { query: vi.fn() } }))

import { resolvePaymentToken } from '../machine-payments.js'

describe('resolvePaymentToken', () => {
  const BASE = 8453
  const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

  it('resolves a known ERC20 token to its config and AllowanceModule address', () => {
    const r = resolvePaymentToken(BASE, USDC)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.tokenConfig.symbol).toBeTruthy()
      expect(r.tokenAddress.toLowerCase()).toBe(USDC.toLowerCase())
    }
  })

  it('returns a structured error listing supported tokens for an unknown asset', () => {
    const r = resolvePaymentToken(BASE, '0x000000000000000000000000000000000000dEaD')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('Unsupported token asset')
      expect(r.supported.length).toBeGreaterThan(0)
      expect(r.supported[0]).toHaveProperty('symbol')
      expect(r.supported[0]).toHaveProperty('address')
    }
  })
})
