/**
 * #3500: the task budget cap arithmetic and the transfer-cap revert
 * classification. Pure: the chain read is injected, nothing touches a DB.
 */
import { describe, expect, it, vi } from 'vitest'
import { EstimateGasExecutionError } from 'viem'
import { checkTaskBudgetCap, readTaskBudgetSpentForReport, taskBudgetExceededBody } from '../task-budget-cap.js'
import { classifyRevertForLedger, isTransferCapRevert } from '../../payments/refusal-ledger.js'

const HASH = `0x${'cd'.repeat(32)}`
const reads = (spent: bigint) => vi.fn().mockResolvedValue(spent)

describe('checkTaskBudgetCap (#3500)', () => {
  it('fits while the remainder covers the amount, including the exact remainder', async () => {
    await expect(
      checkTaskBudgetCap({ chainId: 84532, delegationHash: HASH, maxAtomic: '1500', amountAtomic: 500n }, reads(1000n)),
    ).resolves.toEqual({ outcome: 'fits' })
    await expect(
      checkTaskBudgetCap({ chainId: 84532, delegationHash: HASH, maxAtomic: '1500', amountAtomic: 1500n }, reads(0n)),
    ).resolves.toEqual({ outcome: 'fits' })
  })

  it('is exceeded one atomic unit past the remainder, and reports spent, remaining and max', async () => {
    await expect(
      checkTaskBudgetCap({ chainId: 84532, delegationHash: HASH, maxAtomic: '1500', amountAtomic: 501n }, reads(1000n)),
    ).resolves.toEqual({ outcome: 'exceeded', spentAtomic: 1000n, remainingAtomic: 500n, maxAtomic: 1500n })
  })

  it('a fully spent cap has zero remaining, never a negative one', async () => {
    await expect(
      checkTaskBudgetCap({ chainId: 84532, delegationHash: HASH, maxAtomic: '1500', amountAtomic: 1n }, reads(1600n)),
    ).resolves.toEqual({ outcome: 'exceeded', spentAtomic: 1600n, remainingAtomic: 0n, maxAtomic: 1500n })
  })

  it('reads the enforcer for THIS task budget, on THIS chain', async () => {
    const read = reads(0n)
    await checkTaskBudgetCap({ chainId: 8453, delegationHash: HASH, maxAtomic: '10', amountAtomic: 1n }, read)
    expect(read).toHaveBeenCalledWith(8453, HASH)
  })

  it('an unreadable chain, or an unparseable cap, is "not checked" — never a refusal', async () => {
    await expect(
      checkTaskBudgetCap(
        { chainId: 84532, delegationHash: HASH, maxAtomic: '1500', amountAtomic: 99999n },
        vi.fn().mockRejectedValue(new Error('rpc down')),
      ),
    ).resolves.toEqual({ outcome: 'unreadable' })
    await expect(
      checkTaskBudgetCap({ chainId: 84532, delegationHash: HASH, maxAtomic: 'not-a-number', amountAtomic: 1n }, reads(0n)),
    ).resolves.toEqual({ outcome: 'unreadable' })
  })
})

describe('taskBudgetExceededBody (#3500)', () => {
  it('is the typed, non-retryable refusal: its code, the task budget, and the figures', () => {
    const body = taskBudgetExceededBody({
      taskBudgetId: 'tb-1',
      tokenSymbol: 'USDC',
      amountHuman: '0.0005',
      amountAtomic: '500',
      remainingAtomic: '0',
      remainingHuman: '0',
      maxAtomic: '1500',
    })
    expect(body).toMatchObject({
      error_code: 'task_budget_exceeded',
      task_budget_id: 'tb-1',
      amount_atomic: '500',
      remaining_atomic: '0',
      max_atomic: '1500',
    })
    expect(String(body.error)).toMatch(/retrying cannot succeed/)
    expect(String(body.error)).toMatch(/Close this task budget and open a new one/)
  })
})

describe('readTaskBudgetSpentForReport (#3501)', () => {
  it('reports the enforcer figures with the same clamp the cap check uses', async () => {
    await expect(
      readTaskBudgetSpentForReport({ chainId: 84532, delegationHash: HASH, maxAtomic: '1500' }, reads(1000n)),
    ).resolves.toEqual({ spentAtomic: '1000', remainingAtomic: '500' })
    // A spent-past-cap budget (the issue's reproduction: 1000 + 500 under a
    // 1500 cap) clamps at zero — never a negative, never the full cap.
    await expect(
      readTaskBudgetSpentForReport({ chainId: 84532, delegationHash: HASH, maxAtomic: '1500' }, reads(1600n)),
    ).resolves.toEqual({ spentAtomic: '1600', remainingAtomic: '0' })
  })

  it('a failed chain read degrades to null/null with a warning — never the full cap as remaining', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(
        readTaskBudgetSpentForReport(
          { chainId: 84532, delegationHash: HASH, maxAtomic: '1500' },
          vi.fn().mockRejectedValue(new Error('rpc down')),
        ),
      ).resolves.toEqual({ spentAtomic: null, remainingAtomic: null })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toMatch(/spent read unavailable/)
      expect(String(warn.mock.calls[0][0])).toMatch(/never a fabricated remaining|reporting spent\/remaining as null/)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('transfer-cap revert classification (#3500)', () => {
  const capRevert = () =>
    new EstimateGasExecutionError(
      Object.assign(new Error('ERC20TransferAmountEnforcer:allowance-exceeded'), {
        shortMessage: 'ERC20TransferAmountEnforcer:allowance-exceeded',
      }) as never,
      {},
    )

  it('recognises the cumulative-cap enforcer, wrapped or bare', () => {
    expect(isTransferCapRevert(capRevert())).toBe(true)
    expect(isTransferCapRevert(new Error('reason: ERC20TransferAmountEnforcer:allowance-exceeded.'))).toBe(true)
    expect(isTransferCapRevert(new Error('ERC20PeriodTransferEnforcer:transfer-amount-exceeded'))).toBe(false)
    expect(isTransferCapRevert(new Error('fetch failed'))).toBe(false)
  })

  it('books it as a budget refusal, not the generic on-chain revert', () => {
    expect(classifyRevertForLedger(capRevert())).toBe('delegation_budget_exceeded')
  })
})
