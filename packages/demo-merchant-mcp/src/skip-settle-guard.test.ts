/**
 * The MERCHANT_SKIP_SETTLE_PRODUCT chain guard: the verify-without-settle QA
 * hook (#603) hands out goods against a merely well-FORMED authorization — no
 * settlement, and the only balance check lives inside the settlement call it
 * skips. A copy-pasted env var must not be able to enable that on mainnet.
 * Module-load guard, so each case re-imports x402.ts fresh under stubbed env.
 */
import { randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { encodePaymentSignatureHeader } from '@x402/core/http'
import type { PaymentPayload, PaymentRequired } from '@x402/core/types'

const MERCHANT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a' as const
const PAYER_KEY = `0x${'01'.repeat(32)}` as const
const ZERO_TX_HASH = `0x${'0'.repeat(64)}`

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  vi.restoreAllMocks()
})

async function importX402With(env: Record<string, string>) {
  vi.resetModules()
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  return import('./x402.js')
}

/** Self-contained eip3009 signer, mirroring x402.test.ts's `signedHeader` —
 *  duplicated (not imported) because this suite dynamically re-imports
 *  x402.js per case, and the domain's `chainId`/`name`/`version` must come
 *  from the SAME freshly-loaded module graph as the processor under test. */
async function signSkipSettleHeader(
  mod: typeof import('./x402.js'),
  chainId: number,
  pr: PaymentRequired,
): Promise<string> {
  const account = privateKeyToAccount(PAYER_KEY)
  const now = Math.floor(Date.now() / 1000)
  const accepted = pr.accepts[0]
  const authorization = {
    from: account.address,
    to: MERCHANT,
    value: accepted.amount,
    validAfter: String(now - 5),
    validBefore: String(now + 300),
    nonce: `0x${randomBytes(32).toString('hex')}`,
  }
  const signature = await account.signTypedData({
    domain: {
      name: accepted.extra?.name as string,
      version: accepted.extra?.version as string,
      chainId,
      verifyingContract: mod.USDC_ADDRESS,
    },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: {
      from: authorization.from,
      to: authorization.to as `0x${string}`,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce as `0x${string}`,
    },
  })
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: pr.resource,
    accepted,
    payload: { authorization, signature },
    ...(pr.extensions ? { extensions: pr.extensions } : {}),
  }
  return encodePaymentSignatureHeader(payload)
}

/** Same env-stub + fresh-module-graph pattern as `importX402With`, extended to
 *  pull in `http.js` and `products.js` too — both read chain config at import
 *  time, same as `x402.js` does. */
async function importHttpWith(env: Record<string, string>) {
  vi.resetModules()
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  const [x402, http, products] = await Promise.all([
    import('./x402.js'),
    import('./http.js'),
    import('./products.js'),
  ])
  return { x402, http, products }
}

