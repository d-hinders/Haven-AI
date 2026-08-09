/**
 * Allowance-nonce coordinator (#692, cross-replica since #718).
 *
 * Sequential allowance transfers for the same delegate share one on-chain nonce.
 * When a prior transfer's nonce increment hasn't propagated to the RPC the next
 * `sign_hash` is built from, the new signature targets an already-consumed nonce
 * and the transfer reverts ("transfer amount exceeds balance" / no reason).
 *
 * This tracks the nonce a confirmed transfer left on-chain, so the next build
 * **waits until that nonce is visible** before signing — turning the reactive
 * retry (#693 preflight + #695 retry) into a proactive wait that avoids the
 * revert in the first place. The #693 preflight + #695 retry remain the safety
 * net under all conditions; nothing here is load-bearing for correctness.
 *
 * ## Two tiers, since #718
 *
 * The tracker used to be a process-local `Map`, which is exactly right for one
 * replica and silently narrower for two: replica B knows nothing about the
 * transfer replica A just confirmed, so it reads a stale nonce and signs
 * against a consumed one. Safe (the preflight catches it), but back to the
 * revert-and-retry #692 existed to remove.
 *
 * So the map stays as tier 1 and a Postgres watermark joins it as tier 2:
 *
 * - **Local map** — free, synchronous, and survives a database outage. It is
 *   what the common single-replica path still runs on.
 * - **Shared watermark** — one indexed row per (chain, safe, delegate, token),
 *   consulted alongside the map so any replica waits on the highest nonce ANY
 *   replica has confirmed.
 *
 * The wait target is the max of the two. Every database interaction is
 * **fail-open** (see the repository's header): a read that errors contributes
 * nothing and a write that errors is dropped, which degrades this to exactly
 * its pre-#718 behaviour rather than blocking a payment. Trading a rare retry
 * for an outage would be the wrong direction on a money path.
 */

import {
  findAllowanceNonceWatermark,
  raiseAllowanceNonceWatermark,
} from '../infra/repositories/allowance-nonce-watermarks.js'

const latestNonce = new Map<string, number>()

/**
 * The shared tier, injectable so tests can drive both halves without a
 * database — the same shape as the `db: Executor = pool` convention used by
 * the repositories.
 */
export interface NonceWatermarkStore {
  raise: (
    chainId: number,
    safe: string,
    delegate: string,
    token: string,
    nonce: number,
  ) => Promise<void>
  find: (
    chainId: number,
    safe: string,
    delegate: string,
    token: string,
  ) => Promise<number | null>
}

const postgresStore: NonceWatermarkStore = {
  raise: raiseAllowanceNonceWatermark,
  find: findAllowanceNonceWatermark,
}

function keyOf(chainId: number, safe: string, delegate: string, token: string): string {
  return `${chainId}:${safe.toLowerCase()}:${delegate.toLowerCase()}:${token.toLowerCase()}`
}

/**
 * Record the allowance nonce observed after a **confirmed** transfer. The next
 * build for the same delegate must reach at least this value before signing.
 */
export function recordAllowanceNonce(
  chainId: number,
  safe: string,
  delegate: string,
  token: string,
  nonce: number,
  store: NonceWatermarkStore = postgresStore,
): void {
  const key = keyOf(chainId, safe, delegate, token)
  const prev = latestNonce.get(key)
  if (prev === undefined || nonce > prev) latestNonce.set(key, nonce)

  // Fire-and-forget, matching this function's existing contract: it is called
  // right after a confirmed transfer, on a path that must not grow an await
  // (and must not fail) for a bookkeeping write. The store swallows its own
  // errors; the catch here covers a synchronous throw from a bad store.
  try {
    void store.raise(chainId, safe, delegate, token, nonce).catch(() => {})
  } catch {
    /* fail-open — see the file header */
  }
}

export interface FreshNonceOptions {
  timeoutMs?: number
  intervalMs?: number
  /** Bound on the shared-tier lookup; see `DEFAULT_SHARED_READ_TIMEOUT_MS`. */
  sharedReadTimeoutMs?: number
  /**
   * A watermark the caller already read (#1196), e.g. alongside its on-chain
   * reads. Supplying it skips the lookup here entirely, so the shared tier
   * costs no serial round trip on the request path. `null` means "read it and
   * there was none" — distinct from `undefined`, "I did not read it".
   */
  sharedWatermark?: number | null
}

/**
 * Deliberately short. Losing the shared watermark costs at most one
 * revert-and-retry — the outcome this tier exists to make rarer, not the one
 * it must prevent — so waiting on a struggling database is never the better
 * trade. The on-chain read that follows takes longer than this on a good day.
 */
