import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { keccak256 } from 'viem'
import { encodePaymentSignatureHeader } from '@x402/core/http'
import type { PaymentPayload, PaymentRequired } from '@x402/core/types'
import { createDemoMerchantServer } from './http.js'
import {
  ERC7710_TRANSFER_METHOD,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  createX402PaymentProcessor,
  type Erc7710SettlementClient,
  type SettlementClient,
  type X402PaymentProcessorOptions,
} from './x402.js'

const MERCHANT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a' as const
const DELEGATOR = '0x36615Cf349d7F6344891B1e7CA7C72883F5dc049' as const
const DELEGATION_MANAGER = '0x739309deED0Ae184E66a427ACa432aE1D91d022e' as const
const PERMISSION_CONTEXT = `0x${'ab'.repeat(96)}` as const
const TX_HASH = `0x${'ef'.repeat(32)}` as const
const ERC20_TRANSFER_SELECTOR = '0xa9059cbb'

let servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  servers = []
  vi.restoreAllMocks()
})

function mockErc7710Client(): Erc7710SettlementClient {
  return {
    simulateRedeemDelegations: vi.fn<Erc7710SettlementClient['simulateRedeemDelegations']>().mockResolvedValue(undefined),
    submitRedeemDelegations: vi.fn<Erc7710SettlementClient['submitRedeemDelegations']>().mockResolvedValue(TX_HASH),
  }
}

async function startServer(params: {
  erc7710Client?: Erc7710SettlementClient
  options?: X402PaymentProcessorOptions
} = {}) {
  const settlementClient: SettlementClient = {
    submit: vi.fn<SettlementClient['submit']>().mockResolvedValue(TX_HASH),
    waitForReceipt: vi.fn<SettlementClient['waitForReceipt']>().mockResolvedValue(undefined),
    erc7710: params.erc7710Client,
  }
  const server = createDemoMerchantServer({
    merchantAddress: MERCHANT,
    baseUrl: 'http://127.0.0.1:0',
    paymentProcessor: createX402PaymentProcessor(settlementClient, params.options),
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test server port')
  return { url: `http://127.0.0.1:${address.port}/mcp` }
}

function erc7710Header(
  pr: PaymentRequired,
  overrides: Partial<Record<'delegator' | 'delegationManager' | 'permissionContext', unknown>> = {},
): string {
  const accepted = pr.accepts.find((option) => option.extra?.assetTransferMethod === ERC7710_TRANSFER_METHOD)
  if (!accepted) throw new Error('Merchant did not offer an erc7710 option')
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: pr.resource,
    accepted,
    payload: {
      delegator: DELEGATOR,
      delegationManager: DELEGATION_MANAGER,
      permissionContext: PERMISSION_CONTEXT,
      ...overrides,
    },
  }
  return encodePaymentSignatureHeader(payload)
}

async function postBuyVpn(url: string, headers: Record<string, string> = {}, id = 1) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'buy_vpn', arguments: { plan: 'basic' } },
    }),
  })
}

async function postBuyStorage(url: string, headers: Record<string, string> = {}, id = 1) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'buy_cloud_storage', arguments: { tier: '50gb' } },
    }),
  })
}

