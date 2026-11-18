import {
  createSIWxMessage,
  createSIWxPayload,
  encodeSIWxHeader,
  parseSIWxHeader,
  verifySIWxSignature,
  type CompleteSIWxInfo,
} from '@x402/extensions/sign-in-with-x'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import {
  SIWX_NONCE_LIFETIME_MS,
  buildSiwxChallenge,
  checkSiwxProof,
  composeSiwxMessage,
  siwxBinding,
  type SiwxChallenge,
  type SiwxNonce,
} from './siwx.js'

const RESOURCE = 'https://proxy.example.com/v3/compat/chat/completions'
const CHAIN_ID = 84532

function liveNonce(nowMs: number, nonce = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'): SiwxNonce {
  return {
    nonce,
    issuedAt: new Date(nowMs).toISOString(),
    expirationTime: new Date(nowMs + SIWX_NONCE_LIFETIME_MS).toISOString(),
    expiresMs: nowMs + SIWX_NONCE_LIFETIME_MS,
  }
}

/** What a reference client (and so Haven's signer, pinned to it) signs for the proxy's challenge. */
function referenceInfo(challenge: SiwxChallenge): CompleteSIWxInfo {
  return { ...challenge.info, chainId: challenge.supportedChains[0]!.chainId, type: 'eip191' } as CompleteSIWxInfo
}

async function referenceProof(challenge: SiwxChallenge, account = privateKeyToAccount(generatePrivateKey())): Promise<{ header: string; address: `0x${string}` }> {
  const payload = await createSIWxPayload(referenceInfo(challenge), account, RESOURCE)
  return { header: encodeSIWxHeader(payload), address: account.address }
}

describe('the SIGN-IN-WITH-X challenge (§6 "The challenge")', () => {
  const nowMs = Date.parse('2026-11-17T12:00:00.000Z')
  const challenge = buildSiwxChallenge({ ...siwxBinding(RESOURCE), chainId: CHAIN_ID, nonce: liveNonce(nowMs) })

  it('is the { info, supportedChains } form, bound to the URL being called, with what Haven\'s signer requires', () => {
    // packages/signer/src/siwx.ts validateSiwxChallenge, rule by rule.
    expect(challenge.info.domain).toBe('proxy.example.com')
    expect(challenge.info.domain).not.toMatch(/\s/)
    expect(new URL(challenge.info.uri).origin).toBe(new URL(RESOURCE).origin)
    expect(challenge.info.version).toBe('1')
    expect(challenge.info.nonce).toMatch(/^[A-Za-z0-9]{8,}$/)
    expect(Number.isNaN(Date.parse(challenge.info.issuedAt))).toBe(false)
    const window = Date.parse(challenge.info.expirationTime) - Date.parse(challenge.info.issuedAt)
    expect(window).toBeGreaterThan(0)
    expect(window).toBeLessThanOrEqual(300_000)
    expect(challenge.supportedChains).toEqual([{ chainId: 'eip155:84532', type: 'eip191' }])
    for (const value of Object.values(challenge.info)) {
      expect(typeof value).toBe('string')
      expect(value).not.toMatch(/[\r\n]/)
    }
  })

  it('composes the message byte for byte as the reference client does', () => {
    const address = privateKeyToAccount(generatePrivateKey()).address
    const fields = { ...siwxBinding(RESOURCE), chainId: CHAIN_ID, nonce: liveNonce(nowMs) }
    expect(composeSiwxMessage(fields, address)).toBe(createSIWxMessage(referenceInfo(challenge), address))
  })
})

describe('checking a SIGN-IN-WITH-X proof', () => {
  const nowMs = Date.now()
  const nonce = liveNonce(nowMs)
  const challenge = buildSiwxChallenge({ ...siwxBinding(RESOURCE), chainId: CHAIN_ID, nonce })
  const check = (header: string, payer: `0x${string}`, overrides: Partial<Parameters<typeof checkSiwxProof>[0]> = {}) =>
    checkSiwxProof({ header, binding: siwxBinding(RESOURCE), chainId: CHAIN_ID, live: nonce, payer, nowMs, ...overrides })

  it('accepts a proof the reference client signs with the payer key, and the reference verifier agrees', async () => {
    const { header, address } = await referenceProof(challenge)
    expect(await check(header, address)).toEqual({ ok: true, nonce: nonce.nonce })
    const verified = await verifySIWxSignature(parseSIWxHeader(header))
    expect(verified.isValid).toBe(true)
  })

  it('refuses a proof signed by anyone but the payer, whatever address it names', async () => {
    const { header, address } = await referenceProof(challenge)
    const payer = privateKeyToAccount(generatePrivateKey()).address
    expect(await check(header, payer)).toEqual({ ok: false, reason: 'not_the_payer' })
    // The proof claims the payer's address, but a stranger signed it.
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as Record<string, unknown>
    const forged = Buffer.from(JSON.stringify({ ...decoded, address: payer })).toString('base64')
    expect(await check(forged, payer)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(address).not.toBe(payer)
  })

  it('refuses a proof for another nonce, an expired nonce, a key with no live nonce, and an unreadable header', async () => {
    const { header, address } = await referenceProof(challenge)
    expect(await check(header, address, { live: liveNonce(nowMs, 'ffffffffffffffffffffffffffffffff') })).toEqual({ ok: false, reason: 'nonce_mismatch' })
    expect(await check(header, address, { nowMs: nonce.expiresMs })).toEqual({ ok: false, reason: 'expired' })
    expect(await check(header, address, { live: null })).toEqual({ ok: false, reason: 'no_live_nonce' })
    expect(await check('not base64 json', address)).toEqual({ ok: false, reason: 'unreadable' })
  })

  it('refuses a proof whose signed fields differ from the challenge: another origin, chain, expiry, or an extra field', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const signed = async (info: Partial<CompleteSIWxInfo>): Promise<string> =>
      encodeSIWxHeader(await createSIWxPayload({ ...referenceInfo(challenge), ...info } as CompleteSIWxInfo, account, info.uri ?? RESOURCE))
    expect(await check(await signed({ domain: 'other.example.com', uri: 'https://other.example.com/x' }), account.address)).toEqual({ ok: false, reason: 'field_mismatch' })
    expect(await check(await signed({ chainId: 'eip155:8453' }), account.address)).toEqual({ ok: false, reason: 'field_mismatch' })
    expect(await check(await signed({ expirationTime: new Date(nonce.expiresMs + 60_000).toISOString() }), account.address)).toEqual({ ok: false, reason: 'field_mismatch' })
    expect(await check(await signed({ statement: 'Sign in' }), account.address)).toEqual({ ok: false, reason: 'field_mismatch' })
    // A proof for the challenge on another path of the same proxy is not this request's proof.
    expect(await check(await signed({ uri: 'https://proxy.example.com/v1/other' }), account.address)).toEqual({ ok: false, reason: 'field_mismatch' })
  })
})
