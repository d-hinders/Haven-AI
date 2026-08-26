/**
 * The assertions that stop `x402-catalog-guided-purchase` (#1312) passing
 * vacuously.
 *
 * The hazard is the same class #1154's `x402-hosted-mcp-signer.test.ts`
 * guards against, aimed at the NEW guided entry point: a green run that
 * means less than a reader assumes because the agent secretly had to
 * re-thread bulky protocol state, or because the catalog id was hardcoded
 * rather than resolved, or because the compact/guidance/allowance contracts
 * #1306–#1310 promise silently regressed. Each test feeds the shape the
 * scenario must reject. Network and chain seams are mocked so the assertion
 * logic is the only thing under test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ScenarioContext } from './types.js'

const DELEGATE = '0x' + '11'.repeat(20)
const TREASURY = '0x' + 'a1'.repeat(20)
const MERCHANT_URL = 'https://demo-merchant.example'
const HOSTED_MCP = 'https://hosted-mcp.example/v1'
const BINDING_SIGNER = '0x' + 'bb'.repeat(20)
const FUNDING_TX = '0x' + 'f1'.repeat(32)
const MERCHANT_TX = '0x' + 'f2'.repeat(32)
const CATALOG_ID = 'cat_nordshield_vpn_basic'

const { mockCallTool, mockGetAgent, mockGetCatalog, mockBalanceOf, mockGetReceipt, mockSignX402, mockSign } = vi.hoisted(
  () => ({
    mockCallTool: vi.fn(),
    mockGetAgent: vi.fn(),
    mockGetCatalog: vi.fn(),
    mockBalanceOf: vi.fn(),
    mockGetReceipt: vi.fn(),
    mockSignX402: vi.fn(),
    mockSign: vi.fn(),
  }),
)

vi.mock('@haven_ai/signer', () => ({
  createEdgeSigner: () => ({ delegateAddress: DELEGATE }),
  createToolHandlers: () => ({ haven_sign_x402: mockSignX402, haven_sign: mockSign }),
}))
vi.mock('../lib/haven-api.js', () => ({
  HavenApi: class {
    getAgent = mockGetAgent
    getCatalog = mockGetCatalog
  },
}))
vi.mock('ethers', async (importOriginal) => {
  // formatUnits stays REAL — failure messages quote amounts, and a mocked
  // formatter would let a unit bug through the very assertions that report it.
  const actual = await importOriginal<typeof import('ethers')>()
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      JsonRpcProvider: class {
        getTransactionReceipt = mockGetReceipt
      },
      Contract: class {
        balanceOf = mockBalanceOf
      },
    },
  }
})

const { HostedMcpToolError, HostedMcpTransportError } = await import('../lib/hosted-mcp.js')
vi.mock('../lib/hosted-mcp.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/hosted-mcp.js')>()
  return {
    ...actual,
    HostedMcpClient: class {
      callTool = mockCallTool
    },
  }
})

const { x402CatalogGuidedPurchase, TIMING } = await import('./x402-catalog-guided-purchase.js')

// Real values would make each missing-receipt / non-converging-balance case
// sit out a 60–90s wait.
TIMING.receiptWaitMs = 60
TIMING.balanceWaitMs = 60
TIMING.pollIntervalMs = 20

/** The catalog row a real `GET /catalog` would return for NordShield VPN Basic. */
const catalogEntry = (over: Record<string, unknown> = {}) => ({
  id: CATALOG_ID,
  name: 'NordShield VPN Basic — demo merchant (Base Sepolia)',
  resource_url: `${MERCHANT_URL}/mcp`,
  protocol: 'mcp',
  tool_name: 'buy_vpn',
  tool_arguments: { plan: 'basic' },
  status: 'active',
  ...over,
})

