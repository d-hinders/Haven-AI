import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Wallet, verifyMessage } from 'ethers'
import { stdSerializers } from 'pino'
import { AssuranceLevel } from '../modules/passport/schema.js'
import type { PassportReceipt } from '../modules/passport/receipt.js'
import type { X402ExpectedContext } from '@haven_ai/sdk'

/**
 * #4654 (epic #4484, Railway incident 2026-10-21): a malformed env private key
 * must never reach the logs.
 *
 * ethers v6 echoes the input it could not parse — `invalid BytesLike value
 * (argument="value", value="<the input>", …)` — and sets an enumerable `value`
 * field holding it. `infra/relayer-balance-monitor.ts` logs `err.message` and
 * `infra/http-error-handler.ts` logs the whole error, whose pino `err`
 * serializer emits both `message` and `value`. On 2026-11-04 that wrote a
 * production `RELAYER_PRIVATE_KEY` into the backend logs (#4487).
 *
 * These tests drive each construction site with the three echoing forms and
 * serialize the thrown error with pino's `stdSerializers.err` — NOT
 * `JSON.stringify`, which returns `{}` for an `Error` and would pass no matter
 * what the error carried.
 *
 * The sentinel is a 64-hex string, so each form is a real ethers-echoing input.
 * `MARKER` is its first 16 characters: the fragment that survives in all three
 * forms, including the one where the non-hex character splits the sentinel.
 */
const SENTINEL = 'deadbeef'.repeat(8)
const MARKER = SENTINEL.slice(0, 16)

/** A valid secp256k1 key (hardhat account 0 — never used for real funds). */
const VALID_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const VALID_ADDRESS = new Wallet(VALID_KEY).address

const ECHOING_FORMS: Array<[string, string]> = [
  ['a quoted value', `"0x${SENTINEL}"`],
  ['a NAME=-prefixed value', `RELAYER_PRIVATE_KEY=0x${SENTINEL}`],
  ['a value with an internal non-hex character', `0x${SENTINEL.slice(0, 32)}zz${SENTINEL.slice(32)}`],
]

const CONTEXT: X402ExpectedContext & { typedDataHash: string } = {
  paymentId: 'pay-4654',
  payloadHash: `0x${'11'.repeat(32)}`,
  resourceUrl: 'https://merchant.example/resource',
  merchantTo: `0x${'22'.repeat(20)}`,
  amount: '100000',
  asset: `0x${'33'.repeat(20)}`,
  network: 'eip155:84532',
  typedDataHash: `0x${'44'.repeat(32)}`,
}

const RECEIPT: PassportReceipt = {
  version: '1',
  issuer: VALID_ADDRESS,
  agentId: 'agt_4654',
  agentEoa: `0x${'55'.repeat(20)}`,
  smartAccount: null,
  assuranceLevel: AssuranceLevel.L0,
  standing: 'active',
  anchor: 'anchored',
  evidenceUid: `0x${'66'.repeat(32)}`,
  chainId: 84532,
  controls: null,
  standingEpoch: 1,
  issuedAt: 1_000_000,
  expiresAt: 1_000_300,
}

type SiteName = 'relayer' | 'binding-signer' | 'sweep' | 'receipt'

const SITE_VARIABLE: Record<SiteName, string> = {
  relayer: 'RELAYER_PRIVATE_KEY_8453',
  'binding-signer': 'X402_BINDING_PRIVATE_KEY',
  sweep: 'X402_BINDING_PRIVATE_KEY',
  receipt: 'PASSPORT_RECEIPT_SIGNING_KEY',
}

const SITE_FILE: Record<SiteName, string> = {
  relayer: 'infra/relayer.ts',
  'binding-signer': 'infra/chain/x402-binding-signer.ts',
  sweep: 'rails/sweep.ts',
  receipt: 'modules/passport/receipt.ts',
}

/** pino's `err` serializer — the shape the backend's logger actually emits. */
function serialized(err: unknown): string {
  return JSON.stringify(stdSerializers.err(err as Error))
}

