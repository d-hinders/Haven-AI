/**
 * In-process allowance-nonce coordinator (#692).
 *
 * Sequential allowance transfers for the same delegate share one on-chain nonce.
 * When a prior transfer's nonce increment hasn't propagated to the RPC the next
 * `sign_hash` is built from, the new signature targets an already-consumed nonce
 * and the transfer reverts ("transfer amount exceeds balance" / no reason).
 *
 * This tracks the nonce a confirmed transfer left on-chain, so the next build
 * **waits until that nonce is visible** before signing — turning the reactive
 * retry (#693 preflight + #695 retry) into a proactive wait that avoids the
 * revert in the first place. It is best-effort and **in-process** (one replica);
 * the preflight + retry remain the cross-replica / concurrency safety net.
 */

const latestNonce = new Map<string, number>()

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
): void {
  const key = keyOf(chainId, safe, delegate, token)
  const prev = latestNonce.get(key)
  if (prev === undefined || nonce > prev) latestNonce.set(key, nonce)
}

export interface FreshNonceOptions {
  timeoutMs?: number
  intervalMs?: number
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
): Promise<number> {
  const want = latestNonce.get(keyOf(chainId, safe, delegate, token))
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

/** Test-only: clear the in-process tracker. */
export function __resetAllowanceNonceCoordinator(): void {
  latestNonce.clear()
}
