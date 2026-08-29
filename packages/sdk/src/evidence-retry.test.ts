/**
 * The evidence report retries a RETRYABLE refusal (#2117, AC 3).
 *
 * The backend already distinguishes two refusals on `POST
 * /machine-payments/evidence`: `503` (`settlement_unobservable`) means "not
 * known yet — ask again", `409` means "that is a settled no". The SDK threw
 * both away in one bare `catch {}`. On erc7710 that report is the ONLY thing
 * that produces an evidence row, so a settlement that merely had not been mined
 * yet at report time meant the payment never entered the user's books at all.
 *
 * These tests are about the DISTINCTION, in both directions: the retryable one
 * is retried, and the terminal ones are not — a retry loop against a settled no
 * would be pure noise on a path that must never delay a completed payment.
 */
import { describe, expect, it, vi } from 'vitest'
import { MerchantCompletion } from './merchant-completion.js'
import { HavenApiError } from './types.js'

function completionWith(post: ReturnType<typeof vi.fn>) {
  const sleep = vi.fn(async (_ms: number) => {})
  const completion = new MerchantCompletion({
    post: post as never,
    merchantTransport: {} as never,
    getPaymentStatus: (async () => ({})) as never,
    getAgent: async () => ({}),
    delegateAddress: undefined,
    x402Wallet: undefined,
    sleep,
  })
  return { completion, sleep }
}

const report = (completion: MerchantCompletion) =>
  completion.reportEvidence({
    paymentId: 'pay_1',
    rail: 'x402',
    txHash: `0x${'ab'.repeat(32)}`,
    resourceUrl: 'https://merchant.example/paid',
    merchantStatus: 200,
  })

describe('evidence reporting retries a retryable refusal (#2117)', () => {
  it('AC 3: a 503 settlement_unobservable is RETRIED, and the payment lands on the retry', async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce(new HavenApiError('settlement_unobservable', 503))
      .mockResolvedValueOnce({ ok: true })
    const { completion, sleep } = completionWith(post)

    await report(completion)

    expect(post).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(1)
    // Same body both times — a retry, not a different report.
    expect(post.mock.calls[0]).toEqual(post.mock.calls[1])
  })

  it('backs off between attempts and gives up after a bounded number of them', async () => {
    const post = vi.fn().mockRejectedValue(new HavenApiError('settlement_unobservable', 503))
    const { completion, sleep } = completionWith(post)

    await expect(report(completion)).resolves.toBeUndefined()

    // Bounded: four attempts total, never an unbounded loop against a dead chain.
    expect(post).toHaveBeenCalledTimes(4)
    // Increasing backoff, so the retries are spread rather than hammered.
    const waits = sleep.mock.calls.map((c) => c[0])
    expect(waits).toEqual([1_000, 2_000, 4_000])
  })

  it('a TERMINAL 409 is not retried — that is a settled no, not a "later"', async () => {
    const post = vi.fn().mockRejectedValue(new HavenApiError('settlement_unverified', 409))
    const { completion, sleep } = completionWith(post)

    await report(completion)

    expect(post).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  // #2136, absorbed from PR #2134's `merchant-completion.test.ts`: 409 is not
  // the only terminal refusal the endpoint can answer with. The predicate is
  // an equality on 503 rather than a "5xx retryable" rule, so these already
  // pass — the point is that they are PINNED, because the tempting widening
  // ("retry anything that isn't a 409") would silently start retrying a
  // rejected body or an unknown payment id forever on a path that must never
  // delay a completed payment.
  it.each([
    [400, 'a validation refusal — the body will never become acceptable'],
    [404, 'an unknown payment id — no later attempt can make it exist'],
  ])('a terminal %i is not retried: %s', async (status) => {
    const post = vi.fn().mockRejectedValue(new HavenApiError('refused', status))
    const { completion, sleep } = completionWith(post)

    await report(completion)

    expect(post).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  // Also from #2134. Distinct from the plain-`Error` case below: this IS a
  // `HavenApiError`, so it passes the first half of the retry predicate and is
  // stopped only by the status equality. A transport failure carries
  // `statusCode` 0 — the server never answered, so there is no refusal to
  // classify, and retrying it here would duplicate the transport's own
  // retry policy at a layer that cannot see it.
  it('a transport-level HavenApiError (statusCode 0) is not retried', async () => {
    const post = vi
      .fn()
      .mockRejectedValue(
        new HavenApiError('Request to /machine-payments/evidence failed: ECONNREFUSED', 0),
      )
    const { completion, sleep } = completionWith(post)

    await expect(report(completion)).resolves.toBeUndefined()

    expect(post).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('a non-HTTP failure is not retried, and never surfaces to the caller', async () => {
    const post = vi.fn().mockRejectedValue(new Error('socket hang up'))
    const { completion } = completionWith(post)

    await expect(report(completion)).resolves.toBeUndefined()
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('POSITIVE CONTROL: a first-attempt success posts exactly once and waits for nothing', async () => {
    const post = vi.fn().mockResolvedValue({ ok: true })
    const { completion, sleep } = completionWith(post)

    await report(completion)

    expect(post).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })
})