describe('demo merchant experimental erc7710 rail', () => {
  it('does not advertise erc7710 when the flag is off, and rejects erc7710 payments', async () => {
    const erc7710Client = mockErc7710Client()
    const { url } = await startServer({ erc7710Client })
    const unpaid = await postBuyVpn(url)
    const paymentRequired = await unpaid.json() as PaymentRequired

    expect(unpaid.status).toBe(402)
    expect(paymentRequired.accepts).toHaveLength(1)
    expect(paymentRequired.accepts[0].extra).toEqual({ name: 'USD Coin', version: '2' })

    // A client forcing the method against a merchant that did not offer it is refused.
    const forged: PaymentPayload = {
      x402Version: 2,
      resource: paymentRequired.resource,
      accepted: { ...paymentRequired.accepts[0], extra: { assetTransferMethod: ERC7710_TRANSFER_METHOD } },
      payload: { delegator: DELEGATOR, delegationManager: DELEGATION_MANAGER, permissionContext: PERMISSION_CONTEXT },
    }
    const rejected = await postBuyVpn(url, { [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader(forged) }, 2)
    const body = await rejected.json() as PaymentRequired

    expect(rejected.status).toBe(402)
    expect(body.error).toContain('ERC-7710 payments are not enabled')
    expect(erc7710Client.simulateRedeemDelegations).not.toHaveBeenCalled()
    expect(erc7710Client.submitRedeemDelegations).not.toHaveBeenCalled()
  })

  it('advertises erc7710 alongside eip3009 when enabled, keeping eip3009 first', async () => {
    const { url } = await startServer({ erc7710Client: mockErc7710Client(), options: { erc7710: { delegationManager: DELEGATION_MANAGER } } })
    const unpaid = await postBuyVpn(url)
    const paymentRequired = await unpaid.json() as PaymentRequired

    expect(unpaid.status).toBe(402)
    expect(paymentRequired.accepts).toHaveLength(2)
    expect(paymentRequired.accepts[0].extra).toEqual({ name: 'USD Coin', version: '2' })
    expect(paymentRequired.accepts[1]).toMatchObject({
      scheme: 'exact',
      amount: '1000',
      payTo: MERCHANT,
      extra: { assetTransferMethod: ERC7710_TRANSFER_METHOD },
    })
  })

  it('verifies by simulation, settles via redeemDelegations, and invoices the delegator as payer', async () => {
    const erc7710Client = mockErc7710Client()
    const { url } = await startServer({ erc7710Client, options: { erc7710: { delegationManager: DELEGATION_MANAGER } } })
    const unpaid = await postBuyVpn(url)
    const paymentRequired = await unpaid.json() as PaymentRequired
    const header = erc7710Header(paymentRequired)

    const paid = await postBuyVpn(url, { [PAYMENT_SIGNATURE_HEADER]: header }, 2)
    const text = await paid.text()

    expect(paid.status).toBe(200)
    expect(paid.headers.get(PAYMENT_RESPONSE_HEADER)).toBeTruthy()
    expect(erc7710Client.simulateRedeemDelegations).toHaveBeenCalledTimes(1)
    expect(erc7710Client.submitRedeemDelegations).toHaveBeenCalledTimes(1)

    const redeemCall = vi.mocked(erc7710Client.submitRedeemDelegations).mock.calls[0][0]
    expect(redeemCall.delegationManager).toBe(DELEGATION_MANAGER)
    expect(redeemCall.permissionContext).toBe(PERMISSION_CONTEXT)
    expect(redeemCall.mode).toBe(`0x${'0'.repeat(64)}`)
    // Execution calldata is the packed single-call (USDC, 0, transfer(merchant, amount)).
    expect(redeemCall.executionCallData.toLowerCase()).toContain(ERC20_TRANSFER_SELECTOR.slice(2))
    expect(redeemCall.executionCallData.toLowerCase()).toContain(MERCHANT.slice(2).toLowerCase())
    // Verification and settlement use the identical redeem call.
    expect(vi.mocked(erc7710Client.simulateRedeemDelegations).mock.calls[0][0]).toEqual(redeemCall)

    expect(text).toContain('Köp bekräftat')
    expect(text).toContain(DELEGATOR)
    expect(text).toContain(TX_HASH)
  })

  it('rejects a failing redemption simulation without settling', async () => {
    const erc7710Client = mockErc7710Client()
    vi.mocked(erc7710Client.simulateRedeemDelegations).mockRejectedValue(new Error('AllowedTargetsEnforcer: reverted'))
    const { url } = await startServer({ erc7710Client, options: { erc7710: { delegationManager: DELEGATION_MANAGER } } })
    const unpaid = await postBuyVpn(url)
    const paymentRequired = await unpaid.json() as PaymentRequired

    const rejected = await postBuyVpn(url, { [PAYMENT_SIGNATURE_HEADER]: erc7710Header(paymentRequired) }, 2)
    const body = await rejected.json() as PaymentRequired

    expect(rejected.status).toBe(402)
    expect(body.error).toContain('simulation failed')
    expect(body.error).toContain('AllowedTargetsEnforcer')
    expect(erc7710Client.submitRedeemDelegations).not.toHaveBeenCalled()
  })

  it('rejects a delegationManager other than the pinned trusted contract, before simulating', async () => {
    const erc7710Client = mockErc7710Client()
    const { url } = await startServer({ erc7710Client, options: { erc7710: { delegationManager: DELEGATION_MANAGER } } })
    const unpaid = await postBuyVpn(url)
    const paymentRequired = await unpaid.json() as PaymentRequired

    // A valid-looking payload naming an attacker-deployed no-op "manager" must
    // never reach simulation or settlement — simulating an untrusted contract
    // proves nothing.
    const rejected = await postBuyVpn(url, {
      [PAYMENT_SIGNATURE_HEADER]: erc7710Header(paymentRequired, {
        delegationManager: '0x000000000000000000000000000000000000dEaD',
      }),
    }, 2)
    const body = await rejected.json() as PaymentRequired

    expect(rejected.status).toBe(402)
    expect(body.error).toContain('not the delegation manager trusted by this merchant')
    expect(erc7710Client.simulateRedeemDelegations).not.toHaveBeenCalled()
    expect(erc7710Client.submitRedeemDelegations).not.toHaveBeenCalled()
  })

  it('rejects malformed erc7710 payloads before simulating', async () => {
    const erc7710Client = mockErc7710Client()
    const { url } = await startServer({ erc7710Client, options: { erc7710: { delegationManager: DELEGATION_MANAGER } } })
    const unpaid = await postBuyVpn(url)
    const paymentRequired = await unpaid.json() as PaymentRequired

    const cases: Array<[Record<string, unknown>, string]> = [
      [{ delegator: 'not-an-address' }, 'delegator'],
      [{ delegationManager: '0x1234' }, 'delegationManager'],
      [{ permissionContext: undefined }, 'permissionContext'],
      [{ permissionContext: '0xabc' }, 'permissionContext'],
    ]
    for (const [overrides, field] of cases) {
      const rejected = await postBuyVpn(url, { [PAYMENT_SIGNATURE_HEADER]: erc7710Header(paymentRequired, overrides) }, 2)
      const body = await rejected.json() as PaymentRequired
      expect(rejected.status).toBe(402)
      expect(body.error).toContain(field)
    }
    expect(erc7710Client.simulateRedeemDelegations).not.toHaveBeenCalled()
  })

  it('settles a delegation once: duplicate retries are cached, other products are refused', async () => {
    const erc7710Client = mockErc7710Client()
    const { url } = await startServer({ erc7710Client, options: { erc7710: { delegationManager: DELEGATION_MANAGER } } })
    const unpaid = await postBuyVpn(url)
    const paymentRequired = await unpaid.json() as PaymentRequired
    const header = erc7710Header(paymentRequired)
    const contextHash = keccak256(PERMISSION_CONTEXT)

    const paid = await postBuyVpn(url, { [PAYMENT_SIGNATURE_HEADER]: header }, 2)
    const text = await paid.text()
    expect(paid.status).toBe(200)
    expect(text).toContain(contextHash)

    const duplicate = await postBuyVpn(url, { [PAYMENT_SIGNATURE_HEADER]: header }, 3)
    const duplicateText = await duplicate.text()
    expect(duplicate.status).toBe(200)
    expect(duplicateText.match(/FAK-2026-\d+/)?.[0]).toBe(text.match(/FAK-2026-\d+/)?.[0])
    expect(erc7710Client.submitRedeemDelegations).toHaveBeenCalledTimes(1)

    // The same delegation must not buy a second product in this demo.
    const storageUnpaid = await postBuyStorage(url, {}, 4)
    const storageRequired = await storageUnpaid.json() as PaymentRequired
    const reuse: PaymentPayload = {
      x402Version: 2,
      resource: storageRequired.resource,
      accepted: storageRequired.accepts[1],
      payload: { delegator: DELEGATOR, delegationManager: DELEGATION_MANAGER, permissionContext: PERMISSION_CONTEXT },
    }
    const refused = await postBuyStorage(url, { [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader(reuse) }, 5)
    const refusedBody = await refused.json() as PaymentRequired
    expect(refused.status).toBe(402)
    expect(refusedBody.error).toContain('already settled a different product')
    expect(erc7710Client.submitRedeemDelegations).toHaveBeenCalledTimes(1)
  })

  it('rejects erc7710 payments when the settlement client has no erc7710 support', async () => {
    const { url } = await startServer({ options: { erc7710: { delegationManager: DELEGATION_MANAGER } } })
    const unpaid = await postBuyVpn(url)
    const paymentRequired = await unpaid.json() as PaymentRequired

    const rejected = await postBuyVpn(url, { [PAYMENT_SIGNATURE_HEADER]: erc7710Header(paymentRequired) }, 2)
    const body = await rejected.json() as PaymentRequired

    expect(rejected.status).toBe(402)
    expect(body.error).toContain('not configured')
  })
})
