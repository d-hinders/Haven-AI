import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from './config.js'
import { loadProductsFile } from './products.js'
import { parseReportSaleArgs, reportSaleAgain, ReportSaleError, runReportSaleCommand } from './report-sale.js'
import { openSqliteConsumedPaymentStore } from './sqlite-store.js'
import { PAY_TO, SALES_KEY, UPSTREAM_KEY, CDP_SECRET } from './test-harness.js'

const TX_HASH = `0x${'1'.repeat(64)}`
const dirs: string[] = []

function workspace(): { dir: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), 'report-sale-'))
  dirs.push(dir)
  const productsFile = join(dir, 'products.json')
  writeFileSync(
    productsFile,
    JSON.stringify({
      version: 1,
      products: [{ id: 'lookup', route: 'GET /v1/lookup', price: '20000', description: 'One lookup.' }],
    }),
  )
  return {
    dir,
    env: {
      NETWORK: 'eip155:84532',
      PAY_TO,
      OPERATOR_NAME: 'Acme',
      ENDPOINT_NAME: 'Acme inference',
      ENDPOINT_DESCRIPTION: 'Acme inference, paid per call.',
      PRODUCTS_FILE: productsFile,
      PAYMENTS_DB: join(dir, 'payments.sqlite'),
      UPSTREAM_BASE_URL: 'https://api.example.com',
      UPSTREAM_API_KEY: UPSTREAM_KEY,
      CDP_API_KEY_ID: 'id',
      CDP_API_KEY_SECRET: CDP_SECRET,
      RPC_URL: 'https://rpc.example.com',
      HAVEN_MERCHANT_KEY: SALES_KEY,
      HAVEN_SALES_URL: 'https://api.haven.example',
      SALES_OUTBOX: join(dir, 'sales-outbox.jsonl'),
    },
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the re-report command (#4898)', () => {
  it('parses the transaction hash and the two flags', () => {
    expect(parseReportSaleArgs([TX_HASH])).toEqual({ txHash: TX_HASH })
    expect(parseReportSaleArgs([TX_HASH, '--new-reference'])).toEqual({ txHash: TX_HASH, newReference: true })
    expect(parseReportSaleArgs(['--vat-treatment', 'REVERSE_CHARGE', TX_HASH])).toEqual({
      txHash: TX_HASH,
      vatTreatment: 'REVERSE_CHARGE',
    })
  })

  it('refuses a missing hash, an unknown option and a VAT treatment it does not know', () => {
    expect(() => parseReportSaleArgs([])).toThrow(ReportSaleError)
    expect(() => parseReportSaleArgs([TX_HASH, '--nope'])).toThrow(/Unknown option/)
    expect(() => parseReportSaleArgs([TX_HASH, '--vat-treatment', 'SE_12'])).toThrow(/SE_25 or REVERSE_CHARGE/)
    expect(() => parseReportSaleArgs([TX_HASH, TX_HASH])).toThrow(/one transaction hash/)
  })

  it('refuses a transaction hash the store never saw', async () => {
    const { env } = workspace()
    const config = loadConfig(env)
    const products = loadProductsFile(config.productsFile)
    await expect(reportSaleAgain(config, products, { txHash: TX_HASH })).rejects.toThrow(/no payment with transaction hash/)
  })

  it('refuses a payment the store has not settled: it has no transaction hash to find it by', async () => {
    const { env } = workspace()
    const config = loadConfig(env)
    const products = loadProductsFile(config.productsFile)
    const store = openSqliteConsumedPaymentStore(config.paymentsDb, { takeoverAfterMs: 1 })
    await store.reserve({
      key: 'eip3009:84532:0x7a3f9c2e1b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a:0xnonce',
      productId: 'lookup',
      chain: 'eip155:84532',
      payer: '0x7a3f9c2e1b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a',
      amount: '20000',
      validBefore: 1_800_000_000,
      merchantReference: 'sale_01JB8Z3K4M5N6P7Q8R9S0T1V2W',
      authorizationDigest: 'digest',
      now: '2026-11-18T10:00:00.000Z',
    })
    store.close()

    await expect(reportSaleAgain(config, products, { txHash: TX_HASH })).rejects.toThrow(
      /no payment with transaction hash/,
    )
  })

  it('refuses a hash that is not a transaction hash', async () => {
    const { env } = workspace()
    const config = loadConfig(env)
    const products = loadProductsFile(config.productsFile)
    await expect(reportSaleAgain(config, products, { txHash: '0x1234' })).rejects.toThrow(/64 hex characters/)
  })

  it('refuses to report when no merchant key is configured', async () => {
    const { env } = workspace()
    delete env.HAVEN_MERCHANT_KEY
    const config = loadConfig(env)
    const products = loadProductsFile(config.productsFile)
    await expect(reportSaleAgain(config, products, { txHash: TX_HASH })).rejects.toThrow(/HAVEN_MERCHANT_KEY is not set/)
  })

  it('refuses Base mainnet before it reads the store, with the #5061 refusal inside the ConfigError message', async () => {
    const { env } = workspace()
    env.NETWORK = 'eip155:8453'
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      errors.push(String(line))
    })
    let code: number
    try {
      code = await runReportSaleCommand([TX_HASH], env)
    } finally {
      spy.mockRestore()
    }

    expect(code).toBe(1)
    const text = errors.join('\n')
    expect(text).toContain('The proxy cannot start:')
    expect(text).toContain(
      'NETWORK eip155:8453 (Base mainnet) is not open: the merchant kit runs on Base Sepolia only until the regulatory review in #4888 allows mainnet',
    )
  })
})
