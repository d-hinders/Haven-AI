import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { COMMANDS, run, type RunDeps } from './commands.js'
import { CliApiError, type CliApi } from './api.js'
import type { Session, SessionStore } from './session.js'
import { EXIT } from './errors.js'

/**
 * The `--json` machine contract (#2525), asserted over EVERY command rather
 * than the handful a spot check would reach.
 *
 * The property under test is the one an agent actually depends on: whatever
 * happens, `--json` puts exactly one parseable JSON value on stdout and no
 * prose beside it. A refusal is the interesting half — that is where the old
 * CLI wrote a bare sentence to stderr and returned 1, which a caller could
 * neither parse nor branch on.
 */

const SESSION: Session = {
  // A token whose payload decodes to { exp: 1893456000 } → 2030-01-01T00:00:00Z.
  token: `x.${Buffer.from(JSON.stringify({ exp: 1893456000 })).toString('base64url')}.y`,
  apiBaseUrl: 'https://api.test',
  user: { id: 'u1', email: 'ada@example.com', name: 'Ada' },
}

function store(initial: Session | null): SessionStore {
  let value = initial
  return {
    path: '/tmp/session.json',
    load: async () => value,
    save: async (s: Session) => { value = s },
    clear: async () => { value = null },
  }
}

/** An API that refuses everything with one status — the failure under test. */
function refusingApi(status: number, message: string): CliApi {
  const refuse = async () => { throw new CliApiError(message, status) }
  return { get: refuse, post: refuse, put: refuse, del: refuse, getText: refuse }
}

function harness(over: Partial<RunDeps> = {}) {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    deps: {
      sessionStore: store(SESSION),
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      env: {},
      ...over,
    } as RunDeps,
  }
}

/** argv for a command, with placeholder positionals so parsing gets past usage. */
function argvFor(command: string): string[] {
  const parts = command.split(' ')
  const extras: Record<string, string[]> = {
    'agents show': ['a1'], 'agents pause': ['a1'], 'agents resume': ['a1'],
    'agents revoke': ['a1', '--yes'], 'agents rotate-key': ['a1'],
    'agents rename': ['a1', 'New name'], 'budget show': ['a1'],
    // #2527: `agents connect` refuses on its own usage before it ever calls
    // the backend, so it needs a complete line here or this row would assert
    // the usage path rather than the refusal path it is here to cover.
    'agents connect': ['--name', 'demo', '--budget', '25', '--token', 'USDC', '--period', '1440'],
    'wallets rename': ['s1', 'New name'],
    'contacts add': ['Alice', '0xalice'], 'contacts remove': ['c1'],
    login: ['--email', 'ada@example.com'],
  }
  return [...parts, ...(extras[command] ?? []), '--json']
}

function soleJson(out: string[]): unknown {
  expect(out, `expected exactly one stdout write, got ${out.length}`).toHaveLength(1)
  return JSON.parse(out[0])
}

