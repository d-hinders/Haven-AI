import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatEther } from 'ethers'

// The card's note (#3345): mock `relayer-spend-guard.js`, NOT `db.js` — the
// db-mock ratchet's baseline must not move. The REAL shared sender stays
// wired in (this suite's fetch stub is the seam the mutations bite on).
const { mockGetBalance, mockSpendSummary } = vi.hoisted(() => ({
  mockGetBalance: vi.fn(),
  mockSpendSummary: vi.fn(),
}))

vi.mock('../../config.js', () => ({ relayerPrivateKeyForChain: () => '0xtest-key' }))
vi.mock('../../domain/chains.js', () => ({
  SUPPORTED_CHAIN_IDS: [8453],
  getChain: () => ({ nativeCurrency: { symbol: 'ETH' } }),
}))
vi.mock('../relayer.js', () => ({
  getRelayer: () => ({ address: '0x0000000000000000000000000000000000000bad', provider: { getBalance: mockGetBalance } }),
  RELAYER_LOW_BALANCE_WEI: 1_000_000_000_000_000_000n, // 1 ETH
}))
vi.mock('../relayer-spend-guard.js', () => ({
  relayerSpendSummary: (...a: unknown[]) => mockSpendSummary(...a),
}))

const { runRelayerBalanceMonitor, getRelayerBalanceStatus, resetRelayerAlertStateForTests } =
  await import('../relayer-balance-monitor.js')

// A fake hook URL shape — never a real one, and never asserted to appear in logs.
const WEBHOOK_URL = 'https://hooks.slack.test/services/T000/B000/secrettoken'

const LOW_WEI = 500_000_000_000_000_000n // 0.5 ETH — below the 1 ETH mark
const HIGH_WEI = 2_000_000_000_000_000_000n // 2 ETH — recovered

function httpRes(ok: boolean, status: number, body = ''): Response {
  return { ok, status, text: async () => body } as unknown as Response
}

beforeEach(() => {
  resetRelayerAlertStateForTests()
  mockGetBalance.mockReset()
  mockSpendSummary.mockReset()
  mockSpendSummary.mockResolvedValue([])
  process.env.DELEGATE_ALERT_WEBHOOK_URL = WEBHOOK_URL
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.DELEGATE_ALERT_WEBHOOK_URL
})

