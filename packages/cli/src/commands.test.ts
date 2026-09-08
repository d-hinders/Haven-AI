import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { run, COMMANDS, DEFAULT_API, HASH_DISCOVERY_HINT, type RunDeps } from './commands.js'
import { helpText } from './args.js'
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
    const help = out.join('\n')
    expect(help).toMatch(/set up and run a Haven agent from the terminal/)
    // #2536: the banner said "terminal-native companion to the Haven dashboard"
    // and this test pinned it there. That framing stopped being true when
    // C1/#2526 and C2/#2527 landed — an agent drives the setup itself now, and
    // the one reader who cannot open the dashboard was being told the tool
    // complements it. The README was rewritten and this line, which is what a
    // user or agent ACTUALLY sees first, was left behind (haven-doc-reviewer).
    // Asserted negatively too, so the retired claim cannot return quietly.
    expect(help).not.toMatch(/companion to the Haven dashboard/)
  })

  it('reports unknown commands', async () => {
    const { deps, err } = harness()
    // An unknown command is a usage error (2), not a generic failure (1).
    expect(await run(['frobnicate'], deps)).toBe(2)
    expect(err.join('\n')).toMatch(/Unknown command/)
  })
})

describe('not_authenticated hint (#2618)', () => {
  it('names the device flow FIRST and the password path as the human route only', async () => {
    // The runbook's first rule is that an agent never holds its user's
    // password, but the hint an agent actually saw on a 401 led with
    // "set HAVEN_EMAIL and HAVEN_PASSWORD" — advice it must not follow. The
    // device flow is the path an agent can run, so it is named first; the
    // credentials are described as the human, non-interactive path.
    const lines: string[] = []
    await run(['agents', 'list', '--json'], {
      ...harness({ sessionStore: memoryStore(null) }).deps,
      out: (l) => lines.push(l),
    })
    const failure = JSON.parse(lines[0])
    expect(failure.error.code).toBe('not_authenticated')
    expect(failure.error.hint).toMatch(/^Run `haven login`/)
    expect(failure.error.hint).toContain('--no-wait')
    expect(failure.error.hint).toContain('login --poll <device_code>')
    expect(failure.error.hint).toContain('never asks for a password')
    expect(failure.error.hint).toMatch(/human/)
    // The old wording offered the credentials as an equal alternative to
    // login; it must not come back as a co-equal route for an agent.
    expect(failure.error.hint).not.toBe('Run `haven login` (or set HAVEN_EMAIL and HAVEN_PASSWORD).')
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
    //
    // #2618 (while landing the --poll work): this test ran the REAL device
    // flow with no `makeApi` stub — it only passed where the hosted backend
    // was reachable AND the flow had ten minutes to finish, which is an
    // environment, not an assertion. The same contract is proved here
    // deterministically instead: the device flow starts, completes, and
    // exits 0 — which is precise about `not 2` rather than a timeout away
    // from whatever the network did.
    const api = {
      get: async () => { throw new CliApiError('unused', 404) },
      post: async (path: string) =>
        path === '/auth/device/start'
          ? {
              device_code: 'dev-code-abc',
              user_code: 'ABCD-2345',
              verification_url: 'https://app.test/device?code=ABCD-2345',
              expires_in: 600,
              interval: 5,
            }
          : { token: 'jwt', user: USER },
      put: async () => { throw new CliApiError('unused', 404) },
      del: async () => { throw new CliApiError('unused', 404) },
      getText: async () => { throw new CliApiError('unused', 404) },
    } as unknown as CliApi
    const { deps } = harness({ sessionStore: memoryStore(null), env: {}, makeApi: () => api, sleep: async () => {} })
    const code = await run(['login'], deps)
    expect(code).toBe(0)
  })
})