describe('MERCHANT_SKIP_SETTLE_PRODUCT chain guard', () => {
  // Each case does a fresh `vi.resetModules()` + dynamic import of x402.ts
  // (and its transitive graph), which is consistently the slowest thing in
  // this package's suite and — as the full-package `npx vitest run` count
  // grows — flakes past the 5s default under collection-time load rather
  // than any actual regression. Give this module-reimport guard real headroom.
  it('refuses to start on mainnet with the flag set', async () => {
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {
        throw new Error('process.exit called')
      }) as never)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(
      importX402With({ MERCHANT_CHAIN_ID: '8453', MERCHANT_SKIP_SETTLE_PRODUCT: 'vpn_basic' }),
    ).rejects.toThrow('process.exit called')
    expect(exit).toHaveBeenCalledWith(1)
    expect(String(error.mock.calls[0]?.[0])).toContain('testnet-only')
  }, 15000)

  it('starts on Base Sepolia with the flag set', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as never)
    const mod = await importX402With({
      MERCHANT_CHAIN_ID: '84532',
      MERCHANT_SKIP_SETTLE_PRODUCT: 'vpn_basic',
    })
    expect(mod.createX402PaymentProcessor).toBeTypeOf('function')
    expect(exit).not.toHaveBeenCalled()
  }, 15000)

  it('starts on mainnet when the flag is unset', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as never)
    const mod = await importX402With({ MERCHANT_CHAIN_ID: '8453' })
    expect(mod.createX402PaymentProcessor).toBeTypeOf('function')
    expect(exit).not.toHaveBeenCalled()
  }, 15000)

  // #2969: the QA hook must be labelled honestly, not as an unsettled variant
  // of a real settlement. Mutation target: reverting `settlement` back to a
  // derived `settled: boolean` (or reusing `already_settled_earlier` here)
  // would pass every OTHER assertion in this file and fail only this one.
  it('the skip-settle path settles nothing, submits nothing, and carries settlement_unknown honestly (#2969)', async () => {
    const mod = await importX402With({
      MERCHANT_CHAIN_ID: '84532',
      MERCHANT_SKIP_SETTLE_PRODUCT: 'vpn_basic',
    })
    const products = await import('./products.js')
    const submit = vi.fn().mockResolvedValue(`0x${'cd'.repeat(32)}`)
    const waitForReceipt = vi.fn().mockResolvedValue(undefined)
    const processor = mod.createX402PaymentProcessor({ submit, waitForReceipt })

    const pr = processor.buildPaymentRequired({
      merchantAddress: MERCHANT,
      amountUsdc: 1_000n,
      resource: 'https://merchant.test/mcp',
      description: 'NordShield VPN Basic',
    })
    const header = await signSkipSettleHeader(mod, products.CHAIN_ID, pr)

    const settled = await processor.verifyAndSettle({
      productId: 'vpn_basic',
      paymentHeader: header,
      merchantAddress: MERCHANT,
      expectedAmount: 1_000n,
      paymentRequired: pr,
    })

    // Delivered (goods owed, hook is verify-without-settle by design)...
    expect(settled.from.toLowerCase()).toBe(privateKeyToAccount(PAYER_KEY).address.toLowerCase())
    // ...but never actually settled: no submission happened at all.
    expect(submit).not.toHaveBeenCalled()
    // The internal state is the explicit, honest label — not a boolean that
    // could be confused with the "paid earlier, no reference" state.
    expect(settled.settlement).toBe('settlement_unknown')
    expect(settled.settlement).not.toBe('already_settled_earlier')
    expect(settled.settlement).not.toBe('settled_onchain')
    // The x402 WIRE surface is unchanged: still the zero hash, unconditionally
    // (this is the protocol-facing field this issue explicitly leaves alone).
    expect(settled.txHash).toBe(ZERO_TX_HASH)
    expect(settled.paymentResponse.transaction).toBe(ZERO_TX_HASH)
  }, 15000)

  // #2969 acceptance criterion 5: the RENDERED output of the skip-settle
  // fixture, through the real HTTP + MCP layer — the exact surface d-hinders'
  // report quoted ("✅ Purchase confirmed! … Tx: 0x000…0 … Status: Paid").
  // Mutation targets: the skip-settle heading falling back to
  // `purchaseConfirmed`, or `isSettled` computed as anything but
  // `=== 'settled_onchain'` (which prints the zero hash), must fail this.
  it('the skip-settle fixture renders as delivered-unsettled — never "Purchase confirmed", never the zero hash (#2969)', async () => {
    const mod = await importX402With({
      MERCHANT_CHAIN_ID: '84532',
      MERCHANT_SKIP_SETTLE_PRODUCT: 'vpn_basic',
    })
    const products = await import('./products.js')
    const http = await import('./http.js')
    const submit = vi.fn().mockResolvedValue(`0x${'cd'.repeat(32)}`)
    const waitForReceipt = vi.fn().mockResolvedValue(undefined)
    const server = http.createDemoMerchantServer({
      merchantAddress: MERCHANT,
      baseUrl: 'http://127.0.0.1:0',
      paymentProcessor: mod.createX402PaymentProcessor({ submit, waitForReceipt }),
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('no address')
      const url = `http://127.0.0.1:${address.port}/mcp`
      const post = (body: unknown, headers: Record<string, string> = {}) =>
        fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            ...headers,
          },
          body: JSON.stringify(body),
        })
      const init = await post({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
      })
      const sessionId = init.headers.get('mcp-session-id')!
      const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'buy_vpn', arguments: { plan: 'basic' } } }
      const unpaid = await post(call, { 'mcp-session-id': sessionId })
      expect(unpaid.status).toBe(402)
      const pr = (await unpaid.json()) as PaymentRequired
      const paid = await post(
        { ...call, id: 3 },
        { 'mcp-session-id': sessionId, [mod.PAYMENT_SIGNATURE_HEADER]: await signSkipSettleHeader(mod, products.CHAIN_ID, pr) },
      )
      const text = await paid.text()

      // Goods delivered (the hook is verify-without-settle by design)...
      expect(paid.status).toBe(200)
      expect(submit).not.toHaveBeenCalled()
      // ...and the receipt says exactly that, nothing more.
      expect(text).toContain('Delivered — not confirmed on-chain')
      expect(text).not.toContain('Purchase confirmed')
      expect(text).not.toContain('Paid in an earlier transaction')
      expect(text).toContain('"status":"delivered_unsettled"')
      expect(text).toContain('"settlement_tx_hash":null')
      expect(text).not.toContain('Tx:')
      // Nothing was paid: the amount line is labelled as an amount, not a payment.
      expect(text).toContain('Amount:')
      expect(text).not.toContain('Paid:')
      expect(text).not.toContain('Status: Paid\n')
      expect(text).not.toContain('"status": "Betald"')
      expect(text).not.toContain(ZERO_TX_HASH)

      const receiptHeader = paid.headers.get('x-receipt-json')
      expect(receiptHeader).toBeTruthy()
      const receipt = JSON.parse(Buffer.from(receiptHeader!, 'base64').toString('utf8'))
      expect(receipt.status).toBe('Levererad — ej bekräftad på kedjan')
      expect(receipt.blockkedje_referens).toBeNull()
      expect(JSON.stringify(receipt)).not.toContain(ZERO_TX_HASH)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 20000)
})

