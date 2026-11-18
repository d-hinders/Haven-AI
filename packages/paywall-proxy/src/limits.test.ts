import { describe, expect, it } from 'vitest'
import { DEFAULT_LIMITS, Gate, IpLimiter } from './limits.js'

describe('the design limits (§7)', () => {
  it('are 60 a minute with a burst of 10 and 10 concurrent unpaid per address, 16 verifies, 32 upstream calls and a 10 s slot wait', () => {
    expect(DEFAULT_LIMITS).toEqual({
      unpaidPerMinute: 60,
      unpaidBurst: 10,
      unpaidConcurrentPerIp: 10,
      verifyConcurrency: 16,
      upstreamConcurrency: 32,
      upstreamSlotWaitMs: 10_000,
    })
  })
})

describe('IpLimiter', () => {
  it('allows a burst, then refills at the per-minute rate, per address', () => {
    let t = 0
    const limiter = new IpLimiter({ unpaidPerMinute: 60, unpaidBurst: 10, unpaidConcurrentPerIp: 10 }, () => t)
    for (let i = 0; i < 10; i++) expect(limiter.take('a')).toBeNull()
    expect(limiter.take('a')).toBe(1)
    expect(limiter.take('b')).toBeNull()
    t += 999
    expect(limiter.over('a')).toBe(1)
    t += 1
    expect(limiter.over('a')).toBeNull()
    expect(limiter.take('a')).toBeNull()
    expect(limiter.take('a')).not.toBeNull()
  })

  it('over() takes no token; charge() takes one and never goes below empty', () => {
    let t = 0
    const limiter = new IpLimiter({ unpaidPerMinute: 60, unpaidBurst: 2, unpaidConcurrentPerIp: 10 }, () => t)
    expect(limiter.over('a')).toBeNull()
    expect(limiter.over('a')).toBeNull()
    limiter.charge('a')
    limiter.charge('a')
    limiter.charge('a')
    expect(limiter.over('a')).toBe(1)
    t += 1000
    expect(limiter.over('a')).toBeNull()
  })

  it('bounds concurrent unpaid requests per address', () => {
    const limiter = new IpLimiter({ unpaidPerMinute: 60, unpaidBurst: 10, unpaidConcurrentPerIp: 2 })
    expect(limiter.enter('a')).toBe(true)
    expect(limiter.enter('a')).toBe(true)
    expect(limiter.enter('a')).toBe(false)
    expect(limiter.enter('b')).toBe(true)
    limiter.leave('a')
    expect(limiter.enter('a')).toBe(true)
  })

  it('drops idle addresses with a full bucket once it tracks many, and keeps busy ones', () => {
    let t = 0
    const limiter = new IpLimiter({ unpaidPerMinute: 60, unpaidBurst: 10, unpaidConcurrentPerIp: 10 }, () => t)
    limiter.take('busy')
    limiter.enter('active')
    for (let i = 0; i < 9_998; i++) limiter.over(`ip-${i}`)
    expect(limiter.size()).toBe(10_000)
    limiter.over('one-more')
    // Everything idle and full went; the address still refilling and the one in flight stayed.
    expect(limiter.size()).toBe(3)
  })
})

describe('Gate', () => {
  it('holds at most its capacity, and releasing twice gives back one unit', () => {
    const gate = new Gate(2)
    const a = gate.tryAcquire()!
    const b = gate.tryAcquire()!
    expect(gate.tryAcquire()).toBeNull()
    a.release()
    a.release()
    expect(gate.inUse()).toBe(1)
    expect(gate.tryAcquire()).not.toBeNull()
    expect(gate.tryAcquire()).toBeNull()
    b.release()
  })

  it('a waiter gets the next released unit, and gives up after its wait', async () => {
    const gate = new Gate(1)
    const held = gate.tryAcquire()!
    const timedOut = gate.acquire(10)
    expect(await timedOut).toBeNull()
    const waiting = gate.acquire(1000)
    held.release()
    const granted = await waiting
    expect(granted).not.toBeNull()
    expect(gate.inUse()).toBe(1)
    granted!.release()
    expect(gate.inUse()).toBe(0)
  })
})
