/**
 * #4722 (epic #4718): the `haven-passport` x402 extension.
 *
 * One merge rule (`withHavenPassportExtension`) serves the SDK's EIP-3009
 * envelope and the backend's erc7710 header. This file pins the rule's case
 * table, the envelope's byte identity for callers that pass no passport (the
 * signer), and the funding leg's bounded, advertised-only read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HAVEN_PASSPORT_EXTENSION,
  advertisesHavenPassport,
  withHavenPassportExtension,
  x402V2PaymentEnvelope,
} from './x402.js'
import { PASSPORT_READ_TIMEOUT_MS, X402FundingLeg } from './x402-funding-leg.js'
import type { X402PaymentOption, X402PaymentRequired } from './types.js'

const UID = `0x${'ab'.repeat(32)}`
const PASSPORT = { attestation_uid: UID, chain_id: 84532 }

describe('withHavenPassportExtension — the one merge rule (#4722)', () => {
  it('adds both fields at the top level of an advertised plain object', () => {
    const extensions = { 'haven-passport': { note: 'gated' } }
    expect(withHavenPassportExtension(extensions, PASSPORT)).toEqual({
      'haven-passport': { note: 'gated', attestation_uid: UID, chain_id: 84532 },
    })
  })

  it('adds both fields INSIDE an advertised `info` object, keeping every advertised field', () => {
    const extensions = { 'haven-passport': { info: { purpose: 'kyc-lite' }, schema: { type: 'object' } } }
    expect(withHavenPassportExtension(extensions, PASSPORT)).toEqual({
      'haven-passport': {
        info: { purpose: 'kyc-lite', attestation_uid: UID, chain_id: 84532 },
        schema: { type: 'object' },
      },
    })
  })

  // Spec-review finding 1: a merchant deep-compares the advertised value, so
  // any addition to a non-object, or replacing it, is a mismatch. These all
  // echo verbatim — the SAME reference, so the envelope bytes cannot move.
  it.each([
    ['true', true],
    ['a string', 'x'],
    ['an array', []],
    ['null', null],
    ['an object whose info is null', { info: null }],
    ['an object whose info is an array', { info: [] }],
    ['an object whose info already holds chain_id', { info: { chain_id: 1 } }],
    ['an object whose info already holds attestation_uid', { info: { attestation_uid: 'merchant-set' } }],
    ['an object already holding chain_id at the top level', { chain_id: 1 }],
    ['an object already holding attestation_uid at the top level', { attestation_uid: 'merchant-set' }],
  ])('echoes an advertised value that is %s byte-identical and adds nothing', (_label, advertised) => {
    const extensions = { bazaar: { info: { method: 'GET' } }, 'haven-passport': advertised }
    const before = JSON.stringify(extensions)
    const out = withHavenPassportExtension(extensions, PASSPORT)
    expect(out).toBe(extensions)
    expect(JSON.stringify(out)).toBe(before)
  })

  it.each([
    ['no passport', null],
    ['a malformed UID', { attestation_uid: '0x1234', chain_id: 84532 }],
    ['a zero chain id', { attestation_uid: UID, chain_id: 0 }],
    ['a fractional chain id', { attestation_uid: UID, chain_id: 1.5 }],
  ])('adds nothing for %s', (_label, passport) => {
    const extensions = { 'haven-passport': {} }
    expect(withHavenPassportExtension(extensions, passport as never)).toBe(extensions)
  })

  it('adds nothing when the merchant did not advertise the key, or sent no extensions', () => {
    const extensions = { bazaar: { info: { method: 'GET' } } }
    expect(withHavenPassportExtension(extensions, PASSPORT)).toBe(extensions)
    expect(withHavenPassportExtension(undefined, PASSPORT)).toBeUndefined()
    expect(withHavenPassportExtension(['haven-passport'], PASSPORT)).toEqual(['haven-passport'])
    expect(advertisesHavenPassport(extensions)).toBe(false)
    expect(advertisesHavenPassport({ [HAVEN_PASSPORT_EXTENSION]: {} })).toBe(true)
  })

  it('keeps every other extension byte-identical and in place', () => {
    const extensions = {
      bazaar: { info: { method: 'GET' } },
      'haven-passport': { info: {} },
      'sign-in-with-x': { info: { domain: 'm.test' } },
    }
    const out = withHavenPassportExtension(extensions, PASSPORT) as Record<string, unknown>
    expect(Object.keys(out)).toEqual(['bazaar', 'haven-passport', 'sign-in-with-x'])
    expect(JSON.stringify(out.bazaar)).toBe(JSON.stringify(extensions.bazaar))
    expect(JSON.stringify(out['sign-in-with-x'])).toBe(JSON.stringify(extensions['sign-in-with-x']))
    // The merchant's own object is never mutated.
    expect(extensions['haven-passport']).toEqual({ info: {} })
  })
})

const OPTION: X402PaymentOption = {
  scheme: 'exact',
  network: 'base-sepolia',
  amount: '1000',
  maxAmountRequired: '1000',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  payTo: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
  maxTimeoutSeconds: 60,
  extra: { name: 'USDC', version: '2' },
} as X402PaymentOption

function challenge(extensions?: Record<string, unknown>, x402Version = 2): X402PaymentRequired {
  return {
    x402Version,
    resource: { url: 'https://merchant.test/paid' },
    accepts: [OPTION],
    ...(extensions ? { extensions } : {}),
  } as X402PaymentRequired
}

describe('x402V2PaymentEnvelope — the passport is additive and optional (#4722)', () => {
  it("the signer's three-argument call yields today's bytes, even when the merchant advertises haven-passport", () => {
    const pr = challenge({ 'haven-passport': { info: {} }, bazaar: { info: { method: 'GET' } } })
    const envelope = x402V2PaymentEnvelope(pr, OPTION, { signature: '0xsig' })
    expect(JSON.stringify(envelope)).toBe(
      JSON.stringify({
        x402Version: 2,
        resource: pr.resource,
        accepted: OPTION,
        payload: { signature: '0xsig' },
        extensions: pr.extensions,
      }),
    )
  })

  it('carries the reference inside the advertised extension when a passport is passed', () => {
    const pr = challenge({ 'haven-passport': { info: {} } })
    const envelope = x402V2PaymentEnvelope(pr, OPTION, {}, { passport: PASSPORT })
    expect(envelope.extensions).toEqual({ 'haven-passport': { info: { attestation_uid: UID, chain_id: 84532 } } })
  })
})

function leg(readAgentPassport?: () => Promise<typeof PASSPORT | null>) {
  return new X402FundingLeg({
    delegateKey: `0x${'12'.repeat(32)}`,
    delegateAddress: '0x000000000000000000000000000000000000dEaD',
    x402Wallet: undefined,
    chainRpcs: {},
    post: vi.fn() as never,
    signForData: vi.fn() as never,
    assertSignableAuthorizationState: () => {},
    readAgentPassport,
  })
}

describe('funding leg — the passport read (#4722)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads the passport when the 402 advertises haven-passport', async () => {
    const read = vi.fn(async () => PASSPORT)
    expect(await leg(read).passportForChallenge(challenge({ 'haven-passport': {} }))).toEqual(PASSPORT)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('makes ZERO reads when the key is not advertised, or the challenge is v1', async () => {
    const read = vi.fn(async () => PASSPORT)
    expect(await leg(read).passportForChallenge(challenge({ bazaar: {} }))).toBeNull()
    expect(await leg(read).passportForChallenge(challenge())).toBeNull()
    expect(await leg(read).passportForChallenge(challenge({ 'haven-passport': {} }, 1))).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })

  it('a failed read answers null', async () => {
    const read = vi.fn(async () => {
      throw new Error('agent read failed')
    })
    expect(await leg(read).passportForChallenge(challenge({ 'haven-passport': {} }))).toBeNull()
  })

  it(`a hanging read answers null at the ${PASSPORT_READ_TIMEOUT_MS} ms bound, not later`, async () => {
    vi.useFakeTimers()
    const read = vi.fn(() => new Promise<typeof PASSPORT>(() => {}))
    const pending = leg(read).passportForChallenge(challenge({ 'haven-passport': {} }))
    let settled: unknown = 'pending'
    void pending.then((v) => {
      settled = v
    })
    await vi.advanceTimersByTimeAsync(PASSPORT_READ_TIMEOUT_MS - 1)
    expect(settled).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBeNull()
  })

  it('the minted header carries the reference only when one is passed', async () => {
    const pr = challenge({ 'haven-passport': { info: {} }, bazaar: { info: { method: 'GET' } } })
    const decode = (h: string) => JSON.parse(Buffer.from(h, 'base64').toString('utf8'))
    const withPassport = decode(await leg().createPaymentHeader(pr, OPTION, 'pay-1', PASSPORT))
    const without = decode(await leg().createPaymentHeader(pr, OPTION, 'pay-1'))
    expect(withPassport.extensions['haven-passport']).toEqual({ info: { attestation_uid: UID, chain_id: 84532 } })
    expect(JSON.stringify(without.extensions)).toBe(JSON.stringify(pr.extensions))
    expect(withPassport.extensions.bazaar).toEqual(pr.extensions!.bazaar)
  })

  // The wiring at the fresh mint: the reference reaches `createPaymentHeader`
  // on a fresh authorization, and an executed replay passes none (the funding
  // leg already ran, so a read would only widen a funded window).
  it('a fresh authorization mints with the passport; an executed replay mints without one and never reads', async () => {
    const pr = challenge({ 'haven-passport': {} })
    const stop = new Error('stop after mint')

    const freshRead = vi.fn(async () => PASSPORT)
    const fresh = leg(freshRead)
    ;(fresh as unknown as { post: unknown }).post = vi.fn(async () => ({ success: true, payment_id: 'pay-1' }))
    const freshMint = vi.spyOn(fresh, 'createPaymentHeader').mockRejectedValue(stop)
    await expect(fresh.authorize(pr, OPTION, 'idem-1')).rejects.toBe(stop)
    expect(freshMint).toHaveBeenCalledWith(pr, OPTION, 'pay-1', PASSPORT)

    const replayRead = vi.fn(async () => PASSPORT)
    const replay = leg(replayRead)
    ;(replay as unknown as { post: unknown }).post = vi.fn(async () => ({
      success: true,
      payment_id: 'pay-2',
      tx_hash: `0x${'cd'.repeat(32)}`,
      chain_id: 84532,
    }))
    vi.spyOn(replay, 'delegateCanFund').mockResolvedValue(true)
    const replayMint = vi.spyOn(replay, 'createPaymentHeader').mockRejectedValue(stop)
    await expect(replay.authorize(pr, OPTION, 'idem-2')).rejects.toBe(stop)
    expect(replayMint).toHaveBeenCalledWith(pr, OPTION, 'pay-2', null)
    expect(replayRead).not.toHaveBeenCalled()

    // The approval-resume shape of an executed replay (#4722 review, R8):
    // funding already ran there too, so no read either.
    const approvalRead = vi.fn(async () => PASSPORT)
    const approval = leg(approvalRead)
    ;(approval as unknown as { post: unknown }).post = vi.fn(async () => ({
      success: false,
      payment_id: 'pay-3',
      status: 'executed',
      phase: 'funding_sent',
      next_action: 'retry_original_x402_request',
      chain_id: 84532,
    }))
    vi.spyOn(approval, 'delegateCanFund').mockResolvedValue(true)
    const approvalMint = vi.spyOn(approval, 'createPaymentHeader').mockRejectedValue(stop)
    await expect(approval.authorize(pr, OPTION, 'idem-3')).rejects.toBe(stop)
    expect(approvalMint).toHaveBeenCalledWith(pr, OPTION, 'pay-3', null)
    expect(approvalRead).not.toHaveBeenCalled()
  })
})

describe('HavenClient wiring (#4722)', () => {
  it("the funding leg reads the agent's own passport through getAgent, as the two wire fields", async () => {
    const { HavenClient } = await import('./client.js')
    const haven = new HavenClient({ apiKey: 'sk_agent_test', delegateKey: `0x${'12'.repeat(32)}` })
    const internal = haven as unknown as {
      getAgent: () => Promise<unknown>
      fundingLeg: { readAgentPassport: () => Promise<unknown> }
    }
    internal.getAgent = async () => ({ passport: { attestationUid: UID, chainId: 84532, verifyUrl: 'https://h.test/v' } })
    expect(await internal.fundingLeg.readAgentPassport()).toEqual(PASSPORT)
    internal.getAgent = async () => ({ passport: null })
    expect(await internal.fundingLeg.readAgentPassport()).toBeNull()
  })
})

describe('resumeAuthorizedX402 carries no passport (#4722 review)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Spec-review finding 3: the resume re-mints AFTER the funding leg ran, so a
  // passport read there would widen a funded window. The decision is "no
  // reference on resume"; this pins it.
  it('never reads the passport and mints without one, even for a merchant that advertises haven-passport', async () => {
    const pr = challenge({ 'haven-passport': { info: {} } })
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      payment_id: 'approval-4722',
      kind: 'approval_request',
      rail: 'x402',
      status: 'executed',
      phase: 'funding_sent',
      next_action: 'retry_original_x402_request',
      amount: '0.001',
      token: 'USDC',
      resource_url: pr.resource.url,
      merchant_address: OPTION.payTo,
      tx_hash: `0x${'ab'.repeat(32)}`,
      expires_at: '2099-01-01T00:00:00.000Z',
      chain_id: 84532,
      message: 'Retry the original x402 request.',
    }), { status: 200 }))
    const { HavenClient } = await import('./client.js')
    const haven = new HavenClient({ apiKey: 'sk_agent_test', delegateKey: `0x${'01'.repeat(32)}`, baseUrl: 'https://haven.example' })
    // Structural, not `X402FundingLeg & …`: `readAgentPassport` is private on
    // the class, so the intersection would collapse to `never`.
    const fundingLeg = (haven as unknown as {
      fundingLeg: { readAgentPassport: unknown; createPaymentHeader: X402FundingLeg['createPaymentHeader'] }
    }).fundingLeg
    const read = vi.fn(async () => PASSPORT)
    fundingLeg.readAgentPassport = read
    const mint = vi.spyOn(fundingLeg, 'createPaymentHeader')

    await haven.resumeAuthorizedX402({ paymentId: 'approval-4722', paymentRequired: pr, idempotencyKey: 'resume-4722' })

    expect(read).not.toHaveBeenCalled()
    expect(mint).toHaveBeenCalledTimes(1)
    expect(mint.mock.calls[0][3] ?? null).toBeNull()
    const header = JSON.parse(Buffer.from(await mint.mock.results[0].value, 'base64').toString('utf8'))
    expect(JSON.stringify(header.extensions)).toBe(JSON.stringify(pr.extensions))
  })
})
