import { randomUUID } from 'node:crypto'

/**
 * A distinct x402 idempotency key per purchase attempt (#1520).
 *
 * WHY THE DEFAULT IS WRONG **HERE**. With no key supplied, the SDK synthesises
 * one (`buildX402IdempotencyKey`) from the merchant resource, payTo, asset,
 * amount, network — and a **5-minute time bucket**:
 *
 *     const bucket = Math.floor(now / 300_000)
 *
 * That is right for its purpose: a client that retries the *same* HTTP request
 * must not pay twice. But it cannot distinguish that from a **second, genuine
 * purchase of the same product**, and the money-flow harness makes exactly that
 * second kind of request — `qa-dev.yml` re-runs the whole suite ~2 minutes
 * after any failure, so attempt 2 buys `vpn_basic` again.
 *
 * When both attempts land in one bucket the backend returns attempt 1's payment
 * — already funded, already spent — and the SDK signs a FRESH EIP-3009
 * authorization against a delegate whose USDC has already reached the merchant.
 * The merchant then correctly refuses: `Payer … holds 0 USDC units but the
 * authorization requires 1000`.
 *
 * That is why these legs were intermittent rather than broken. On 2026-08-17
 * the 12:43 run straddled a bucket boundary, funded twice, and PASSED; the
 * 13:10 and 13:25 runs did not, funded once, and FAILED — matching the on-chain
 * transfer history exactly.
 *
 * Each attempt is a real purchase, so it gets a real key. This does not weaken
 * idempotency: it states the harness's actual intent instead of inheriting a
 * heuristic built for a different one.
 *
 * NOTE the product question this leaves open: a live agent buying the same item
 * twice inside five minutes hits the same collapse, and the second purchase
 * fails rather than being charged twice. Tracked separately — the harness must
 * not paper over it, which is why this helper is scoped to the QA legs and the
 * SDK default is untouched.
 */
export function freshPurchaseIdempotencyKey(scenario: string): string {
  return `qa:${scenario}:${randomUUID()}`
}