// #2979: the settlement-readiness gate must exempt this fixture — it settles
// nothing on-chain (see x402.ts's `SKIP_SETTLE_PRODUCTS` branch), so a
// drained settlement wallet cannot block a settlement that never runs. Driven
// at the real HTTP layer (`createDemoMerchantServer`), same as the gate
// itself, not the in-process `verifyAndSettle` call.
describe('MERCHANT_SKIP_SETTLE_PRODUCT is exempt from the settlement-readiness gate (#2979)', () => {
  it('still serves the fixture product, unsettled, when the wallet is in the fail band', async () => {
    const { x402, http, products } = await importHttpWith({
      MERCHANT_CHAIN_ID: '84532',
      MERCHANT_SKIP_SETTLE_PRODUCT: 'vpn_basic',
    })
    const submit = vi.fn<import('./x402.js').SettlementClient['submit']>()
    const waitForReceipt = vi.fn<import('./x402.js').SettlementClient['waitForReceipt']>()
    const readiness = vi
      .fn<NonNullable<import('./x402.js').SettlementClient['readiness']>>()
      .mockResolvedValue(x402.settlementReadiness(MERCHANT, 255_000_000_000n))
    const settlementClient = { submit, waitForReceipt, readiness }

    const server: Server = http.createDemoMerchantServer({
      merchantAddress: MERCHANT,
      baseUrl: 'http://127.0.0.1:0',
      paymentProcessor: x402.createX402PaymentProcessor(settlementClient),
      settlementClient,
      readinessCacheMs: 0,
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })

    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('No test server port')
      const url = `http://127.0.0.1:${address.port}/mcp`

      // Exempt at the CHALLENGE step: a 402, not the 503 a non-exempt product
      // would get in the fail band.
      const unpaid = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'buy_vpn', arguments: { plan: 'basic' } },
        }),
      })
      expect(unpaid.status).toBe(402)
      const paymentRequired = (await unpaid.json()) as PaymentRequired

      const paymentHeader = await signSkipSettleHeader(x402, products.CHAIN_ID, paymentRequired)

      // Exempt at the SETTLE step too: served (200), still with the wallet in
      // the fail band, and the settlement client's `submit` is never called —
      // exactly what "settles nothing" means for this fixture.
      const paid = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          [x402.PAYMENT_SIGNATURE_HEADER]: paymentHeader,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'buy_vpn', arguments: { plan: 'basic' } },
        }),
      })

      expect(paid.status).toBe(200)
      expect(submit).not.toHaveBeenCalled()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 15000)
})