describe('--json contract, over every command', () => {
  it.each([...COMMANDS])('%s: a backend refusal is one JSON object on stdout', async (command) => {
    const { deps, out, err } = harness({
      makeApi: () => refusingApi(403, 'Refused by policy'),
      env: { HAVEN_PASSWORD: 'pw' },
      promptPassword: async () => 'pw',
    })
    const code = await run(argvFor(command), deps)

    // `guide` needs neither a session nor the backend: it is compiled in, and
    // succeeding here is the point of it existing.
    if (command === 'guide') {
      expect(code).toBe(EXIT.ok)
      expect(soleJson(out)).toMatchObject({ ok: true, format: 'markdown' })
      return
    }
    // `logout` is local too — clearing a session cannot be refused.
    if (command === 'logout') {
      expect(code).toBe(EXIT.ok)
      expect(soleJson(out)).toMatchObject({ ok: true, signed_out: true })
      return
    }

    expect(code).toBe(EXIT.refused)
    expect(soleJson(out)).toEqual({
      ok: false,
      error: { code: 'refused', message: 'Refused by policy' },
    })
    // Prose never contaminates stdout under --json; stderr is where it goes.
    expect(out.join('')).not.toMatch(/[A-Za-z]{3,}\s+[A-Za-z]{3,}\.$/m)
  })

  it.each([...COMMANDS].filter((c) => c !== 'guide' && c !== 'logout' && c !== 'login'))(
    '%s: no session exits 3 with a not_authenticated object',
    async (command) => {
      const { deps, out } = harness({ sessionStore: store(null) })
      const code = await run(argvFor(command), deps)
      expect(code).toBe(EXIT.notAuthenticated)
      expect(soleJson(out)).toMatchObject({ ok: false, error: { code: 'not_authenticated' } })
    },
  )

  it('a network failure exits 5 and says so', async () => {
    const { deps, out } = harness({ makeApi: () => refusingApi(0, 'Could not reach Haven at https://api.test') })
    expect(await run(['agents', 'list', '--json'], deps)).toBe(EXIT.network)
    expect(soleJson(out)).toMatchObject({ ok: false, error: { code: 'network' } })
  })

  it('a usage error exits 2 — unknown command, bad flag and missing argument alike', async () => {
    for (const argv of [
      ['frobnicate', '--json'],
      ['agents', 'list', '--nope', '--json'],
      ['agents', 'show', '--json'],
      ['agents', 'revoke', 'a1', '--json'],
    ]) {
      const { deps, out } = harness()
      expect(await run(argv, deps), argv.join(' ')).toBe(EXIT.usage)
      expect(soleJson(out), argv.join(' ')).toMatchObject({ ok: false, error: { code: 'usage' } })
    }
  })

  it('parses --json even when the argv it appears in is invalid', () => {
    // The flag is read before parseArgs runs. Without that, the one refusal a
    // caller is most likely to hit — a malformed command line — would come
    // back as prose, and only that one.
    const { deps, out } = harness()
    return run(['--not-a-flag', '--json'], deps).then((code) => {
      expect(code).toBe(EXIT.usage)
      expect(soleJson(out)).toMatchObject({ ok: false, error: { code: 'usage' } })
    })
  })

  it('COMMANDS matches the commands dispatch actually answers', async () => {
    // The list drives the tests above, so a command missing from it would be
    // silently uncovered. Rather than trust the list, this reads the switch's
    // own case labels — the thing that decides at runtime.
    const source = readFileSync(join(__dirname, 'commands.ts'), 'utf8')
    const dispatched = [...source.matchAll(/^\s{4}case '([^']+)':/gm)].map((m) => m[1]).sort()
    expect(dispatched).toEqual([...COMMANDS].sort())
    // Positive control: the matcher can find something.
    expect(dispatched).toContain('agents list')
  })
})

describe('--json contract, success paths', () => {
  // The refusal table above proves the failure half over every command. This
  // proves the SUCCESS half over the commands that print something other than a
  // plain payload — the export writers and the one command whose payload is a
  // secret — because those are the paths that could put a second thing on
  // stdout (haven-reviewer, finding 4 @ 2d43d255). Without these, the shared
  // `data()`/`text()` plumbing is trusted rather than asserted.
  const ROUTES: Record<string, unknown> = {
    'GET /user/safes': { safes: [{ id: 's1', safe_address: '0xabc', chain_id: 8453, name: 'Ops', is_default: true }] },
    'GET /balances/0xabc': { balances: [{ symbol: 'USDC', formatted: '10.00', balance: '10000000' }] },
    'GET /agents': { agents: [{ id: 'a1', name: 'Payer', status: 'active' }] },
    'GET /agents/a1': { id: 'a1', name: 'Payer', status: 'active', allowances: [] },
    'GET /transactions': { transactions: [] },
    'GET /catalog': { entries: [] },
    'GET /contacts': { contacts: [] },
    'GET /accounting/export': 'the SIE body',
    'POST /agents/a1/rotate-key': { api_key: 'sk_agent_NEWKEY_NEVERREAL', api_key_prefix: 'sk_agent_' },
    'POST /agents/a1/pause': {},
    'POST /agents/a1/revoke': {},
    'PUT /agents/a1': {},
    'PUT /user/safes/s1': {},
    'POST /contacts': { id: 'c1', name: 'Alice', address: '0xalice' },
    'DELETE /contacts/c1': {},
  }
  function stubApi(): CliApi {
    const resolve = (method: string, path: string) => {
      const hit = ROUTES[`${method} ${path}`] ?? ROUTES[`${method} ${path.split('?')[0]}`]
      if (hit === undefined) throw new CliApiError(`Unmocked ${method} ${path}`, 404)
      return hit
    }
    return {
      get: async <T,>(p: string) => resolve('GET', p) as T,
      post: async <T,>(p: string) => resolve('POST', p) as T,
      put: async <T,>(p: string) => resolve('PUT', p) as T,
      del: async <T,>(p: string) => resolve('DELETE', p) as T,
      getText: async (p: string) => resolve('GET', p) as string,
    }
  }

  it.each([
    ['wallets list', ['wallets', 'list']],
    ['wallets balances', ['wallets', 'balances']],
    ['agents list', ['agents', 'list']],
    ['agents show', ['agents', 'show', 'a1']],
    ['budget show', ['budget', 'show', 'a1']],
    ['activity list', ['activity', 'list']],
    ['activity export (csv)', ['activity', 'export']],
    ['activity export (sie)', ['activity', 'export', '--format', 'sie']],
    ['agents rotate-key', ['agents', 'rotate-key', 'a1']],
    ['agents pause', ['agents', 'pause', 'a1']],
    ['agents revoke', ['agents', 'revoke', 'a1', '--yes']],
    ['agents rename', ['agents', 'rename', 'a1', 'New']],
    ['wallets rename', ['wallets', 'rename', 's1', 'Ops']],
    ['catalog list', ['catalog', 'list']],
    ['contacts list', ['contacts', 'list']],
    ['contacts add', ['contacts', 'add', 'Alice', '0xalice']],
    ['contacts remove', ['contacts', 'remove', 'c1']],
  ])('%s: success is one JSON value on stdout', async (_label, argv) => {
    const { deps, out } = harness({ makeApi: () => stubApi() })
    expect(await run([...argv, '--json'], deps)).toBe(EXIT.ok)
    expect(() => soleJson(out)).not.toThrow()
  })

  it('the export writers keep the file body inside the one object', async () => {
    for (const [argv, format] of [
      [['activity', 'export', '--json'], 'csv'],
      [['activity', 'export', '--format', 'sie', '--json'], 'sie'],
    ] as const) {
      const { deps, out } = harness({ makeApi: () => stubApi() })
      await run([...argv], deps)
      expect(soleJson(out)).toMatchObject({ ok: true, format })
      expect(soleJson(out)).toHaveProperty('content')
    }
  })

  it('rotate-key puts the key in the object and the warning on stderr', async () => {
    const { deps, out, err } = harness({ makeApi: () => stubApi() })
    await run(['agents', 'rotate-key', 'a1', '--json'], deps)
    // The key is the payload, so it is on stdout by design — but as a field of
    // the single object, with the sentence about it out of the way.
    expect(soleJson(out)).toMatchObject({ api_key: 'sk_agent_NEWKEY_NEVERREAL' })
    expect(err.join('\n')).toContain('shown once')
    expect(err.join('\n')).not.toContain('sk_agent_NEWKEY_NEVERREAL')
  })
})

