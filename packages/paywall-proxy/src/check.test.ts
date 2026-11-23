/**
 * The pre-flight check (#5008).
 *
 * Each test injects ONE fault and asserts that its own line says `fail`, that
 * the exit code is non-zero, and that the other checks still ran and printed.
 * The network collaborators are injected — the chain-id read, the facilitator
 * and the Sales probe's `fetch` — so nothing here reaches a chain, Coinbase or
 * Haven.
 *
 * Two properties are asserted across every case: no line carries a secret
 * (`UPSTREAM_API_KEY`, `CDP_API_KEY_SECRET`, `HAVEN_MERCHANT_KEY`, or the
 * configured `RPC_URL` beyond its host), and `check` makes no call that can
 * move money — no `verify`, no `settle`, no sale record.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCdpFacilitator, type CdpFacilitator } from '@haven_ai/merchant-payments'
import {
  CHECK_NAMES,
  formatCheckLine,
  formatCheckReport,
  runCheckCommand,
  runChecks,
  type CheckDeps,
  type CheckLine,
} from './check.js'
import { openSqliteConsumedPaymentStore } from './sqlite-store.js'
import { CDP_SECRET, PAY_TO, SALES_KEY, UPSTREAM_KEY } from './test-harness.js'

/** A key in the RPC URL's path: the check must print the host and nothing else. */
const RPC_PATH_SECRET = 'RPC-PATH-SECRET-0123456789'
const RPC_URL = `https://rpc.example.com/v2/${RPC_PATH_SECRET}`
const RPC_HOST = 'rpc.example.com'
const HAVEN_URL = 'https://api.haven.example'

const dirs: string[] = []

function workspace(overrides: Record<string, string | undefined> = {}): {
  dir: string
  env: Record<string, string | undefined>
} {
  const dir = mkdtempSync(join(tmpdir(), 'check-'))
  dirs.push(dir)
  const productsFile = join(dir, 'products.json')
  writeFileSync(
    productsFile,
    JSON.stringify({
      version: 1,
      products: [
        { id: 'lookup', route: 'GET /v1/lookup', price: '20000', description: 'One lookup.' },
        { id: 'chat', route: 'POST /v1/chat', price: '10000', description: 'One chat call.' },
      ],
    }),
  )
  const env: Record<string, string | undefined> = {
    NETWORK: 'eip155:84532',
    PAY_TO,
    OPERATOR_NAME: 'Acme',
    PRODUCTS_FILE: productsFile,
    PAYMENTS_DB: join(dir, 'payments.sqlite'),
    UPSTREAM_BASE_URL: 'https://api.example.com',
    UPSTREAM_API_KEY: UPSTREAM_KEY,
    CDP_API_KEY_ID: 'cdp-key-id',
    CDP_API_KEY_SECRET: CDP_SECRET,
    RPC_URL,
    HAVEN_MERCHANT_KEY: SALES_KEY,
    HAVEN_SALES_URL: HAVEN_URL,
    ...overrides,
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key]
  }
  return { dir, env }
}

/** A facilitator that answers `getSupported` and refuses to verify or settle. */
function facilitator(overrides: Partial<CdpFacilitator> = {}): CdpFacilitator {
  return {
    verify: async () => {
      throw new Error('check must never verify a payment')
    },
    settle: async () => {
      throw new Error('check must never settle a payment')
    },
    getSupported: async () => ({
      kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }],
      extensions: [],
      signers: {},
    }),
    ...overrides,
  }
}

interface SeenProbe {
  url: string
  method: string
  body: string | undefined
  authorization: string | undefined
}

/** A `fetch` that answers one status and records what the Sales probe sent. */
function salesFetch(status: number, body: unknown = {}): { fetch: typeof fetch; seen: SeenProbe[] } {
  const seen: SeenProbe[] = []
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    seen.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
      authorization: headers.get('authorization') ?? undefined,
    })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { fetch: impl, seen }
}

/** The default deps: a Base Sepolia chain id, a working facilitator, a 400 `invalid_request`. */
function deps(overrides: CheckDeps = {}): CheckDeps {
  return {
    readChainId: async () => 84532,
    createFacilitator: async () => facilitator(),
    fetch: salesFetch(400, { error: 'invalid_request', error_code: 'invalid_request' }).fetch,
    ...overrides,
  }
}

