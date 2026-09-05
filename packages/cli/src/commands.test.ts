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
  it('requires a session for read commands (exit 3)', async () => {
    // #2525 moved this from 2 to 3: 2 now means "the command line was wrong",
    // and "you are not logged in" is a different thing a caller acts on
    // differently (run `haven login`, don't fix the argv).
    const { deps, err } = harness({ sessionStore: memoryStore(null) })
    const code = await run(['wallets', 'list'], deps)
    expect(code).toBe(3)
    expect(err.join('\n')).toMatch(/Not authenticated/)
  })

  it('prints help with no command', async () => {
    const { deps, out } = harness()
    expect(await run([], deps)).toBe(0)
    expect(out.join('\n')).toMatch(/terminal-native companion/)
  })

  it('reports unknown commands', async () => {
    const { deps, err } = harness()
    // An unknown command is a usage error (2), not a generic failure (1).
    expect(await run(['frobnicate'], deps)).toBe(2)
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

  it('#2526 changed this: no email is the DEVICE FLOW, not a usage error', async () => {
    // This case used to assert exit 2 and a message about `--email`. That was
    // the old contract, and the change is deliberate: an agent driving this
    // CLI must never hold its user's password, so `login` with no email now
    // starts the browser-approved flow instead of refusing. The password path
    // is still there behind `--email`, and is covered below.
    //
    // Recorded as a contract change rather than deleted, so a reader who
    // remembers the old behaviour finds out why it moved.
    const { deps } = harness({ sessionStore: memoryStore(null), env: {} })
    const code = await run(['login'], deps)
    expect(code).not.toBe(2)
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
    // A --safe that matches nothing is a bad argument: usage (2).
    expect(await run(['activity', 'list', '--safe', 'nope'], deps)).toBe(2)
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
    // Missing --yes is a usage error: the command line needs one more flag.
    expect(await run(['agents', 'revoke', 'a1'], deps)).toBe(2)
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
    // 403 is the backend refusing an authenticated caller: exit 4, distinct
    // from 3 (log in again) and from 1 (something else broke). The message is
    // still echoed verbatim — that half is unchanged.
    expect(await run(['agents', 'list'], deps)).toBe(4)
    expect(err.join('\n')).toContain('Account is locked')
  })
})

/**
 * Browser-approved login (#2526).
 *
 * The poll loop is where this can go quietly wrong: a client that invents its
 * own interval, ignores `slow_down`, or reports the wrong exit code leaves an
 * agent unable to tell "keep waiting" from "give up". Each of those is a case
 * here, and the clock is injected so they run in no time at all.
 */
