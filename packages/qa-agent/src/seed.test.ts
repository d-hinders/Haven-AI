import { ethers } from 'ethers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureBudget, findReusableAgent, main } from './seed.js'

const API = 'https://api.example'
const DELEGATE = '0x' + 'aB'.repeat(20)
const config = {
  apiUrl: API,
  delegateAddress: DELEGATE,
  periodMin: 1440,
} as Parameters<typeof findReusableAgent>[0]

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function installAgents(agents: unknown[]) {
  const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const path = String(input).replace(API, '')
    if (path === '/agents' && (!init?.method || init.method === 'GET')) return json({ agents })
    if (path === '/agents' && init?.method === 'POST') return json({ id: 'created-agent' }, 201)
    throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${path}`)
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

beforeEach(() => vi.unstubAllGlobals())

describe('findReusableAgent', () => {
  it.each(['active', 'pending_approval'])(
    'reuses a case-insensitive delegate match in %s status',
    async (status) => {
      const fetch = installAgents([
        { id: 'agent-existing', name: 'QA Agent', delegate_address: DELEGATE.toLowerCase(), status },
      ])

      await expect(findReusableAgent(config, 'token')).resolves.toMatchObject({ id: 'agent-existing' })
      expect(fetch).toHaveBeenCalledTimes(1)
    },
  )

  it.each(['revoked', 'paused', null])(
    'refuses a %s agent with the configured delegate instead of reusing or creating it',
    async (status) => {
      const fetch = installAgents([
        { id: 'agent-revoked', name: 'QA Agent', delegate_address: DELEGATE.toLowerCase(), status },
      ])

      await expect(findReusableAgent(config, 'token')).rejects.toThrow(
        /agent-revoked.*rotate SEED_DELEGATE_ADDRESS.*un-revoke/i,
      )
      expect(fetch).toHaveBeenCalledTimes(1)
    },
  )
})

describe('ensureBudget', () => {
  const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
  const FIVE_USDC = '5000000'
  const DAY = 86_400
  const budgetConfig = {
    apiUrl: API,
    ownerKey: '0x' + '11'.repeat(32),
    budgetUsdc: '5',
    periodMin: 1440,
  } as Parameters<typeof ensureBudget>[0]
  const nowSec = () => Math.floor(Date.now() / 1000)
  const OWNER = new ethers.Wallet(budgetConfig.ownerKey).address
  const grant = (delegation_hash: string, expires_at: number, overrides: Record<string, unknown> = {}) => ({
    chain_id: 84532,
    token_address: USDC,
    recipient_address: null,
    status: 'active',
    budget_atomic: FIVE_USDC,
    delegation_hash,
    // node-postgres decodes int8 as a string; the route passes it through.
    expires_at: String(expires_at),
    ...overrides,
  })

  function installDelegations(delegations: unknown[], ownerAddress: string | null = OWNER.toLowerCase()) {
    const bodies: Record<string, Record<string, unknown>> = {}
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const path = String(input).replace(API, '')
      if (path === '/agents/agent-1/delegations') return json({ delegations })
      if (path === '/agents/agent-1/account-signers') return json({ owner_address: ownerAddress })
      // Replaced rows get an owner-signed Stop; a failed Stop is logged, not fatal.
      if (path.endsWith('/revoke')) return json({ error: 'not exercised here' }, 500)
      if (path === '/agents/agent-1/delegations/build') {
        bodies.build = JSON.parse(String(init?.body))
        return json(
          {
            delegation_hash: '0xnew',
            signing_payload: {
              domain: { name: 'Test', chainId: 84532 },
              types: { Grant: [{ name: 'amount', type: 'uint256' }] },
              message: { amount: 1 },
            },
          },
          201,
        )
      }
      if (path === '/agents/agent-1/delegations/0xnew/activate') {
        bodies.activate = JSON.parse(String(init?.body))
        return json({ status: 'active' })
      }
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${path}`)
    })
    vi.stubGlobal('fetch', fetch)
    return { fetch, bodies }
  }

  // The 2026-11-03 lapse: an expired grant keeps status='active' (the status
  // CHECK has no expired value), so matching on status and amount alone reported
  // the lapsed budget as "already granted" and the recovery run changed nothing.
  it('grants anew over a lapsed budget of the same amount, without naming it as replaced', async () => {
    const { bodies } = installDelegations([grant('0xlapsed', nowSec() - DAY)])

    await ensureBudget(budgetConfig, 'token', 'agent-1', FIVE_USDC)

    expect(bodies.build).toMatchObject({ budget_atomic: FIVE_USDC, recipient_address: null })
    expect(bodies.build).not.toHaveProperty('replaces')
    expect(bodies.activate).toHaveProperty('signature')
    expect(bodies.activate).not.toHaveProperty('replaces')
  })

  it('leaves a live budget of the same amount alone', async () => {
    const { fetch } = installDelegations([grant('0xlive', nowSec() + DAY)])

    await ensureBudget(budgetConfig, 'token', 'agent-1', FIVE_USDC)

    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not count a live pinned budget: the EIP-3009 legs need an open one', async () => {
    const pinned = grant('0xpinned', nowSec() + DAY, { recipient_address: '0x' + 'cd'.repeat(20) })
    const { bodies } = installDelegations([pinned])

    await ensureBudget(budgetConfig, 'token', 'agent-1', FIVE_USDC)

    expect(bodies.build).toMatchObject({ recipient_address: null })
    expect(bodies.build).not.toHaveProperty('replaces')
  })

  it('replaces every live open row when the amount differs, naming a re-keyed pair', async () => {
    const other = { budget_atomic: '2000000' }
    const { bodies } = installDelegations([
      grant('0xcarry', nowSec() + DAY, other),
      grant('0xsteady', nowSec() + DAY, other),
    ])

    await ensureBudget(budgetConfig, 'token', 'agent-1', FIVE_USDC)

    expect(bodies.build?.replaces).toEqual(['0xcarry', '0xsteady'])
    expect(bodies.activate?.replaces).toEqual(['0xcarry', '0xsteady'])
  })

  // Activate checks only the signature's shape, so a wrong key would otherwise
  // leave a live-looking grant that reverts on every payment.
  it.each([
    ['another EOA', '0x' + 'ab'.repeat(20)],
    ['no EOA owner', null],
  ])('refuses before building or signing when the account has %s', async (_case, ownerAddress) => {
    const { bodies } = installDelegations([grant('0xlapsed', nowSec() - DAY)], ownerAddress)

    await expect(ensureBudget(budgetConfig, 'token', 'agent-1', FIVE_USDC)).rejects.toThrow(
      /SEED_OWNER_PRIVATE_KEY.*Nothing was signed/,
    )
    expect(bodies.build).toBeUndefined()
    expect(bodies.activate).toBeUndefined()
  })

  it('does not ask for the owner when a live budget means there is nothing to sign', async () => {
    const { fetch } = installDelegations([grant('0xlive', nowSec() + DAY)], '0x' + 'ab'.repeat(20))

    await ensureBudget(budgetConfig, 'token', 'agent-1', FIVE_USDC)

    expect(fetch).toHaveBeenCalledTimes(1)
  })

  // The route caps expires_at at now + 365 days on ITS clock (#4351), and
  // defaults to 90 days when none is sent, which is what lapsed on 2026-11-03.
  it('asks for a long-lived grant that stays inside the route cap', async () => {
    const { bodies } = installDelegations([])

    await ensureBudget(budgetConfig, 'token', 'agent-1', FIVE_USDC)

    const expiresAt = Number(bodies.build?.expires_at)
    expect(expiresAt).toBeGreaterThan(nowSec() + 300 * DAY)
    expect(expiresAt).toBeLessThan(nowSec() + 365 * DAY)
  })
})

