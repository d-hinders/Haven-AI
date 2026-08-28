import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Wallet } from 'ethers'
import type { ScenarioContext } from './types.js'

const DELEGATE_KEY = `0x${'11'.repeat(32)}`
const DELEGATE = new Wallet(DELEGATE_KEY).address
const TREASURY = `0x${'aa'.repeat(20)}`
const MERCHANT = `0x${'bb'.repeat(20)}`

const {
  mockAuthorize,
  mockSign,
  mockPoll,
  mockStatus,
  mockGetAgent,
  mockResume,
  mockBalanceOf,
  mockPrepareSweep,
  mockSignTyped,
  mockFetch,
} = vi.hoisted(() => ({
  mockAuthorize: vi.fn(),
  mockSign: vi.fn(),
  mockPoll: vi.fn(),
  mockStatus: vi.fn(),
  mockGetAgent: vi.fn(),
  mockResume: vi.fn(),
  mockBalanceOf: vi.fn(),
  mockPrepareSweep: vi.fn(),
  mockSignTyped: vi.fn(),
  mockFetch: vi.fn(),
}))

vi.mock('@haven_ai/sdk', () => ({
  HavenClient: class {
    resumeX402Payment = mockResume
    prepareSweep = mockPrepareSweep
    submitSweep = vi.fn()
  },
  buildSweepTypedData: vi.fn(),
  signUserOpTypedDataForDelegation: mockSignTyped,
}))
vi.mock('../lib/haven-api.js', () => ({
  HavenApi: class {
    authorizeX402 = mockAuthorize
    signPayment = mockSign
    pollUntilSettled = mockPoll
    getMachinePaymentStatus = mockStatus
    getAgent = mockGetAgent
  },
}))
vi.mock('../lib/merchant-mcp.js', () => ({
  MCP_HEADERS: { 'Content-Type': 'application/json' },
  mcpBody: vi.fn(() => '{"jsonrpc":"2.0"}'),
  decodeChallenge: vi.fn(() => ({
    resource: { url: 'https://merchant.example/mcp' },
    accepts: [{ payTo: MERCHANT, amount: '1000', asset: '0xusdc', network: 'eip155:84532' }],
  })),
  readMcpOutcome: vi.fn(() => ({ served: true })),
}))
vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ethers')>()
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      JsonRpcProvider: class {},
      Contract: class { balanceOf = mockBalanceOf },
    },
  }
})

const { x402Delegation3009GraceResume } = await import('./x402-delegation-3009-grace-resume.js')

function ctx(over: Partial<ScenarioContext['cfg']> = {}): ScenarioContext {
  return {
    cfg: {
      apiUrl: 'https://dev-backend.example',
      paymentTo: MERCHANT,
      demoMerchantUrl: 'https://merchant.example',
      delegationAgentApiKey: 'sk_agent_delegation',
      delegationDelegateKey: DELEGATE_KEY,
      ...over,
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', mockFetch)
  mockFetch.mockResolvedValue(new Response('payment required', { status: 402, headers: { 'PAYMENT-REQUIRED': 'x' } }))
  mockGetAgent.mockResolvedValue({ ok: true, data: { safe_address: TREASURY } })
  mockAuthorize.mockResolvedValue({
    ok: true, status: 201,
    data: { payment_id: 'pay_2159', sign_data: { signature_scheme: 'eip712_userop', typed_data: {} } },
  })
  mockSignTyped.mockResolvedValue('0xsigned')
  mockSign.mockResolvedValue({ ok: true, status: 200, data: {} })
  mockPoll.mockResolvedValue({ status: 'confirmed', tx_hash: '0xfunding' })
  mockStatus.mockResolvedValue({
    ok: true,
    status: 200,
    data: { phase: 'funded_but_unsettled', next_action: 'retry_original_x402_request' },
  })
  mockResume.mockResolvedValue(new Response(JSON.stringify({ result: { content: [{ text: 'paid' }] } }), { status: 200 }))
  mockPrepareSweep.mockResolvedValue({ nothing_stranded: true })
  // treasury / merchant / delegate before, then each after resume.
  mockBalanceOf
    .mockResolvedValueOnce(1_000_000n)
    .mockResolvedValueOnce(0n)
    .mockResolvedValueOnce(0n)
    .mockResolvedValueOnce(999_000n)
    .mockResolvedValueOnce(1_000n)
    .mockResolvedValueOnce(0n)
})

describe('x402-delegation-3009-grace-resume (#2159)', () => {
  it('skips without the delegation credentials', async () => {
    const result = await x402Delegation3009GraceResume.run(ctx({ delegationDelegateKey: undefined }))
    expect(result.skipped).toBe(true)
    expect(mockAuthorize).not.toHaveBeenCalled()
  })

  it('proves the server recovery state and resumes through the SDK gate', async () => {
    const result = await x402Delegation3009GraceResume.run(ctx())
    expect(result.pass).toBe(true)
    expect(mockStatus).toHaveBeenCalledWith('pay_2159')
    expect(mockAuthorize).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: expect.stringContaining('x402-delegation-3009-grace-resume'),
    }))
    expect(mockResume).toHaveBeenCalledWith(expect.objectContaining({
      paymentId: 'pay_2159',
      url: 'https://merchant.example/mcp',
      idempotencyKey: expect.stringContaining('x402-delegation-3009-grace-resume'),
    }))
    expect(result.detail).toMatch(/delegate restored/)
  })

  it('fails if the resumed purchase does not debit treasury and credit merchant equally', async () => {
    mockBalanceOf
      .mockReset()
      .mockResolvedValue(0n)
      .mockResolvedValueOnce(1_000_000n)
      .mockResolvedValueOnce(0n)
      .mockResolvedValueOnce(0n)
      .mockResolvedValueOnce(999_000n)
      .mockResolvedValueOnce(500n)
      .mockResolvedValueOnce(0n)
      .mockResolvedValueOnce(999_000n)
      .mockResolvedValueOnce(500n)
      .mockResolvedValueOnce(0n)
      .mockResolvedValueOnce(500n)
    const now = vi.spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(30_001)
    const result = await x402Delegation3009GraceResume.run(ctx())
    now.mockRestore()
    expect(result.pass).toBe(false)
    expect(result.detail).toMatch(/money proof failed/)
    expect(mockPrepareSweep).toHaveBeenCalledOnce()
  })

  it('attempts cleanup when status lookup throws after confirmed funding', async () => {
    mockStatus.mockRejectedValue(new Error('status endpoint unavailable'))
    mockBalanceOf
      .mockReset()
      .mockResolvedValueOnce(1_000_000n)
      .mockResolvedValueOnce(0n)
      .mockResolvedValueOnce(0n)
      .mockResolvedValueOnce(500n)
    const result = await x402Delegation3009GraceResume.run(ctx())
    expect(result.pass).toBe(false)
    expect(result.detail).toMatch(/post-funding recovery failed: status endpoint unavailable/)
    expect(mockPrepareSweep).toHaveBeenCalledOnce()
  })
})
