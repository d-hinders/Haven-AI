import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  transactionInitiator,
  transactionMovement,
  transactionStatus,
  transactionTitle,
} from '../transaction-presentation'
import type { AggregatedTransaction } from '@/types/transactions'

function tx(overrides: Partial<AggregatedTransaction> = {}): AggregatedTransaction {
  return {
    hash: '0x' + '12'.repeat(32),
    type: 'erc20',
    from: '0xA87300000000000000000000000000000000DD35',
    to: '0x135a9215604711AC70d970e12Caa812c53537EF4',
    value: '40000',
    valueFormatted: '0.04',
    asset: 'USDC',
    decimals: 6,
    direction: 'in',
    timestamp: 1779436199,
    blockNumber: 45725826,
    isError: false,
    tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    tokenSymbol: 'USDC',
    chainId: 8453,
    safeId: 'safe-id',
    safeAddress: '0x135a9215604711AC70d970e12Caa812c53537EF4',
    safeName: 'Main Haven wallet',
    ...overrides,
  }
}

describe('transaction presentation', () => {
  it('labels delegate sweeps as recovered agent funds', () => {
    const sweep = tx({
      activityType: 'delegate_sweep',
      agentName: 'Research assistant',
      agentId: 'agent-id',
      paymentId: 'sweep-id',
    })

    expect(transactionTitle(sweep)).toBe('Agent funds swept back')
    expect(transactionInitiator(sweep)).toBe('Research assistant')
    expect(transactionStatus(sweep)).toEqual({ label: 'Recovered', tone: 'success' })

    render(transactionMovement(sweep))

    expect(screen.getByText('Research assistant delegate')).toBeInTheDocument()
    expect(screen.getByText('Main Haven wallet')).toBeInTheDocument()
  })

  it('keeps ordinary incoming transfers generic', () => {
    const incoming = tx()

    expect(transactionTitle(incoming)).toBe('Received payment')
    expect(transactionInitiator(incoming)).toBe('')
    expect(transactionStatus(incoming)).toBeNull()
  })
})
