/**
 * #5010 — the worked example in `docs/product/selling-with-your-own-server.md`,
 * checked against the REAL spec.
 *
 * The doc is the seller's copy-paste path: the x402 `402` answer, then the
 * `POST /merchant/sales` record. Two things can rot silently — the record's
 * fields and the answers the doc promises — so both are read from the doc and
 * checked against `packages/backend/src/openapi/spec.ts`, never restated here.
 *
 * The doc is the source of truth for the prose; this file only pins the two
 * machine-checkable halves the issue names: the `curl` body passes
 * `MerchantSaleRecord`, and every status code the doc names is one the route
 * declares.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { openapiSpec } from '../spec.js'
import { makeSpecAjv, REQUEST_AJV_OPTIONS } from '../ajv.js'

const DOC_URL = new URL('../../../../../docs/product/selling-with-your-own-server.md', import.meta.url)
const doc = readFileSync(DOC_URL, 'utf8')

/** Every fenced ```json block in the doc, parsed. */
function jsonBlocks(source: string): unknown[] {
  const blocks: unknown[] = []
  const re = /```json\n([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = re.exec(source)) !== null) blocks.push(JSON.parse(match[1]))
  return blocks
}

/** The `POST /merchant/sales` body: the one JSON block carrying a merchant reference. */
function saleRecord(): Record<string, unknown> {
  const record = jsonBlocks(doc).find(
    (block): block is Record<string, unknown> =>
      typeof block === 'object' && block !== null && 'merchant_reference' in block,
  )
  expect(record, 'the doc must carry the POST /merchant/sales body as a ```json block').toBeTruthy()
  return record as Record<string, unknown>
}

/** The status codes the doc's answers table names, in order. */
function namedAnswers(): string[] {
  const section = doc.split('### The answers to expect')[1]
  expect(section, 'the doc must carry the answers section').toBeTruthy()
  return [...section.matchAll(/^\|\s*`(\d{3})`\s*\|/gm)].map((match) => match[1])
}

const spec = openapiSpec as unknown as {
  paths: Record<string, Record<string, { responses: Record<string, unknown> }>>
  components: { schemas: Record<string, unknown> }
}

const route = spec.paths['/merchant/sales'].post

describe('the worked example (#5010)', () => {
  it("sends a sale record that passes the spec's MerchantSaleRecord schema", () => {
    const ajv = makeSpecAjv({ ...REQUEST_AJV_OPTIONS, closeObjects: false }, spec.components.schemas as never)
    const validate = ajv.compile({ $ref: '#/components/schemas/MerchantSaleRecord' })
    expect(validate(saleRecord()), JSON.stringify(validate.errors)).toBe(true)
  })

  it('sends version 1 explicitly, which the spec treats as optional', () => {
    const schema = spec.components.schemas.MerchantSaleRecord as { required: string[] }
    expect(schema.required).not.toContain('version')
    expect(saleRecord().version).toBe(1)
  })

  it('names only status codes the route declares', () => {
    const declared = Object.keys(route.responses)
    const named = namedAnswers()
    expect(named.length).toBeGreaterThan(0)
    for (const code of named) {
      expect(declared, `the doc names ${code}, which the route does not declare`).toContain(code)
    }
  })

  it('names every answer a reporter meets', () => {
    const named = namedAnswers()
    for (const code of ['200', '201', '401', '403', '409', '422', '425', '429']) {
      expect(named, `the doc omits ${code}`).toContain(code)
    }
  })

  it('carries the x402 challenge fields the proxy sends', () => {
    const challenge = jsonBlocks(doc).find(
      (block): block is Record<string, unknown> =>
        typeof block === 'object' && block !== null && 'accepts' in block,
    )
    expect(challenge, 'the doc must carry the 402 answer as a ```json block').toBeTruthy()
    const accepts = (challenge as { accepts: Record<string, unknown>[] }).accepts
    expect(accepts).toHaveLength(1)
    expect(accepts[0]).toMatchObject({
      scheme: 'exact',
      network: 'eip155:84532',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      extra: { name: 'USDC', version: '2' },
    })
    for (const field of ['payTo', 'amount', 'maxTimeoutSeconds']) {
      expect(accepts[0], `accepts[0] must name ${field}`).toHaveProperty(field)
    }
  })

  it('settles through the merchant’s own facilitator key, never Haven’s', () => {
    expect(doc).toContain("merchant's own Coinbase facilitator key")
    expect(doc).toContain("Haven's own key is not offered")
  })

  it('never carries a Sales key or a key prefix', () => {
    expect(doc).not.toContain('sk_merchant_')
  })
})
