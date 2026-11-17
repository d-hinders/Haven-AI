import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigError, loadConfig, secretValues } from './config.js'
import { startProxy } from './main.js'
import { ProductsFileError } from './products.js'
import { StoreLockedError } from './sqlite-store.js'
import { CDP_SECRET, PAY_TO, UPSTREAM_KEY } from './test-harness.js'

const base = {
  NETWORK: 'eip155:84532',
  PAY_TO,
  OPERATOR_NAME: 'Acme',
  PRODUCTS_FILE: '/tmp/products.json',
  PAYMENTS_DB: '/tmp/payments.sqlite',
  UPSTREAM_BASE_URL: 'https://api.example.com/v3',
  UPSTREAM_API_KEY: UPSTREAM_KEY,
  CDP_API_KEY_ID: 'id',
  CDP_API_KEY_SECRET: CDP_SECRET,
  RPC_URL: 'https://rpc.example.com',
}

function problems(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env)
  } catch (err) {
    if (err instanceof ConfigError) return [...err.problems]
    throw err
  }
  return []
}

describe('configuration (refuses to start when it is incomplete)', () => {
  it('reads a complete environment once into a typed config, with the chain facts from the one network setting', () => {
    const config = loadConfig({ ...base, UPSTREAM_AUTH_HEADER: 'x-api-key', UPSTREAM_AUTH_SCHEME: '', BASE_PATH: '/api/' })
    expect(config.chain).toMatchObject({ chainId: 84532, network: 'eip155:84532', usdcDomainName: 'USDC' })
    expect(config.payTo).toBe(PAY_TO)
    expect(config.basePath).toBe('/api')
    expect(config.upstream).toMatchObject({ authHeader: 'x-api-key', authScheme: '' })
    expect(config.upstreamTimeoutMs).toBe(180_000)
    expect(loadConfig({ ...base, NETWORK: 'eip155:8453' }).chain.chainId).toBe(8453)
    expect(loadConfig(base).upstream.authScheme).toBe('Bearer')
    expect(loadConfig(base).upstream.authHeader).toBe('Authorization')
  })

  it.each(['NETWORK', 'PAY_TO', 'OPERATOR_NAME', 'PRODUCTS_FILE', 'PAYMENTS_DB', 'UPSTREAM_BASE_URL', 'UPSTREAM_API_KEY', 'CDP_API_KEY_ID', 'CDP_API_KEY_SECRET', 'RPC_URL'])(
    'refuses to start without %s',
    (name) => {
      const env: Record<string, string | undefined> = { ...base }
      delete env[name]
      expect(problems(env)).toEqual([`${name} is required`])
      expect(problems({ ...env, [name]: '   ' })).toEqual([`${name} is required`])
    },
  )

  it('names every problem at once and never a secret value', () => {
    let message = ''
    try {
      loadConfig({ NETWORK: 'eip155:1', UPSTREAM_API_KEY: UPSTREAM_KEY, CDP_API_KEY_SECRET: CDP_SECRET })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('PAY_TO is required')
    expect(message).toContain('NETWORK must be one of')
    expect(message).toContain('OPERATOR_NAME is required')
    expect(message).not.toContain(UPSTREAM_KEY)
    expect(message).not.toContain(CDP_SECRET)
  })

  it('has no default network, and refuses a chain it does not know', () => {
    expect(problems({ ...base, NETWORK: 'eip155:100' })[0]).toContain('NETWORK must be one of')
    expect(problems({ ...base, NETWORK: 'base' })[0]).toContain('NETWORK must be one of')
  })

  it('refuses an invalid receiving address, upstream URL, header name, base path and timeouts', () => {
    expect(problems({ ...base, PAY_TO: '0x123' })).toEqual(['PAY_TO must be an EVM address (0x followed by 40 hex characters)'])
    expect(problems({ ...base, UPSTREAM_BASE_URL: 'ftp://x' })).toEqual(['UPSTREAM_BASE_URL must be an http(s) URL'])
    expect(problems({ ...base, UPSTREAM_BASE_URL: 'https://user:pass@x.example' })[0]).toContain('must not carry credentials')
    expect(problems({ ...base, UPSTREAM_AUTH_HEADER: 'bad header' })[0]).toContain('UPSTREAM_AUTH_HEADER')
    expect(problems({ ...base, BASE_PATH: 'api' })[0]).toContain('BASE_PATH')
    expect(problems({ ...base, UPSTREAM_TIMEOUT_MS: '0' })[0]).toContain('UPSTREAM_TIMEOUT_MS')
    expect(problems({ ...base, DIRECTORY_LISTING: 'on' })[0]).toContain('DIRECTORY_LISTING=on')
    expect(problems({ ...base, CLIENT_IP_HEADER: 'bad header' })[0]).toContain('CLIENT_IP_HEADER')
    expect(loadConfig({ ...base, CLIENT_IP_HEADER: 'X-Forwarded-For' }).clientIpHeader).toBe('x-forwarded-for')
    expect(loadConfig(base).clientIpHeader).toBeUndefined()
  })

  it('lists the secrets to keep out of output', () => {
    expect(secretValues(loadConfig(base))).toEqual([UPSTREAM_KEY, CDP_SECRET])
  })
})

describe('starting the proxy', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const env = (): Record<string, string> => {
    const dir = mkdtempSync(join(tmpdir(), 'paywall-start-'))
    dirs.push(dir)
    const products = join(dir, 'products.json')
    writeFileSync(products, JSON.stringify({ version: 1, products: [{ id: 'p', route: 'GET /x', price: '10', description: 'd' }] }))
    return { ...base, PRODUCTS_FILE: products, PAYMENTS_DB: join(dir, 'p.sqlite'), PORT: '0', HOST: '127.0.0.1' }
  }
  const cdp = { facilitator: { verify: async () => ({ isValid: true }), settle: async () => ({ success: false }) } as never, chain: {} as never }

  it('refuses to start without PAY_TO', async () => {
    const e = env()
    delete (e as Record<string, string | undefined>).PAY_TO
    await expect(startProxy(e, { cdp })).rejects.toThrow(/PAY_TO is required/)
  })

  it('refuses to start on an invalid products file', async () => {
    const e = env()
    writeFileSync(e.PRODUCTS_FILE!, '{"version":1,"products":[{"id":"p"}]}')
    await expect(startProxy(e, { cdp })).rejects.toBeInstanceOf(ProductsFileError)
    writeFileSync(e.PRODUCTS_FILE!, 'nope')
    await expect(startProxy(e, { cdp })).rejects.toBeInstanceOf(ProductsFileError)
  })

  it('refuses to start while another proxy holds the payments database, and starts once it is stopped', async () => {
    const e = env()
    const first = await startProxy(e, { cdp, log: () => undefined })
    await expect(startProxy(e, { cdp, log: () => undefined })).rejects.toBeInstanceOf(StoreLockedError)
    await first.close()
    const second = await startProxy(e, { cdp, log: () => undefined })
    await second.close()
  })

  it('reports readiness on /healthz and closes cleanly', async () => {
    const proxy = await startProxy(env(), { cdp, log: () => undefined })
    const res = await fetch(`http://127.0.0.1:${proxy.port}/healthz`)
    expect(res.status).toBe(200)
    await proxy.close()
  })
})

describe('the timing settings stay inside the design bounds (review of #4893)', () => {
  it('refuses an UPSTREAM_TIMEOUT_MS above 180 s and a RESERVATION_DEADLINE_MS below the holder worst case', () => {
    expect(problems({ ...base, UPSTREAM_TIMEOUT_MS: '180001' }).join(' ')).toMatch(/UPSTREAM_TIMEOUT_MS may not exceed/)
    expect(problems({ ...base, RESERVATION_DEADLINE_MS: '109999' }).join(' ')).toMatch(/RESERVATION_DEADLINE_MS may not be below/)
    expect(problems({ ...base, UPSTREAM_TIMEOUT_MS: '60000', RESERVATION_DEADLINE_MS: '150000' })).toEqual([])
  })
})
