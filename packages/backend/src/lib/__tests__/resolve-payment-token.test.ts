import { describe, it, expect, vi } from 'vitest'

// resolvePaymentToken is pure over static chain config, but machine-payments.ts
// imports the db pool at module load — stub it so this unit test needs no DB.
vi.mock('../../db.js', () => ({ default: { query: vi.fn() } }))

import { resolvePaymentToken } from '../machine-payments.js'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const GNOSIS = 100 // POC target chain
const BASE = 8453

describe('resolvePaymentToken', () => {
  it('resolves a known ERC20 on the POC chain (Gnosis EURe)', () => {
    const r = resolvePaymentToken(GNOSIS, '0xcB444e90D8198415266c6a2724b7900fb12FC56E')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.tokenConfig.symbol).toBe('EURe')
      expect(r.tokenAddress.toLowerCase()).toBe('0xcb444e90d8198415266c6a2724b7900fb12fc56e')
    }
  })

  it('resolves the native asset (ZERO_ADDRESS) to the native token config', () => {
    const r = resolvePaymentToken(GNOSIS, ZERO_ADDRESS)
    expect(r.ok).toBe(true)
    if (r.ok) {
      // Native tokens have address: null in the registry; tokenAddress falls
      // back to ZERO_ADDRESS for the AllowanceModule.
      expect(r.tokenConfig.symbol).toBe('xDAI')
      expect(r.tokenAddress).toBe(ZERO_ADDRESS)
    }
  })

  it('resolves a known ERC20 on Base (USDC) to its AllowanceModule address', () => {
    const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    const r = resolvePaymentToken(BASE, USDC)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.tokenConfig.symbol).toBe('USDC')
      expect(r.tokenAddress.toLowerCase()).toBe(USDC.toLowerCase())
    }
  })

  it('returns a structured error listing supported tokens for an unknown asset', () => {
    const r = resolvePaymentToken(GNOSIS, '0x000000000000000000000000000000000000dEaD')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('Unsupported token asset')
      expect(r.supported.length).toBeGreaterThan(0)
      expect(r.supported[0]).toHaveProperty('symbol')
      expect(r.supported[0]).toHaveProperty('address')
    }
  })
})