async function capture(fn: () => unknown | Promise<unknown>): Promise<Error> {
  try {
    await fn()
  } catch (err) {
    return err as Error
  }
  throw new Error('expected the site to throw, but it did not')
}

/**
 * Run one construction site with `raw` as its key and return the address it
 * derived. Each site is imported fresh (`vi.resetModules`) so the relayer's
 * per-chain cache and the receipt module's `signerKey` cannot leak between
 * cases.
 */
async function deriveAddress(site: SiteName, raw: string): Promise<string> {
  vi.resetModules()
  if (site === 'relayer') {
    process.env.RELAYER_PRIVATE_KEY_8453 = raw
    const { getRelayer } = await import('../infra/relayer.js')
    return getRelayer(8453).address
  }
  if (site === 'binding-signer') {
    process.env.X402_BINDING_PRIVATE_KEY = raw
    const { signX402ExpectedContext } = await import('../infra/chain/x402-binding-signer.js')
    return (await signX402ExpectedContext(CONTEXT)).signer
  }
  if (site === 'sweep') {
    process.env.X402_BINDING_PRIVATE_KEY = raw
    const { signSweepExpectedContext, buildSweepAuthorization } = await import('../rails/sweep.js')
    const auth = buildSweepAuthorization({
      delegateAddress: `0x${'11'.repeat(20)}`,
      accountAddress: `0x${'22'.repeat(20)}`,
      chainId: 84532,
      valueAtomic: 1n,
      nowSec: 1_000_000,
    })
    return (await signSweepExpectedContext(auth)).signer
  }
  const { setReceiptSigningKey, receiptIssuerAddress } = await import(
    '../modules/passport/receipt.js'
  )
  setReceiptSigningKey(raw)
  const address = receiptIssuerAddress()
  if (!address) throw new Error('receiptIssuerAddress returned null for a valid key')
  return address
}

/** The same sites, but through the path that THROWS on a bad key. */
async function deriveError(site: SiteName, raw: string): Promise<Error> {
  vi.resetModules()
  if (site === 'relayer') {
    process.env.RELAYER_PRIVATE_KEY_8453 = raw
    const { getRelayer } = await import('../infra/relayer.js')
    return capture(() => getRelayer(8453))
  }
  if (site === 'binding-signer') {
    process.env.X402_BINDING_PRIVATE_KEY = raw
    const { signX402ExpectedContext } = await import('../infra/chain/x402-binding-signer.js')
    return capture(() => signX402ExpectedContext(CONTEXT))
  }
  if (site === 'sweep') {
    process.env.X402_BINDING_PRIVATE_KEY = raw
    const { signSweepExpectedContext, buildSweepAuthorization } = await import('../rails/sweep.js')
    const auth = buildSweepAuthorization({
      delegateAddress: `0x${'11'.repeat(20)}`,
      accountAddress: `0x${'22'.repeat(20)}`,
      chainId: 84532,
      valueAtomic: 1n,
      nowSec: 1_000_000,
    })
    return capture(() => signSweepExpectedContext(auth))
  }
  const { setReceiptSigningKey, signReceipt } = await import('../modules/passport/receipt.js')
  setReceiptSigningKey(raw)
  return capture(() => signReceipt(RECEIPT))
}

const SITES: SiteName[] = ['relayer', 'binding-signer', 'sweep', 'receipt']

const CLEARED = [
  'RELAYER_PRIVATE_KEY',
  'RELAYER_PRIVATE_KEY_8453',
  'RELAYER_PRIVATE_KEY_84532',
  'X402_BINDING_PRIVATE_KEY',
  'HAVEN_X402_BINDING_SIGNER',
  'PASSPORT_RECEIPT_SIGNING_KEY',
] as const

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of CLEARED) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of CLEARED) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('no value in errors (#4654)', () => {
  for (const site of SITES) {
    it.each(ECHOING_FORMS)(
      `${SITE_FILE[site]}: refuses %s, naming the variable and echoing nothing`,
      async (_label, raw) => {
        const err = await deriveError(site, raw)
        expect(err).toBeInstanceOf(Error)
        // message, stack, value, cause — the whole serialized error. Asserted
        // FIRST so a bypassed helper reddens on the leak itself, not merely on
        // the missing variable name.
        expect(serialized(err)).not.toContain(MARKER)
        expect(err.message).toContain(SITE_VARIABLE[site])
        expect(err.cause).toBeUndefined()
        expect((err as Error & { value?: unknown }).value).toBeUndefined()
      },
    )
  }
})

