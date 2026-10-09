import { renderHook, act } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useChainScope, inScope } from '@/hooks/useChainScope'

const BASE = 8453
const SEPOLIA = 84532

describe('useChainScope', () => {
  it('inScope: a specific chain matches only itself, "all" matches everything', () => {
    expect(inScope(BASE, BASE)).toBe(true)
    expect(inScope(SEPOLIA, BASE)).toBe(false)
    expect(inScope(BASE, 'all')).toBe(true)
    expect(inScope(SEPOLIA, 'all')).toBe(true)
  })

  it('defaults to all chains, with the chain filter as an opt-in (#3719)', () => {
    const { result } = renderHook(() => useChainScope())
    expect(result.current.scope).toBe('all')

    act(() => result.current.setScope(SEPOLIA))
    expect(result.current.scope).toBe(SEPOLIA)

    act(() => result.current.setScope('all'))
    expect(result.current.scope).toBe('all')
  })
})
