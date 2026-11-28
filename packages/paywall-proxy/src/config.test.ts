import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigError, loadConfig, secretValues } from './config.js'
import { startProxy } from './main.js'
import { ProductsFileError } from './products.js'
import { StoreLockedError } from './sqlite-store.js'
import { CDP_SECRET, PAY_TO, SALES_KEY, UPSTREAM_KEY } from './test-harness.js'

const base = {
  NETWORK: 'eip155:84532',
  PAY_TO,
  OPERATOR_NAME: 'Acme',
  ENDPOINT_NAME: 'Acme inference',
  ENDPOINT_DESCRIPTION: 'Acme inference, paid per call.',
  PRODUCTS_FILE: '/tmp/products.json',
  PAYMENTS_DB: '/tmp/payments.sqlite',
  UPSTREAM_BASE_URL: 'https://api.example.com/v3',
  UPSTREAM_API_KEY: UPSTREAM_KEY,
  CDP_API_KEY_ID: 'id',
  CDP_API_KEY_SECRET: CDP_SECRET,
  RPC_URL: 'https://rpc.example.com',
}

/**
 * The refusal #5061 adds, pinned word for word: a builder who changes the
 * wording turns this red, and so does one who removes the refusal without
 * meaning to. Removing it is the go-live step once #4888 allows mainnet.
 */