async function run(env: Record<string, string | undefined>, overrides: CheckDeps = {}): Promise<{
  lines: readonly CheckLine[]
  printed: string[]
  exitCode: number
}> {
  const printed: string[] = []
  const report = await runChecks(env, deps(overrides))
  printed.push(...formatCheckReport(report))
  return { lines: report.lines, printed, exitCode: report.exitCode }
}

function line(lines: readonly CheckLine[], name: string): CheckLine {
  const found = lines.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`no "${name}" line in ${lines.map((l) => l.name).join(', ')}`)
  return found
}

/** Every line, plus the details printed under them, as one blob. */
function blob(lines: readonly CheckLine[]): string {
  return lines.map((l) => `${formatCheckLine(l)}\n${(l.details ?? []).join('\n')}`).join('\n')
}

afterEach(() => {
  vi.unstubAllGlobals()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the pre-flight check (#5008)', () => {
  it('prints one ok line per check for a complete, valid Base Sepolia configuration, and exits 0', async () => {
    const { env } = workspace()
    const { lines, printed, exitCode } = await run(env)

    expect(lines.map((l) => l.name)).toEqual([...CHECK_NAMES])
    for (const name of CHECK_NAMES) expect(line(lines, name).status, name).toBe('ok')
    expect(exitCode).toBe(0)
    expect(printed).toHaveLength(CHECK_NAMES.length)
    expect(printed[0]).toBe('settings: ok')
    expect(printed[1]).toBe('products: ok (2 products: lookup, chat)')
    expect(printed[2]).toBe(`rpc: ok (eip155:84532 at ${RPC_HOST})`)
    expect(printed[3]).toBe('coinbase key: ok (exact on eip155:84532)')
    expect(printed[4]).toBe('sales key: ok (the key was accepted)')
    expect(printed[5]).toBe(`store: ok (will be created at ${env.PAYMENTS_DB})`)
    expect(printed[6]).toBe(`outbox: ok (will be created at ${join(env.PAYMENTS_DB!.replace(/payments\.sqlite$/, ''), 'sales-outbox.jsonl')})`)
  })

  it('creates no ledger: a missing PAYMENTS_DB stays missing', async () => {
    const { env } = workspace()
    const { existsSync } = await import('node:fs')
    expect(existsSync(env.PAYMENTS_DB!)).toBe(false)
    await run(env)
    expect(existsSync(env.PAYMENTS_DB!)).toBe(false)
  })

  it('never prints a secret, and never the RPC URL beyond its host', async () => {
    const { env } = workspace()
    const { printed } = await run(env)
    const text = printed.join('\n')
    for (const secret of [UPSTREAM_KEY, CDP_SECRET, SALES_KEY, RPC_PATH_SECRET]) {
      expect(text).not.toContain(secret)
    }
    expect(text).toContain(RPC_HOST)
  })

  it('makes no call that can move money: no verify, no settle, and the Sales probe sends an empty body', async () => {
    const { env } = workspace()
    const verify = vi.fn(async () => {
      throw new Error('check must never verify a payment')
    })
    const settle = vi.fn(async () => {
      throw new Error('check must never settle a payment')
    })
    const probe = salesFetch(400, { error_code: 'invalid_request' })
    await run(env, {
      createFacilitator: async () => facilitator({ verify, settle }),
      fetch: probe.fetch,
    })
    expect(verify).not.toHaveBeenCalled()
    expect(settle).not.toHaveBeenCalled()
    expect(probe.seen).toHaveLength(1)
    expect(probe.seen[0]).toMatchObject({
      url: `${HAVEN_URL}/merchant/sales`,
      method: 'POST',
      body: '{}',
      authorization: `Bearer ${SALES_KEY}`,
    })
  })

  it('a missing setting prints its problem and skips checks 3-6, while the products check still runs', async () => {
    const { env } = workspace({ NETWORK: undefined })
    const { lines, exitCode } = await run(env)

    const settings = line(lines, 'settings')
    expect(settings.status).toBe('fail')
    expect(settings.details).toContain('NETWORK is required')
    expect(line(lines, 'products').status).toBe('ok')
    for (const name of ['rpc', 'coinbase key', 'sales key', 'store', 'outbox']) {
      expect(line(lines, name), name).toMatchObject({ status: 'skipped', reason: 'settings invalid' })
    }
    expect(exitCode).toBe(1)
  })

  it('Base mainnet fails the settings line with the #5061 refusal and skips checks 3-6', async () => {
    const { env } = workspace({ NETWORK: 'eip155:8453' })
    const { lines, exitCode } = await run(env)

    const settings = line(lines, 'settings')
    expect(settings.status).toBe('fail')
    expect(settings.details).toEqual([
      'NETWORK eip155:8453 (Base mainnet) is not open: the merchant kit runs on Base Sepolia only until the regulatory review in #4888 allows mainnet',
    ])
    expect(line(lines, 'products').status).toBe('ok')
    for (const name of ['rpc', 'coinbase key', 'sales key', 'store', 'outbox']) {
      expect(line(lines, name), name).toMatchObject({ status: 'skipped', reason: 'settings invalid' })
    }
    expect(exitCode).toBe(1)
  })

  it('a malformed products file fails its own line and the other checks still run', async () => {
    const { dir, env } = workspace()
    writeFileSync(join(dir, 'products.json'), '{ not json')
    const { lines, exitCode } = await run(env)

    const products = line(lines, 'products')
    expect(products.status).toBe('fail')
    expect(products.details).toContain('the file is not valid JSON')
    expect(line(lines, 'settings').status).toBe('ok')
    expect(line(lines, 'rpc').status).toBe('ok')
    expect(line(lines, 'store').status).toBe('ok')
    expect(exitCode).toBe(1)
  })

  it('an RPC on the wrong chain fails, naming both chain ids', async () => {
    const { env } = workspace()
    const { lines, exitCode } = await run(env, { readChainId: async () => 8453 })

    expect(line(lines, 'rpc')).toMatchObject({
      status: 'fail',
      reason: `the node at ${RPC_HOST} reports chain 8453, not 84532`,
    })
    expect(line(lines, 'coinbase key').status).toBe('ok')
    expect(exitCode).toBe(1)
  })

  it('an unreachable RPC fails naming the host only, never the URL', async () => {
    const { env } = workspace()
    const { lines, printed, exitCode } = await run(env, {
      readChainId: async () => {
        throw new Error(`fetch failed for ${RPC_URL}`)
      },
    })

    expect(line(lines, 'rpc')).toMatchObject({
      status: 'fail',
      reason: `the node at ${RPC_HOST} did not answer (Error)`,
    })
    expect(printed.join('\n')).not.toContain(RPC_PATH_SECRET)
    expect(exitCode).toBe(1)
  })

  it('a malformed Coinbase secret fails locally, with no network call', async () => {
    const { env } = workspace({ CDP_API_KEY_SECRET: 'not-a-key' })
    const fetchSpy = vi.fn(async () => {
      throw new Error('check must not reach the network for a malformed secret')
    })
    vi.stubGlobal('fetch', fetchSpy)

    const { lines, exitCode } = await run(env, {
      // The real factory: the throw comes from JWT signing inside getSupported.
      createFacilitator: (credentials) => createCdpFacilitator(credentials, { timeoutMs: 5_000 }),
    })

    expect(line(lines, 'coinbase key')).toMatchObject({
      status: 'fail',
      reason: 'CDP_API_KEY_SECRET is not a key the Coinbase client can sign with',
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(line(lines, 'rpc').status).toBe('ok')
    expect(exitCode).toBe(1)
  })

  it('a Coinbase key the facilitator refuses fails with the status, never the message', async () => {
    const { env } = workspace()
    const { lines, printed, exitCode } = await run(env, {
      createFacilitator: async () =>
        facilitator({
          getSupported: async () => {
            throw new Error('Facilitator getSupported failed (401): Unauthorized')
          },
        }),
    })

    expect(line(lines, 'coinbase key')).toMatchObject({
      status: 'fail',
      reason: 'the facilitator refused the key (401)',
    })
    expect(printed.join('\n')).not.toContain('Unauthorized')
    expect(exitCode).toBe(1)
  })

  it('a facilitator that does not list exact on the configured network fails', async () => {
    const { env } = workspace()
    const { lines, exitCode } = await run(env, {
      createFacilitator: async () =>
        facilitator({
          getSupported: async () => ({
            kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }],
            extensions: [],
            signers: {},
          }),
        }),
    })

    expect(line(lines, 'coinbase key')).toMatchObject({
      status: 'fail',
      reason: 'the facilitator does not list exact on eip155:84532',
    })
    expect(exitCode).toBe(1)
  })

  it('a facilitator client without getSupported reports not verified, not ok', async () => {
    const { env } = workspace()
    const { lines, exitCode } = await run(env, {
      createFacilitator: async () => ({ verify: facilitator().verify, settle: facilitator().settle }),
    })

    expect(line(lines, 'coinbase key').status).toBe('not verified')
    expect(line(lines, 'coinbase key').reason).toContain('no getSupported')
    expect(exitCode).toBe(0)
  })

  it('a Sales key answered 401 fails', async () => {
    const { env } = workspace()
    const { lines, exitCode } = await run(env, { fetch: salesFetch(401, { error_code: 'invalid_key' }).fetch })

    expect(line(lines, 'sales key')).toMatchObject({
      status: 'fail',
      reason: 'the key is missing, wrong or revoked, or its account is no longer a merchant account',
    })
    expect(line(lines, 'store').status).toBe('ok')
    expect(exitCode).toBe(1)
  })

  it('Sales off for the account (403) fails', async () => {
    const { env } = workspace()
    const { lines, exitCode } = await run(env, {
      fetch: salesFetch(403, { error_code: 'MERCHANT_SERVICES_OFF' }).fetch,
    })

    expect(line(lines, 'sales key')).toMatchObject({ status: 'fail', reason: 'Sales is off for the account' })
    expect(exitCode).toBe(1)
  })

  it('a 400 without Haven\'s error_code means HAVEN_SALES_URL is not Haven\'s API origin', async () => {
    const { env } = workspace()
    const { lines, exitCode } = await run(env, { fetch: salesFetch(400, { message: 'nope' }).fetch })

    expect(line(lines, 'sales key')).toMatchObject({
      status: 'fail',
      reason: "HAVEN_SALES_URL is not Haven's API origin (400 without Haven's error_code)",
    })
    expect(exitCode).toBe(1)
  })

  it('a 404 or an HTML answer means HAVEN_SALES_URL is not Haven\'s API origin', async () => {
    const { env } = workspace()
    const notFound = await run(env, { fetch: salesFetch(404, {}).fetch })
    expect(line(notFound.lines, 'sales key').status).toBe('fail')
    expect(line(notFound.lines, 'sales key').reason).toContain("not Haven's API origin")

    const html = (async () =>
      new Response('<html>nope</html>', { status: 400, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch
    const htmlRun = await run(env, { fetch: html })
    expect(line(htmlRun.lines, 'sales key').status).toBe('fail')
    expect(line(htmlRun.lines, 'sales key').reason).toContain("not Haven's API origin")
  })

  it('a 400 with invalid_record is an accepted key: the handler refused the empty body', async () => {
    const { env } = workspace()
    const { lines, exitCode } = await run(env, { fetch: salesFetch(400, { error_code: 'invalid_record' }).fetch })

    expect(line(lines, 'sales key')).toMatchObject({ status: 'ok', reason: 'the key was accepted' })
    expect(exitCode).toBe(0)
  })

  it('a 429 is reported as not verified (rate limited), not as a failure', async () => {
    const { env } = workspace()
    const { lines, exitCode } = await run(env, { fetch: salesFetch(429, {}).fetch })

    expect(line(lines, 'sales key')).toMatchObject({ status: 'not verified', reason: 'rate limited' })
    expect(exitCode).toBe(0)
  })

  it('skips the Sales key and the outbox when HAVEN_MERCHANT_KEY is unset', async () => {
    const { env } = workspace({ HAVEN_MERCHANT_KEY: undefined })
    const { lines, exitCode } = await run(env)

    expect(line(lines, 'sales key')).toMatchObject({
      status: 'skipped',
      reason: 'HAVEN_MERCHANT_KEY is not set',
    })
    expect(line(lines, 'outbox')).toMatchObject({ status: 'skipped', reason: 'HAVEN_MERCHANT_KEY is not set' })
    expect(exitCode).toBe(0)
  })

  it('a store held by another process fails with the one-process rule', async () => {
    const { env } = workspace()
    const held = openSqliteConsumedPaymentStore(env.PAYMENTS_DB!, { takeoverAfterMs: 1 })
    try {
      const { lines, exitCode } = await run(env)
      expect(line(lines, 'store')).toMatchObject({
        status: 'fail',
        reason: 'in use by a running proxy; stop it first',
      })
      expect(line(lines, 'settings').status).toBe('ok')
      expect(line(lines, 'rpc').status).toBe('ok')
      expect(exitCode).toBe(1)
    } finally {
      held.close()
    }
  })

  it('a store file it can lock reports ok, and the outbox depth is read without replaying it', async () => {
    const { dir, env } = workspace()
    const store = openSqliteConsumedPaymentStore(env.PAYMENTS_DB!, { takeoverAfterMs: 1 })
    store.close()

    const outboxPath = join(dir, 'sales-outbox.jsonl')
    writeFileSync(
      outboxPath,
      `${JSON.stringify({
        id: 'a1',
        key: 'k1',
        record: { tx_hash: `0x${'1'.repeat(64)}`, merchant_reference: 'sale_1', product_id: 'lookup' },
        attempts: 0,
        queued_at: '2026-11-20T10:00:00.000Z',
        last_status: 503,
        last_code: null,
      })}\n`,
    )

    const { lines, exitCode } = await run(env)
    expect(line(lines, 'store')).toMatchObject({
      status: 'ok',
      reason: `the file at ${env.PAYMENTS_DB} can take the exclusive lock`,
    })
    expect(line(lines, 'outbox')).toMatchObject({ status: 'ok', reason: `1 record waiting at ${outboxPath}` })
    expect(exitCode).toBe(0)
  })

  it('a PAYMENTS_DB directory that does not exist fails the store and the outbox', async () => {
    const { dir, env } = workspace({ PAYMENTS_DB: join(tmpdir(), 'check-no-such-dir-5008', 'payments.sqlite') })
    void dir
    const { lines, exitCode } = await run(env)

    expect(line(lines, 'store').status).toBe('fail')
    expect(line(lines, 'store').reason).toContain('does not exist')
    expect(line(lines, 'outbox').status).toBe('fail')
    expect(exitCode).toBe(1)
  })

  it('refuses an argument it does not take, with exit 2', async () => {
    const { env } = workspace()
    const printed: string[] = []
    const code = await runCheckCommand(['--nope'], env, { ...deps(), print: (line) => printed.push(line) })
    expect(code).toBe(2)
    expect(printed).toHaveLength(0)
  })

  it('prints the details of a failing check under its line', async () => {
    const { env } = workspace({ NETWORK: undefined, PAY_TO: undefined })
    const printed: string[] = []
    const code = await runCheckCommand([], env, { ...deps(), print: (line) => printed.push(line) })

    expect(code).toBe(1)
    expect(printed[0]).toBe('settings: fail (2 problems)')
    expect(printed[1]).toBe('  NETWORK is required')
    expect(printed[2]).toBe('  PAY_TO is required')
    expect(printed).toContain('rpc: skipped (settings invalid)')
  })

  it('formats a line with and without a reason', () => {
    expect(formatCheckLine({ name: 'settings', status: 'ok', reason: '' })).toBe('settings: ok')
    expect(formatCheckLine({ name: 'rpc', status: 'fail', reason: 'wrong chain' })).toBe('rpc: fail (wrong chain)')
  })

  it('never prints a secret in any failing case either', async () => {
    const { env } = workspace({ NETWORK: undefined })
    const { printed } = await run(env)
    const text = printed.join('\n')
    for (const secret of [UPSTREAM_KEY, CDP_SECRET, SALES_KEY, RPC_PATH_SECRET]) {
      expect(text).not.toContain(secret)
    }
  })
})
