import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * #4876: a captured merchant receipt releases the feed's receipt wait. The
 * capture runs every late attach first (a payment already pushed gets its
 * attachment), then feeds the payment (a payment still held is pushed once,
 * receipt included). A duplicate report changes nothing.
 */

const { calls, repo, accounting } = vi.hoisted(() => {
  const calls: string[] = []
  const settle = (name: string) => vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    calls.push(name)
  })
  return {
    calls,
    repo: {
      findEvidenceAnchorForAgent: vi.fn(),
      insertMerchantReceiptOnce: vi.fn(),
      getMerchantReceiptRow: vi.fn(),
    },
    accounting: {
      lateAttachMerchantReceipt: settle('fortnox'),
      lateAttachAccountedMerchantReceipt: settle('accounted'),
      lateAttachIgdrasilMerchantReceipt: settle('igdrasil'),
      feedSettledPaymentBestEffort: vi.fn(() => {
        calls.push('feed')
      }),
    },
  }
})

vi.mock('../../../infra/repositories/machine-payments.js', () => repo)
vi.mock('../../accounting/index.js', () => accounting)

const { handleMerchantReceiptCapture } = await import('../merchant-receipt.js')

const flush = () => new Promise((resolve) => setTimeout(resolve, 50))

describe('a captured merchant receipt feeds the payment (#4876)', () => {
  beforeEach(() => {
    calls.length = 0
    vi.clearAllMocks()
    repo.findEvidenceAnchorForAgent.mockResolvedValue({ id: 'ev-1', user_id: 'user-1' })
  })

  it('runs every late attach, then feeds the payment', async () => {
    repo.insertMerchantReceiptOnce.mockResolvedValue(true)
    const result = await handleMerchantReceiptCapture('agent-1', 'pi-1', undefined, { rader: [] })
    expect(result.statusCode).toBe(201)
    await flush()
    expect(accounting.feedSettledPaymentBestEffort).toHaveBeenCalledWith('user-1', 'pi-1')
    expect(calls.at(-1)).toBe('feed')
    expect(calls.slice(0, 3).sort()).toEqual(['accounted', 'fortnox', 'igdrasil'])
  })

  it('still feeds when a late attach fails', async () => {
    repo.insertMerchantReceiptOnce.mockResolvedValue(true)
    accounting.lateAttachAccountedMerchantReceipt.mockRejectedValueOnce(new Error('provider down'))
    await handleMerchantReceiptCapture('agent-1', 'pi-1', undefined, { rader: [] })
    await flush()
    expect(accounting.feedSettledPaymentBestEffort).toHaveBeenCalledWith('user-1', 'pi-1')
  })

  it('a duplicate report (first write wins) neither attaches nor feeds', async () => {
    repo.insertMerchantReceiptOnce.mockResolvedValue(false)
    const result = await handleMerchantReceiptCapture('agent-1', 'pi-1', undefined, { rader: [] })
    expect(result.statusCode).toBe(200)
    await flush()
    expect(accounting.feedSettledPaymentBestEffort).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })
})
