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
    put: async <T>(path: string) => resolve('PUT', path) as T,
    del: async <T>(path: string) => resolve('DELETE', path) as T,
    getText: async (path: string) => resolve('GET', path) as string,
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

  it('resolves activity --safe by address to a safeId filter', async () => {
    const api = fakeApi({
      'GET /user/safes': { safes: [{ id: 's1', safe_address: '0xABC', chain_id: 100, name: 'Main', is_default: true }] },
      'GET /transactions': { transactions: [] },
    })
    const { deps } = harness({ makeApi: () => api })
    expect(await run(['activity', 'list', '--safe', '0xabc'], deps)).toBe(0)
    const txCall = api.calls.find((c) => c.startsWith('GET /transactions'))
    expect(txCall).toContain('safeId=s1')
  })

  it('passes --offset through to the transactions query', async () => {
    const api = fakeApi({ 'GET /transactions': { transactions: [] } })
    const { deps } = harness({ makeApi: () => api })
    expect(await run(['activity', 'list', '--offset', '40'], deps)).toBe(0)
    const txCall = api.calls.find((c) => c.startsWith('GET /transactions'))
    expect(txCall).toContain('offset=40')
  })

  it('errors when activity --safe matches no wallet', async () => {
    const api = fakeApi({ 'GET /user/safes': { safes: [] } })
    const { deps, err } = harness({ makeApi: () => api })
    expect(await run(['activity', 'list', '--safe', 'nope'], deps)).toBe(1)
    expect(err.join('\n')).toContain('No wallet matches')
  })

  it('exports SIE from the backend accounting endpoint', async () => {
    const sie = '#FLAGGA 0\r\n#SIETYP 4\r\n#VER "A" 1 20260619 "Soundside"\r\n'
    const { deps, out } = harness({ makeApi: () => fakeApi({ 'GET /accounting/export': sie }) })
    expect(await run(['activity', 'export', '--format', 'sie', '--company', 'Acme'], deps)).toBe(0)
    expect(out.join('\n')).toContain('#SIETYP 4')
  })

  it('lists the catalog', async () => {
    const entries = [{ name: 'Soundside', category: 'media', rail: 'x402', price_display: '$0.01 USDC', status: 'active' }]
    const { deps, out } = harness({ makeApi: () => fakeApi({ 'GET /catalog': { entries } }) })
    expect(await run(['catalog', 'list'], deps)).toBe(0)
    expect(out.join('\n')).toContain('Soundside')
  })

  it('exports activity as CSV with a formula-injection guard', async () => {
    const transactions = [
      {
        hash: '0xabc', direction: 'out', valueFormatted: '12.50', asset: 'USDC',
        tokenSymbol: 'USDC', tokenAddress: '0xtok', timestamp: 1_700_000_000,
        from: '0xsafe', to: '0xmerchant', source: 'x402', chainId: 8453,
        safeAddress: '0xsafe', agentName: '=cmd()',
      },
    ]
    const { deps, out } = harness({ makeApi: () => fakeApi({ 'GET /transactions': { transactions } }) })
    expect(await run(['activity', 'export'], deps)).toBe(0)
    const csv = out.join('\n')
    expect(csv.split('\n')[0]).toContain('date,type,status,direction,amount')
    expect(csv).toContain('x402')
    // agent name starting with = is neutralised
    expect(csv).toContain('"\'=cmd()"')
  })
})

describe('management commands (backend-only)', () => {
  it('pauses an agent', async () => {
    const api = fakeApi({ 'POST /agents/a1/pause': {} })
    const { deps, out } = harness({ makeApi: () => api })
    expect(await run(['agents', 'pause', 'a1'], deps)).toBe(0)
    expect(api.calls).toContain('POST /agents/a1/pause')
    expect(out.join('\n')).toMatch(/paused/)
  })

  it('refuses to revoke without --yes and never calls the API', async () => {
    const api = fakeApi({ 'POST /agents/a1/revoke': {} })
    const { deps, err } = harness({ makeApi: () => api })
    expect(await run(['agents', 'revoke', 'a1'], deps)).toBe(1)
    expect(api.calls).not.toContain('POST /agents/a1/revoke')
    expect(err.join('\n')).toMatch(/--yes/)
  })

  it('revokes with --yes', async () => {
    const api = fakeApi({ 'POST /agents/a1/revoke': {} })
    const { deps } = harness({ makeApi: () => api })
    expect(await run(['agents', 'revoke', 'a1', '--yes'], deps)).toBe(0)
    expect(api.calls).toContain('POST /agents/a1/revoke')
  })

  it('rotates an agent key and prints it once', async () => {
    const api = fakeApi({ 'POST /agents/a1/rotate-key': { api_key: 'sk_agent_NEW', api_key_prefix: 'sk_agent_NEW'.slice(0, 12) } })
    const { deps, out } = harness({ makeApi: () => api })
    expect(await run(['agents', 'rotate-key', 'a1'], deps)).toBe(0)
    expect(out.join('\n')).toContain('sk_agent_NEW')
  })

  it('renames an agent via PUT', async () => {
    const api = fakeApi({ 'PUT /agents/a1': {} })
    const { deps } = harness({ makeApi: () => api })
    expect(await run(['agents', 'rename', 'a1', 'New', 'Name'], deps)).toBe(0)
    expect(api.calls).toContain('PUT /agents/a1')
  })

  it('renames a wallet via PUT', async () => {
    const api = fakeApi({ 'PUT /user/safes/s1': {} })
    const { deps } = harness({ makeApi: () => api })
    expect(await run(['wallets', 'rename', 's1', 'Operating'], deps)).toBe(0)
    expect(api.calls).toContain('PUT /user/safes/s1')
  })

  it('adds and removes contacts', async () => {
    const api = fakeApi({
      'POST /contacts': { id: 'c1', name: 'Alice', address: '0xalice' },
      'DELETE /contacts/c1': {},
    })
    const add = harness({ makeApi: () => api })
    expect(await run(['contacts', 'add', 'Alice', '0xalice'], add.deps)).toBe(0)
    expect(add.out.join('\n')).toContain('Alice')

    const rm = harness({ makeApi: () => api })
    expect(await run(['contacts', 'remove', 'c1'], rm.deps)).toBe(0)
    expect(api.calls).toContain('DELETE /contacts/c1')
  })

  it('surfaces a backend error message', async () => {
    const failing: CliApi = {
      get: async () => { throw new CliApiError('Account is locked', 403) },
      post: async () => { throw new CliApiError('Account is locked', 403) },
      put: async () => { throw new CliApiError('Account is locked', 403) },
      del: async () => { throw new CliApiError('Account is locked', 403) },
      getText: async () => { throw new CliApiError('Account is locked', 403) },
    }
    const { deps, err } = harness({ makeApi: () => failing })
    expect(await run(['agents', 'list'], deps)).toBe(1)
    expect(err.join('\n')).toContain('Account is locked')
  })
})