/** A guided catalog preflight (#1306) — the shape this leg exists to cover. */
const prep = (over: Record<string, unknown> = {}) => ({
  payment_id: 'pay_catalog_1',
  status: 'pending_signature',
  payload_hash: '0x' + 'cd'.repeat(32),
  signature_scheme: 'eip712_userop',
  // #1272: the production default is COMPACT — no typed_data/typed_data_b64.
  amount_atomic: '1000',
  amount: '0.001',
  token: 'USDC',
  catalog_id: CATALOG_ID,
  catalog_name: 'NordShield VPN Basic — demo merchant (Base Sepolia)',
  catalog_price_atomic: '1000',
  catalog_price_display: '$0.001 USDC',
  catalog_price_is_indicative: true,
  allowance: { rail: 'delegation', sufficient: true, remaining_atomic: '2000000', source: 'active_delegations' },
  next_action: 'sign_and_submit_payment',
  next_tool: 'mcp__haven-signer__haven_sign_x402',
  next_arguments: { payment_id: 'pay_catalog_1' },
  x402: {
    expected: {
      payment_id: 'pay_catalog_1',
      payload_hash: '0x' + 'cd'.repeat(32),
      resource_url: `${MERCHANT_URL}/mcp`,
      merchant_to: '0x' + 'cc'.repeat(20),
      amount: '1000',
      asset: '0x' + '99'.repeat(20),
      network: 'base-sepolia',
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      typed_data_hash: '0x' + 'ef'.repeat(32),
      auth: { version: 2, message: 'Haven x402 expected context v2\n{}', signature: '0xaa', signer: BINDING_SIGNER },
    },
  },
  ...over,
})

const settled = (over: Record<string, unknown> = {}) => ({
  payment_id: 'pay_catalog_1',
  funding_tx_hash: FUNDING_TX,
  settled: true,
  settlement_tx_hash: MERCHANT_TX,
  result: { content: [{ text: 'VPN basic purchased' }] },
  allowance: {
    rail: 'delegation',
    remaining_atomic: '1999000',
    token_symbol: 'USDC',
    token_address: '0x' + '99'.repeat(20),
    source: 'active_delegations',
  },
  ...over,
})

function ctx(over: Partial<ScenarioContext['cfg']> = {}): ScenarioContext {
  return {
    cfg: {
      apiUrl: 'https://dev-backend.example',
      paymentTo: '0x' + 'dd'.repeat(20),
      demoMerchantUrl: MERCHANT_URL,
      delegationAgentApiKey: 'sk_agent_delegation',
      delegationDelegateKey: '0x' + '33'.repeat(32),
      hostedMcpUrl: HOSTED_MCP,
      x402BindingSigner: BINDING_SIGNER,
      ...over,
    },
  }
}

/**
 * The scenario reads a (treasury, delegate) baseline pair, then POLLS the
 * same pair until both settle conditions hold. Modelled as a call counter, as
 * the sibling `x402-hosted-mcp-signer.test.ts` does.
 */