export const DEFAULT_SHARED_READ_TIMEOUT_MS = 250

/** Resolve `null` if `promise` has not settled within `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms)
        // Never hold the process open for a best-effort read.
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Resolve the allowance nonce to sign against. Given the already-read `initial`
 * nonce, return it immediately unless a recorded post-transfer nonce for this
 * delegate is higher — only then poll `read` until that nonce is visible (so a
 * lagging RPC can't make us sign a stale nonce). Re-reads happen ONLY while
 * waiting, so the common (non-stale) path costs no extra RPC call. Falls back to
 * the latest read on timeout, so a lagging RPC can never block a payment.
 */
export async function waitForFreshAllowanceNonce(
  chainId: number,
  safe: string,
  delegate: string,
  token: string,
  initial: number,
  read: () => Promise<number>,
  opts: FreshNonceOptions = {},
  store: NonceWatermarkStore = postgresStore,
): Promise<number> {
  const local = latestNonce.get(keyOf(chainId, safe, delegate, token))

  // The shared tier is consulted even when the local map already knows a value:
  // another replica may have confirmed a LATER transfer, and waiting for the
  // lower of the two would sign against a nonce that replica already consumed.
  // One indexed lookup on the money path, and it returns null rather than
  // throwing if the database is unavailable.
  // Guarded HERE as well as in the repository, and BOUNDED as well as guarded.
  //
  // The repository catches its own errors, but that makes fail-open a
  // convention two files have to remember rather than a property of this path.
  // And catching is only half of it: a rejection is the easy failure. The one
  // that matters is a query that is slow and never rejects — a wedged
  // connection, a partition after the socket is up, an overloaded database.
  // Nothing else would stop it: the pool sets no `statement_timeout` and
  // Fastify sets no request timeout, so an unbounded await here would hang a
  // payment that used to do no I/O on this path at all. Strictly worse than
  // before, which this whole tier must never be.
  // `Promise.resolve().then(...)` rather than calling `store.find` directly:
  // `.catch()` only attaches once a call has RETURNED, so a store that throws
  // synchronously would escape it entirely and surface as a 500 on the money
  // path (the call site does not wrap this). Unreachable with the real
  // repository — it is `async`, so it cannot throw synchronously — but that is
  // the kind of guarantee that holds until someone writes a different store,
  // which is exactly the convention-two-files-must-remember this tier argues
  // against. `recordAllowanceNonce` already guards its own write this way.
  const shared =
    opts.sharedWatermark !== undefined
      ? opts.sharedWatermark
      : await withTimeout(
          Promise.resolve()
            .then(() => store.find(chainId, safe, delegate, token))
            .catch(() => null),
          opts.sharedReadTimeoutMs ?? DEFAULT_SHARED_READ_TIMEOUT_MS,
        )

  const candidates = [local, shared].filter((n): n is number => typeof n === 'number')
  const want = candidates.length > 0 ? Math.max(...candidates) : undefined
  if (want === undefined || initial >= want) return initial

  const timeoutMs = opts.timeoutMs ?? 15_000
  const intervalMs = opts.intervalMs ?? 1_500
  const deadline = Date.now() + timeoutMs
  let nonce = initial
  while (nonce < want && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
    nonce = await read()
  }
  return nonce
}

/**
 * Read the shared watermark for a delegate, bounded and fail-open (#1196).
 *
 * The prefetch counterpart to `waitForFreshAllowanceNonce`'s inline read: call
 * this alongside the on-chain reads a handler already does — every one of the
 * four sign-hash builders has a `Promise.all([getTokenAllowance,
 * getLatestBlockTimeSec])` — and hand the result over as
 * `opts.sharedWatermark`. Concurrent with reads that take far longer, the
 * lookup costs nothing measurable; done inline it is a serial round trip on
 * the request path.
 *
 * The bound and the guards live HERE, not at the four call sites, so no site
 * can prefetch and forget them. Returns `null` on any failure — the caller
 * then behaves exactly as it did before the shared tier existed.
 */
export async function readSharedWatermark(
  chainId: number,
  safe: string,
  delegate: string,
  token: string,
  opts: { timeoutMs?: number } = {},
  store: NonceWatermarkStore = postgresStore,
): Promise<number | null> {
  return withTimeout(
    Promise.resolve()
      .then(() => store.find(chainId, safe, delegate, token))
      .catch(() => null),
    opts.timeoutMs ?? DEFAULT_SHARED_READ_TIMEOUT_MS,
  )
}

/** Test-only: clear the in-process tracker. */
export function __resetAllowanceNonceCoordinator(): void {
  latestNonce.clear()
}
