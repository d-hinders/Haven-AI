/**
 * #1521 — a second genuine purchase of the same product inside one
 * `X402_IDEMPOTENCY_BUCKET_MS` window collapses onto the first payment's
 * idempotency key, and the backend answers with the ALREADY-SETTLED intent
 * (`delegationReplay`'s `status: 'confirmed'` branch).
 *
 * The defect these tests pin: `authorizeStandardX402` used to mint the
 * EIP-3009 authorization BEFORE it knew what the backend would say, so on
 * that replay it paired a brand-new, unfunded authorization with the FIRST
 * purchase's `tx_hash` and returned it as a valid receipt. The delegate EOA's
 * USDC had already gone to the merchant, so the header was unfundable by
 * construction and the merchant rejected it with a balance error that reads
 * exactly like a broken payment rail.
 *
 * The subtlety, and why the fix is a balance check rather than a status
 * check: `status: 'confirmed'` on the replayed intent is AMBIGUOUS. It is
 * equally true of a legitimate resume — funding confirmed, merchant never
 * paid, delegate still holding the money. Only the delegate's balance tells
 * the two apart, so both directions are pinned here.
 *
 * `vi.mock('./provider.js')` is file-wide, hence the separate file (the same
 * reason `x402-race-condition.test.ts` exists).
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { HavenClient } from './client.js'
import { X402AlreadySettledError } from './types.js'
import type { X402PaymentRequired, X402PaymentOption } from './types.js'

const { mockBalanceOf, mockCreateJsonRpcProvider, mockCreateErc20Contract } = vi.hoisted(() => {
  const mockBalanceOf = vi.fn()
  return {
    mockBalanceOf,
    mockCreateJsonRpcProvider: vi.fn(() => ({})),
    mockCreateErc20Contract: vi.fn(() => ({ balanceOf: mockBalanceOf })),
  }
})

vi.mock('./provider.js', () => ({
  createJsonRpcProvider: mockCreateJsonRpcProvider,
  createErc20Contract: mockCreateErc20Contract,
  createWallet: vi.fn(),
}))

// A RECORDING PASSTHROUGH, not a stub: header creation keeps its real
// behaviour (the funded-resume case below needs a genuine header) while
// becoming observable, so "was a spend authorization created at all?" can be
// asserted. `x402/schemes` exports a frozen ESM namespace, so `vi.spyOn`
// cannot do this.
const { mockCreatePaymentHeader, realCreatePaymentHeader } = vi.hoisted(() => ({
  mockCreatePaymentHeader: vi.fn(),
  // `afterEach`'s `restoreAllMocks` wipes a `vi.fn()` implementation, so the
  // real one is stashed here and re-applied per test rather than set once in
  // the factory.
  realCreatePaymentHeader: { current: undefined as undefined | ((...args: never[]) => unknown) },
}))

vi.mock('x402/schemes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('x402/schemes')>()
  realCreatePaymentHeader.current = actual.exact.evm.createPaymentHeader as never
  return {
    ...actual,
    exact: {
      ...actual.exact,
      evm: { ...actual.exact.evm, createPaymentHeader: mockCreatePaymentHeader },
    },
  }
})

const accepted: X402PaymentOption = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amount: '1000',
  payTo: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2' },
}

const paymentRequired: X402PaymentRequired = {
  x402Version: 2,
  error: 'Payment required',
  resource: {
    url: 'https://api.merchant.example/paid',
    description: 'NordShield VPN Basic - $0.001 USDC',
    mimeType: 'application/json',
  },
  accepts: [accepted],
}

const delegateAddress = '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1'
const safeAddress = '0x135a9215604711AC70d970e12Caa812c53537EF4'
const backendUrl = 'https://haven.example'
const rpcUrl = 'https://rpc.test.example'

/**
 * The backend's answer when the idempotency key resolves to an intent that
 * already settled — `delegationReplay`'s first branch, verbatim in shape.
 */
function alreadySettledResponse(): Response {
  return new Response(JSON.stringify({
    success: true,
    payment_id: 'pay_first',
    status: 'confirmed',
    tx_hash: '0xfirstfunding',
    chain_id: 8453,
    safe_address: safeAddress,
    payer: safeAddress,
    token: 'USDC',
    amount: '0.001',
    to: delegateAddress,
    merchant_to: accepted.payTo,
    resource_url: paymentRequired.resource.url,
    explorer_url: 'https://basescan.org/tx/0xfirstfunding',
  }), { status: 200 })
}

function client(withRpc = false): HavenClient {
  return new HavenClient({
    apiKey: 'sk_agent_test',
    delegateKey: `0x${'01'.repeat(32)}`,
    baseUrl: backendUrl,
    x402Wallet: safeAddress,
    ...(withRpc ? { chainRpcs: { 8453: rpcUrl } } : {}),
  })
}