function balances(treasuryBefore = 1_000_000n, delegateBefore = 0n, treasuryAfter = 999_000n, delegateAfter = 0n) {
  let call = 0
  mockBalanceOf.mockReset()
  mockBalanceOf.mockImplementation(async () => {
    const index = call++
    if (index === 0) return treasuryBefore
    if (index === 1) return delegateBefore
    return index % 2 === 0 ? treasuryAfter : delegateAfter
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetAgent.mockResolvedValue({ ok: true, data: { safe_address: TREASURY, delegate_address: DELEGATE } })
  mockGetCatalog.mockResolvedValue({ ok: true, status: 200, data: { entries: [catalogEntry()] } })
  mockCallTool.mockImplementation(async (tool: string) =>
    tool === 'haven_prepare_catalog_purchase' ? prep() : settled(),
  )
  mockSignX402.mockResolvedValue({
    success: true,
    data: { signature: '0xsig', x402_binding: 'b1', payment_header: 'hdr', accepted: {} },
  })
  mockGetReceipt.mockResolvedValue({ status: 1, blockNumber: 45_212_857 })
  balances()
})

describe('preconditions skip rather than fail', () => {
  it.each([
    ['no demo merchant', { demoMerchantUrl: undefined }],
    ['no hosted MCP URL', { hostedMcpUrl: undefined }],
    ['no binding signer', { x402BindingSigner: undefined }],
    ['no delegation api key', { delegationAgentApiKey: undefined }],
    ['no delegation delegate key', { delegationDelegateKey: undefined }],
  ])('skips with %s, and never calls the catalog API or the hosted server', async (_name, over) => {
    const r = await x402CatalogGuidedPurchase.run(ctx(over))
    expect(r.skipped).toBe(true)
    expect(r.pass).toBe(true)
    expect(mockGetCatalog).not.toHaveBeenCalled()
    expect(mockCallTool).not.toHaveBeenCalled()
  })
})

describe('the catalog entry is resolved, never hardcoded', () => {
  it('skips naming the #1299 seed migration when no row matches', async () => {
    mockGetCatalog.mockResolvedValue({ ok: true, status: 200, data: { entries: [] } })
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.skipped).toBe(true)
    expect(r.pass).toBe(true)
    expect(r.detail).toMatch(/058_demo_merchant_catalog/)
    expect(mockCallTool).not.toHaveBeenCalled()
  })

  it('skips when only a DIFFERENT product/merchant row exists', async () => {
    mockGetCatalog.mockResolvedValue({
      ok: true,
      status: 200,
      data: { entries: [catalogEntry({ tool_arguments: { tier: '50gb' }, tool_name: 'buy_cloud_storage' })] },
    })
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.skipped).toBe(true)
    expect(mockCallTool).not.toHaveBeenCalled()
  })

  it('fails when GET /catalog itself errors', async () => {
    mockGetCatalog.mockResolvedValue({ ok: false, status: 500, data: {} })
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.skipped).toBeFalsy()
    expect(r.detail).toMatch(/GET \/catalog returned HTTP 500/)
  })

  it('fails when the preflight echoes a DIFFERENT catalog_id than the resolved entry', async () => {
    mockCallTool.mockImplementation(async (tool: string) =>
      tool === 'haven_prepare_catalog_purchase' ? prep({ catalog_id: 'cat_something_else' }) : settled(),
    )
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/not the resolved entry/)
  })

  it('calls haven_prepare_catalog_purchase with the RESOLVED catalog_id, not a literal', async () => {
    await x402CatalogGuidedPurchase.run(ctx())
    const call = mockCallTool.mock.calls.find(([tool]) => tool === 'haven_prepare_catalog_purchase')
    expect(call?.[1]).toMatchObject({ catalog_id: CATALOG_ID })
  })
})

describe('deploy skew: the hosted MCP has not picked up #1306 yet', () => {
  it('SKIPS (never fails) when haven_prepare_catalog_purchase is not registered', async () => {
    mockCallTool.mockImplementation(async (tool: string) => {
      if (tool === 'haven_prepare_catalog_purchase') {
        throw new HostedMcpTransportError(
          'hosted MCP JSON-RPC error on haven_prepare_catalog_purchase: Tool haven_prepare_catalog_purchase not found',
        )
      }
      return settled()
    })
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.skipped).toBe(true)
    expect(r.pass).toBe(true)
    expect(r.detail).toMatch(/has not deployed/)
  })

  it('does NOT skip a genuine transport error unrelated to tool registration', async () => {
    mockCallTool.mockImplementation(async (tool: string) => {
      if (tool === 'haven_prepare_catalog_purchase') {
        throw new HostedMcpTransportError('hosted MCP haven_prepare_catalog_purchase returned HTTP 500: boom')
      }
      return settled()
    })
    await expect(x402CatalogGuidedPurchase.run(ctx())).rejects.toThrow(/HTTP 500/)
  })
})

describe('the rail discriminator — a v1 quote means the #1138 seam went untouched', () => {
  it('FAILS (never skips) on a v1 expected context', async () => {
    const v1 = prep()
    delete (v1.x402.expected as Record<string, unknown>).typed_data_hash
    mockCallTool.mockImplementation(async (tool: string) => (tool === 'haven_prepare_catalog_purchase' ? v1 : settled()))
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.skipped).toBeFalsy()
    expect(r.detail).toMatch(/v1 expected context/)
  })

  it('fails when the scheme does not name the typed-data path', async () => {
    mockCallTool.mockImplementation(async (tool: string) =>
      tool === 'haven_prepare_catalog_purchase' ? prep({ signature_scheme: undefined }) : settled(),
    )
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/scheme does not name/)
  })

  it('fails when the preflight ships bulk typed data by default — the #1272 compact contract regressed', async () => {
    mockCallTool.mockImplementation(async (tool: string) =>
      tool === 'haven_prepare_catalog_purchase'
        ? prep({ typed_data: { domain: {}, types: {}, primaryType: 'X', message: {} } })
        : settled(),
    )
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/compact default regressed/)
  })

  it('fails when the preflight is queued for approval instead of signable', async () => {
    mockCallTool.mockImplementation(async (tool: string) =>
      tool === 'haven_prepare_catalog_purchase' ? prep({ status: 'pending_approval', payload_hash: null }) : settled(),
    )
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/pending_approval/)
  })
})