/**
 * #2989: nothing an agent reads distinguished the skip-settle fixture from a
 * product that settles — `list_products`, the 402 challenge, and the
 * discovery document all presented it identically. A cold agent bought it,
 * got an honest "Delivered — not confirmed on-chain" receipt, and had no way
 * to know beforehand that this was by design (quality-scan finding B6).
 *
 * Mutation-proved: deleting the `isSkipSettleProduct` branch in
 * `list_products` / `extractPaymentToolInfo` / `buildDiscovery` fails the two
 * positive assertions below; hard-coding `qa_fixture` onto every product
 * (instead of gating it) fails the absence assertions.
 */
// #2992 review: the disclosure QUOTES the receipt heading. A quote that drifts
// from the heading is exactly the "grep the receipt for the promised phrase,
// miss, chase a stuck payment" failure this marker exists to prevent — so
// the promise is bound to the heading in both locales, not restated.
describe('the QA-fixture disclosure quotes the real receipt heading (#2989)', () => {
  it('en: the 402 suffix and list_products line quote STRINGS.en.deliveredUnsettled', async () => {
    const [{ QA_FIXTURE_DESCRIPTION_SUFFIX }, { STRINGS }] = await Promise.all([
      import('./x402.js'),
      import('./server.js'),
    ])
    const promised = /"([^"]+)"/.exec(QA_FIXTURE_DESCRIPTION_SUFFIX)?.[1]
    expect(promised).toBeTruthy()
    expect(STRINGS.en.deliveredUnsettled).toContain(promised!)
    const promisedInList = /"([^"]+)"/.exec(STRINGS.en.qaFixtureLine)?.[1]
    expect(STRINGS.en.deliveredUnsettled).toContain(promisedInList!)
  })

  it('sv: the list_products line quotes STRINGS.sv.deliveredUnsettled', async () => {
    const { STRINGS } = await import('./server.js')
    const promised = /"([^"]+)"/.exec(STRINGS.sv.qaFixtureLine)?.[1]
    expect(promised).toBeTruthy()
    expect(STRINGS.sv.deliveredUnsettled).toContain(promised!)
  })
})

