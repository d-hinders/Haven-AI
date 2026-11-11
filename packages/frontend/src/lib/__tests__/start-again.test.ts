import { describe, expect, it, vi } from 'vitest'
import { ApiRequestError } from '../api'
import {
  prefillFromStatus,
  startAgainSetup,
  type SetupStatusResponse,
} from '../start-again'

/**
 * #4710: "Start again" must read the setup first, cancel only while it is
 * still awaiting a connector, and create nothing when the setup moved on or
 * the cancel answers 409. Each order is pinned here; the caller (the
 * dashboard) only opens the flow on `prefilled`, and the flow creates a new
 * setup only when the user submits it.
 */

const SETUP_ID = '11111111-1111-1111-1111-111111111111'

function status(overrides: Partial<SetupStatusResponse> = {}): SetupStatusResponse {
  return {
    setup_id: SETUP_ID,
    status: 'awaiting_connection',
    approval_url: `https://app.haven.test/agents?setup=${SETUP_ID}`,
    expires_at: '2099-01-01T00:00:00.000Z',
    agent: { name: 'Research agent', description: 'Pays for research APIs' },
    haven_wallet: {
      id: 'wallet-1',
      name: 'Main Haven wallet',
      address: '0x2222222222222222222222222222222222222222',
      chain_id: 84532,
      network: 'Base Sepolia',
    },
    agent_budget: [
      {
        token_address: '0x0000000000000000000000000000000000000000',
        token_symbol: 'USDC',
        allowance_amount: '10000000',
        reset_period_min: 1440,
      },
    ],
    connector_package: '@haven_ai/connect@alpha',
    install_status: {},
    approval: { account_tx_hash: null, tx_hash: null, status: 'not_started' },
    ...overrides,
  } as SetupStatusResponse
}

describe('startAgainSetup (#4710)', () => {
  it('cancels an awaiting setup and returns the prefill for a new one', async () => {
    const readSetup = vi.fn(async () => status())
    const cancelSetup = vi.fn(async () => {})

    const outcome = await startAgainSetup(SETUP_ID, { readSetup, cancelSetup })

    expect(readSetup).toHaveBeenCalledWith(SETUP_ID)
    expect(cancelSetup).toHaveBeenCalledWith(SETUP_ID)
    expect(outcome).toEqual({
      kind: 'prefilled',
      prefill: {
        name: 'Research agent',
        description: 'Pays for research APIs',
        accountId: 'wallet-1',
        amount: '10',
        resetPeriodMin: 1440,
      },
    })
  })

  it('creates nothing when the setup has moved on — it opens the resume link instead', async () => {
    const readSetup = vi.fn(async () => status({ status: 'connected_local' }))
    const cancelSetup = vi.fn(async () => {})

    const outcome = await startAgainSetup(SETUP_ID, { readSetup, cancelSetup })

    expect(outcome).toEqual({ kind: 'resume', setupId: SETUP_ID })
    // The agent may already have registered; cancelling would revoke a
    // pending agent that is about to be approved.
    expect(cancelSetup).not.toHaveBeenCalled()
  })

  it('creates nothing when the cancel answers 409 — it opens the resume link instead', async () => {
    const readSetup = vi.fn(async () => status())
    const cancelSetup = vi.fn(async () => {
      throw new ApiRequestError('Setup state changed; refresh and try again', 409)
    })

    const outcome = await startAgainSetup(SETUP_ID, { readSetup, cancelSetup })

    expect(outcome).toEqual({ kind: 'resume', setupId: SETUP_ID })
  })

  it('propagates a non-409 cancel failure so the caller can show it and create nothing', async () => {
    const readSetup = vi.fn(async () => status())
    const cancelSetup = vi.fn(async () => {
      throw new ApiRequestError('Internal error', 500)
    })

    await expect(startAgainSetup(SETUP_ID, { readSetup, cancelSetup })).rejects.toThrow(
      'Internal error',
    )
  })

  it('propagates a read failure — nothing is cancelled on an unknown status', async () => {
    const readSetup = vi.fn(async () => {
      throw new ApiRequestError('Setup not found', 404)
    })
    const cancelSetup = vi.fn(async () => {})

    await expect(startAgainSetup(SETUP_ID, { readSetup, cancelSetup })).rejects.toThrow(
      'Setup not found',
    )
    expect(cancelSetup).not.toHaveBeenCalled()
  })
})

describe('prefillFromStatus (#4710)', () => {
  it('converts the atomic budget to the policy step’s human amount', () => {
    const prefill = prefillFromStatus(status())
    expect(prefill.amount).toBe('10')
    expect(prefill.resetPeriodMin).toBe(1440)
  })

  it('keeps fractional budgets exact', () => {
    const prefill = prefillFromStatus(
      status({
        agent_budget: [
          {
            token_address: '0x0000000000000000000000000000000000000000',
            token_symbol: 'USDC',
            allowance_amount: '12500000',
            reset_period_min: 60,
          },
        ],
      }),
    )
    expect(prefill.amount).toBe('12.5')
    expect(prefill.resetPeriodMin).toBe(60)
  })

  it('leaves the amount empty when the setup asked for no budget', () => {
    const prefill = prefillFromStatus(status({ agent_budget: [] }))
    expect(prefill.amount).toBe('')
    expect(prefill.resetPeriodMin).toBe(1440)
  })
})
