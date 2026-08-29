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