describe('skip-settle qa_fixture marker (#2989)', () => {
  it('marks the skip-settle product — and ONLY it — with the flag set on Base Sepolia', async () => {
    const { http, products } = await importHttpWith({
      MERCHANT_CHAIN_ID: '84532',
      MERCHANT_SKIP_SETTLE_PRODUCT: 'vpn_basic',
    })
    const submit = vi.fn().mockResolvedValue(`0x${'cd'.repeat(32)}`)
    const waitForReceipt = vi.fn().mockResolvedValue(undefined)
    const mod = await import('./x402.js')
    const server = http.createDemoMerchantServer({
      merchantAddress: MERCHANT,
      baseUrl: 'http://127.0.0.1:0',
      paymentProcessor: mod.createX402PaymentProcessor({ submit, waitForReceipt }),
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('no address')
      const url = `http://127.0.0.1:${address.port}/mcp`
      const origin = `http://127.0.0.1:${address.port}`
      const post = (body: unknown) =>
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
          body: JSON.stringify(body),
        })

      // list_products: structured qa_fixture on vpn_basic only, plus the
      // disclosure line in the text.
      const listed = await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_products', arguments: {} } })
      const listedRaw = await listed.text()
      const listedDataLine = listedRaw.split('\n').find((line) => line.startsWith('data:'))
      const listedBody = JSON.parse(listedDataLine ? listedDataLine.slice('data:'.length).trim() : listedRaw) as {
        result: {
          content: Array<{ type: string; text: string }>
          structuredContent: { products: Array<Record<string, unknown>> }
        }
      }
      const listedProducts = listedBody.result.structuredContent.products
      const fixture = listedProducts.find((p) => p.product_id === 'vpn_basic')
      expect(fixture?.qa_fixture).toEqual({ kind: 'skip_settle', settles_on_chain: false })
      for (const other of listedProducts.filter((p) => p.product_id !== 'vpn_basic')) {
        expect(other).not.toHaveProperty('qa_fixture')
      }
      expect(listedBody.result.content[0]?.text).toContain('QA fixture: verified but never settled on-chain')

      // The 402 for that product carries the same suffix in its description,
      // visible to the agent BEFORE it signs.
      const quote = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'buy_vpn', arguments: { plan: 'basic' } } })
      expect(quote.status).toBe(402)
      const paymentRequired = (await quote.json()) as { resource: { description: string } }
      expect(paymentRequired.resource.description).toContain('QA fixture: verified but never settled on-chain')
      const otherQuote = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'buy_vpn', arguments: { plan: 'pro' } } })
      const otherPaymentRequired = (await otherQuote.json()) as { resource: { description: string } }
      expect(otherPaymentRequired.resource.description).not.toContain('QA fixture')

      // The discovery document carries the same marker on that product only.
      const discovery = await fetch(`${origin}/`)
      const discoveryBody = (await discovery.json()) as { products: Array<Record<string, unknown>> }
      const discoveredFixture = discoveryBody.products.find((p) => p.id === 'vpn_basic')
      expect(discoveredFixture?.qa_fixture).toEqual({ kind: 'skip_settle', settles_on_chain: false })
      for (const other of discoveryBody.products.filter((p) => p.id !== 'vpn_basic')) {
        expect(other).not.toHaveProperty('qa_fixture')
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 20000)

  it('never carries qa_fixture on any product without the flag, even on Base Sepolia', async () => {
    const { http } = await importHttpWith({ MERCHANT_CHAIN_ID: '84532' })
    const mod = await import('./x402.js')
    const submit = vi.fn().mockResolvedValue(`0x${'cd'.repeat(32)}`)
    const waitForReceipt = vi.fn().mockResolvedValue(undefined)
    const server = http.createDemoMerchantServer({
      merchantAddress: MERCHANT,
      baseUrl: 'http://127.0.0.1:0',
      paymentProcessor: mod.createX402PaymentProcessor({ submit, waitForReceipt }),
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('no address')
      const url = `http://127.0.0.1:${address.port}/mcp`
      const origin = `http://127.0.0.1:${address.port}`
      const post = (body: unknown) =>
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
          body: JSON.stringify(body),
        })

      const listed = await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_products', arguments: {} } })
      const listedRaw = await listed.text()
      const listedDataLine = listedRaw.split('\n').find((line) => line.startsWith('data:'))
      const listedBody = JSON.parse(listedDataLine ? listedDataLine.slice('data:'.length).trim() : listedRaw) as {
        result: { structuredContent: { products: Array<Record<string, unknown>> } }
      }
      for (const product of listedBody.result.structuredContent.products) {
        expect(product).not.toHaveProperty('qa_fixture')
      }

      const quote = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'buy_vpn', arguments: { plan: 'basic' } } })
      const paymentRequired = (await quote.json()) as { resource: { description: string } }
      expect(paymentRequired.resource.description).not.toContain('QA fixture')

      const discovery = await fetch(`${origin}/`)
      const discoveryBody = (await discovery.json()) as { products: Array<Record<string, unknown>> }
      for (const product of discoveryBody.products) {
        expect(product).not.toHaveProperty('qa_fixture')
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 20000)

  it('never carries qa_fixture on any product on the unflagged mainnet path', async () => {
    const { http } = await importHttpWith({ MERCHANT_CHAIN_ID: '8453' })
    const mod = await import('./x402.js')
    const submit = vi.fn().mockResolvedValue(`0x${'cd'.repeat(32)}`)
    const waitForReceipt = vi.fn().mockResolvedValue(undefined)
    const server = http.createDemoMerchantServer({
      merchantAddress: MERCHANT,
      baseUrl: 'http://127.0.0.1:0',
      paymentProcessor: mod.createX402PaymentProcessor({ submit, waitForReceipt }),
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('no address')
      const origin = `http://127.0.0.1:${address.port}`
      const url = `http://127.0.0.1:${address.port}/mcp`
      const listed = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_products', arguments: {} } }),
      })
      const listedRaw = await listed.text()
      const listedDataLine = listedRaw.split('\n').find((line) => line.startsWith('data:'))
      const listedBody = JSON.parse(listedDataLine ? listedDataLine.slice('data:'.length).trim() : listedRaw) as {
        result: { structuredContent: { products: Array<Record<string, unknown>> } }
      }
      for (const product of listedBody.result.structuredContent.products) {
        expect(product).not.toHaveProperty('qa_fixture')
      }

      const discovery = await fetch(`${origin}/`)
      const discoveryBody = (await discovery.json()) as { products: Array<Record<string, unknown>> }
      for (const product of discoveryBody.products) {
        expect(product).not.toHaveProperty('qa_fixture')
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 20000)
})