describe('main', () => {
  it('refuses before provisioning an account or granting a budget to a revoked delegate', async () => {
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
        const path = String(input).replace(API, '')
        if (path === '/auth/signup' && init?.method === 'POST') return json({ token: 'token' }, 201)
        if (path === '/agents' && (!init?.method || init.method === 'GET')) {
          return json({
            agents: [
              { id: 'agent-revoked', name: 'QA Agent', delegate_address: DELEGATE.toLowerCase(), status: 'revoked' },
            ],
          })
        }
        throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${path}`)
      })
    vi.stubGlobal('fetch', fetch)
    const env = process.env
    process.env = {
      ...env,
      SEED_HAVEN_API_URL: API,
      SEED_OWNER_PRIVATE_KEY: '0x' + '11'.repeat(32),
      SEED_DELEGATE_ADDRESS: DELEGATE.toLowerCase(),
      SEED_PAYMENT_TO: '0x' + 'cd'.repeat(20),
      SEED_QA_EMAIL: 'qa@example.com',
      SEED_QA_PASSWORD: 'not-a-real-password',
    }

    try {
      await expect(main()).rejects.toThrow(/agent-revoked.*rotate SEED_DELEGATE_ADDRESS.*un-revoke/i)
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally {
      process.env = env
    }
  })
})
