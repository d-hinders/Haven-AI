/**
 * #4242 — an x402 binding remembers which shape it was minted for, and only a
 * funding leg may build an EIP-3009 merchant header.
 *
 * The expected context carries no settlement scheme, so before #4242 a binding
 * minted for an erc7710 settlement child was indistinguishable from a
 * funding-leg binding at header time. Every context below is a VALID v3 Haven
 * binding (digest committed, payer = this signer), so a refusal can only come
 * from the rail check.
 */
import { describe, expect, it } from 'vitest'
import { hashTypedData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { addressFromKey, buildX402ExpectedMessage, deriveDelegateAccountAddress } from '@haven_ai/sdk'
import { buildFundingLegUserOp } from '@haven_ai/sdk/test-support'
import { createEdgeSigner, NO_FUNDING_LEG_MESSAGE, type X402ExpectedPayment } from './core.js'
import { createToolHandlers, type ToolPayload } from './tools.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const DELEGATE = addressFromKey(KEY) as `0x${string}`
const OWN_ACCOUNT = deriveDelegateAccountAddress(DELEGATE)
const BINDING_KEY = '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d'
const BINDING_SIGNER = privateKeyToAccount(BINDING_KEY).address

const RESOURCE_URL = 'https://merchant.test/paid'
const EXPIRES_AT = '2099-01-01T00:00:00.000Z'

const FUNDING_QUOTE = {
  paymentId: 'pay_x402_rail_funding',
  resourceUrl: RESOURCE_URL,
  merchantTo: '0x000000000000000000000000000000000000dEaD',
  amount: '1000000',
  asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // Base USDC
  network: 'base',
  expiresAt: EXPIRES_AT,
}

// The settlement-delegation fixture's own payee, amount, token and chain.
const CHILD_QUOTE = {
  paymentId: 'pay_x402_rail_child',
  resourceUrl: RESOURCE_URL,
  merchantTo: '0x3333333333333333333333333333333333333333',
  amount: '1000',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Base Sepolia USDC
  network: 'eip155:84532',
  expiresAt: EXPIRES_AT,
}

async function bind(quote: typeof FUNDING_QUOTE, typedData: unknown, payloadHash: string) {
  const context = {
    ...quote,
    payloadHash,
    typedDataHash: hashTypedData(typedData as Parameters<typeof hashTypedData>[0]),
    payerDelegate: DELEGATE.toLowerCase(),
    payerAgentId: 'agent_rail',
  }
  const message = buildX402ExpectedMessage(context)
  const account = privateKeyToAccount(BINDING_KEY)
  return {
    ...context,
    auth: { version: 3 as const, message, signature: await account.signMessage({ message }), signer: account.address },
  }
}

function wire(expected: Awaited<ReturnType<typeof bind>>) {
  return {
    payment_id: expected.paymentId,
    payload_hash: expected.payloadHash,
    resource_url: expected.resourceUrl,
    merchant_to: expected.merchantTo,
    amount: expected.amount,
    asset: expected.asset,
    network: expected.network,
    expires_at: expected.expiresAt,
    typed_data_hash: expected.typedDataHash,
    payer_delegate: expected.payerDelegate,
    payer_agent_id: expected.payerAgentId,
    auth: expected.auth,
  }
}

/** A merchant 402 whose single EIP-3009 option matches `quote` exactly. */
function paymentRequiredFor(quote: typeof FUNDING_QUOTE) {
  return {
    x402Version: 2,
    resource: { url: quote.resourceUrl, description: 'paid data' },
    accepts: [
      {
        scheme: 'exact',
        network: quote.network,
        amount: quote.amount,
        asset: quote.asset,
        payTo: quote.merchantTo,
        maxTimeoutSeconds: 60,
        extra: { name: 'USDC', version: '2' },
      },
    ],
  }
}

function signer() {
  return createEdgeSigner(KEY, { x402BindingSigner: BINDING_SIGNER, agentId: 'agent_rail' })
}

function fundingLeg() {
  return buildFundingLegUserOp({
    delegate: DELEGATE,
    asset: FUNDING_QUOTE.asset as `0x${string}`,
    amount: FUNDING_QUOTE.amount,
    chainId: 8453,
  })
}

function ownChild() {
  const td = JSON.parse(
    JSON.stringify(require('../../sdk/src/__fixtures__/settlement-delegation-payload.json')),
  )
  td.message.delegator = OWN_ACCOUNT
  return td
}
const CHILD_PAYLOAD_HASH = `0x${'ab'.repeat(32)}`

// The child fixture's expiry is a fixed timestamp; the verifier reads Date.now().
const inWindow = <T>(fn: () => Promise<T>) => {
  const real = Date.now
  Date.now = () => (0x6a80709b - 60) * 1000
  return fn().finally(() => {
    Date.now = real
  })
}

describe('x402 binding rail (#4242)', () => {
  it('characterization: a funding-leg binding still builds its EIP-3009 header', async () => {
    const funding = fundingLeg()
    const expected = await bind(FUNDING_QUOTE, funding.typedData, funding.payloadHash)
    const s = signer()
    const signed = await s.signX402FundingTypedData(funding.typedData as never, expected as unknown as X402ExpectedPayment)
    // Caught and asserted, so a refusal fails this as an assertion, not as a stray throw.
    let refusal: unknown
    let header: Awaited<ReturnType<typeof s.buildX402PaymentHeader>> | undefined
    try {
      header = await s.buildX402PaymentHeader(paymentRequiredFor(FUNDING_QUOTE) as never, signed.x402Binding)
    } catch (err) {
      refusal = err
    }
    expect(refusal).toBeUndefined()
    expect(header?.paymentHeader).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(header?.accepted.payTo).toBe(FUNDING_QUOTE.merchantTo)
  })

  it('a settlement-child binding is refused at header time, and stays refused on retry', async () => {
    const td = ownChild()
    const expected = await bind(CHILD_QUOTE, td, CHILD_PAYLOAD_HASH)
    const s = signer()
    await inWindow(async () => {
      const signed = await s.signX402FundingTypedData(td as never, expected as unknown as X402ExpectedPayment)
      const build = () => s.buildX402PaymentHeader(paymentRequiredFor(CHILD_QUOTE) as never, signed.x402Binding)
      await expect(build()).rejects.toThrow(NO_FUNDING_LEG_MESSAGE)
      // Retired with its own reason, not the "already built a header" one.
      await expect(build()).rejects.toThrow(NO_FUNDING_LEG_MESSAGE)
    })
  })

  it('tool layer: haven_sign then haven_x402_sign_header on a settlement child returns no payment_header', async () => {
    const td = ownChild()
    const expected = await bind(CHILD_QUOTE, td, CHILD_PAYLOAD_HASH)
    await inWindow(async () => {
      const handlers = createToolHandlers(signer())
      const signed = (await handlers.haven_sign({
        payload_hash: expected.payloadHash,
        typed_data: td,
        x402_expected: wire(expected),
      } as never)) as ToolPayload & { data?: { x402_binding?: string } }
      expect(signed.success).toBe(true)
      const binding = signed.data?.x402_binding
      expect(typeof binding).toBe('string')
      const header = (await handlers.haven_x402_sign_header({
        payment_required: paymentRequiredFor(CHILD_QUOTE),
        x402_binding: binding,
      } as never)) as ToolPayload & { message?: string; data?: unknown }
      expect(header.success).toBe(false)
      expect(header.message).toBe(NO_FUNDING_LEG_MESSAGE)
      expect(header.data).toBeUndefined()
    })
  })

  it('tool layer: haven_sign_x402 refuses a settlement child before signing, and audits nothing', async () => {
    const td = ownChild()
    const expected = await bind(CHILD_QUOTE, td, CHILD_PAYLOAD_HASH)
    const dir = await mkdtemp(join(tmpdir(), 'x402-binding-rail-'))
    const auditPath = join(dir, 'audit.jsonl')
    try {
      await inWindow(async () => {
        // Count signing calls: the header builder refuses this child too, so
        // only the call count shows the refusal came BEFORE the child was signed.
        const s = signer()
        let childSignings = 0
        const sign = s.signX402FundingTypedData.bind(s)
        s.signX402FundingTypedData = (...args) => {
          childSignings += 1
          return sign(...args)
        }
        const handlers = createToolHandlers(s, {
          audit: { auditPath, delegateAddress: DELEGATE, accountAddress: OWN_ACCOUNT, chainId: 84532 },
        })
        const result = (await handlers.haven_sign_x402({
          payload_hash: expected.payloadHash,
          typed_data: td,
          x402_expected: wire(expected),
          payment_required: paymentRequiredFor(CHILD_QUOTE),
        } as never)) as ToolPayload & { message?: string; data?: unknown }
        expect(result.success).toBe(false)
        expect(result.message).toBe(NO_FUNDING_LEG_MESSAGE)
        expect(result.data).toBeUndefined()
        expect(childSignings).toBe(0)
      })
      await expect(readFile(auditPath, 'utf8')).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
