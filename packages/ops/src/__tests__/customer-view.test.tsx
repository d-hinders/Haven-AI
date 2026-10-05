/**
 * Customer-page renders (#3516 AC): an `unavailable` budget renders as
 * unavailable — never as a number and never as an error page — and the
 * classified refusals render their buckets. Driven through CustomerView with
 * the client mocked at the fetch boundary.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { CustomerView } from '../components/customer/CustomerView'
import { createOpsClient } from '../lib/ops-client'
import { FIXTURE_USER_ID } from '../../scripts/screenshot-fixture.mjs'

const userDetail = {
  user: { id: FIXTURE_USER_ID, email: 'da•••@gmail.com', name: 'D•••', created_at: '2026-03-14T09:12:00.000Z' },
  smart_accounts: [
    {
      id: '7b9d2c4e-6f8a-4b0c-9d1e-3f5a7b9c0e2d',
      chain_id: 100,
      account_address: '0x9f8f72aA9304c8B593d555F12eF6589cC3A579A2',
      account_type: 'delegator_hybrid',
      execution_rail: 'delegation',
      name: 'Main account',
      created_at: '2026-03-14T09:15:00.000Z',
    },
  ],
  agents: [],
  active_delegations: [
    {
      id: '3c5d7e9f-1a3b-4c5d-9e7f-1a3c5e7f9a1b',
      agent_id: '1f0c3a52-9b04-4e6a-8f21-7c5d2e8b9a10',
      chain_id: 100,
      token_address: '0x2a22f9c3b484c3629090FeD35F2F0fA482F2DB0E',
      recipient_address: null,
      merchant_id: null,
      budget_atomic: '250000000',
      period_seconds: 604800,
      start_date: 1789900000,
      expires_at: 1799982400,
    },
  ],
  payment_intents: [],
  payment_refusals: [
    {
      id: '8f5b1c4d-6a8c-4d9e-9b3e-5c7f9a1b2d4f',
      agent_id: '1f0c3a52-9b04-4e6a-8f21-7c5d2e8b9a10',
      chain_id: 100,
      token_symbol: 'USDC',
      amount_atomic: '40000000',
      reason: 'delegation_budget_exceeded',
      source: 'x402_authorize',
      created_at: '2026-10-01T09:40:00.000Z',
    },
  ],
}

const onchainUnavailable = {
  user_id: FIXTURE_USER_ID,
  accounts: [
    {
      account_id: '7b9d2c4e-6f8a-4b0c-9d1e-3f5a7b9c0e2d',
      chain_id: 100,
      account_address: '0x9f8f72aA9304c8B593d555F12eF6589cC3A579A2',
      account_type: 'delegator_hybrid',
      execution_rail: 'delegation',
      name: 'Main account',
      db: { active_delegations: [{ budget_atomic: '250000000' }] },
      chain: {
        deploy_status: 'deployed',
        delegations: [
          {
            budget_atomic: '250000000',
            onchain: 'enabled',
            budget_status: 'unavailable',
            budget_remaining_atomic: null,
          },
        ],
      },
      flags: { counterfactual_with_active_delegation: false, delegation_disabled_onchain_active_in_db: false },
    },
  ],
  generated_at: '2026-10-02T06:00:00.000Z',
}

const fetchMock = vi.fn<typeof fetch>()

function client() {
  return createOpsClient(
    {
      length: 0,
      key: () => null,
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
    },
    'https://api.dev.example',
    () => {},
  )
}

function routeJson(url: string, body: unknown) {
  fetchMock.mockImplementation((input) => {
    if (String(input) === url) return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
    return Promise.resolve(new Response('', { status: 404 }))
  })
}

describe('CustomerView', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    fetchMock.mockReset()
  })

  it('renders an unavailable budget as unavailable — never as a number, never as an error page', async () => {
    routeJson(`https://api.dev.example/ops/users/${FIXTURE_USER_ID}`, userDetail)
    fetchMock.mockImplementation((input) => {
      const url = String(input)
      if (url.endsWith(`/ops/users/${FIXTURE_USER_ID}`)) {
        return Promise.resolve(new Response(JSON.stringify(userDetail), { status: 200 }))
      }
      if (url.endsWith('/onchain')) {
        return Promise.resolve(new Response(JSON.stringify(onchainUnavailable), { status: 200 }))
      }
      return Promise.resolve(new Response('', { status: 404 }))
    })
    render(<CustomerView userId={FIXTURE_USER_ID} client={client()} />)
    const badge = await screen.findByText('unavailable')
    expect(badge).toBeInTheDocument()
    // The chain could not read the budget: no remaining FIGURE may render.
    expect(screen.queryByText(/remaining/)).not.toBeInTheDocument()
    // The page itself is not an error: the user header rendered.
    expect(screen.getByText('da•••@gmail.com')).toBeInTheDocument()
  })

  it('renders the classified refusal bucket for an over-budget refusal', async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input)
      if (url.endsWith(`/ops/users/${FIXTURE_USER_ID}`)) {
        return Promise.resolve(new Response(JSON.stringify(userDetail), { status: 200 }))
      }
      if (url.endsWith('/onchain')) {
        return Promise.resolve(new Response(JSON.stringify(onchainUnavailable), { status: 200 }))
      }
      return Promise.resolve(new Response('', { status: 404 }))
    })
    render(<CustomerView userId={FIXTURE_USER_ID} client={client()} />)
    expect(await screen.findByText('Over budget')).toBeInTheDocument()
    // The raw reason stays beside the bucket for the operator.
    expect(screen.getByText(/delegation_budget_exceeded/)).toBeInTheDocument()
  })

  it('a not_served account renders its reason — a condition, not an error', async () => {
    const detailWithLegacy = {
      ...userDetail,
      smart_accounts: [
        ...userDetail.smart_accounts,
        {
          id: '11111111-2222-4333-8444-555555555555',
          chain_id: 84532,
          account_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          account_type: 'legacy_safe',
          execution_rail: 'legacy',
          name: 'Old Safe',
          created_at: '2025-11-02T08:00:00.000Z',
        },
      ],
    }
    const onchainWithNotServed = {
      ...onchainUnavailable,
      accounts: [
        ...onchainUnavailable.accounts,
        {
          account_id: '11111111-2222-4333-8444-555555555555',
          chain_id: 84532,
          account_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          account_type: 'legacy_safe',
          execution_rail: 'legacy',
          status: 'not_served',
          reason: 'legacy_safe',
        },
      ],
    }
    fetchMock.mockImplementation((input) => {
      const url = String(input)
      if (url.endsWith(`/ops/users/${FIXTURE_USER_ID}`)) {
        return Promise.resolve(new Response(JSON.stringify(detailWithLegacy), { status: 200 }))
      }
      if (url.endsWith('/onchain')) {
        return Promise.resolve(new Response(JSON.stringify(onchainWithNotServed), { status: 200 }))
      }
      return Promise.resolve(new Response('', { status: 404 }))
    })
    render(<CustomerView userId={FIXTURE_USER_ID} client={client()} />)
    expect(await screen.findByText('not_served')).toBeInTheDocument()
    expect(screen.getByText(/legacy Safe record/)).toBeInTheDocument()
    // The page did not turn into an error page over the unread account.
    expect(screen.getByText('da•••@gmail.com')).toBeInTheDocument()
  })
})
