import { beforeEach, describe, expect, it, vi } from 'vitest'
import { findReusableAgent, main } from './seed.js'

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