describe('the #1308 guidance is machine-readable and correct', () => {
  it('fails when next_action does not name signing', async () => {
    mockCallTool.mockImplementation(async (tool: string) =>
      tool === 'haven_prepare_catalog_purchase' ? prep({ next_action: 'stop_and_tell_user' }) : settled(),
    )
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/next_action/)
  })

  it("fails when next_tool is not the signer's own tool", async () => {
    mockCallTool.mockImplementation(async (tool: string) =>
      tool === 'haven_prepare_catalog_purchase' ? prep({ next_tool: 'mcp__haven__haven_pay_mcp_tool' }) : settled(),
    )
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/next_tool/)
  })

  it('fails when next_arguments.payment_id does not match this payment_id', async () => {
    mockCallTool.mockImplementation(async (tool: string) =>
      tool === 'haven_prepare_catalog_purchase' ? prep({ next_arguments: { payment_id: 'pay_stale' } }) : settled(),
    )
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/next_arguments\.payment_id/)
  })
})

describe('the allowance block and indicative catalog price (#1306)', () => {
  it('fails when the allowance block is missing', async () => {
    mockCallTool.mockImplementation(async (tool: string) =>
      tool === 'haven_prepare_catalog_purchase' ? prep({ allowance: undefined }) : settled(),
    )
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/rail-labeled allowance block/)
  })

  it('fails when catalog_price_is_indicative is not true', async () => {
    mockCallTool.mockImplementation(async (tool: string) =>
      tool === 'haven_prepare_catalog_purchase' ? prep({ catalog_price_is_indicative: false }) : settled(),
    )
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/indicative/)
  })

  it('fails when the live quoted amount exceeds max_amount', async () => {
    mockCallTool.mockImplementation(async (tool: string) =>
      tool === 'haven_prepare_catalog_purchase' ? prep({ amount_atomic: '999999999' }) : settled(),
    )
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/exceeds max_amount/)
  })
})

describe('the local signer is consulted with ONLY payment_id — #1305 thesis, tightened by #1549', () => {
  it('FAILS when the preflight echoes payment_required again — the #1549 compact contract', async () => {
    mockCallTool.mockImplementation(async (tool: string) =>
      tool === 'haven_prepare_catalog_purchase'
        ? prep({ payment_required: { x402Version: 2, accepts: [] } })
        : settled(),
    )
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/#1549.*compact.*regressed/s)
  })

  it('never carries merchant_url, tool_name, arguments, or mcp_transport', async () => {
    await x402CatalogGuidedPurchase.run(ctx())
    const args = mockSignX402.mock.calls[0][0] as Record<string, unknown>
    expect(args.payment_id).toBe('pay_catalog_1')
    // #1549: the compact preflight carries no payment_required, so the sign
    // call cannot relay one — the signer fetches it by payment_id.
    expect(args.payment_required).toBeUndefined()
    expect(args.merchant_url).toBeUndefined()
    expect(args.tool_name).toBeUndefined()
    expect(args.arguments).toBeUndefined()
    expect(args.mcp_transport).toBeUndefined()
    expect(args.typed_data).toBeUndefined()
    expect(args.typed_data_b64).toBeUndefined()
  })

  it('fails loudly when the signer REFUSES, quoting the signer', async () => {
    mockSignX402.mockResolvedValue({
      success: false,
      code: 'SIGNING_ERROR',
      message: 'x402 expected context authentication message is invalid.',
    })
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/REFUSED/)
    expect(r.detail).toMatch(/authentication message is invalid/)
    // Nothing was relayed to the hosted server after the refusal.
    expect(mockCallTool).toHaveBeenCalledTimes(1)
  })

  it('fails when the credentials do not belong together', async () => {
    mockGetAgent.mockResolvedValue({
      ok: true,
      data: { safe_address: TREASURY, delegate_address: '0x' + '77'.repeat(20) },
    })
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/do not belong together/)
    expect(mockCallTool).not.toHaveBeenCalled()
  })
})