describe('haven login — device flow', () => {
  const START = {
    device_code: 'dev-code-abc',
    user_code: 'ABCD-2345',
    verification_url: 'https://app.test/device?code=ABCD-2345',
    expires_in: 600,
    interval: 5,
  }

  function deviceApi(tokenResponses: Array<unknown | CliApiError>) {
    const calls: string[] = []
    let i = 0
    const api = {
      calls,
      get: async () => { throw new CliApiError('unused', 404) },
      post: async (path: string) => {
        calls.push(`POST ${path}`)
        if (path === '/auth/device/start') return START as never
        if (path === '/auth/device/token') {
          const next = tokenResponses[Math.min(i, tokenResponses.length - 1)]
          i += 1
          if (next instanceof CliApiError) throw next
          return next as never
        }
        throw new CliApiError(`Unmocked POST ${path}`, 404)
      },
    } as unknown as CliApi & { calls: string[] }
    return api
  }

  const pending = () => new CliApiError('authorization_pending', 400, { error: 'authorization_pending' })
  const slowDown = () => new CliApiError('slow_down', 400, { error: 'slow_down' })
  const denied = () => new CliApiError('access_denied', 400, { error: 'access_denied' })
  const expired = () => new CliApiError('expired_token', 400, { error: 'expired_token' })

  function deps(api: CliApi, store = memoryStore(), slept: number[] = []): RunDeps {
    return {
      sessionStore: store,
      makeApi: () => api,
      out: () => {},
      err: () => {},
      env: { HAVEN_API_URL: 'https://api.test', HOSTNAME: 'test-host' },
      sleep: async (ms: number) => { slept.push(ms) },
    }
  }

  it('is the DEFAULT — no --email means no password is ever asked for', async () => {
    const api = deviceApi([{ token: 'jwt', user: USER }])
    const store = memoryStore()
    const promptPassword = vi.fn()
    const code = await run(['login'], { ...deps(api, store), promptPassword })
    expect(code).toBe(0)
    expect(promptPassword).not.toHaveBeenCalled()
    expect(api.calls[0]).toBe('POST /auth/device/start')
    expect(store.value?.token).toBe('jwt')
  })

  it('--no-wait prints the link and stops, without polling', async () => {
    // What an agent uses when it wants to hand the link over and get on with
    // something else. A poll here would block the agent on its own user.
    const api = deviceApi([])
    const code = await run(['login', '--no-wait'], deps(api))
    expect(code).toBe(0)
    expect(api.calls).toEqual(['POST /auth/device/start'])
  })

  it('emits the link BEFORE polling under --json', async () => {
    const lines: string[] = []
    const api = deviceApi([pending(), { token: 'jwt', user: USER }])
    await run(['login', '--json'], { ...deps(api), out: (l) => lines.push(l) })
    const first = JSON.parse(lines[0])
    expect(first.verification_url).toBe(START.verification_url)
    expect(first.user_code).toBe('ABCD-2345')
    // The token is never echoed — not in the first object, not in the last.
    expect(lines.join('\n')).not.toContain('jwt')
  })

  it('keeps polling on authorization_pending, at the interval the SERVER named', async () => {
    const slept: number[] = []
    const api = deviceApi([pending(), pending(), { token: 'jwt', user: USER }])
    const code = await run(['login'], deps(api, memoryStore(), slept))
    expect(code).toBe(0)
    expect(slept).toEqual([5000, 5000, 5000])
  })

  it('widens the interval on slow_down instead of hammering', async () => {
    const slept: number[] = []
    const api = deviceApi([slowDown(), { token: 'jwt', user: USER }])
    await run(['login'], deps(api, memoryStore(), slept))
    expect(slept).toEqual([5000, 10000])
  })

  it('a DENIED request exits 4 — refused, not "try again"', async () => {
    // The distinction an agent acts on: refused means stop asking.
    const api = deviceApi([denied()])
    expect(await run(['login'], deps(api))).toBe(4)
  })

  it('an EXPIRED code exits 3 — not authenticated, so a retry is the answer', async () => {
    const api = deviceApi([expired()])
    expect(await run(['login'], deps(api))).toBe(3)
  })

  it('--email still takes the password path, unchanged', async () => {
    // The human route is not removed; it is no longer what an agent gets by
    // asking for `login`.
    const calls: string[] = []
    const api = {
      calls,
      get: async () => { throw new CliApiError('unused', 404) },
      post: async (path: string) => {
        calls.push(`POST ${path}`)
        return { token: 'jwt', user: USER } as never
      },
    } as unknown as CliApi & { calls: string[] }
    const code = await run(['login', '--email', 'ada@example.com'], {
      ...deps(api),
      env: { HAVEN_API_URL: 'https://api.test', HAVEN_PASSWORD: 'hunter2' },
    })
    expect(code).toBe(0)
    expect(calls).toEqual(['POST /auth/login'])
  })
})