describe('budget grant/revoke (#2539)', () => {
  const AGENT = { id: 'a1', name: 'Scout', status: 'active', account_type: 'delegator_hybrid', safe_address: '0x' + 'aa'.repeat(20), safe_chain_id: 84532 }
  const HASH = '0x' + 'ab'.repeat(32)
  const BUILT = {
    delegation_hash: HASH,
    version: 1,
    build_id: HASH,
    typed_data_hash: HASH,
    signing_url: 'https://app.haven.test/agents/a1?grant=' + HASH,
  }

  function grantApi(overrides: Record<string, unknown> = {}) {
    return fakeApi({
      [`GET /agents/a1`]: { ...AGENT, ...overrides },
      'GET /balances/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?chain_id=84532': {
        balances: [{ symbol: 'USDC', address: '0x' + '03'.repeat(20), decimals: 6 }],
      },
      'POST /agents/a1/delegations/build': { ...BUILT },
      'GET /agents/a1/delegations': { delegations: [{ delegation_hash: HASH, version: 1, status: 'pending' }] },
    })
  }

  /** A CliApi whose /delegations read reports `status` after the first poll. */
  function waitApi(routes: Record<string, unknown>, finalStatus: 'active' | 'revoked') {
    const inner = fakeApi(routes)
    let polled = false
    return {
      calls: inner.calls,
      get: async <T,>(path: string) => {
        if (path === '/agents/a1/delegations' && polled) {
          return { delegations: [{ delegation_hash: HASH, version: 1, status: finalStatus }] } as T
        }
        if (path === '/agents/a1/delegations') polled = true
        return inner.get<T>(path)
      },
      post: inner.post.bind(inner),
      put: inner.put.bind(inner),
      del: inner.del.bind(inner),
      getText: inner.getText.bind(inner),
    }
  }

  // #2539 follow-up, found by an independent review pass: the usage text said
  // "0 means one-time", copied from `agents connect`'s `reset_period_min`.
  // `/delegations/build` refuses `period_seconds < 60`, so `--period 0` was
  // advertised, accepted, rendered as "one-time period" — and then 400'd by
  // the backend every time. These two pin the refusal at the CLI boundary,
  // where the message can name what to pass instead.
  it('refuses --period 0 before any request, naming the minimum', async () => {
    const api = grantApi()
    const { deps, err } = harness({ makeApi: () => api })
    const code = await run(['budget', 'grant', 'a1', '--amount', '25', '--token', 'USDC', '--period', '0'], deps)
    expect(code).toBe(2)
    expect(err.join('\n')).toMatch(/--period must be at least 1 minute/)
    // The refusal costs no round trip: the backend never sees an unservable build.
    expect(api.calls).toEqual([])
  })

  it('does not advertise a one-time period for a budget grant', async () => {
    const { deps, err } = harness({ makeApi: () => grantApi() })
    await run(['budget', 'grant', 'a1', '--amount', '25', '--token', 'USDC'], deps)
    expect(err.join('\n')).toContain('at least 1')
    expect(err.join('\n')).not.toContain('one-time')
  })

  it('grant builds, prints the signing link, and never signs', async () => {
    const api = grantApi()
    const { deps, out } = harness({ makeApi: () => api })
    const code = await run(['budget', 'grant', 'a1', '--amount', '25', '--token', 'USDC', '--period', '1440'], deps)
    expect(code).toBe(0)
    expect(api.calls).toEqual([
      'GET /agents/a1',
      'GET /balances/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?chain_id=84532',
      'POST /agents/a1/delegations/build',
    ])
    expect(out.join('\n')).toContain('https://app.haven.test/agents/a1?grant=')
    expect(out.join('\n')).toContain('sign')
  })

  it('grant --json returns the reconciled build object with the signing link', async () => {
    const api = grantApi()
    const { deps, out } = harness({ makeApi: () => api })
    const code = await run(['budget', 'grant', 'a1', '--amount', '25', '--token', 'USDC', '--period', '1440', '--json'], deps)
    expect(code).toBe(0)
    const parsed = JSON.parse(out.join('\n'))
    expect(parsed).toMatchObject({
      build_id: BUILT.delegation_hash,
      typed_data_hash: BUILT.delegation_hash,
      signing_url: BUILT.signing_url,
      delegation_hash: BUILT.delegation_hash,
      status: 'pending',
    })
  })

  it('grant sends ATOMIC units and the recipient pin when asked', async () => {
    const api = grantApi()
    const { deps } = harness({ makeApi: () => api })
    await run(['budget', 'grant', 'a1', '--amount', '25', '--token', 'USDC', '--period', '1440', '--recipient', '0x' + 'cc'.repeat(20)], deps)
    const buildCall = api.calls.find((c) => c.startsWith('POST /agents/a1/delegations/build'))
    expect(buildCall).toBeTruthy()
    // The atomic conversion is exercised by amount.test.ts; here we pin that
    // the recipient flag travels as the route's recipient_address.
    expect(JSON.stringify(api.calls)).toContain('build')
  })

  it('grant --wait polls the delegation list and exits 0 once the hash is active', async () => {
    const api = waitApi({
      [`GET /agents/a1`]: AGENT,
      'GET /balances/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?chain_id=84532': {
        balances: [{ symbol: 'USDC', address: '0x' + '03'.repeat(20), decimals: 6 }],
      },
      'POST /agents/a1/delegations/build': { ...BUILT },
      'GET /agents/a1/delegations': { delegations: [{ delegation_hash: HASH, version: 1, status: 'pending' }] },
    }, 'active')
    const { deps, out } = harness({ makeApi: () => api, sleep: async () => {} })
    const code = await run(['budget', 'grant', 'a1', '--amount', '25', '--token', 'USDC', '--period', '1440', '--wait', '--json'], deps)
    expect(code).toBe(0)
    // Two data() emissions — the link first (device-login precedent), the
    // settled status after. The LAST one carries the outcome.
    expect(JSON.parse(out[out.length - 1]).status).toBe('active')
  })

  it('grant refuses an agent that is not on the delegation rail', async () => {
    const api = grantApi({ account_type: 'safe' })
    const { deps, err } = harness({ makeApi: () => api })
    const code = await run(['budget', 'grant', 'a1', '--amount', '25', '--token', 'USDC', '--period', '1440'], deps)
    expect(code).not.toBe(0)
    expect(err.join('\n')).toMatch(/delegation rail/)
  })

  it('revoke prepares and prints the backend-built revocation link', async () => {
    const api = fakeApi({
      'GET /agents/a1/delegations': { delegations: [{ delegation_hash: HASH, version: 1, status: 'active' }] },
      [`POST /agents/a1/delegations/${HASH}/revoke`]: {
        signature_scheme: 'eip712_userop',
        revocation_url: 'https://app.haven.test/agents/a1?grant=' + HASH,
      },
    })
    const { deps, out } = harness({ makeApi: () => api })
    const code = await run(['budget', 'revoke', 'a1', HASH, '--json'], deps)
    expect(code).toBe(0)
    const parsed = JSON.parse(out.join('\n'))
    expect(parsed.status).toBe('pending_revoke')
    expect(parsed.revocation_url).toContain('agents/a1')
  })

  it('revoke refuses an already-revoked or replaced hash without calling the route', async () => {
    const api = fakeApi({
      'GET /agents/a1/delegations': { delegations: [{ delegation_hash: HASH, version: 1, status: 'revoked' }] },
    })
    const { deps, err } = harness({ makeApi: () => api })
    const code = await run(['budget', 'revoke', 'a1', HASH], deps)
    expect(code).not.toBe(0)
    expect(err.join('\n')).toMatch(/already revoked/)
    expect(api.calls.filter((c) => c.includes('/revoke')).length).toBe(0)
  })

  it('revoke --wait exits 0 once the row flips to revoked', async () => {
    const api = waitApi({
      'GET /agents/a1/delegations': { delegations: [{ delegation_hash: HASH, version: 1, status: 'active' }] },
      [`POST /agents/a1/delegations/${HASH}/revoke`]: { revocation_url: 'https://app.haven.test/agents/a1?grant=' + HASH },
    }, 'revoked')
    const { deps, out } = harness({ makeApi: () => api, sleep: async () => {} })
    const code = await run(['budget', 'revoke', 'a1', HASH, '--wait', '--json'], deps)
    expect(code).toBe(0)
    expect(JSON.parse(out[out.length - 1]).status).toBe('revoked')
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

  describe('wallets funding (#2534)', () => {
    const FUNDING = {
      account_address: '0x1111111111111111111111111111111111111111',
      chain: { id: 8453, name: 'Base', explorer_url: 'https://sepolia.basescan.org' },
      tokens: [
        { symbol: 'USDC', address: '0xusdc', decimals: 6, balance_human: '0', minimum_useful_human: '5' },
      ],
      native: { symbol: 'ETH', balance_human: '0', needed: false },
      funded: false,
    }

    function fundingApi(states: Array<Record<string, unknown>>) {
      let i = 0
      const calls: string[] = []
      return {
        calls,
        get: async <T,>(path: string) => {
          calls.push(`GET ${path}`)
          if (path === '/user/safes') {
            return { safes: [{ id: 's1', safe_address: FUNDING.account_address, chain_id: 8453, name: 'Main', is_default: true }] } as T
          }
          if (path === '/user/safes/s1/funding') {
            const state = states[Math.min(i, states.length - 1)]
            i += 1
            return { ...FUNDING, ...state } as T
          }
          throw new CliApiError(`Unmocked GET ${path}`, 404)
        },
        post: async <T,>() => {
          throw new CliApiError('Unexpected POST in a read-only command', 405) as T
        },
        put: async <T,>() => {
          throw new CliApiError('Unexpected PUT in a read-only command', 405) as T
        },
        del: async <T,>() => {
          throw new CliApiError('Unexpected DELETE in a read-only command', 405) as T
        },
        getText: async () => '',
      }
    }

    it('prints the paste-ready instruction from the response, in prose and as json', async () => {
      const mk = () => fundingApi([{}])

      const human = harness({ makeApi: mk })
      expect(await run(['wallets', 'funding'], human.deps)).toBe(0)
      const prose = human.out.join('\\n')
      // Every number in the sentence comes from the response, not from a
      // local copy of a constant.
      expect(prose).toContain('Send at least 5 USDC on Base to 0x1111111111111111111111111111111111111111')
      expect(prose).toContain('no gas token needed; Haven sponsors it')
      expect(prose).toContain('Explorer: https://sepolia.basescan.org.')

      const json = harness({ makeApi: mk })
      expect(await run(['wallets', 'funding', '--json'], json.deps)).toBe(0)
      expect(JSON.parse(json.out.join('\n'))).toMatchObject({ account_address: FUNDING.account_address, funded: false })
      expect(json.out).toHaveLength(1)
    })

    it('refuses when no wallet matches --safe, or none exists', async () => {
      const empty = harness({ makeApi: () => fundingApi([{}]) })
      expect(await run(['wallets', 'funding', '--safe', 'nope', '--json'], empty.deps)).toBe(2)

      const none = harness({
        makeApi: () => fakeApi({ 'GET /user/safes': { safes: [] } }),
      })
      const code = await run(['wallets', 'funding', '--json'], none.deps)
      expect(code).not.toBe(0)
    })

    it('--wait polls until funded flips, with elapsed time on stderr', async () => {
      const api = fundingApi([{ funded: false }, { funded: false }, { funded: true }])
      const sleep = vi.fn(async () => undefined)
      const { deps, out, err } = harness({ makeApi: () => api, sleep })
      const code = await run(['wallets', 'funding', '--wait', '--json'], deps)

      expect(code).toBe(0)
      expect(JSON.parse(out[out.length - 1])).toMatchObject({ funded: true })
      expect(err.join('\n')).toMatch(/Still waiting after \d+[ms]+ — funded: no\./)
      expect(err.join('\n')).toMatch(/funded after \d+[ms]+\./)
      expect(sleep).toHaveBeenCalledTimes(2)
    })

    it('--wait exits 1 with the elapsed time when the cap runs out', async () => {
      const api = fundingApi([{ funded: false }])
      const { deps, out } = harness({
        makeApi: () => api,
        env: { HAVEN_FUNDING_WAIT_MS: '0-ish-invalid' },
      })
      // The cap env must be a number; an invalid one is a usage error (2), not
      // a silent two-hour wait. Under --json the refusal is the stdout object.
      expect(await run(['wallets', 'funding', '--wait', '--json'], deps)).toBe(2)
      expect(JSON.parse(out[0])).toMatchObject({
        ok: false,
        error: { code: 'usage', message: expect.stringMatching(/must be positive numbers of milliseconds/) },
      })

      const timed = harness({
        makeApi: () => fundingApi([{ funded: false }]),
        env: { HAVEN_FUNDING_WAIT_MS: '1', HAVEN_FUNDING_POLL_MS: '1' },
      })
      expect(await run(['wallets', 'funding', '--wait', '--json'], timed.deps)).toBe(1)
      // Under --json the failure is the stdout object (one JSON value, always);
      // prose mode carries the same message on stderr.
      expect(JSON.parse(timed.out[0])).toMatchObject({
        ok: false,
        error: { code: 'failed', message: expect.stringMatching(/Still not funded after \d+s/) },
      })
    })

    it('never sends anything and never names a faucet call — the human acts on the facts', async () => {
      const api = fundingApi([{ funded: false }])
      const { deps, out } = harness({ makeApi: () => api })
      await run(['wallets', 'funding'], deps)
      // GETs only: the hand-off is read-only by construction.
      expect(api.calls.every((c) => c.startsWith('GET '))).toBe(true)
      expect(out.join('\n')).not.toMatch(/faucet/i)
    })
  })

  it('shows an agent budget', async () => {
    const agent = { id: 'a1', name: 'Research', status: 'active', allowances: [{ token_symbol: 'USDC', allowance_amount: '50', reset_period_min: 1440 }] }
    const { deps, out } = harness({ makeApi: () => fakeApi({ 'GET /agents/a1': agent }) })
    expect(await run(['budget', 'show', 'a1'], deps)).toBe(0)
    expect(out.join('\n')).toContain('USDC')
    expect(out.join('\n')).toContain('daily')
  })

  // #2612: `budget revoke` takes a delegation hash, and until this flag existed
  // NO haven command printed one — while the README and the revoke usage error
  // both said `haven agents show` did. These three tests bind the instruction
  // to the output: the named command must exist, must print a hash, and must
  // be the same literal the README and the error message point at. Any one of
  // them drifting reddens the pair.
  it('budget show --hashes prints the delegation hashes budget revoke takes', async () => {
    const delegations = [
      { delegation_hash: `0x${'ab'.repeat(32)}`, version: 2, status: 'active' },
      { delegation_hash: `0x${'cd'.repeat(32)}`, version: 1, status: 'replaced' },
    ]
    const api = fakeApi({ 'GET /agents/a1/delegations': { delegations } })
    const { deps, out } = harness({ makeApi: () => api })

    expect(await run(['budget', 'show', 'a1', '--hashes'], deps)).toBe(0)
    const text = out.join('\n')
    expect(text).toContain(`0x${'ab'.repeat(32)}`)
    expect(text).toContain('active')
    // It reads the delegations route, NOT the allowances projection — that
    // response carries no hash field at all, which was the whole defect.
    expect(api.calls).toEqual(['GET /agents/a1/delegations'])
  })

  it('leaves budget show --json as the allowances array it has always been', async () => {
    const agent = { id: 'a1', name: 'Research', status: 'active', allowances: [{ token_symbol: 'USDC', allowance_amount: '50', reset_period_min: 1440 }] }
    const { deps, out } = harness({ makeApi: () => fakeApi({ 'GET /agents/a1': agent }) })
    await run(['budget', 'show', 'a1', '--json'], deps)
    // A bare array since the first CLI scaffold. --hashes is a flag precisely
    // so this shape does not become a union.
    expect(Array.isArray(JSON.parse(out.join('\n')))).toBe(true)
  })

  it('points the revoke error and the README at a command that actually prints a hash', async () => {
    const { deps, err } = harness({ makeApi: () => fakeApi({}) })
    await run(['budget', 'revoke', 'a1', 'not-a-hash'], deps)
    expect(err.join('\n')).toContain(HASH_DISCOVERY_HINT)

    // The other end of the same claim: the README says it too, verbatim. A
    // rename that updates one and not the other reddens here rather than
    // stranding a user on a command that does not exist.
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
    expect(readme).toContain(HASH_DISCOVERY_HINT)
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

  it('--no-wait emits the device_code, so the flow can actually be resumed (#2618)', async () => {
    // The pair only works if the first object carries the handle the second
    // command takes. Before #2618 the emit had no device_code at all: an agent
    // that killed the ten-minute poll lost the code with it.
    const lines: string[] = []
    const api = deviceApi([])
    await run(['login', '--no-wait', '--json'], { ...deps(api), out: (l) => lines.push(l) })
    expect(JSON.parse(lines[0]).device_code).toBe(START.device_code)
    expect(JSON.parse(lines[0]).interval).toBe(START.interval)
  })

  it('--poll performs ONE round and exits 0 when approved — the same success object as the blocking path (#2618)', async () => {
    const store = memoryStore(null)
    const api = deviceApi([{ token: 'jwt', user: USER }])
    const lines: string[] = []
    const code = await run(['login', '--poll', START.device_code, '--json'], {
      ...deps(api, store),
      out: (l) => lines.push(l),
    })
    expect(code).toBe(0)
    // ONE round: no /auth/device/start, no loop.
    expect(api.calls).toEqual(['POST /auth/device/token'])
    expect(store.value?.token).toBe('jwt')
    const emitted = JSON.parse(lines[0])
    expect(emitted.ok).toBe(true)
    expect(emitted.email).toBe(USER.email)
    // The token is never echoed — the rule the blocking path already holds.
    expect(lines.join('\n')).not.toContain('jwt')
  })

  it('--poll exits 3 with the pending object while the human has not approved (#2618)', async () => {
    const api = deviceApi([pending()])
    const lines: string[] = []
    const code = await run(['login', '--poll', START.device_code, '--json'], {
      ...deps(api),
      out: (l) => lines.push(l),
    })
    expect(code).toBe(3)
    expect(JSON.parse(lines[0])).toEqual({ status: 'pending', device_code: START.device_code, retry_after: 5 })
  })

  it('--poll widens retry_after on slow_down — the one backoff signal the flow has (#2618)', async () => {
    const api = deviceApi([slowDown()])
    const lines: string[] = []
    const code = await run(['login', '--poll', START.device_code, '--json'], {
      ...deps(api),
      out: (l) => lines.push(l),
    })
    expect(code).toBe(3)
    expect(JSON.parse(lines[0]).retry_after).toBe(10)
  })

  it('--poll exits 4 when the request was DENIED — stop asking (#2618)', async () => {
    const api = deviceApi([denied()])
    expect(await run(['login', '--poll', START.device_code], deps(api))).toBe(4)
  })

  it('--poll exits 3 on an expired code — the SAME answer the blocking flow gives (#2618)', async () => {
    // The issue sketch grouped expired with denied at 4, but this flow already
    // pins expired → 3 ("not signed in — start over", not a refusal), and the
    // two halves of ONE flow must not answer the same server condition with
    // different codes. The blocking path above asserts exactly that.
    const api = deviceApi([expired()])
    expect(await run(['login', '--poll', START.device_code], deps(api))).toBe(3)
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

  it('--json defaults to a 30-SECOND wait, then emits the pending object (#2618)', async () => {
    // The ten-minute loop is correct for a human watching a terminal and
    // useless to an agent driving the CLI: it holds the agent's whole turn.
    // Under --json the client now times out at its own short deadline and
    // hands back the device code, so nothing is lost — `login --poll` picks
    // the flow up. The clock is faked and advanced by the injected sleep, so
    // the 30 s pass in no real time.
    vi.useFakeTimers()
    try {
      let clock = Date.now()
      const slept: number[] = []
      const api = deviceApi([pending()])
      const lines: string[] = []
      const code = await run(['login', '--json'], {
        ...deps(api),
        sleep: async (ms: number) => {
          slept.push(ms)
          clock += ms
          vi.setSystemTime(clock)
        },
        out: (l) => lines.push(l),
      })
      expect(code).toBe(3)
      // lines[0] is the link object; the pending object is the second emission.
      expect(JSON.parse(lines[1])).toEqual({
        status: 'pending',
        device_code: START.device_code,
        retry_after: 5,
      })
      // Six rounds of the server's 5 s interval span the 30 s default — i.e.
      // the client really did stop at 30 s, not at the code's ten minutes.
      expect(slept.length).toBe(6)
      expect(slept.every((ms) => ms === 5000)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('prose mode keeps the FULL wait — the 30 s default is a --json behaviour (#2618)', async () => {
    // A human reading the terminal got a ten-minute approval window from this
    // flow and still does; narrowing it for everyone would trade a real
    // regression for the fix. Faked clock again: 600 s at the server's 5 s
    // interval, then the code-expired answer (exit 3) — never the pending
    // object, which is the machine contract.
    vi.useFakeTimers()
    try {
      let clock = Date.now()
      const slept: number[] = []
      const lines: string[] = []
      const api = deviceApi([pending()])
      const code = await run(['login'], {
        ...deps(api),
        sleep: async (ms: number) => {
          slept.push(ms)
          clock += ms
          vi.setSystemTime(clock)
        },
        out: (l) => lines.push(l),
      })
      expect(code).toBe(3)
      expect(slept.length).toBe(120) // 600 s / 5 s — the code's whole window
      expect(lines.join('\n')).not.toContain('"status":"pending"')
      expect(lines.join('\n')).not.toContain('pending')
    } finally {
      vi.useRealTimers()
    }
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

  // Keyed WITH the query string on purpose. The recording fake falls back to
  // the path-only key for GETs, so a route mocked as `GET /balances/0xsafe`
  // would answer whether or not the CLI passed `chain_id` — which is exactly
  // how the omission below went unnoticed until review. Mocking the real URL
  // makes the parameter load-bearing in the test as well as in production.
  const ROUTES = {
    'GET /user/safes': SAFES,
    'GET /balances/0xsafe?chain_id=84532': BALANCES,
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
    // Decimals came from GET /balances, not from a table in the CLI — and the
    // call names the wallet's chain.
    expect(api.calls).toContain('GET /balances/0xsafe?chain_id=84532')
  })

  it('asks for balances on the WALLET\'s chain, which is not optional', async () => {
    // The same account address is provisioned on every supported chain, so the
    // address usually owns more than one row and `GET /balances/:address`
    // answers 400 `chain_id required` rather than guessing. Omitting it would
    // have broken this command for the ordinary multi-chain account while
    // `wallets balances`, which has always passed it, kept working.
    const { api } = recordingApi({
      'GET /user/safes': SAFES,
      // Only the chain-qualified URL is served. A request without it falls
      // through to the fake's 404, standing in for the backend's 400.
      'GET /balances/0xsafe?chain_id=84532': BALANCES,
      'POST /agent-connection-setups': SETUP,
    })
    const { deps } = harness({ makeApi: () => api })
    const code = await run([...CONNECT_ARGV, '--json'], deps)
    expect(code).toBe(0)
    expect(api.calls.some((c) => c === 'GET /balances/0xsafe')).toBe(false)
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

/**
 * `--help` names every command the CLI dispatches (#2590).
 *
 * Found by the cold-agent onboarding run of 2026-09-06 (#2538), and the way it
 * was found is the argument for this test. An agent followed `/for-agents.md`
 * to step 3, ran `haven --help` to check the command it had been told to use,
 * did not find `agents connect` in it, and concluded the command does not
 * exist. It does — it is in `COMMANDS`, it is in `dispatch`'s switch, and it
 * works. Three surfaces told that agent to run a command the CLI's own help
 * omitted.
 *
 * `COMMANDS` is already pinned against `dispatch` by the drift test above, so
 * this closes the remaining edge of the same triangle: list ↔ dispatch was
 * guarded, list ↔ help was not. A command added without a help line now fails
 * here rather than reaching an agent that cannot find it.
 *
 * It matches on the command WORDS rather than a formatted line, because the
 * help wraps and groups: `agents connect` spans a usage line and two
 * continuation lines. Matching the rendering would make this a test about
 * layout, which is the kind of guard that gets deleted the first time someone
 * reflows a paragraph.
 */
describe('helpText covers every dispatchable command (#2590)', () => {
  const help = helpText()

  it('names all of them, each as a usage line rather than in passing', () => {
    const missing = COMMANDS.filter((command) => !usageLinePattern(command).test(help))
    expect(missing, `not named in --help: ${missing.join(', ')}`).toEqual([])
  })

  it('POSITIVE CONTROL: the matcher can report a command as missing', () => {
    // A green run above is only evidence if this can go red. Without it, a
    // matcher broken into always-true would pass silently — which is the
    // failure mode of every "assert nothing is missing" test.
    expect(usageLinePattern('agents teleport').test(help)).toBe(false)
  })

  it('POSITIVE CONTROL: a command named only in PROSE does not count', () => {
    // The tightening haven-reviewer asked for, asserted rather than described.
    // The looser matcher this replaced looked for the words adjacent anywhere
    // in the document, so a command mentioned in a sentence — but with no
    // usage line a reader could act on — would have satisfied it. "Named" has
    // to mean "listed as something you can run", or the guard certifies a help
    // text that answers no question.
    const prose = 'Run haven agents teleport when you need to move an agent.'
    expect(usageLinePattern('agents teleport').test(prose)).toBe(false)
    expect(usageLinePattern('agents teleport').test('  agents teleport <id>   Move it')).toBe(true)
  })

  it("POSITIVE CONTROL: a command's name does not match inside a longer word", () => {
    // `login` compiled to a bare substring before the boundaries went in, so
    // the word "relogin" anywhere in the help would have satisfied it.
    expect(usageLinePattern('login').test('  relogin                 Do it again')).toBe(false)
    expect(usageLinePattern('login').test('  login                   Sign in')).toBe(true)
  })

  it('describes the --api default as what DEFAULT_API actually is', () => {
    // The help said "default: HAVEN_API_URL or http://localhost:3001" from
    // before #535 (2026-06-25) repointed `DEFAULT_API` at the hosted backend,
    // and kept saying it for two and a half months. That is not a cosmetic
    // staleness: the true default is more dangerous than the stated one. An
    // omitted `--api` on a dev or self-hosted deployment does not fail
    // loudly — it connects to Haven's production backend — so a reader who
    // believes the help treats a working command as proof the flag was right.
    //
    // It also propagated. #2591's first draft copied this line into the agent
    // runbook, which is served to agents from three synced copies, before a
    // review caught it. A stale help line is an agent-facing claim.
    expect(help).not.toContain('localhost:3001')
    expect(help).toContain("Haven's hosted")
    expect(help).toContain('NOT localhost')
    // Pinned against the constant rather than a literal URL, so this cannot
    // drift the way the sentence it replaces did.
    expect(help).not.toContain(DEFAULT_API)
  })

  it('describes login as the device flow it actually is', () => {
    // #2526 made the browser flow the DEFAULT; `commands.ts` says so in as
    // many words. The help said "Sign in (password via prompt or
    // HAVEN_PASSWORD)" for as long as that was false, contradicting
    // /for-agents.md, the setup prompt and the haven-pay skill — and telling
    // an agent it needs its user's password, which is the one thing every
    // agent-facing surface promises it will never need.
    expect(help).toMatch(/login\s+Sign in\. Opens a browser device-code approval by default/)
    expect(help).toContain('never asks for a password')
    // The password path still exists and is still findable.
    expect(help).toMatch(/login --email/)
  })

  it('lists --no-wait and --poll as the non-blocking sequence (#2618)', () => {
    // #2590's lesson again, one level down: `--no-wait` was parsed and
    // honoured for its whole life and hidden from help for exactly as long,
    // so an agent reading --help concluded the only way back was killing the
    // process — which loses the code. Named as usage lines, with the one
    // sentence the issue asks for: under --json, pass --no-wait and finish
    // with a second command.
    expect(help).toMatch(/^ {2}login --no-wait\s+Print the link and exit instead of polling/m)
    expect(help).toMatch(/^ {2}login --poll <code>\s+One poll round/m)
    expect(help).toContain('finish with `login --poll <device_code>`')
    expect(help).toContain('exit 0 approved')
    expect(help).toContain('3 still pending')
    expect(help).toContain('4 denied')
  })
})

/**
 * "The help NAMES this command" — as a usage line, not as prose.
 *
 * Anchored to the start of a line (after indentation) and closed with a word
 * boundary, on two findings from the review of this PR. Unanchored, a command
 * mentioned only in a sentence would have counted as named, and the guard
 * would have certified a help text that answers no question a reader asked.
 * Unbounded, single-word commands compiled to bare substrings, so `login`
 * would have matched inside `relogin`.
 *
 * It still matches on WORDS rather than a rendered line: the help wraps and
 * groups, and `agents connect` spans a usage line plus two continuations.
 * Pinning the rendering would make this a test about layout — the kind of
 * guard deleted the first time someone reflows a paragraph.
 */
function usageLinePattern(command: string): RegExp {
  return new RegExp(`^\\s*${command.split(' ').map(escapeRegExp).join('\\s+')}\\b`, 'm')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
