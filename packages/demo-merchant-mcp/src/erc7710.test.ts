import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem'
import { DelegationManager as DELEGATION_MANAGER_PACKAGE_ABI, ERC20TransferAmountEnforcer } from '@metamask/delegation-abis'
import { encodePaymentSignatureHeader } from '@x402/core/http'
import type { PaymentPayload, PaymentRequired } from '@x402/core/types'
import { createDemoMerchantServer } from './http.js'
import { PRODUCTS } from './products.js'
import {
  DELEGATION_STRUCT_COMPONENTS,
  ERC7710_TRANSFER_METHOD,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  createX402PaymentProcessor,
  decodeLeafDelegation,
  decodeTransferAmountCap,
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
    settlementMethods: params.options?.settlementMethods ?? (params.options?.erc7710 ? ['eip3009', 'erc7710'] : undefined),
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

async function postBuyVpn(
  url: string,
  headers: Record<string, string> = {},
  id = 1,
  plan: 'basic' | 'legacy' = 'basic',
) {
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
      params: { name: 'buy_vpn', arguments: { plan } },
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

async function postListProducts(url: string, id = 1) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'list_products', arguments: {} },
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

  it('advertises erc7710 alongside eip3009 when enabled, keeping eip3009 first by default', async () => {
    const { url } = await startServer({ erc7710Client: mockErc7710Client(), options: { erc7710: { delegationManager: DELEGATION_MANAGER } } })
    const unpaid = await postBuyVpn(url)
    const paymentRequired = await unpaid.json() as PaymentRequired
    const products = await postListProducts(url, 2)
    const productText = await products.text()

    expect(unpaid.status).toBe(402)
    expect(products.status).toBe(200)
    expect(productText).toContain('settlement_methods=eip3009,erc7710')
    expect(productText).toContain('default=eip3009')
    expect(productText).toContain('Merchant MCP URL: http://127.0.0.1:0/mcp')
    expect(productText).toContain('dev=https://demo-merchant-dev-84e4.up.railway.app/mcp')
    expect(productText).toContain('prod=https://enthusiastic-blessing-production-171f.up.railway.app/mcp')
    expect(paymentRequired.accepts).toHaveLength(2)
    expect(paymentRequired.accepts[0]).toMatchObject({
      scheme: 'exact',
      amount: '1000',
      payTo: MERCHANT,
      extra: { name: 'USD Coin', version: '2' },
    })
    expect(paymentRequired.accepts[1]).toMatchObject({
      scheme: 'exact',
      amount: '1000',
      payTo: MERCHANT,
      extra: { assetTransferMethod: ERC7710_TRANSFER_METHOD },
    })
    // The mock client names no redeemer — nothing must be advertised, so a
    // payer never pins a caveat to an address that will not redeem.
    expect(paymentRequired.accepts[1].extra).not.toHaveProperty('facilitatorAddresses')
  })

  it('puts explicit eip3009 selection first while still advertising erc7710', async () => {
    const { url } = await startServer({ erc7710Client: mockErc7710Client(), options: { erc7710: { delegationManager: DELEGATION_MANAGER } } })
    const unpaid = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'buy_vpn', arguments: { plan: 'basic', settlement_method: 'eip3009' } },
      }),
    })
    const paymentRequired = await unpaid.json() as PaymentRequired

    expect(unpaid.status).toBe(402)
    expect(paymentRequired.accepts.map((option) => option.extra.assetTransferMethod ?? 'eip3009')).toEqual(['eip3009', 'erc7710'])
  })

  // #1058: when the settlement client names its redeemer, the erc7710 option
  // advertises it so payers can pin their child delegation's redeemer caveat.
  it('advertises the redeemer as extra.facilitatorAddresses when the client names one', async () => {
    const REDEEMER = '0x2222222222222222222222222222222222222222' as const
    const erc7710Client = { ...mockErc7710Client(), redeemerAddress: REDEEMER }
    const { url } = await startServer({
      erc7710Client,
      options: { erc7710: { delegationManager: DELEGATION_MANAGER } },
    })
    const unpaid = await postBuyVpn(url)
    const paymentRequired = await unpaid.json() as PaymentRequired

    expect(unpaid.status).toBe(402)
    expect(paymentRequired.accepts[1].extra).toEqual({
      name: 'USD Coin',
      version: '2',
      assetTransferMethod: ERC7710_TRANSFER_METHOD,
      facilitatorAddresses: [REDEEMER],
    })
    expect(paymentRequired.accepts[0].extra).toEqual({ name: 'USD Coin', version: '2' })
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
      accepted: storageRequired.accepts.find((option) => option.extra?.assetTransferMethod === ERC7710_TRANSFER_METHOD)!,
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

describe("a product's own settlement methods bind the 402 it serves (#1441)", () => {
  /**
   * The catalogue said one thing and the challenge served another. `vpn_legacy`
   * advertises eip3009 alone, but the 402 was built from the MERCHANT-wide
   * enabled set — so it offered erc7710, a delegation-rail client preferred it
   * per #1450, and the funding-leg topology stayed unreachable even after the
   * product existed to make it reachable.
   *
   * Caught by a live `qa-dev` run, not by any test: the leg failed with
   * `hosted quote selected "erc7710" for plan 'legacy', which advertises
   * eip3009 ONLY`. The 402 is what decides, so it is what must be asserted.
   */
  it('serves a 3009-ONLY challenge for a 3009-only product, even with erc7710 enabled', async () => {
    const { url } = await startServer({
      erc7710Client: mockErc7710Client(),
      options: { erc7710: { delegationManager: DELEGATION_MANAGER } },
    })

    const unpaid = await postBuyVpn(url, {}, 1, 'legacy')
    const paymentRequired = await unpaid.json() as PaymentRequired

    expect(unpaid.status).toBe(402)
    expect(paymentRequired.accepts).toHaveLength(1)
    expect(paymentRequired.accepts[0]?.extra?.assetTransferMethod).not.toBe(ERC7710_TRANSFER_METHOD)
  })

  it('still serves both for a product that advertises both, so the gate only narrows', async () => {
    const { url } = await startServer({
      erc7710Client: mockErc7710Client(),
      options: { erc7710: { delegationManager: DELEGATION_MANAGER } },
    })

    const unpaid = await postBuyVpn(url, {}, 1, 'basic')
    const paymentRequired = await unpaid.json() as PaymentRequired

    expect(paymentRequired.accepts).toHaveLength(2)
  })
})

describe('restart survival — the chain remembers what the maps forget (#1515)', () => {
  // The PINNED transfer-amount enforcer (deterministic; the signer pins the same).
  const ENFORCER = '0xf100b0819427117EcF76Ed94B358B1A5b5C6D2Fc' as const
  const OTHER_ENFORCER = '0x1046bb45C8d673d4ea75321280DB34899413c069' as const
  const LEAF_HASH = `0x${'1f'.repeat(32)}` as const
  const PRICE = 1_000n // vpn_basic
  const ERC7710_OPTIONS = {
    erc7710: { delegationManager: DELEGATION_MANAGER, erc20TransferAmountEnforcer: ENFORCER },
  } as const

  /** ERC20TransferAmountEnforcer terms: 20-byte token ‖ 32-byte cap. */
  function transferAmountTerms(cap: bigint): Hex {
    const token = '00'.repeat(20)
    const amount = cap.toString(16).padStart(64, '0')
    return `0x${token}${amount}` as Hex
  }

  /**
   * A REAL abi-encoded Delegation[] — the shape a MetaMask permissionContext
   * has. `capEnforcer`/`cap` let a test forge the transfer-amount caveat.
   */
  function realPermissionContext(
    opts: { capEnforcer?: Address; cap?: bigint } = {},
  ): Hex {
    const capEnforcer = opts.capEnforcer ?? ENFORCER
    const cap = opts.cap ?? PRICE
    return encodeAbiParameters(
      [{ name: 'delegations', type: 'tuple[]', components: DELEGATION_STRUCT_COMPONENTS }],
      [[
        {
          delegate: MERCHANT,
          delegator: DELEGATOR,
          authority: `0x${'aa'.repeat(32)}` as Hex,
          caveats: [
            // Deliberately NOT first: the check must find the transfer-amount
            // caveat by (pinned) address, not by assuming a position.
            { enforcer: OTHER_ENFORCER, terms: '0x' as Hex, args: '0x' as Hex },
            { enforcer: capEnforcer, terms: transferAmountTerms(cap), args: '0x' as Hex },
          ],
          salt: 0n,
          signature: `0x${'cc'.repeat(65)}` as Hex,
        },
      ]],
    )
  }

  /** Chain state after a restart that lost the maps: the child is exhausted. */
  function restartedClient(params: { spent: bigint | null }): Erc7710SettlementClient {
    return {
      simulateRedeemDelegations: vi
        .fn<Erc7710SettlementClient['simulateRedeemDelegations']>()
        .mockRejectedValue(new Error('ERC20TransferAmountEnforcer: allowance-exceeded')),
      submitRedeemDelegations: vi.fn<Erc7710SettlementClient['submitRedeemDelegations']>(),
      getDelegationHash: vi
        .fn<NonNullable<Erc7710SettlementClient['getDelegationHash']>>()
        .mockResolvedValue(LEAF_HASH),
      // Only the PINNED enforcer answers with a real number; a forged enforcer
      // in this mock would return whatever a real attacker contract chose — so
      // the mock returns a huge number for ANY address to prove the code, not
      // the mock, is what refuses an untrusted enforcer.
      spentOnDelegation: vi
        .fn<NonNullable<Erc7710SettlementClient['spentOnDelegation']>>()
        .mockResolvedValue(params.spent),
    }
  }

  it('a paid retry after a merchant restart is SERVED, with no second submit (the #1515 defect)', async () => {
    const context = realPermissionContext()

    // Before the restart: a normal successful settlement.
    const first = mockErc7710Client()
    const server1 = await startServer({ erc7710Client: first, options: ERC7710_OPTIONS })
    const unpaid = await postBuyVpn(server1.url)
    const paymentRequired = await unpaid.json() as PaymentRequired
    const header = erc7710Header(paymentRequired, { permissionContext: context })
    const paid = await postBuyVpn(server1.url, { [PAYMENT_SIGNATURE_HEADER]: header }, 2)
    expect(paid.status).toBe(200)
    expect(first.submitRedeemDelegations).toHaveBeenCalledTimes(1)

    // "Restart": a fresh server with empty maps, over chain state where the
    // child's exact amount is already spent — simulation now reverts.
    const second = restartedClient({ spent: PRICE })
    const server2 = await startServer({ erc7710Client: second, options: ERC7710_OPTIONS })
    const retryUnpaid = await postBuyVpn(server2.url)
    const retryPr = await retryUnpaid.json() as PaymentRequired
    const retry = await postBuyVpn(
      server2.url,
      { [PAYMENT_SIGNATURE_HEADER]: erc7710Header(retryPr, { permissionContext: context }) },
      2,
    )
    const text = await retry.text()

    // The buyer whose money already moved gets the goods, and nothing is
    // submitted on-chain again. The spent read went to the PINNED enforcer.
    expect(retry.status).toBe(200)
    expect(retry.headers.get(PAYMENT_RESPONSE_HEADER)).toBeTruthy()
    expect(text).toContain('Köp bekräftat')
    expect(second.submitRedeemDelegations).not.toHaveBeenCalled()
    expect(second.spentOnDelegation).toHaveBeenCalledWith(ENFORCER, DELEGATION_MANAGER, LEAF_HASH)
  })

  it('an unredeemed child whose simulation fails is still REFUSED — the check must not over-serve', async () => {
    const client = restartedClient({ spent: 0n })
    const { url } = await startServer({ erc7710Client: client, options: ERC7710_OPTIONS })
    const unpaid = await postBuyVpn(url)
    const paymentRequired = await unpaid.json() as PaymentRequired

    const rejected = await postBuyVpn(
      url,
      { [PAYMENT_SIGNATURE_HEADER]: erc7710Header(paymentRequired, { permissionContext: realPermissionContext() }) },
      2,
    )
    const body = await rejected.json() as PaymentRequired

    expect(rejected.status).toBe(402)
    expect(body.error).toContain('simulation failed')
    expect(client.submitRedeemDelegations).not.toHaveBeenCalled()
  })

  it('SECURITY: a forged caveat enforcer is NOT trusted — no free goods from an attacker oracle', async () => {
    // The attacker names their own contract as the transfer-amount caveat and
    // has it report a huge spend. The pinned-enforcer bind must ignore it: the
    // real trusted enforcer is absent from this context, so the check finds no
    // trusted caveat and refuses. `restartedClient` returns a huge spent for
    // ANY address, so only the code's address bind — not the mock — refuses.
    const client = restartedClient({ spent: 10n ** 18n })
    const { url } = await startServer({ erc7710Client: client, options: ERC7710_OPTIONS })
    const unpaid = await postBuyVpn(url)
    const paymentRequired = await unpaid.json() as PaymentRequired

    const attacker = await postBuyVpn(
      url,
      {
        [PAYMENT_SIGNATURE_HEADER]: erc7710Header(paymentRequired, {
          permissionContext: realPermissionContext({ capEnforcer: OTHER_ENFORCER }),
        }),
      },
      2,
    )
    expect(attacker.status).toBe(402)
    expect(client.submitRedeemDelegations).not.toHaveBeenCalled()
    // The untrusted enforcer's spentMap is never even consulted.
    expect(client.spentOnDelegation).not.toHaveBeenCalled()
  })

  it('SECURITY: a child spent for an expensive product cannot buy a cheaper one after restart', async () => {
    // The exhausted child was minted exact-amount for vpn_pro (cap 3000). The
    // buyer replays that SAME context against vpn_basic (price 1000). spentMap
    // reports 3000 >= 1000 — but the cap bind (3000 ≠ 1000) refuses, so the
    // pre-#1515 `spent >= amount` cross-product replay is closed.
    const proContext = realPermissionContext({ cap: 3_000n })
    const client = restartedClient({ spent: 3_000n })
    const { url } = await startServer({ erc7710Client: client, options: ERC7710_OPTIONS })
    const unpaid = await postBuyVpn(url) // vpn_basic, price 1000
    const paymentRequired = await unpaid.json() as PaymentRequired

    const replay = await postBuyVpn(
      url,
      { [PAYMENT_SIGNATURE_HEADER]: erc7710Header(paymentRequired, { permissionContext: proContext }) },
      2,
    )
    expect(replay.status).toBe(402)
    expect(client.submitRedeemDelegations).not.toHaveBeenCalled()
  })

  it('a client without the chain-read methods keeps the pre-#1515 refusal behaviour', async () => {
    const client = mockErc7710Client()
    vi.mocked(client.simulateRedeemDelegations).mockRejectedValue(new Error('allowance-exceeded'))
    const { url } = await startServer({ erc7710Client: client, options: ERC7710_OPTIONS })
    const unpaid = await postBuyVpn(url)
    const paymentRequired = await unpaid.json() as PaymentRequired

    const rejected = await postBuyVpn(
      url,
      { [PAYMENT_SIGNATURE_HEADER]: erc7710Header(paymentRequired, { permissionContext: realPermissionContext() }) },
      2,
    )
    expect(rejected.status).toBe(402)
  })

  it('decodeLeafDelegation: real context round-trips, garbage is null — never a throw', () => {
    const leaf = decodeLeafDelegation(realPermissionContext())
    expect(leaf?.delegator).toBe(DELEGATOR)
    expect(leaf?.caveats.map((caveat) => caveat.enforcer)).toEqual([OTHER_ENFORCER, ENFORCER])
    expect(decodeLeafDelegation(PERMISSION_CONTEXT)).toBeNull()
    expect(decodeLeafDelegation('0x')).toBeNull()
  })

  it('GUARD: erc7710-eligible product prices stay unique — the cap bind is price-shaped', () => {
    // The already-redeemed bind identifies a purchase by its exact-amount cap,
    // which is only a purchase identity while no two erc7710 products share a
    // price. If two did, an exhausted child from one could satisfy the other
    // post-restart: paid once, served twice. Prices are distinct today
    // (vpn_basic and vpn_legacy both cost 1000, but vpn_legacy is 3009-only),
    // and this fails the moment someone prices a new erc7710 product onto an
    // existing one — which would silently reopen a free-goods path.
    const erc7710Prices = Object.values(PRODUCTS)
      .filter((product) => product.x402.settlementMethods.includes(ERC7710_TRANSFER_METHOD))
      .map((product) => product.price_usdc)
    expect(new Set(erc7710Prices).size).toBe(erc7710Prices.length)
  })

  it('decodeTransferAmountCap: reads maxTokens from 20+32-byte terms, null on short terms', () => {
    expect(decodeTransferAmountCap(transferAmountTerms(1_000n))).toBe(1_000n)
    expect(decodeTransferAmountCap(transferAmountTerms(0n))).toBe(0n)
    expect(decodeTransferAmountCap('0x')).toBeNull()
    expect(decodeTransferAmountCap(`0x${'00'.repeat(40)}` as Hex)).toBeNull()
  })

  it('pin: the mirrored Delegation struct matches @metamask/delegation-abis exactly', () => {
    // The decode literal in x402.ts is hand-mirrored for static typing; this
    // is what makes mirrored survivable. `getDelegationHash`'s input IS the
    // struct, componentwise.
    const fn = DELEGATION_MANAGER_PACKAGE_ABI.find(
      (entry): entry is Extract<typeof entry, { type: 'function' }> =>
        entry.type === 'function' && entry.name === 'getDelegationHash',
    )
    const strip = (components: readonly unknown[]): unknown =>
      components.map((c) => {
        const { name, type, components: nested } = c as { name: string; type: string; components?: readonly unknown[] }
        return { name, type, ...(nested ? { components: strip(nested) } : {}) }
      })
    expect(strip((fn?.inputs[0] as { components: readonly unknown[] }).components)).toEqual(
      strip(DELEGATION_STRUCT_COMPONENTS),
    )

    // And the spentMap read the client performs matches the enforcer's ABI.
    const spentMap = ERC20TransferAmountEnforcer.find(
      (entry) => entry.type === 'function' && entry.name === 'spentMap',
    ) as { inputs: readonly { type: string }[]; outputs: readonly { type: string }[] } | undefined
    expect(spentMap?.inputs.map((input) => input.type)).toEqual(['address', 'bytes32'])
    expect(spentMap?.outputs.map((output) => output.type)).toEqual(['uint256'])
  })
})