describe('settle carries ONLY payment_id + signature + payment_header — #1307 rehydration', () => {
  it('never carries merchant_url, tool_name, arguments, or mcp_transport', async () => {
    await x402CatalogGuidedPurchase.run(ctx())
    const call = mockCallTool.mock.calls.find(([tool]) => tool === 'haven_settle_mcp_tool')
    const args = call?.[1] as Record<string, unknown>
    expect(args.payment_id).toBe('pay_catalog_1')
    expect(args.signature).toBe('0xsig')
    expect(args.payment_header).toBe('hdr')
    expect(args.merchant_url).toBeUndefined()
    expect(args.tool_name).toBeUndefined()
    expect(args.arguments).toBeUndefined()
    expect(args.mcp_transport).toBeUndefined()
  })

  it('fails when settle reports settled:false', async () => {
    mockCallTool.mockImplementation(async (tool: string) =>
      tool === 'haven_prepare_catalog_purchase' ? prep() : settled({ settled: false, funding_status: 'pending_approval' }),
    )
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/did not settle/)
  })
})

describe('the post-purchase allowance block (#1310)', () => {
  it('fails when settle carries no allowance key at all', async () => {
    mockCallTool.mockImplementation(async (tool: string) => {
      if (tool === 'haven_prepare_catalog_purchase') return prep()
      const { allowance: _drop, ...rest } = settled()
      return rest
    })
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/no allowance key at all/)
  })

  it('PASSES with a note on allowance: null + ALLOWANCE_CHECK_UNAVAILABLE — the legitimate #1310/#1320 degrade (#1323 review)', async () => {
    // A transient post-settlement read failure must never red a
    // promotion-gating leg AFTER money provably moved.
    mockCallTool.mockImplementation(async (tool: string) =>
      tool === 'haven_prepare_catalog_purchase'
        ? prep()
        : settled({ allowance: null, warnings: [{ code: 'ALLOWANCE_CHECK_UNAVAILABLE', message: 'boom' }] }),
    )
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(true)
    expect(r.detail).toMatch(/allowance read degraded/)
  })

  it('fails on allowance: null WITHOUT the warning — the degrade contract itself regressing', async () => {
    mockCallTool.mockImplementation(async (tool: string) =>
      tool === 'haven_prepare_catalog_purchase'
        ? prep()
        : settled({ allowance: null, warnings: [] }),
    )
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/WITHOUT the ALLOWANCE_CHECK_UNAVAILABLE/)
  })

  it('reports the remaining rail in the pass detail', async () => {
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(true)
    expect(r.detail).toMatch(/remaining allowance rail=delegation/)
  })
})

describe('both on-chain legs, not just the merchant saying yes', () => {
  it.each([
    ['no funding hash', { funding_tx_hash: null }, /funding leg is unevidenced/],
    ['no settlement hash', { settlement_tx_hash: null }, /merchant leg cannot be\s+verified/],
  ])('fails with %s', async (_name, over, pattern) => {
    mockCallTool.mockImplementation(async (tool: string) =>
      tool === 'haven_prepare_catalog_purchase' ? prep() : settled(over),
    )
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(pattern)
  })

  it('fails when the two legs report the same tx hash', async () => {
    mockCallTool.mockImplementation(async (tool: string) =>
      tool === 'haven_prepare_catalog_purchase' ? prep() : settled({ settlement_tx_hash: FUNDING_TX }),
    )
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/SAME tx/)
  })

  it('fails when a leg REVERTED even though the merchant served the tool', async () => {
    mockGetReceipt.mockResolvedValue({ status: 0, blockNumber: 1 })
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/REVERTED/)
  })

  it('fails when the merchant settlement hash never lands', async () => {
    mockGetReceipt.mockImplementation(async (hash: string) =>
      hash === FUNDING_TX ? { status: 1, blockNumber: 1 } : null,
    )
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/no receipt within/)
  })
})