describe('secret hygiene', () => {
  it('login never echoes the password or the token, in either mode', async () => {
    const api: CliApi = {
      get: async () => ({}) as never,
      post: async () => ({ token: SESSION.token, user: SESSION.user }) as never,
      put: async () => ({}) as never,
      del: async () => ({}) as never,
      getText: async () => '',
    }
    for (const json of [true, false]) {
      const { deps, out, err } = harness({
        makeApi: () => api,
        sessionStore: store(null),
        env: { HAVEN_PASSWORD: 'hunter2-NEVERREAL' },
      })
      const argv = ['login', '--email', 'ada@example.com', ...(json ? ['--json'] : [])]
      expect(await run(argv, deps)).toBe(EXIT.ok)
      const everything = [...out, ...err].join('\n')
      expect(everything).not.toContain('hunter2-NEVERREAL')
      expect(everything).not.toContain(SESSION.token)
    }
  })

  it('login --json reports ok, email and expires_at', async () => {
    const { deps, out } = harness({
      makeApi: () => ({
        get: async () => ({}) as never,
        post: async () => ({ token: SESSION.token, user: SESSION.user }) as never,
        put: async () => ({}) as never,
        del: async () => ({}) as never,
        getText: async () => '',
      }),
      sessionStore: store(null),
      env: { HAVEN_PASSWORD: 'pw' },
    })
    await run(['login', '--email', 'ada@example.com', '--json'], deps)
    expect(soleJson(out)).toMatchObject({
      ok: true,
      email: 'ada@example.com',
      expires_at: '2030-01-01T00:00:00.000Z',
    })
  })

  it('whoami --json carries the four fields the contract names', async () => {
    const { deps, out } = harness({
      makeApi: () => ({
        get: async () => SESSION.user as never,
        post: async () => ({}) as never,
        put: async () => ({}) as never,
        del: async () => ({}) as never,
        getText: async () => '',
      }),
    })
    expect(await run(['whoami', '--json'], deps)).toBe(EXIT.ok)
    expect(soleJson(out)).toMatchObject({
      id: 'u1',
      email: 'ada@example.com',
      expires_at: '2030-01-01T00:00:00.000Z',
      api_url: 'https://api.test',
    })
  })
})
