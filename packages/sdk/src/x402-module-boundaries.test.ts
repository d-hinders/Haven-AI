import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { X402FundingLeg } from './x402-funding-leg.js'
import { x402PayerAddress, withX402Wallet } from './x402-protocol.js'
import type { X402PaymentOption, X402PaymentRequired } from './types.js'

const SRC = dirname(fileURLToPath(import.meta.url))

function source(file: string): string {
  return readFileSync(join(SRC, file), 'utf8')
}

/**
 * The dividing line this slice exists to draw (#1618, epic #1613).
 *
 * The 3009 funding leg and the erc7710 direct-settlement path are two ways to
 * move the same money, and #1510/#1511/#1521 all came from one leaking into
 * the other. `x402-protocol.ts` holds what both need; `x402-funding-leg.ts`
 * holds what only the two-hop scheme has. If the neutral layer ever reaches
 * back into the funding leg, that separation is gone and the next slice
 * (#1619) inherits a funding leg it does not have.
 */
describe('x402 module boundaries (#1618)', () => {
  it('MUTATION PROOF: the protocol layer never imports the funding leg', () => {
    // Add `import { X402FundingLeg } from './x402-funding-leg.js'` to
    // x402-protocol.ts and this fails — which is the whole point, because
    // that import is how a funding-leg assumption reaches erc7710. Scanned
    // over IMPORT statements, not the whole text: the module's own doc
    // comment names its sibling deliberately, and a guard that cannot tell
    // prose from a dependency would punish explaining the boundary.
    const imports = source('x402-protocol.ts').match(/^import[\s\S]*?from '.*'$/gm) ?? []
    expect(imports.length).toBeGreaterThan(0)
    expect(imports.join('\n')).not.toContain('x402-funding-leg')
  })

  it('MUTATION PROOF: the erc7710 module imports no funding leg and no RPC provider (#1619)', () => {
    // The scheme's defining property is an absence — no funding transaction to
    // confirm, no delegate balance to check. Either import would be the first
    // step back toward the confusion this epic is decomposing away.
    const imports = source('x402-erc7710.ts').match(/^import[\s\S]*?from '.*'$/gm) ?? []
    expect(imports.length).toBeGreaterThan(0)
    expect(imports.join('\n')).not.toContain('x402-funding-leg')
    expect(imports.join('\n')).not.toContain('provider.js')
  })

  it('the funding leg is internal — the SDK entrypoint does not publish it', () => {
    // A published module is a compatibility promise. This is an internal
    // decomposition, so neither module is part of the SDK's public surface.
    const exports = source('index.ts').match(/^export[\s\S]*?from '.*'$/gm) ?? []
    expect(exports.length).toBeGreaterThan(0)
    expect(exports.join('\n')).not.toContain('x402-funding-leg')
    expect(exports.join('\n')).not.toContain('x402-protocol')
    expect(exports.join('\n')).not.toContain('x402-erc7710')
  })

  it('the funding leg mints and caches with no HavenClient at all', async () => {
    // Proof the extraction actually decoupled: construct the module with
    // stubs and it runs. Before #1618 this behaviour could only be reached
    // through a fully-constructed client.
    const fundingLeg = new X402FundingLeg({
      delegateKey: undefined,
      delegateAddress: '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1',
      x402Wallet: undefined,
      chainRpcs: {},
      post: async () => {
        throw new Error('the cache path must not call the backend')
      },
      signForData: async () => '0xsig',
      assertSignableAuthorizationState: () => {},
    })

    expect(fundingLeg.cachedReceipt('never-seen')).toBeUndefined()

    // No chainRpcs entry means the delegate's balance is UNVERIFIABLE, and
    // the tri-state says so rather than guessing "funded" (#1521).
    await expect(fundingLeg.delegateCanFund(8453, '0xtoken', '1000')).resolves.toBeNull()

    // Likewise a funding wait with no RPC configured is skipped, not failed.
    await expect(fundingLeg.waitForFundingTx('0xabc', 8453)).resolves.toBeUndefined()
  })

  it('refuses to mint a header without a local delegate key', async () => {
    const fundingLeg = new X402FundingLeg({
      delegateKey: undefined,
      delegateAddress: undefined,
      x402Wallet: undefined,
      chainRpcs: {},
      post: async () => ({}) as never,
      signForData: async () => '0xsig',
      assertSignableAuthorizationState: () => {},
    })

    await expect(
      fundingLeg.createPaymentHeader(
        {} as X402PaymentRequired,
        {} as X402PaymentOption,
      ),
    ).rejects.toThrow(/delegateKey is required/)
  })

  it('an expired authorization is never served from the cache', () => {
    const fundingLeg = new X402FundingLeg({
      delegateKey: undefined,
      delegateAddress: undefined,
      x402Wallet: undefined,
      chainRpcs: {},
      post: async () => ({}) as never,
      signForData: async () => '0xsig',
      assertSignableAuthorizationState: () => {},
    })

    // validBefore in the past: the header is already unusable, so caching a
    // receipt that carries it would hand back an authorization no merchant
    // will accept.
    const expiredHeader = Buffer.from(
      JSON.stringify({ payload: { authorization: { validBefore: '1' } } }),
    ).toString('base64')

    fundingLeg.cacheReceipt('key', expiredHeader, { paymentId: 'pay_1' } as never)
    expect(fundingLeg.cachedReceipt('key')).toBeUndefined()
  })

  it('the payer and the wallet header are protocol-level, not scheme-level', () => {
    // Both schemes answer these the same way, which is why they are free
    // functions rather than methods on either module.
    expect(x402PayerAddress('0xdelegate', '0xwallet')).toBe('0xdelegate')
    expect(x402PayerAddress(undefined, '0xwallet')).toBe('0xwallet')
    expect(x402PayerAddress(undefined, undefined)).toBeUndefined()

    const init = withX402Wallet({ method: 'POST' }, '0xdelegate')
    expect(new Headers(init?.headers).get('x402-wallet')).toBe('0xdelegate')

    // A caller-set header wins — the SDK does not overwrite an explicit payer.
    const explicit = withX402Wallet({ headers: { 'x402-wallet': '0xmine' } }, '0xdelegate')
    expect(new Headers(explicit?.headers).get('x402-wallet')).toBe('0xmine')

    // With no payer to name, the init passes through untouched.
    expect(withX402Wallet(undefined, undefined)).toBeUndefined()
  })
})