describe('the null-returning paths stay value-free (#4654)', () => {
  it.each(ECHOING_FORMS)(
    'receiptIssuerAddress() returns null for %s and logs nothing',
    async (_label, raw) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.resetModules()
      const { setReceiptSigningKey, receiptIssuerAddress } = await import(
        '../modules/passport/receipt.js'
      )
      setReceiptSigningKey(raw)
      expect(receiptIssuerAddress()).toBeNull()
      const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls])
      expect(logged).not.toContain(MARKER)
    },
  )

  it.each(ECHOING_FORMS)(
    'resolveX402BindingSignerAddress() returns null for %s and its warning is value-free',
    async (_label, raw) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      process.env.X402_BINDING_PRIVATE_KEY = raw
      vi.resetModules()
      const { resolveX402BindingSignerAddress } = await import(
        '../infra/chain/x402-binding-signer.js'
      )
      expect(resolveX402BindingSignerAddress()).toBeNull()
      expect(warn).toHaveBeenCalled()
      expect(JSON.stringify(warn.mock.calls)).not.toContain(MARKER)
    },
  )
})

describe('same input, same answer everywhere (#4654)', () => {
  for (const site of SITES) {
    it(`${SITE_FILE[site]}: a valid key with surrounding whitespace builds the trimmed key's wallet`, async () => {
      expect(await deriveAddress(site, `  \n${VALID_KEY}\t `)).toBe(VALID_ADDRESS)
    })

    it(`${SITE_FILE[site]}: a valid key without 0x keeps working`, async () => {
      expect(await deriveAddress(site, VALID_KEY.slice(2))).toBe(VALID_ADDRESS)
    })
  }

  it('receipt.ts: signReceipt signs with the trimmed key, and the signature verifies against it', async () => {
    vi.resetModules()
    const { setReceiptSigningKey, signReceipt, canonicalize } = await import(
      '../modules/passport/receipt.js'
    )
    setReceiptSigningKey(`\n ${VALID_KEY} `)
    const signed = await signReceipt(RECEIPT)
    expect(verifyMessage(canonicalize(RECEIPT), signed.signature)).toBe(VALID_ADDRESS)
  })

  it('relayer.ts: a whitespace-only RELAYER_PRIVATE_KEY_<chainId> errors naming that variable and does NOT fall back', async () => {
    // A valid global key exists, so a fallback would succeed silently — which is
    // exactly the per-chain isolation collapse (#640) this must not do.
    process.env.RELAYER_PRIVATE_KEY = VALID_KEY
    process.env.RELAYER_PRIVATE_KEY_8453 = '   \n '
    vi.resetModules()
    const { getRelayer } = await import('../infra/relayer.js')
    const err = await capture(() => getRelayer(8453))
    expect(err.message).toContain('RELAYER_PRIVATE_KEY_8453')
    expect(serialized(err)).not.toContain(MARKER)
  })

  it('relayer.ts: the global key is named when no per-chain variable is set', async () => {
    process.env.RELAYER_PRIVATE_KEY = `"0x${SENTINEL}"`
    vi.resetModules()
    const { getRelayer } = await import('../infra/relayer.js')
    const err = await capture(() => getRelayer(8453))
    expect(err.message).toContain('RELAYER_PRIVATE_KEY')
    expect(err.message).not.toContain('RELAYER_PRIVATE_KEY_8453')
    expect(serialized(err)).not.toContain(MARKER)
  })
})