describe('the money proof', () => {
  it('fails when the treasury did not move — the budget was never metered', async () => {
    balances(1_000_000n, 0n, 1_000_000n, 0n)
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/did not decrease/)
  })

  it('fails on ANY delegate residual introduced by this leg', async () => {
    balances(1_000_000n, 0n, 999_000n, 500n)
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/stranded/)
  })

  it('tolerates sub-floor dust an EARLIER leg left, because it asserts a delta', async () => {
    balances(1_000_000n, 900n, 999_000n, 900n)
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(true)
    expect(r.detail).toMatch(/pre-existing dust unchanged/)
  })

  it('passes on the full happy path, reporting both tx hashes and the catalog id', async () => {
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(true)
    expect(r.skipped).toBeFalsy()
    expect(r.detail).toContain(FUNDING_TX)
    expect(r.detail).toContain(MERCHANT_TX)
    expect(r.detail).toContain(CATALOG_ID)
    expect(r.detail).toMatch(/zero delegate residual/)
  })
})

describe('hosted tool refusals are reported as such', () => {
  it('reports a preflight refusal with its code', async () => {
    mockCallTool.mockImplementation(async (tool: string) => {
      if (tool === 'haven_prepare_catalog_purchase') {
        throw new HostedMcpToolError('haven_prepare_catalog_purchase', 'DELEGATION_BUDGET_EXCEEDED', 'no budget left')
      }
      return settled()
    })
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/DELEGATION_BUDGET_EXCEEDED/)
  })

  it('reports a settle refusal with its code', async () => {
    mockCallTool.mockImplementation(async (tool: string) => {
      if (tool === 'haven_prepare_catalog_purchase') return prep()
      throw new HostedMcpToolError('haven_settle_mcp_tool', 'MERCHANT_REJECTED_AFTER_FUNDING', 'merchant said no')
    })
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/MERCHANT_REJECTED_AFTER_FUNDING/)
  })
})

/**
 * #1547 — the erc7710 direct-settlement shape of the guided path.
 *
 * The catalog prepare now honours the #1450 preference, so on dev (delegation
 * agent + erc7710-advertising demo merchant) this is the EXPECTED shape. The
 * money proof INVERTS here: a funding_tx_hash is a FAILURE, not evidence —
 * asserting the 3009 proof against a direct settlement was exactly the
 * green-test-asserting-a-lie trap #1547's acceptance criteria named.
 */
