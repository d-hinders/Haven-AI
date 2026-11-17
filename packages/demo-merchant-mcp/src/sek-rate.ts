/**
 * #4856: the USDC→SEK rate the receipt for the Stripe-recorded product states.
 *
 * The receipt is built before Stripe is contacted (#4880), so Stripe's own
 * SEK figure never exists when the merchant answers, and the merchant never
 * waits for Stripe (#4853). What the receipt can state instead is an
 * indicative rate with its source and time, read from a cache this module
 * keeps warm in the background. The purchase path only reads the cache
 * (`current()`), synchronously: a slow, failing or unreachable rate source can
 * never delay or refuse the goods. With no fresh rate cached, the receipt says
 * the SEK amount was not available at the time of purchase — it never
 * estimates one.
 *
 * The source is CoinGecko's spot price for USD Coin in SEK, the same source
 * and provenance string Haven's backend records for its own SEK values
 * (`FX_SOURCE_SPOT = 'coingecko_spot'`, `packages/backend/src/infra/fiat-values.ts`).
 */

/** Provenance string printed on the receipt; matches the backend's. */
export const SEK_RATE_SOURCE = 'coingecko_spot' as const

/** CoinGecko's public simple-price endpoint for USDC in SEK. */
export const SEK_RATE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=sek'

/**
 * How often the cache is refreshed. Well above Railway's ~10-minute idle
 * threshold, so the refresh alone does not keep a sleeping service awake; a
 * woken service restarts and reads a fresh rate at startup (`start()`).
 */
export const SEK_RATE_REFRESH_MS = 30 * 60_000

/**
 * How old a cached rate may be and still be printed. Past this the receipt
 * says "not available" rather than state a stale rate as current.
 */
export const SEK_RATE_MAX_AGE_MS = 60 * 60_000

/** One fetch is abandoned after this long; the previous rate is kept. */
export const SEK_RATE_FETCH_TIMEOUT_MS = 10_000

/** A rate the receipt may state. */
export interface SekRate {
  /** SEK per 1 USDC, as the source gave it. */
  rate: number
  source: typeof SEK_RATE_SOURCE
  /** When this merchant read the rate. */
  fetchedAt: Date
}

export interface SekRateFeed {
  /** The cached rate when it is fresh, else `undefined`. Never fetches. */
  current(): SekRate | undefined
  /** Fetch once now; resolves when done. Never rejects. */
  refresh(): Promise<void>
  /** Fetch now and then every `refreshMs`. Idempotent. */
  start(): void
  stop(): void
}

export interface SekRateFeedOptions {
  fetchImpl?: typeof fetch
  now?: () => Date
  refreshMs?: number
  maxAgeMs?: number
  timeoutMs?: number
}

/** Parse CoinGecko's `{ "usd-coin": { "sek": <number> } }`; `undefined` on anything else. */
export function parseSekRate(body: unknown): number | undefined {
  if (!body || typeof body !== 'object') return undefined
  const coin = (body as Record<string, unknown>)['usd-coin']
  if (!coin || typeof coin !== 'object') return undefined
  const sek = (coin as Record<string, unknown>).sek
  if (typeof sek !== 'number' || !Number.isFinite(sek) || sek <= 0) return undefined
  return sek
}

export function createSekRateFeed(opts: SekRateFeedOptions = {}): SekRateFeed {
  const fetchImpl = opts.fetchImpl ?? fetch
  const now = opts.now ?? (() => new Date())
  const refreshMs = opts.refreshMs ?? SEK_RATE_REFRESH_MS
  const maxAgeMs = opts.maxAgeMs ?? SEK_RATE_MAX_AGE_MS
  const timeoutMs = opts.timeoutMs ?? SEK_RATE_FETCH_TIMEOUT_MS
  let cached: SekRate | undefined
  let timer: ReturnType<typeof setInterval> | undefined

  async function refresh(): Promise<void> {
    try {
      const res = await fetchImpl(SEK_RATE_URL, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) return
      const rate = parseSekRate(await res.json())
      if (rate === undefined) return
      cached = { rate, source: SEK_RATE_SOURCE, fetchedAt: now() }
    } catch {
      // Keep the previous rate; it ages out on its own.
    }
  }

  return {
    current() {
      if (!cached) return undefined
      return now().getTime() - cached.fetchedAt.getTime() <= maxAgeMs ? cached : undefined
    },
    refresh,
    start() {
      if (timer) return
      void refresh()
      timer = setInterval(() => void refresh(), refreshMs)
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
    },
  }
}
