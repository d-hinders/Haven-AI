/**
 * The assertions that stop `x402-hosted-mcp-signer` passing vacuously (#1154).
 *
 * The hazard this leg has to survive is the same one #1154 was filed about: a
 * green run that means less than a reader assumes. A hosted purchase can
 * succeed while the delegation-rail typed-data seam — the one #1138 broke — was
 * never touched at all, because a legacy-rail identity would produce a perfectly
 * happy v1 flow. And "the merchant said yes" is not "money moved": Haven relays
 * the facilitator's settlement hash but never watches that leg itself.
 *
 * Each test feeds the shape the scenario must reject. Network and chain seams
 * are mocked so the assertion logic is the only thing under test.
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

const { mockCallTool, mockGetAgent, mockBalanceOf, mockGetReceipt, mockSignX402 } = vi.hoisted(() => ({
  mockCallTool: vi.fn(),
  mockGetAgent: vi.fn(),
  mockBalanceOf: vi.fn(),
  mockGetReceipt: vi.fn(),
  mockSignX402: vi.fn(),
}))

vi.mock('@haven_ai/signer', () => ({
  createEdgeSigner: () => ({ delegateAddress: DELEGATE }),
  createToolHandlers: () => ({ haven_sign_x402: mockSignX402 }),
}))
vi.mock('../lib/haven-api.js', () => ({
  HavenApi: class {
    getAgent = mockGetAgent
  },
}))
vi.mock('ethers', async (importOriginal) => {
  // formatUnits stays REAL — the failure messages quote amounts, and a mocked
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

const { HostedMcpToolError } = await import('../lib/hosted-mcp.js')
vi.mock('../lib/hosted-mcp.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/hosted-mcp.js')>()
  return {
    ...actual,
    HostedMcpClient: class {
      callTool = mockCallTool
    },
  }
})

const { x402HostedMcpSigner, TIMING } = await import('./x402-hosted-mcp-signer.js')

// Real values would make each missing-receipt / non-converging-balance case sit
// out a 60–90s wait.
TIMING.receiptWaitMs = 60
TIMING.balanceWaitMs = 60
TIMING.pollIntervalMs = 20

/** A delegation-rail (v2) hosted quote — the shape this leg exists to cover. */
const quote = (over: Record<string, unknown> = {}) => ({
  payment_id: 'pay_hosted_1',
  status: 'pending_signature',
  payload_hash: '0x' + 'cd'.repeat(32),
  signature_scheme: 'eip712_userop',
  typed_data: { domain: {}, types: {}, primaryType: 'X', message: {} },
  payment_required: { x402Version: 2, accepts: [] },
  x402: {
    expected: {
      payment_id: 'pay_hosted_1',
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
  payment_id: 'pay_hosted_1',
  funding_tx_hash: FUNDING_TX,
  settled: true,
  settlement_tx_hash: MERCHANT_TX,
  result: { content: [{ text: 'VPN basic purchased' }] },
  ...over,
})

function ctx(over: Partial<ScenarioContext['cfg']> = {}): ScenarioContext {
  return {
    cfg: {
      apiUrl: 'https://dev-backend.example',
      agentApiKey: 'sk_agent_legacy',
      delegateKey: '0x' + '22'.repeat(32),
      paymentTo: '0x' + 'dd'.repeat(20),
      demoMerchantUrl: MERCHANT_URL,
      delegationAgentApiKey: 'sk_agent_delegation',
      delegationDelegateKey: '0x' + '33'.repeat(32),
      hostedMcpUrl: HOSTED_MCP,
      x402BindingSigner: BINDING_SIGNER,
      ...over,
    },
    api: {} as ScenarioContext['api'],
    delegateKey: '0x' + '22'.repeat(32),
    delegateAddress: '0x' + 'ee'.repeat(20),
  }
}

/**
 * The scenario reads a (treasury, delegate) baseline pair, then POLLS the same
 * pair until both settle conditions hold. Modelled as a call counter so extra
 * poll iterations keep returning the same "after" values — which is also what
 * pins that a non-converging case actually gives up rather than looping.
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
  mockCallTool.mockImplementation(async (tool: string) =>
    tool === 'haven_pay_mcp_tool' ? quote() : settled(),
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
  ])('skips with %s, and never calls the hosted server', async (_name, over) => {
    // A skip, not a failure: each of these needs an operator to provision
    // something. Under QA_REQUIRE_ALL_LEGS=1 the runner turns the skip into a
    // run failure anyway, which is where "provision it" is enforced.
    const r = await x402HostedMcpSigner.run(ctx(over))
    expect(r.skipped).toBe(true)
    expect(r.pass).toBe(true)
    expect(mockCallTool).not.toHaveBeenCalled()
  })
})

describe('the rail discriminator — a v1 quote means the #1138 seam went untouched', () => {
  it('FAILS (never skips) on a v1 expected context', async () => {
    const v1 = quote()
    delete (v1.x402.expected as Record<string, unknown>).typed_data_hash
    mockCallTool.mockImplementation(async (tool: string) => (tool === 'haven_pay_mcp_tool' ? v1 : settled()))
    const r = await x402HostedMcpSigner.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.skipped).toBeFalsy()
    expect(r.detail).toMatch(/v1 expected context/)
  })

  it('fails when the context commits to typed data but the quote omits it', async () => {
    // The exact shape that would make the signer refuse: Haven declared a
    // typed-data digest and then did not send the payload it commits to.
    mockCallTool.mockImplementation(async (tool: string) =>
      tool === 'haven_pay_mcp_tool' ? quote({ typed_data: undefined }) : settled(),
    )
    const r = await x402HostedMcpSigner.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/typed_data=absent/)
  })

  it('fails when the quote is queued for approval instead of signable', async () => {
    mockCallTool.mockImplementation(async (tool: string) =>
      tool === 'haven_pay_mcp_tool' ? quote({ status: 'pending_approval', payload_hash: null }) : settled(),
    )
    const r = await x402HostedMcpSigner.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/pending_approval/)
  })
})

describe('the local signer is really consulted', () => {
  it('passes the NESTED expected context, not the x402 wrapper', async () => {
    // Gotcha from the manual run: passing `quote.x402` fails the signer's Zod
    // schema with "Required at x402_expected.asset/network/expires_at/auth".
    await x402HostedMcpSigner.run(ctx())
    const args = mockSignX402.mock.calls[0][0] as Record<string, unknown>
    expect(args.x402_expected).toHaveProperty('auth')
    expect(args.x402_expected).not.toHaveProperty('expected')
    expect(args.typed_data).toBeDefined()
  })

  it('fails loudly when the signer REFUSES, quoting the signer', async () => {
    // The refusal paths are the security property (#1138). Swallowing one and
    // continuing would report green for a payment that was never authorised.
    mockSignX402.mockResolvedValue({
      success: false,
      code: 'SIGNING_ERROR',
      message: 'x402 expected context authentication message is invalid.',
    })
    const r = await x402HostedMcpSigner.run(ctx())
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
    const r = await x402HostedMcpSigner.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/do not belong together/)
    expect(mockCallTool).not.toHaveBeenCalled()
  })
})

describe('both on-chain legs, not just the merchant saying yes', () => {
  it('fails when settle reports settled:false', async () => {
    mockCallTool.mockImplementation(async (tool: string) =>
      tool === 'haven_pay_mcp_tool' ? quote() : settled({ settled: false, funding_status: 'pending_approval' }),
    )
    const r = await x402HostedMcpSigner.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/did not settle/)
  })

  it.each([
    ['no funding hash', { funding_tx_hash: null }, /funding leg is unevidenced/],
    ['no settlement hash', { settlement_tx_hash: null }, /merchant leg cannot be\s+verified/],
  ])('fails with %s', async (_name, over, pattern) => {
    mockCallTool.mockImplementation(async (tool: string) =>
      tool === 'haven_pay_mcp_tool' ? quote() : settled(over),
    )
    const r = await x402HostedMcpSigner.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(pattern)
  })

  it('fails when the two legs report the same tx hash', async () => {
    // A single hash echoed for both would satisfy a naive "did we get tx
    // hashes?" check while proving only one hop happened.
    mockCallTool.mockImplementation(async (tool: string) =>
      tool === 'haven_pay_mcp_tool' ? quote() : settled({ settlement_tx_hash: FUNDING_TX }),
    )
    const r = await x402HostedMcpSigner.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/SAME tx/)
  })

  it('fails when a leg REVERTED even though the merchant served the tool', async () => {
    mockGetReceipt.mockResolvedValue({ status: 0, blockNumber: 1 })
    const r = await x402HostedMcpSigner.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/REVERTED/)
  })

  it('fails when the merchant settlement hash never lands', async () => {
    mockGetReceipt.mockImplementation(async (hash: string) =>
      hash === FUNDING_TX ? { status: 1, blockNumber: 1 } : null,
    )
    const r = await x402HostedMcpSigner.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/no receipt within/)
  })
})

describe('the money proof', () => {
  it('fails when the treasury did not move — the budget was never metered', async () => {
    balances(1_000_000n, 0n, 1_000_000n, 0n)
    const r = await x402HostedMcpSigner.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/did not decrease/)
  })

  it('fails on ANY delegate residual introduced by this leg', async () => {
    balances(1_000_000n, 0n, 999_000n, 500n)
    const r = await x402HostedMcpSigner.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/stranded/)
  })

  it('tolerates sub-floor dust an EARLIER leg left, because it asserts a delta', async () => {
    // x402-delegation-3009 legitimately leaves sub-floor dust on this shared
    // delegate. An absolute-zero assertion would make this leg red for another
    // leg's by-design behaviour.
    balances(1_000_000n, 900n, 999_000n, 900n)
    const r = await x402HostedMcpSigner.run(ctx())
    expect(r.pass).toBe(true)
    expect(r.detail).toMatch(/pre-existing dust unchanged/)
  })

  it('passes on the full happy path, reporting both tx hashes', async () => {
    const r = await x402HostedMcpSigner.run(ctx())
    expect(r.pass).toBe(true)
    expect(r.skipped).toBeFalsy()
    expect(r.detail).toContain(FUNDING_TX)
    expect(r.detail).toContain(MERCHANT_TX)
    expect(r.detail).toMatch(/zero delegate residual/)
  })
})

describe('hosted tool refusals are reported as such', () => {
  it('reports a hosted quote refusal with its code', async () => {
    mockCallTool.mockRejectedValue(new HostedMcpToolError('haven_pay_mcp_tool', 'OVER_BUDGET', 'no budget left'))
    const r = await x402HostedMcpSigner.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/OVER_BUDGET/)
  })
})
