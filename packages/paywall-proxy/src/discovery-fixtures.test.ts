/**
 * #4990: the kit discovery document Haven's catalogue reads is the proxy's own
 * builder output. This regenerates it from `buildDiscoveryDocument` over the
 * largest example products file the package ships (`demo/opper-products.json`)
 * and compares it byte for byte with the committed fixture, so a change to the
 * document cannot silently change what Haven reads. The backend's
 * `catalog/__tests__/kit-merchant-x402.test.ts` parses the same fixture with
 * the real reader.
 *
 * #5034: the second fixture is the same document with `BASE_PATH=/api`, so the
 * reader side is pinned for a deployment that serves its products under a base
 * path. With no `BASE_PATH` the first fixture is unchanged.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'
import { buildDiscoveryDocument } from './discovery.js'
import { loadProductsFile } from './products.js'

const PRODUCTS_FILE = fileURLToPath(new URL('../demo/opper-products.json', import.meta.url))
const FIXTURE = fileURLToPath(
  new URL('../../backend/src/modules/catalog/__tests__/fixtures/kit-merchant-x402.json', import.meta.url),
)
const BASE_PATH_FIXTURE = fileURLToPath(
  new URL('../../backend/src/modules/catalog/__tests__/fixtures/kit-merchant-x402-base-path.json', import.meta.url),
)

const ENV = {
  NETWORK: 'eip155:84532',
  PAY_TO: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  OPERATOR_NAME: 'Haven',
  OPERATOR_CONTACT: 'https://haven.example/merchant-kit',
  ENDPOINT_NAME: 'Haven inference demo',
  ENDPOINT_DESCRIPTION: 'Opper inference paid per call on Base Sepolia.',
  PRODUCTS_FILE,
  PAYMENTS_DB: '/tmp/kit-fixture-payments.sqlite',
  UPSTREAM_BASE_URL: 'https://api.opper.ai',
  UPSTREAM_API_KEY: 'sk-fixture-key',
  CDP_API_KEY_ID: 'cdp-key-id',
  CDP_API_KEY_SECRET: 'cdp-secret-abcdefghij',
  RPC_URL: 'https://sepolia.base.org',
}

const CONFIG = loadConfig(ENV)

function serialized(json: unknown): string {
  return `${JSON.stringify(json, null, 2)}\n`
}

describe('the backend kit discovery fixture is the proxy builder output (#4990)', () => {
  it('reproduces kit-merchant-x402.json byte for byte', () => {
    const fixture = readFileSync(FIXTURE, 'utf8')
    expect(serialized(buildDiscoveryDocument({ config: CONFIG, products: loadProductsFile(PRODUCTS_FILE) }))).toBe(fixture)
  })

  it('reproduces kit-merchant-x402-base-path.json byte for byte with BASE_PATH set (#5034)', () => {
    const fixture = readFileSync(BASE_PATH_FIXTURE, 'utf8')
    const config = loadConfig({ ...ENV, BASE_PATH: '/api' })
    expect(config.basePath).toBe('/api')
    expect(serialized(buildDiscoveryDocument({ config, products: loadProductsFile(PRODUCTS_FILE) }))).toBe(fixture)
  })
})