describe('the erc7710 shape (#1547)', () => {
  const MERCHANT_PAY_TO = '0x' + 'ce'.repeat(20)

  const prep7710 = (over: Record<string, unknown> = {}) => ({
    payment_id: 'pay_catalog_7710',
    settlement_scheme: 'erc7710',
    settlement: { scheme: 'erc7710', funding_leg: false, merchant_pay_to: MERCHANT_PAY_TO },
    amount_atomic: '1000',
    amount: '0.001',
    token: 'USDC',
    catalog_id: CATALOG_ID,
    catalog_name: 'NordShield VPN Basic — demo merchant (Base Sepolia)',
    catalog_price_atomic: '1000',
    catalog_price_display: '$0.001 USDC',
    catalog_price_is_indicative: true,
    allowance: { rail: 'delegation', sufficient: true, remaining_atomic: '2000000', source: 'active_delegations' },
    next_action: 'sign_and_submit_payment',
    next_tool: 'mcp__haven-signer__haven_sign',
    next_arguments: { payment_id: 'pay_catalog_7710' },
    ...over,
  })

  const settled7710 = (over: Record<string, unknown> = {}) => ({
    payment_id: 'pay_catalog_7710',
    settlement_scheme: 'erc7710',
    funding_tx_hash: null,
    settled: true,
    settlement_tx_hash: MERCHANT_TX,
    result: { content: [{ text: 'VPN basic purchased' }] },
    allowance: {
      rail: 'delegation',
      remaining_atomic: '1999000',
      token_symbol: 'USDC',
      token_address: '0x' + '99'.repeat(20),
      source: 'active_delegations',
    },
    ...over,
  })

  /**
   * The erc7710 read sequence: [treasury, delegate] baseline pair, merchant
   * baseline, then [treasury, merchant] poll pairs, then one final delegate
   * read — a DIFFERENT shape from the 3009 helper above.
   */
  function balances7710(over: Partial<{
    treasuryBefore: bigint; delegateBefore: bigint; merchantBefore: bigint
    treasuryAfter: bigint; merchantAfter: bigint; delegateAfter: bigint
  }> = {}) {
    const v = {
      treasuryBefore: 1_000_000n, delegateBefore: 0n, merchantBefore: 500n,
      treasuryAfter: 999_000n, merchantAfter: 1_500n, delegateAfter: 0n,
      ...over,
    }
    let call = 0
    mockBalanceOf.mockReset()
    mockBalanceOf.mockImplementation(async () => {
      const index = call++
      if (index === 0) return v.treasuryBefore
      if (index === 1) return v.delegateBefore
      if (index === 2) return v.merchantBefore
      // Poll pairs: even = treasury, odd = merchant … except the LAST read
      // after the loop breaks, which is the delegate. The loop breaks on the
      // first pair when treasuryAfter differs, so: 3=treasury, 4=merchant,
      // 5=delegate.
      if (index === 3) return v.treasuryAfter
      if (index === 4) return v.merchantAfter
      return v.delegateAfter
    })
  }

  beforeEach(() => {
    mockCallTool.mockImplementation(async (tool: string) =>
      tool === 'haven_prepare_catalog_purchase' ? prep7710() : settled7710(),
    )
    mockSign.mockResolvedValue({ success: true, data: { signature: '0xsig7710' } })
    balances7710()
  })

  it('passes, signing via haven_sign with ONLY payment_id and settling with ONLY payment_id + signature', async () => {
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(true)
    expect(r.detail).toMatch(/erc7710 DIRECT/)
    expect(r.detail).toMatch(/delegate EOA untouched/)

    // The signer saw the payment_id and nothing else — and never the 3009 tool.
    expect(mockSign).toHaveBeenCalledWith({ payment_id: 'pay_catalog_7710' })
    expect(mockSignX402).not.toHaveBeenCalled()

    // Settle carried NO payment_header (its absence selects the erc7710
    // branch) and NO merchant context (#1307 rehydration from the persisted
    // catalog context).
    const settleCall = mockCallTool.mock.calls.find(([tool]) => tool === 'haven_settle_mcp_tool')
    expect(settleCall?.[1]).toEqual({ payment_id: 'pay_catalog_7710', signature: '0xsig7710' })
  })

  it('FAILS when settle reports a funding tx — the 3009 proof inverted', async () => {
    mockCallTool.mockImplementation(async (tool: string) =>
      tool === 'haven_prepare_catalog_purchase' ? prep7710() : settled7710({ funding_tx_hash: FUNDING_TX }),
    )
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/no funding leg/)
  })

  it('fails when settle reports a different scheme than prepare chose', async () => {
    mockCallTool.mockImplementation(async (tool: string) =>
      tool === 'haven_prepare_catalog_purchase' ? prep7710() : settled7710({ settlement_scheme: undefined }),
    )
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/must not settle as anything else/)
  })

  it('fails when the delegate EOA moved — a hidden funding leg', async () => {
    balances7710({ delegateAfter: 7n })
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/delegate EOA balance changed/)
  })

  it('fails when the treasury debit does not equal the merchant credit', async () => {
    balances7710({ merchantAfter: 700n })
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/must move the same amount/)
  })

  it('fails when the erc7710 shape still points next_tool at haven_sign_x402', async () => {
    mockCallTool.mockImplementation(async (tool: string) =>
      tool === 'haven_prepare_catalog_purchase'
        ? prep7710({ next_tool: 'mcp__haven-signer__haven_sign_x402' })
        : settled7710(),
    )
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/expected the signer's haven_sign tool/)
  })

  it('fails when the erc7710 shape omits funding_leg: false or merchant_pay_to', async () => {
    mockCallTool.mockImplementation(async (tool: string) =>
      tool === 'haven_prepare_catalog_purchase'
        ? prep7710({ settlement: { scheme: 'erc7710', funding_leg: false } })
        : settled7710(),
    )
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/merchant_pay_to/)
  })

  it('keeps the guided contract on this shape: allowance block and indicative price still required', async () => {
    mockCallTool.mockImplementation(async (tool: string) =>
      tool === 'haven_prepare_catalog_purchase' ? prep7710({ allowance: undefined }) : settled7710(),
    )
    const r = await x402CatalogGuidedPurchase.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/rail-labeled allowance/)
  })
})
