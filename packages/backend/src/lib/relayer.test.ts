import { describe, expect, it } from 'vitest'
import type { Provider } from 'ethers'
import { withRelayerSendLock, getRelayerFeeOverrides } from './relayer.js'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('withRelayerSendLock', () => {
  it('serialises concurrent submissions on the same chain', async () => {
    const events: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = withRelayerSendLock(8453, async () => {
      events.push('first:start')
      await firstGate
      events.push('first:end')
      return 1
    })
    const second = withRelayerSendLock(8453, async () => {
      events.push('second:start')
      return 2
    })

    // The second submission must not start while the first holds the lock.
    await tick()
    expect(events).toEqual(['first:start'])

    releaseFirst()
    await expect(first).resolves.toBe(1)
    await expect(second).resolves.toBe(2)
    expect(events).toEqual(['first:start', 'first:end', 'second:start'])
  })

  it('does not serialise across different chains', async () => {
    const events: string[] = []
    let releaseBase!: () => void
    const baseGate = new Promise<void>((resolve) => {
      releaseBase = resolve
    })

    const base = withRelayerSendLock(8453, async () => {
      events.push('base:start')
      await baseGate
      return 'base'
    })
    const gnosis = withRelayerSendLock(100, async () => {
      events.push('gnosis:start')
      return 'gnosis'
    })

    // Gnosis must run even while the Base lock is held.
    await expect(gnosis).resolves.toBe('gnosis')
    expect(events).toContain('gnosis:start')

    releaseBase()
    await expect(base).resolves.toBe('base')
  })

  it('a failed submission does not poison the lock for the next one', async () => {
    await expect(
      withRelayerSendLock(8453, async () => {
        throw new Error('nonce too low')
      }),
    ).rejects.toThrow('nonce too low')

    await expect(withRelayerSendLock(8453, async () => 'recovered')).resolves.toBe(
      'recovered',
    )
  })
})

describe('getRelayerFeeOverrides', () => {
  function providerWithFeeData(feeData: {
    maxFeePerGas: bigint | null
    maxPriorityFeePerGas: bigint | null
  }): Provider {
    return { getFeeData: async () => feeData } as unknown as Provider
  }

  it('doubles maxFeePerGas and keeps the priority fee on EIP-1559 chains', async () => {
    const overrides = await getRelayerFeeOverrides(
      providerWithFeeData({ maxFeePerGas: 100n, maxPriorityFeePerGas: 2n }),
    )
    expect(overrides).toEqual({ maxFeePerGas: 200n, maxPriorityFeePerGas: 2n })
  })

  it('returns no overrides on non-1559 fee data so legacy defaults apply', async () => {
    const overrides = await getRelayerFeeOverrides(
      providerWithFeeData({ maxFeePerGas: null, maxPriorityFeePerGas: null }),
    )
    expect(overrides).toEqual({})
  })
})