const MAINNET_REFUSAL =
  'NETWORK eip155:8453 (Base mainnet) is not open: the merchant kit runs on Base Sepolia only until the regulatory review in #4888 allows mainnet'

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
    expect(loadConfig(base).upstream.authScheme).toBe('Bearer')
    expect(loadConfig(base).upstream.authHeader).toBe('Authorization')
    expect(loadConfig(base).upstream.auth).toBe('key')
  })

  // #5060: an upstream with no key is an explicit opt-out, not an optional key.
  it('UPSTREAM_AUTH=none starts without a key, and the key is not a secret to redact', () => {
    const env: Record<string, string | undefined> = { ...base, UPSTREAM_AUTH: 'none' }
    delete env.UPSTREAM_API_KEY
    const config = loadConfig(env)
    expect(config.upstream).toMatchObject({ auth: 'none', apiKey: '' })
    expect(secretValues(config)).toEqual([CDP_SECRET])
  })

  it('UPSTREAM_AUTH=none refuses the key settings it would ignore', () => {
    expect(problems({ ...base, UPSTREAM_AUTH: 'none' })).toEqual([
      'UPSTREAM_API_KEY must not be set with UPSTREAM_AUTH=none',
    ])
    const noKey: Record<string, string | undefined> = { ...base, UPSTREAM_AUTH: 'none' }
    delete noKey.UPSTREAM_API_KEY
    expect(problems({ ...noKey, UPSTREAM_AUTH_HEADER: 'x-api-key' })).toEqual([
      'UPSTREAM_AUTH_HEADER must not be set with UPSTREAM_AUTH=none',
    ])
    expect(problems({ ...noKey, UPSTREAM_AUTH_SCHEME: 'Bearer' })).toEqual([
      'UPSTREAM_AUTH_SCHEME must not be set with UPSTREAM_AUTH=none',
    ])
  })

  it('refuses any UPSTREAM_AUTH value other than none, and keeps the key required when it is unset', () => {
    expect(problems({ ...base, UPSTREAM_AUTH: 'basic' })).toEqual([
      'UPSTREAM_AUTH must be "none" when set; unset sends UPSTREAM_API_KEY',
    ])
    const noKey: Record<string, string | undefined> = { ...base }
    delete noKey.UPSTREAM_API_KEY
    expect(problems(noKey)).toEqual(['UPSTREAM_API_KEY is required'])
  })

  // #5108: the path `check` calls to prove the upstream key. It is joined onto
  // UPSTREAM_BASE_URL, so it is a path and not a URL.
  it('reads UPSTREAM_CHECK_PATH as an optional path, and refuses one that is not a path', () => {
    expect(loadConfig(base).upstream.checkPath).toBeUndefined()
    expect(loadConfig({ ...base, UPSTREAM_CHECK_PATH: '/v3/compat/models' }).upstream.checkPath).toBe('/v3/compat/models')
    expect(problems({ ...base, UPSTREAM_CHECK_PATH: 'v3/compat/models' })).toEqual([
      'UPSTREAM_CHECK_PATH must start with "/" (it is joined onto UPSTREAM_BASE_URL)',
    ])
    expect(problems({ ...base, UPSTREAM_CHECK_PATH: '/v3/compat/models?x=1' })).toEqual([
      'UPSTREAM_CHECK_PATH must be a path, with no spaces, query string or fragment',
    ])
    expect(problems({ ...base, UPSTREAM_CHECK_PATH: '/v3/compat models' })).toEqual([
      'UPSTREAM_CHECK_PATH must be a path, with no spaces, query string or fragment',
    ])
  })

  it('refuses Base mainnet at startup until the regulatory review in #4888 allows it — removing the refusal is a go-live step (#5061)', () => {
    // The refusal alone: the "must be one of" problem does not also fire for a
    // network the chain table knows.
    expect(problems({ ...base, NETWORK: 'eip155:8453' })).toEqual([MAINNET_REFUSAL])
  })

  it.each(['NETWORK', 'PAY_TO', 'OPERATOR_NAME', 'PRODUCTS_FILE', 'PAYMENTS_DB', 'UPSTREAM_BASE_URL', 'UPSTREAM_API_KEY', 'CDP_API_KEY_ID', 'CDP_API_KEY_SECRET'])(
    'refuses to start without %s',
    (name) => {
      const env: Record<string, string | undefined> = { ...base }
      delete env[name]
      expect(problems(env)).toEqual([`${name} is required`])
      expect(problems({ ...env, [name]: '   ' })).toEqual([`${name} is required`])
    },
  )

  it('defaults RPC_URL to the public Base Sepolia node, and keeps it required on Base mainnet (#5006)', () => {
    const sepolia = { ...base }
    delete (sepolia as Record<string, string | undefined>).RPC_URL
    const config = loadConfig(sepolia)
    expect(config.rpcUrl).toBe('https://sepolia.base.org')
    expect(config.rpcUrlDefault).toBe(true)

    // A set value always wins, and is not reported as the default.
    expect(loadConfig(base).rpcUrl).toBe('https://rpc.example.com')
    expect(loadConfig(base).rpcUrlDefault).toBe(false)

    // Base mainnet has no default: real money would rest on a rate-limited
    // public node. The network is refused at startup (#5061), and the rule
    // stays for go-live, so both problems are reported together.
    const mainnet = { ...base, NETWORK: 'eip155:8453' }
    delete (mainnet as Record<string, string | undefined>).RPC_URL
    expect(problems(mainnet)).toEqual([MAINNET_REFUSAL, 'RPC_URL is required'])
    expect(problems({ ...mainnet, RPC_URL: 'https://rpc.example.com' })).toEqual([MAINNET_REFUSAL])
  })

  it('adds no RPC_URL problem when NETWORK is missing or invalid (#5006)', () => {
    const missing = { ...base }
    delete (missing as Record<string, string | undefined>).NETWORK
    delete (missing as Record<string, string | undefined>).RPC_URL
    expect(problems(missing)).toEqual(['NETWORK is required'])
    expect(problems({ ...missing, NETWORK: 'eip155:1' })).toEqual([
      'NETWORK must be one of eip155:84532 (there is no default network)',
    ])
  })

  it('defaults ENDPOINT_NAME to OPERATOR_NAME and leaves ENDPOINT_DESCRIPTION absent, and a set value always wins (#5006)', () => {
    const unset = { ...base }
    delete (unset as Record<string, string | undefined>).ENDPOINT_NAME
    delete (unset as Record<string, string | undefined>).ENDPOINT_DESCRIPTION
    const config = loadConfig(unset)
    expect(config.endpointName).toBe('Acme')
    expect(config.endpointDescription).toBeUndefined()

    expect(loadConfig(base).endpointName).toBe('Acme inference')
    expect(loadConfig(base).endpointDescription).toBe('Acme inference, paid per call.')
  })

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
    expect(problems({ ...base, ICON_URL: 'ftp://x' })).toEqual(['ICON_URL must be an http(s) URL'])
    expect(problems({ ...base, ENDPOINT_NAME: 'two\nlines' })).toEqual(['ENDPOINT_NAME must be a single line of text'])
    expect(problems({ ...base, ENDPOINT_DESCRIPTION: 'two\nlines' })).toEqual(['ENDPOINT_DESCRIPTION must be a single line of text'])
    expect(problems({ ...base, OPERATOR_CONTACT: 'two\nlines' })).toEqual(['OPERATOR_CONTACT must be a single line of text'])
  })

  it('reads the discovery document settings, and leaves the optional ones absent when unset', () => {
    const config = loadConfig({ ...base, OPERATOR_CONTACT: 'https://acme.example/contact', ICON_URL: 'https://acme.example/icon.png' })
    expect(config.endpointName).toBe('Acme inference')
    expect(config.endpointDescription).toBe('Acme inference, paid per call.')
    expect(config.operatorContact).toBe('https://acme.example/contact')
    expect(config.iconUrl).toBe('https://acme.example/icon.png')
    expect(loadConfig(base).operatorContact).toBeUndefined()
    expect(loadConfig(base).iconUrl).toBeUndefined()
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

  // #5060: the `.env.example` placeholder and well-formed junk both refuse
  // startup, naming the variable and never printing its value.
  it('refuses to start with a Coinbase secret that cannot sign, naming the variable and never the value', async () => {
    for (const secret of ['your-cdp-api-key-secret', randomBytes(64).toString('base64')]) {
      const e = { ...env(), CDP_API_KEY_SECRET: secret }
      const failure = await startProxy(e, { cdp }).then(
        () => undefined,
        (err: unknown) => err,
      )
      expect(failure).toBeInstanceOf(ConfigError)
      const message = (failure as Error).message
      expect(message).toContain('CDP_API_KEY_SECRET cannot sign a request')
      expect(message).not.toContain(secret)
    }
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

  it('starts on the public Base Sepolia RPC default and names it on the started line, never a configured URL (#5006)', async () => {
    const e = env()
    delete (e as Record<string, string | undefined>).RPC_URL
    const logs: Record<string, unknown>[] = []
    const proxy = await startProxy(e, { cdp, log: (event, fields) => logs.push({ event, ...fields }) })
    expect(proxy.config.rpcUrl).toBe('https://sepolia.base.org')
    expect(logs.find((line) => line.event === 'started')).toMatchObject({ rpc: 'default (public Base Sepolia)' })
    await proxy.close()

    const configured = env()
    const configuredLogs: Record<string, unknown>[] = []
    const second = await startProxy(configured, { cdp, log: (event, fields) => configuredLogs.push({ event, ...fields }) })
    const started = configuredLogs.find((line) => line.event === 'started')!
    expect(started.rpc).toBe('configured')
    // A provider URL can embed a key, so the line never prints it.
    expect(JSON.stringify(started)).not.toContain('rpc.example.com')
    await second.close()
  })
})

describe('the timing settings stay inside the design bounds (review of #4893)', () => {
  it('refuses an UPSTREAM_TIMEOUT_MS above 180 s and a RESERVATION_DEADLINE_MS below the holder worst case', () => {
    expect(problems({ ...base, UPSTREAM_TIMEOUT_MS: '180001' }).join(' ')).toMatch(/UPSTREAM_TIMEOUT_MS may not exceed/)
    expect(problems({ ...base, RESERVATION_DEADLINE_MS: '109999' }).join(' ')).toMatch(/RESERVATION_DEADLINE_MS may not be below/)
    expect(problems({ ...base, UPSTREAM_TIMEOUT_MS: '60000', RESERVATION_DEADLINE_MS: '150000' })).toEqual([])
  })
})

describe('the receipt settings (#4913, §11)', () => {
  const SELLER = {
    SELLER_NAME: 'Kit Merchant AB',
    SELLER_ADDRESS: 'Sveavägen 10, 111 57 Stockholm',
    SELLER_ORG_NR: '559123-4567',
    SELLER_VAT_NR: 'SE559123456701',
  }

  it('with no VAT rule, no seller detail is required and the proxy sends no receipt', () => {
    const config = loadConfig(base)
    expect(config.receipt).toBeUndefined()
    expect(config.receiptStatus).toBe('off (no VAT_RULE)')
    expect(config.warnings).toEqual([])
  })

  it('with the Swedish rule and the seller details, the receipt settings are read once', () => {
    const config = loadConfig({
      ...base,
      VAT_RULE: 'SE_25_WITH_EU_REVERSE_CHARGE',
      ...SELLER,
      SELLER_IBAN: 'SE35 5000 0000 0549 1000 0003',
      SELLER_BIC: 'ESSESESS',
      SELLER_SUPPORT_CONTACT: 'support@kit-merchant.example',
    })
    expect(config.receiptStatus).toBe('on')
    expect(config.receipt).toEqual({
      vatRule: 'SE_25_WITH_EU_REVERSE_CHARGE',
      seller: {
        name: 'Kit Merchant AB',
        address: 'Sveavägen 10, 111 57 Stockholm',
        org_nr: '559123-4567',
        moms_nr: 'SE559123456701',
        iban: 'SE35 5000 0000 0549 1000 0003',
        bic: 'ESSESESS',
      },
      supportContact: 'support@kit-merchant.example',
    })
    expect(config.warnings).toEqual([])
  })

  it('refuses a VAT rule it does not know', () => {
    expect(problems({ ...base, VAT_RULE: 'UK_20' }).join(' ')).toMatch(/VAT_RULE must be one of SE_25_WITH_EU_REVERSE_CHARGE/)
  })

  it('on Base mainnet, refuses to start with a VAT rule and no seller name, organisation number or VAT number, alongside the mainnet refusal (#5061)', () => {
    const mainnet = { ...base, NETWORK: 'eip155:8453', VAT_RULE: 'SE_25_WITH_EU_REVERSE_CHARGE' }
    expect(problems(mainnet)).toEqual([
      MAINNET_REFUSAL,
      'with VAT_RULE set, SELLER_NAME, SELLER_ORG_NR, SELLER_VAT_NR are required on Base mainnet',
    ])
    expect(problems({ ...mainnet, SELLER_NAME: 'Kit Merchant AB' })).toEqual([
      MAINNET_REFUSAL,
      'with VAT_RULE set, SELLER_ORG_NR, SELLER_VAT_NR are required on Base mainnet',
    ])
    expect(problems({ ...mainnet, ...SELLER })).toEqual([MAINNET_REFUSAL])
  })

  it('on a test network, starts with a warning and sends no receipt when the seller details are missing', () => {
    const config = loadConfig({ ...base, VAT_RULE: 'SE_25_WITH_EU_REVERSE_CHARGE', SELLER_NAME: 'Kit Merchant AB' })
    expect(config.receipt).toBeUndefined()
    expect(config.receiptStatus).toBe('off (seller details missing)')
    expect(config.warnings).toEqual([
      'VAT_RULE is set but SELLER_ORG_NR, SELLER_VAT_NR are missing: the proxy starts and sends no receipt',
    ])
  })

  it('refuses a seller detail that is not a single line', () => {
    expect(
      problems({ ...base, VAT_RULE: 'SE_25_WITH_EU_REVERSE_CHARGE', ...SELLER, SELLER_NAME: 'Kit\nMerchant' }).join(' '),
    ).toMatch(/SELLER_NAME must be a single line of text/)
  })
})

describe('sales reporting settings (#4898)', () => {
  it('is off when no merchant key is configured, and needs nothing else', () => {
    const config = loadConfig(base)
    expect(config.sales).toBeUndefined()
    expect(config.salesStatus).toBe('off (no HAVEN_MERCHANT_KEY)')
    expect(secretValues(config)).toEqual([UPSTREAM_KEY, CDP_SECRET])
  })

  it('is on with a Sales key, Haven\'s origin and an outbox file, and the key is a secret', () => {
    const config = loadConfig({
      ...base,
      HAVEN_MERCHANT_KEY: SALES_KEY,
      HAVEN_SALES_URL: 'https://api.haven.example/',
      SALES_OUTBOX: '/tmp/sales-outbox.jsonl',
    })
    expect(config.sales).toEqual({
      havenBaseUrl: 'https://api.haven.example',
      merchantKey: SALES_KEY,
      outboxPath: '/tmp/sales-outbox.jsonl',
    })
    expect(config.salesStatus).toBe('on')
    expect(secretValues(config)).toContain(SALES_KEY)
  })

  it('refuses a key that is not a Sales key, and a missing or unusable Haven origin', () => {
    const sales = { HAVEN_MERCHANT_KEY: SALES_KEY, HAVEN_SALES_URL: 'https://api.haven.example', SALES_OUTBOX: '/tmp/o' }
    expect(problems({ ...base, ...sales, HAVEN_MERCHANT_KEY: 'not-a-sales-key' }).join(' ')).toMatch(
      /HAVEN_MERCHANT_KEY must be a Sales key/,
    )
    expect(problems({ ...base, ...sales, HAVEN_SALES_URL: undefined }).join(' ')).toMatch(
      /HAVEN_SALES_URL is required when HAVEN_MERCHANT_KEY is set/,
    )
    expect(problems({ ...base, ...sales, HAVEN_SALES_URL: 'https://api.haven.example/v1' }).join(' ')).toMatch(
      /HAVEN_SALES_URL must be Haven's API origin/,
    )
  })

  it('defaults SALES_OUTBOX to sales-outbox.jsonl beside PAYMENTS_DB, and a set value still overrides it (#5006)', () => {
    const config = loadConfig({
      ...base,
      PAYMENTS_DB: '/var/lib/kit/payments.sqlite',
      HAVEN_MERCHANT_KEY: SALES_KEY,
      HAVEN_SALES_URL: 'https://api.haven.example',
    })
    expect(config.sales).toEqual({
      havenBaseUrl: 'https://api.haven.example',
      merchantKey: SALES_KEY,
      outboxPath: '/var/lib/kit/sales-outbox.jsonl',
    })
    expect(config.salesStatus).toBe('on')

    expect(
      loadConfig({
        ...base,
        PAYMENTS_DB: '/var/lib/kit/payments.sqlite',
        HAVEN_MERCHANT_KEY: SALES_KEY,
        HAVEN_SALES_URL: 'https://api.haven.example',
        SALES_OUTBOX: '/tmp/sales-outbox.jsonl',
      }).sales?.outboxPath,
    ).toBe('/tmp/sales-outbox.jsonl')
  })
})
