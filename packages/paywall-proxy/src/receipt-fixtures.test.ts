import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { buildSignedTaxDeclaration, encodeTaxDeclarationHeader } from '@haven_ai/sdk/edge'
import { PROXY_CHAINS } from './chains.js'
import { buildReceiptForPayment, type ReceiptParams, type ReceiptSettings } from './receipt.js'

/**
 * #4913: the two kit receipts beside the demo merchant's in the backend's
 * accounting fixtures are the proxy's own builder output. This regenerates
 * both from `buildReceiptForPayment` and compares them byte for byte, with the
 * clock injected, so a change to the proxy's receipt path cannot silently
 * change a receipt Haven's accounting already reads.
 */
const FIXTURES = fileURLToPath(
  new URL('../../backend/src/modules/accounting/__tests__/fixtures/merchant-receipts/', import.meta.url),
)

const PAYER_KEY = `0x${'01'.repeat(32)}` as const
const PAYER = privateKeyToAccount(PAYER_KEY).address
const CHAIN = PROXY_CHAINS['eip155:84532']!

const SETTINGS: ReceiptSettings = {
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
}

const PARAMS: ReceiptParams = {
  settings: SETTINGS,
  product: {
    id: 'chat-1k',
    name: 'Chat, 1,000 output tokens',
    method: 'POST',
    path: '/v1/chat/completions',
    route: 'POST /v1/chat/completions',
    price: 10000n,
    description: 'One chat completion on your-provider/your-model, up to 1,000 output tokens.',
  },
  chain: CHAIN,
  payTo: '0x1111111111111111111111111111111111111111',
  payer: PAYER,
  txHash: `0x${'cd'.repeat(32)}`,
  settledAt: '2026-11-18T12:00:00Z',
  now: Date.parse('2026-11-18T12:00:00Z'),
}

const DECLARATION = encodeTaxDeclarationHeader(
  buildSignedTaxDeclaration({
    content: {
      version: 'x402-tax-1',
      jurisdiction: 'DE',
      taxableStatus: 'TAXABLE_PERSON',
      taxId: 'DE123456789',
      validUntil: Date.parse('2027-06-30T12:00:00Z'),
    },
    network: `eip155:${CHAIN.chainId}`,
    delegateKey: PAYER_KEY,
  }),
)

function serialized(json: unknown): string {
  return `${JSON.stringify(json, null, 2)}\n`
}

describe('the backend kit receipt fixtures are the proxy builder output (#4913)', () => {
  it('reproduces kit-merchant-se25.json byte for byte', () => {
    const fixture = readFileSync(`${FIXTURES}kit-merchant-se25.json`, 'utf8')
    expect(serialized(buildReceiptForPayment(PARAMS))).toBe(fixture)
  })

  it('reproduces kit-merchant-reverse-charge.json byte for byte', () => {
    const fixture = readFileSync(`${FIXTURES}kit-merchant-reverse-charge.json`, 'utf8')
    expect(serialized(buildReceiptForPayment({ ...PARAMS, taxDeclarationHeader: DECLARATION }))).toBe(fixture)
  })
})
