import { beforeEach, describe, expect, it, vi } from 'vitest'
import { run, type RunDeps } from './commands.js'
import type { Session, SessionStore } from './session.js'
import { CliApiError, type CliApi } from './api.js'

const USER = { id: 'u1', email: 'ada@example.com', name: 'Ada' }
const SESSION: Session = { token: 'jwt', apiBaseUrl: 'https://api.test', user: USER }

function memoryStore(initial: Session | null = null): SessionStore & { value: Session | null } {
  const store = {
    value: initial,
    path: '/tmp/session.json',
    load: async () => store.value,
    save: async (s: Session) => { store.value = s },
    clear: async () => { store.value = null },
  }
  return store
}

/** Fake API backed by a route map; records calls. */
function fakeApi(routes: Record<string, unknown>): CliApi & { calls: string[] } {
  const calls: string[] = []
  const resolve = (method: string, path: string) => {
    calls.push(`${method} ${path}`)
    const key = `${method} ${path}`
    // Allow matching ignoring query string for GETs.
    const match = routes[key] ?? routes[`${method} ${path.split('?')[0]}`]
    if (match === undefined) throw new CliApiError(`Unmocked ${key}`, 404)
    return match
  }
  return {
    calls,
    get: async <T>(path: string) => resolve('GET', path) as T,
    post: async <T>(path: string) => resolve('POST', path) as T,
  }
}

function harness(over: Partial<RunDeps> = {}) {
  const out: string[] = []
  const err: string[] = []
  const deps: RunDeps = {
    sessionStore: memoryStore(SESSION),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env: {},
    ...over,
  }
  return { deps, out, err }
}

describe('run — auth gating', () => {
  it('requires a session for read commands (exit 2)', async () => {
    const { deps, err } = harness({ sessionStore: memoryStore(null) })
    const code = await run(['wallets', 'list'], deps)
    expect(code).toBe(2)
    expect(err.join('\n')).toMatch(/Not authenticated/)
  })

  it('prints help with no command', async () => {
    const { deps, out } = harness()
    expect(await run([], deps)).toBe(0)
    expect(out.join('\n')).toMatch(/terminal-native companion/)
  })

  it('reports unknown commands', async () => {
    const { deps, err } = harness()
    expect(await run(['frobnicate'], deps)).toBe(1)
    expect(err.join('\n')).toMatch(/Unknown command/)
  })
})

describe('login', () => {
  it('posts credentials, saves the session, and never echoes the password', async () => {
    const store = memoryStore(null)
    const api = fakeApi({ 'POST /auth/login': { token: 'jwt-new', user: USER } })
    const { deps, out } = harness({
      sessionStore: store,
      makeApi: () => api,
      env: { HAVEN_PASSWORD: 'hunter2' },
      promptPassword: vi.fn(),
    })

    const code = await run(['login', '--email', 'ada@example.com', '--api', 'https://api.test'], deps)
    expect(code).toBe(0)
    expect(store.value).toMatchObject({ token: 'jwt-new', apiBaseUrl: 'https://api.test' })
    expect(out.join('\n')).toContain('Signed in as ada@example.com')
    expect(out.join('\n')).not.toContain('hunter2')
  })

  it('errors clearly without an email', async () => {
    const { deps, err } = harness({ sessionStore: memoryStore(null), env: {} })
    expect(await run(['login'], deps)).toBe(1)
    expect(err.join('\n')).toMatch(/email/i)
  })
})

describe('read commands', () => {
  it('lists wallets as a table and as json', async () => {
    const safes = [
      { id: 's1', safe_address: '0x1111111111111111111111111111111111111111', chain_id: 8453, name: 'Main', is_default: true },
    ]
    const mk = () => fakeApi({ 'GET /user/safes': { safes } })

    const human = harness({ makeApi: mk })
    await run(['wallets', 'list'], human.deps)
    expect(human.out.join('\n')).toContain('Main')
    expect(human.out.join('\n')).toContain('Base')

    const json = harness({ makeApi: mk })
    await run(['wallets', 'list', '--json'], json.deps)
    expect(JSON.parse(json.out.join('\n'))).toEqual(safes)
  })

  it('shows an agent budget', async () => {
    const agent = { id: 'a1', name: 'Research', status: 'active', allowances: [{ token_symbol: 'USDC', allowance_amount: '50', reset_period_min: 1440 }] }
    const { deps, out } = harness({ makeApi: () => fakeApi({ 'GET /agents/a1': agent }) })
    expect(await run(['budget', 'show', 'a1'], deps)).toBe(0)
    expect(out.join('\n')).toContain('USDC')
    expect(out.join('\n')).toContain('daily')
  })

  it('applies the client-side direction filter to activity', async () => {
    const transactions = [
      { hash: '0xa', direction: 'in', valueFormatted: '1', asset: 'USDC', timestamp: 1_700_000_000, source: 'x402' },
      { hash: '0xb', direction: 'out', valueFormatted: '2', asset: 'USDC', timestamp: 1_700_000_000 },
    ]
    const { deps, out } = harness({ makeApi: () => fakeApi({ 'GET /transactions': { transactions } }) })
    await run(['activity', 'list', '--direction', 'in', '--json'], deps)
    const parsed = JSON.parse(out.join('\n')) as Array<{ hash: string }>
    expect(parsed).toHaveLength(1)
    expect(parsed[0].hash).toBe('0xa')
  })

  it('lists the catalog', async () => {
    const entries = [{ name: 'Soundside', category: 'media', rail: 'x402', price_display: '$0.01 USDC', status: 'active' }]
    const { deps, out } = harness({ makeApi: () => fakeApi({ 'GET /catalog': { entries } }) })
    expect(await run(['catalog', 'list'], deps)).toBe(0)
    expect(out.join('\n')).toContain('Soundside')
  })

  it('surfaces a backend error message', async () => {
    const failing: CliApi = {
      get: async () => { throw new CliApiError('Account is locked', 403) },
      post: async () => { throw new CliApiError('Account is locked', 403) },
    }
    const { deps, err } = harness({ makeApi: () => failing })
    expect(await run(['agents', 'list'], deps)).toBe(1)
    expect(err.join('\n')).toContain('Account is locked')
  })
})