describe('agents connect (#2527)', () => {
  const SAFES = { safes: [{ id: 's1', safe_address: '0xsafe', chain_id: 84532, name: 'Wallet', is_default: true }] }
  const BALANCES = {
    balances: [
      { symbol: 'ETH', address: null, decimals: 18 },
      { symbol: 'USDC', address: '0xusdc', decimals: 6 },
    ],
  }
  const SETUP = {
    setup_id: 'set-1',
    status: 'awaiting_connection',
    approval_url: 'https://app.haven.example/connect/set-1',
    expires_at: '2026-09-06T00:00:00.000Z',
    connector_command: "npx -y @haven_ai/connect@alpha --setup 'hv_setup_abc' --api 'https://api.test' --ack-local-tools",
    connector_package: '@haven_ai/connect@alpha',
    setup_prompt: '# rules',
  }

  /** Fake API that RECORDS request bodies — the wire shape is the assertion. */
  function recordingApi(routes: Record<string, unknown>) {
    const bodies: { path: string; body: unknown }[] = []
    const api = {
      calls: [] as string[],
      get: async <T,>(path: string) => {
        api.calls.push(`GET ${path}`)
        const hit = routes[`GET ${path}`] ?? routes[`GET ${path.split('?')[0]}`]
        if (hit === undefined) throw new CliApiError(`Unmocked GET ${path}`, 404)
        return hit as T
      },
      post: async <T,>(path: string, body?: unknown) => {
        api.calls.push(`POST ${path}`)
        bodies.push({ path, body })
        const hit = routes[`POST ${path}`]
        if (hit === undefined) throw new CliApiError(`Unmocked POST ${path}`, 404)
        return hit as T
      },
      put: async <T,>() => ({}) as T,
      del: async <T,>() => ({}) as T,
      getText: async () => '',
    }
    return { api: api as unknown as CliApi & { calls: string[] }, bodies }
  }

  const ROUTES = {
    'GET /user/safes': SAFES,
    'GET /balances/0xsafe': BALANCES,
    'POST /agent-connection-setups': SETUP,
  }

  const CONNECT_ARGV = [
    'agents', 'connect', '--name', 'demo', '--budget', '25', '--token', 'USDC', '--period', '1440',
  ]

  it('sends the budget as ATOMIC units, with decimals read from the backend', async () => {
    // The field is atomic on the way in and human on the way back (#2295).
    // 25 USDC at 6 decimals is 25000000 — a wrong power of ten here is a
    // budget wrong by a factor of a million.
    const { api, bodies } = recordingApi(ROUTES)
    const { deps } = harness({ makeApi: () => api })
    const code = await run([...CONNECT_ARGV, '--json'], deps)

    expect(code).toBe(0)
    const body = bodies[0].body as { allowances: { allowance_amount: string; token_address: string }[] }
    expect(body.allowances[0].allowance_amount).toBe('25000000')
    expect(body.allowances[0].token_address).toBe('0xusdc')
    // Decimals came from GET /balances, not from a table in the CLI.
    expect(api.calls).toContain('GET /balances/0xsafe')
  })

  it('records source=cli, and sends via ONLY when an agent says it is driving', async () => {
    const first = recordingApi(ROUTES)
    await run([...CONNECT_ARGV, '--json'], harness({ makeApi: () => first.api }).deps)
    expect(first.bodies[0].body).toMatchObject({ source: 'cli' })
    expect(first.bodies[0].body).not.toHaveProperty('via')

    const second = recordingApi(ROUTES)
    await run(
      [...CONNECT_ARGV, '--json'],
      harness({ makeApi: () => second.api, env: { HAVEN_AGENT_DRIVEN: '1' } }).deps,
    )
    expect(second.bodies[0].body).toMatchObject({ source: 'cli', via: 'agent' })
  })

  it('PRINTS the backend command rather than composing one', async () => {
    // This is what makes it byte-identical to the dashboard modal's: both
    // render the same string from the same builder. A CLI that rebuilt the
    // command would have to be kept in agreement with the backend forever.
    const { api } = recordingApi(ROUTES)
    const { deps, out } = harness({ makeApi: () => api })
    await run([...CONNECT_ARGV], deps)
    expect(out.join('\n')).toContain(SETUP.connector_command)
  })

  it('refuses a budget with more precision than the token has', async () => {
    const { api } = recordingApi(ROUTES)
    const { deps, err } = harness({ makeApi: () => api })
    const code = await run(['agents', 'connect', '--name', 'd', '--budget', '1.9999999', '--token', 'USDC', '--period', '0'], deps)
    expect(code).toBe(2)
    expect(err.join('\n')).toMatch(/USDC supports up to 6 decimal places/)
  })

  it('refuses a token the wallet chain does not have, naming what it does', async () => {
    const { api } = recordingApi(ROUTES)
    const { deps, err } = harness({ makeApi: () => api })
    const code = await run(['agents', 'connect', '--name', 'd', '--budget', '1', '--token', 'DAI', '--period', '0'], deps)
    expect(code).toBe(2)
    expect(err.join('\n')).toMatch(/Unknown token DAI.*ETH, USDC/s)
  })

  describe('--run', () => {
    const spawnerFor = (stdout: string, exitCode = 0) => {
      const seen: { command: string; args: string[] }[] = []
      const spawner = async (command: string, args: string[]) => {
        seen.push({ command, args })
        return { stdout, stderr: '', exitCode }
      }
      return { spawner: spawner as never, seen }
    }

    it('runs the connector with exactly --json appended and exits 0', async () => {
      const { api } = recordingApi(ROUTES)
      const { spawner, seen } = spawnerFor('{"schema_version":1,"outcome":"complete"}')
      const { deps } = harness({ makeApi: () => api, spawner })
      const code = await run([...CONNECT_ARGV, '--run', '--json'], deps)

      expect(code).toBe(0)
      expect(seen[0].args.at(-1)).toBe('--json')
      expect(seen[0].args.filter((a) => a === '--json')).toHaveLength(1)
    })

    it('surfaces a connector REFUSAL as exit 4 with the object embedded', async () => {
      const refusal = JSON.stringify({
        schema_version: 1,
        outcome: 'failed',
        error: {
          code: 'runtime_undetermined',
          next_action: 'rerun_connect_with_explicit_runtime',
          message: 'Could not tell which runtime to wire',
          allowed_runtimes: ['claude-code', 'codex'],
        },
      })
      const { api } = recordingApi(ROUTES)
      const { spawner } = spawnerFor(refusal, 1)
      const { deps, out } = harness({ makeApi: () => api, spawner })
      const code = await run([...CONNECT_ARGV, '--run', '--json'], deps)

      expect(code).toBe(4)
      const payload = JSON.parse(out[0]) as { outcome: { error: { allowed_runtimes: string[] } }; relay: string }
      expect(payload.outcome.error.allowed_runtimes).toEqual(['claude-code', 'codex'])
      expect(payload.relay).toContain('rerun_connect_with_explicit_runtime')
    })

    it('exits 4 for a refusal code that did not exist when this CLI was written', async () => {
      // The guard behind the boundary note on #2527: a refusal is recognised
      // by the presence of `error`, never by matching a code, so a refusal the
      // connector adds later still reaches the human as a refusal rather than
      // as a success. A mutation that enumerated the two known codes here
      // passed every other test in this file, which is why this one exists.
      const future = JSON.stringify({
        schema_version: 1,
        outcome: 'failed',
        error: {
          code: 'some_refusal_invented_next_year',
          next_action: 'do_the_new_thing',
          message: 'Something new happened',
        },
      })
      const { api } = recordingApi(ROUTES)
      const { spawner } = spawnerFor(future, 1)
      const { deps, out } = harness({ makeApi: () => api, spawner })
      const code = await run([...CONNECT_ARGV, '--run', '--json'], deps)

      expect(code).toBe(4)
      const payload = JSON.parse(out[0]) as { relay: string }
      expect(payload.relay).toContain('do_the_new_thing')
    })

    it('puts the approval instruction FIRST in prose (#2483 one gate)', async () => {
      // A link buried under an outcome dump is a link nobody acts on.
      const outcome = JSON.stringify({
        schema_version: 1,
        outcome: 'action_required',
        approval: { required: true, url: 'https://app.haven.example/connect/set-1' },
      })
      const { api } = recordingApi(ROUTES)
      const { spawner } = spawnerFor(outcome)
      const { deps, out } = harness({ makeApi: () => api, spawner })
      await run([...CONNECT_ARGV, '--run'], deps)

      expect(out[0].split('\n')[0]).toContain('https://app.haven.example/connect/set-1')
    })

    it('does not run the connector at all without --run', async () => {
      const { api } = recordingApi(ROUTES)
      const { spawner, seen } = spawnerFor('{"outcome":"complete"}')
      const { deps } = harness({ makeApi: () => api, spawner })
      await run([...CONNECT_ARGV], deps)
      expect(seen).toHaveLength(0)
    })
  })

  describe('--status', () => {
    it('reads a setup and reports its state', async () => {
      const { api } = recordingApi({
        'GET /agent-connection-setups/set-1': {
          setup_id: 'set-1', status: 'awaiting_connection', agent_id: null,
          approval_url: SETUP.approval_url, expires_at: SETUP.expires_at,
        },
      })
      const { deps, out } = harness({ makeApi: () => api })
      const code = await run(['agents', 'connect', '--status', 'set-1', '--json'], deps)
      expect(code).toBe(0)
      expect(JSON.parse(out[0])).toMatchObject({ setup_id: 'set-1', status: 'awaiting_connection' })
    })

    it('--wait polls until the setup settles', async () => {
      const states = ['awaiting_connection', 'awaiting_wallet_approval', 'active']
      let i = 0
      const api = {
        calls: [],
        get: async <T,>() => ({
          setup_id: 'set-1',
          status: states[Math.min(i++, states.length - 1)],
          agent_id: i >= 3 ? 'agt-1' : null,
          approval_url: SETUP.approval_url,
          // Far enough ahead that the deadline is never what stops the loop —
          // the settled status has to be.
          expires_at: new Date(Date.now() + 600_000).toISOString(),
        }) as T,
        post: async <T,>() => ({}) as T,
        put: async <T,>() => ({}) as T,
        del: async <T,>() => ({}) as T,
        getText: async () => '',
      } as unknown as CliApi
      const sleep = vi.fn(async () => undefined)
      const { deps, out } = harness({ makeApi: () => api, sleep })
      const code = await run(['agents', 'connect', '--status', 'set-1', '--wait', '--json'], deps)

      expect(code).toBe(0)
      expect(JSON.parse(out[0])).toMatchObject({ status: 'active', agent_id: 'agt-1' })
      expect(sleep).toHaveBeenCalled()
    })

    it('--wait stops at the setup\'s own expiry rather than looping forever', async () => {
      // The loop is bounded by the thing it is watching, not by a local guess.
      const api = {
        calls: [],
        get: async <T,>() => ({
          setup_id: 'set-1', status: 'awaiting_connection', agent_id: null,
          approval_url: SETUP.approval_url,
          expires_at: new Date(Date.now() - 1000).toISOString(),
        }) as T,
        post: async <T,>() => ({}) as T,
        put: async <T,>() => ({}) as T,
        del: async <T,>() => ({}) as T,
        getText: async () => '',
      } as unknown as CliApi
      const sleep = vi.fn(async () => undefined)
      const { deps } = harness({ makeApi: () => api, sleep })
      const code = await run(['agents', 'connect', '--status', 'set-1', '--wait', '--json'], deps)
      expect(code).toBe(0)
      expect(sleep).not.toHaveBeenCalled()
    })
  })
})