describe('#1521 — replayed settled payment', () => {
  beforeEach(() => {
    mockBalanceOf.mockReset()
    mockCreatePaymentHeader.mockReset()
    mockCreatePaymentHeader.mockImplementation(realCreatePaymentHeader.current!)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('refuses to hand back an authorization when the delegate cannot fund it', async () => {
    // The delegate spent its USDC on the first purchase.
    mockBalanceOf.mockResolvedValue(0n)
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(alreadySettledResponse())

    const error = await client(true).authorizeX402(paymentRequired).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(X402AlreadySettledError)
    expect((error as X402AlreadySettledError).basis).toBe('settled')
    // The ONLY call is the authorize. Nothing was signed against spent funds,
    // and no merchant retry was attempted with an unfundable header.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(`${backendUrl}/x402`)
  })

  it('carries the original receipt and the remedy, so the caller can tell what happened', async () => {
    mockBalanceOf.mockResolvedValue(0n)
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(alreadySettledResponse())

    const error = await client(true).authorizeX402(paymentRequired).catch((e: unknown) => e)

    const settled = error as X402AlreadySettledError
    // The original receipt — this is what makes the failure self-describing
    // rather than "the payment rail is broken".
    expect(settled.receipt).toMatchObject({
      paymentId: 'pay_first',
      txHash: '0xfirstfunding',
      amount: '0.001',
      token: 'USDC',
      resourceUrl: paymentRequired.resource.url,
    })
    // A receipt for a settled payment must not carry a freshly minted
    // authorization — that header is exactly the thing that was unfundable.
    expect(settled.receipt.paymentHeader).toBeUndefined()
    // The remedy is stated, because the caller cannot otherwise know that a
    // deliberate second purchase needs a distinct key.
    expect(settled.message).toContain('idempotencyKey')
  })

  it('still resumes when the delegate IS funded — the merchant was never paid', async () => {
    // Funding confirmed, merchant call never completed: same `confirmed`
    // status, opposite correct behaviour. Refusing here would break resume.
    mockBalanceOf.mockResolvedValue(5000n)
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(alreadySettledResponse())

    const receipt = await client(true).authorizeX402(paymentRequired)

    expect(receipt.txHash).toBe('0xfirstfunding')
    // A header IS minted here, and legitimately so — the delegate can fund it.
    expect(receipt.paymentHeader).toBeDefined()
  })

  it('refuses rather than guess when fundability cannot be checked', async () => {
    // No `chainRpcs` entry: `delegateCanFund` returns null. Treating that as
    // "funded" is how the defect presented, so it is treated as a refusal
    // with a weaker stated basis.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(alreadySettledResponse())

    const error = await client(false).authorizeX402(paymentRequired).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(X402AlreadySettledError)
    expect((error as X402AlreadySettledError).basis).toBe('unverifiable')
    expect(mockBalanceOf).not.toHaveBeenCalled()
  })

  it('signs nothing at all on the settled path', async () => {
    // The other half of the fix, and the half a receipt assertion cannot see:
    // the authorization is minted AFTER the backend's answer is classified,
    // so a payment that already settled never causes a spend authorization to
    // exist in the first place — not one that is created and then discarded.
    mockBalanceOf.mockResolvedValue(0n)
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(alreadySettledResponse())

    await client(true).authorizeX402(paymentRequired).catch(() => undefined)

    expect(mockCreatePaymentHeader).not.toHaveBeenCalled()
  })

  it('makes two same-product purchases in one bucket distinct when the caller says so', async () => {
    // The supported way to buy the same thing twice: distinct explicit keys.
    // Each gets its own intent, so neither takes the already-settled branch.
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({
        payment_id: 'pay_fresh',
        status: 'pending_signature',
        chain_id: 8453,
        safe_address: safeAddress,
        token: 'USDC',
        amount: '0.001',
        to: delegateAddress,
        resource_url: paymentRequired.resource.url,
        sign_data: {
          hash: `0x${'11'.repeat(32)}`,
          components: {
            safe: safeAddress,
            token: accepted.asset,
            to: delegateAddress,
            amount: accepted.amount,
            payment_token: '0x0000000000000000000000000000000000000000',
            payment: '0',
            nonce: 1,
          },
          instructions: 'Sign with delegate key',
        },
      }), { status: 201 }))

    const haven = client()
    await haven.authorizeX402(paymentRequired, { idempotencyKey: 'purchase-1' })
      .catch(() => undefined)
    await haven.authorizeX402(paymentRequired, { idempotencyKey: 'purchase-2' })
      .catch(() => undefined)

    const keys = fetchMock.mock.calls
      .filter((call) => String(call[0]).endsWith('/x402'))
      .map((call) => JSON.parse((call[1] as RequestInit).body as string).idempotencyKey)

    expect(keys).toEqual(['purchase-1', 'purchase-2'])
  })
})