describe('runRelayerBalanceMonitor — webhook alerting (#3345)', () => {
  it('a 404: one post, the failure logged by the sender, never as a failed balance read', async () => {
    mockGetBalance.mockResolvedValue(LOW_WEI)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(httpRes(false, 404, 'nope')))

    const warn = vi.fn()
    await runRelayerBalanceMonitor({ warn, info: vi.fn() })

    expect(fetch).toHaveBeenCalledTimes(1)
    const messages = warn.mock.calls.map((c) => c[1] as string)
    expect(messages.some((m) => m.includes('ops alert webhook failed'))).toBe(true)
    expect(messages.some((m) => m.includes('relayer balance read failed'))).toBe(false)
    // lastStatus still recorded before the alert (/health/ops reads it).
    expect(getRelayerBalanceStatus()[0]).toMatchObject({ chainId: 8453, low: true })
  })

  it('MUTATION: a 404 with the balance held low retries on the next scan', async () => {
    // The bug: state committed before sending → run 2 posts nothing and the
    // alert is lost while the relayer stays dry.
    mockGetBalance.mockResolvedValue(LOW_WEI)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(httpRes(false, 404)))
    await runRelayerBalanceMonitor({ warn: vi.fn(), info: vi.fn() })

    const fetchMock = vi.fn().mockResolvedValue(httpRes(false, 404))
    vi.stubGlobal('fetch', fetchMock)
    await runRelayerBalanceMonitor({ warn: vi.fn(), info: vi.fn() })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a network error: logged once per scan (not as a failed balance read), retried next scan', async () => {
    mockGetBalance.mockResolvedValue(LOW_WEI)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const warn = vi.fn()
    await runRelayerBalanceMonitor({ warn, info: vi.fn() })

    const messages = warn.mock.calls.map((c) => c[1] as string)
    expect(messages.some((m) => m.includes('network error'))).toBe(true)
    expect(messages.some((m) => m.includes('relayer balance read failed'))).toBe(false)

    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    vi.stubGlobal('fetch', fetchMock)
    await runRelayerBalanceMonitor({ warn: vi.fn(), info: vi.fn() })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retry-then-success: the third scan with the same low balance stays silent', async () => {
    mockGetBalance.mockResolvedValue(LOW_WEI)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(httpRes(false, 404)))
    await runRelayerBalanceMonitor({ warn: vi.fn(), info: vi.fn() })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(httpRes(true, 200)))
    await runRelayerBalanceMonitor({ warn: vi.fn(), info: vi.fn() })

    const fetchMock = vi.fn().mockResolvedValue(httpRes(true, 200))
    vi.stubGlobal('fetch', fetchMock)
    await runRelayerBalanceMonitor({ warn: vi.fn(), info: vi.fn() })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a delivered alert arms the edge; recovery re-arms it for the next episode', async () => {
    mockGetBalance.mockResolvedValue(LOW_WEI)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(httpRes(true, 200)))
    await runRelayerBalanceMonitor({ warn: vi.fn(), info: vi.fn() })
    expect(fetch).toHaveBeenCalledTimes(1)

    // recovered: no post, edge cleared
    mockGetBalance.mockResolvedValue(HIGH_WEI)
    let fetchMock = vi.fn().mockResolvedValue(httpRes(true, 200))
    vi.stubGlobal('fetch', fetchMock)
    await runRelayerBalanceMonitor({ warn: vi.fn(), info: vi.fn() })
    expect(fetchMock).not.toHaveBeenCalled()

    // low again: a fresh episode posts again
    mockGetBalance.mockResolvedValue(LOW_WEI)
    fetchMock = vi.fn().mockResolvedValue(httpRes(true, 200))
    vi.stubGlobal('fetch', fetchMock)
    await runRelayerBalanceMonitor({ warn: vi.fn(), info: vi.fn() })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('with the URL unset nothing is sent and log-only mode arms the edge (pre-#3345 behaviour)', async () => {
    delete process.env.DELEGATE_ALERT_WEBHOOK_URL
    mockGetBalance.mockResolvedValue(LOW_WEI)

    const warn = vi.fn()
    await runRelayerBalanceMonitor({ warn, info: vi.fn() })
    expect(fetch).not.toHaveBeenCalled()
    expect(warn.mock.calls.map((c) => c[1])).toContain('Relayer balance below low-water mark')

    // Log-only mode armed the episode: re-enabling the webhook on the NEXT
    // scan must not re-send the alert for the same continuous low episode.
    // (The low-water log warn itself fires every scan by design — the edge
    // gates only the webhook.)
    const fetchMock = vi.fn().mockResolvedValue(httpRes(true, 200))
    vi.stubGlobal('fetch', fetchMock)
    await runRelayerBalanceMonitor({ warn: vi.fn(), info: vi.fn() })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the alert text carries the balance, mark and address; the body is the { text } payload', async () => {
    mockGetBalance.mockResolvedValue(LOW_WEI)
    const fetchMock = vi.fn().mockResolvedValue(httpRes(true, 200))
    vi.stubGlobal('fetch', fetchMock)
    await runRelayerBalanceMonitor({ warn: vi.fn(), info: vi.fn() })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const text = JSON.parse(String(init.body)).text as string
    expect(text).toContain(formatEther(LOW_WEI))
    expect(text).toContain(formatEther(1_000_000_000_000_000_000n))
    expect(text).toContain('0x0000000000000000000000000000000000000bad')
    expect(text).toContain('ETH')
  })
})
