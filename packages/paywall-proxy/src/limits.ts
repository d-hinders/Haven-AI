/**
 * The proxy's request limits (docs/architecture/12-merchant-kit.md §7,
 * "Limiting unpaid requests"):
 *
 * - per client IP, a token bucket for unpaid requests and for payment headers
 *   that fail verification (60 a minute, a burst of 10), and at most 10
 *   concurrent unpaid requests;
 * - two global caps on the merchant's own cost: 16 concurrent verify calls
 *   (taken without waiting, before `reserve`) and 32 concurrent upstream calls
 *   (waited for up to 10 s, after verify and before settle).
 *
 * A header that verifies is never counted against an IP, and a request whose
 * header matches a known key's digest is never answered 429: every hosted
 * Haven buyer reaches the merchant from one shared address.
 */

export interface LimitSettings {
  unpaidPerMinute: number
  unpaidBurst: number
  unpaidConcurrentPerIp: number
  verifyConcurrency: number
  upstreamConcurrency: number
  upstreamSlotWaitMs: number
}

export const DEFAULT_LIMITS: LimitSettings = {
  unpaidPerMinute: 60,
  unpaidBurst: 10,
  unpaidConcurrentPerIp: 10,
  verifyConcurrency: 16,
  upstreamConcurrency: 32,
  upstreamSlotWaitMs: 10_000,
}

/** Above this many tracked addresses, idle ones with a full bucket are dropped. */
const PRUNE_ABOVE = 10_000

interface Bucket {
  tokens: number
  at: number
  active: number
}

export class IpLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private readonly perMs: number

  constructor(
    private readonly settings: Pick<LimitSettings, 'unpaidPerMinute' | 'unpaidBurst' | 'unpaidConcurrentPerIp'>,
    private readonly clock: () => number = () => performance.now(),
  ) {
    this.perMs = settings.unpaidPerMinute / 60_000
  }

  private bucket(ip: string): Bucket {
    const t = this.clock()
    let b = this.buckets.get(ip)
    if (!b) {
      if (this.buckets.size >= PRUNE_ABOVE) this.prune(t)
      b = { tokens: this.settings.unpaidBurst, at: t, active: 0 }
      this.buckets.set(ip, b)
      return b
    }
    b.tokens = Math.min(this.settings.unpaidBurst, b.tokens + (t - b.at) * this.perMs)
    b.at = t
    return b
  }

  private prune(t: number): void {
    for (const [ip, b] of this.buckets) {
      const tokens = Math.min(this.settings.unpaidBurst, b.tokens + (t - b.at) * this.perMs)
      if (b.active === 0 && tokens >= this.settings.unpaidBurst) this.buckets.delete(ip)
    }
  }

  private retryAfter(b: Bucket): number {
    return Math.max(1, Math.ceil((1 - b.tokens) / this.perMs / 1000))
  }

  /** Take one token for an unpaid request. Returns the seconds to wait when the IP is over the limit, else null. */
  take(ip: string): number | null {
    const b = this.bucket(ip)
    if (b.tokens < 1) return this.retryAfter(b)
    b.tokens -= 1
    return null
  }

  /** Whether the IP is over the limit, without taking a token (an unknown-key payment header, before it is reserved). */
  over(ip: string): number | null {
    const b = this.bucket(ip)
    return b.tokens < 1 ? this.retryAfter(b) : null
  }

  /** Count a payment header that failed verification against the IP. */
  charge(ip: string): void {
    const b = this.bucket(ip)
    b.tokens = Math.max(0, b.tokens - 1)
  }

  /** Enter an unpaid request; false when the IP already has the maximum in flight. */
  enter(ip: string): boolean {
    const b = this.bucket(ip)
    if (b.active >= this.settings.unpaidConcurrentPerIp) return false
    b.active += 1
    return true
  }

  leave(ip: string): void {
    const b = this.buckets.get(ip)
    if (b && b.active > 0) b.active -= 1
  }

  /** Tests only. */
  size(): number {
    return this.buckets.size
  }
}

/** One held unit of a gate. Releasing it twice gives back one unit. */
export interface Permit {
  release(): void
}

/** A counting gate: at most `capacity` permits held at once. */
export class Gate {
  private held = 0
  private readonly waiting: { grant: (permit: Permit) => void }[] = []

  constructor(private readonly capacity: number) {}

  private permit(): Permit {
    this.held += 1
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        const next = this.waiting.shift()
        if (next) {
          // Hand the unit straight to the next waiter: `held` is unchanged.
          this.held -= 1
          next.grant(this.permit())
          return
        }
        this.held -= 1
      },
    }
  }

  /** A permit now, or null when the gate is full. */
  tryAcquire(): Permit | null {
    if (this.held >= this.capacity) return null
    return this.permit()
  }

  /** A permit within `waitMs`, or null when none came free in time. */
  acquire(waitMs: number): Promise<Permit | null> {
    const now = this.tryAcquire()
    if (now) return Promise.resolve(now)
    return new Promise((resolve) => {
      const entry = {
        grant: (permit: Permit) => {
          clearTimeout(timer)
          resolve(permit)
        },
      }
      const timer = setTimeout(() => {
        const index = this.waiting.indexOf(entry)
        if (index >= 0) this.waiting.splice(index, 1)
        resolve(null)
      }, waitMs)
      this.waiting.push(entry)
    })
  }

  /** Tests and logs. */
  inUse(): number {
    return this.held
  }
}
