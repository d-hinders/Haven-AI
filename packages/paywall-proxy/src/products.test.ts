import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ProductsFileError, RECEIPT_LINE_MAX, loadProductsFile, parseProducts } from './products.js'

const product = {
  id: 'opper-gpt-6-sol-1k',
  name: 'Opper GPT-6 Sol, 1,000 output tokens',
  route: 'POST /v3/compat/chat/completions',
  model: 'openai/gpt-6-sol',
  price: '10000',
  output_token_cap: 1000,
  description: 'One chat completion on openai/gpt-6-sol, up to 1,000 output tokens.',
}
const file = (products: unknown[], extra: Record<string, unknown> = {}) => ({ version: 1, products, ...extra })

function problems(raw: unknown): string[] {
  try {
    parseProducts(raw)
  } catch (err) {
    if (err instanceof ProductsFileError) return [...err.problems]
    throw err
  }
  return []
}

describe('products file (design 12 section 3)', () => {
  it('accepts the documented shape', () => {
    const [p] = parseProducts(file([product]))
    expect(p).toMatchObject({ id: product.id, method: 'POST', path: '/v3/compat/chat/completions', price: 10000n, outputTokenCap: 1000, model: 'openai/gpt-6-sol' })
  })

  it('keeps the optional directory fields', () => {
    const [p] = parseProducts(file([{ ...product, input_example: { a: 1 }, input_schema: { type: 'object' }, output_example: { b: 2 } }]))
    expect(p).toMatchObject({ inputExample: { a: 1 }, inputSchema: { type: 'object' }, outputExample: { b: 2 } })
  })

  it('refuses an unknown version, a missing or empty product list and a non-object file', () => {
    expect(problems({ version: 2, products: [product] })).toContain('"version" must be 1')
    expect(problems({ version: 1 })[0]).toContain('"products" must be a non-empty array')
    expect(problems({ version: 1, products: [] })[0]).toContain('"products" must be a non-empty array')
    expect(problems([])).toEqual(['the file must be a JSON object'])
  })

  it('refuses a file or product that names a network: it is a deployment setting', () => {
    expect(problems(file([product], { network: 'eip155:84532' }))[0]).toContain('NETWORK setting')
    expect(problems(file([{ ...product, network: 'eip155:84532' }]))[0]).toContain('deployment setting')
  })

  it('refuses a price that is a number, a float, a dollar string, zero or negative, naming the product', () => {
    expect(problems(file([{ ...product, price: 10000 }]))[0]).toBe(`product "${product.id}": "price" must be a decimal string of atomic USDC units, not a JSON number`)
    for (const price of ['0.01', '$0.01', '0', '-5', '', '1e4', ' 10', '010']) {
      expect(problems(file([{ ...product, price }]))[0], price).toContain('"price" must be a decimal string')
    }
    expect(problems(file([{ ...product, price: undefined }]))[0]).toContain('"price"')
  })

  it('refuses a bad route, id, cap, name and missing description', () => {
    expect(problems(file([{ ...product, route: '/no-method' }]))[0]).toContain('"route" must be "METHOD /path"')
    expect(problems(file([{ ...product, route: 'FETCH /x' }]))[0]).toContain('"route" must be "METHOD /path"')
    expect(problems(file([{ ...product, route: 'GET /x?y=1' }]))[0]).toContain('no query')
    expect(problems(file([{ ...product, id: 'Upper Case' }]))[0]).toContain('"id" must be a lower-case identifier')
    expect(problems(file([{ ...product, output_token_cap: 0 }]))[0]).toContain('"output_token_cap"')
    expect(problems(file([{ ...product, output_token_cap: 1.5 }]))[0]).toContain('"output_token_cap"')
    expect(problems(file([{ ...product, description: '' }]))[0]).toContain('"description" is required')
    expect(problems(file([{ ...product, name: '  ' }]))[0]).toContain('"name"')
    expect(problems(file([{ ...product, typo_field: 1 }]))[0]).toContain('unknown field "typo_field"')
  })

  it('refuses a duplicate id, and two products on one route unless each names a distinct model', () => {
    expect(problems(file([product, { ...product, route: 'GET /other' }]))[0]).toContain('"id" is used by another product')
    expect(problems(file([product, { ...product, id: 'b', model: 'other' }]))).toEqual([])
    expect(problems(file([product, { ...product, id: 'b' }]))[0]).toContain('same model')
    const { model: _m, ...noModel } = product
    expect(problems(file([product, { ...noModel, id: 'b' }]))[0]).toContain('must each name a "model"')
  })

  it(`refuses a receipt line over ${RECEIPT_LINE_MAX} characters or with a forbidden character, naming the product`, () => {
    const long = 'x'.repeat(RECEIPT_LINE_MAX)
    expect(problems(file([{ ...product, description: long }]))[0]).toContain(`product "${product.id}": the receipt line`)
    // exactly at the limit is fine
    const name = 'n'
    const description = 'd'.repeat(RECEIPT_LINE_MAX - `${name} — `.length)
    expect(problems(file([{ ...product, name, description }]))).toEqual([])
    expect(problems(file([{ ...product, description: `${description}d` , name}]))[0]).toContain('receipt line')
    expect(problems(file([{ ...product, description: 'line one\nline two' }]))[0]).toContain('control')
    expect(problems(file([{ ...product, description: 'zero​width' }]))[0]).toContain('control')
  })

  it('the example products file shipped with the package is valid', () => {
    const example = fileURLToPath(new URL('../products.example.json', import.meta.url))
    expect(loadProductsFile(example).map((p) => p.id)).toEqual(['chat-1k', 'lookup'])
  })

  it('loads from a path and refuses a missing file or invalid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'paywall-products-'))
    try {
      const path = join(dir, 'products.json')
      writeFileSync(path, JSON.stringify(file([product])))
      expect(loadProductsFile(path)).toHaveLength(1)
      expect(() => loadProductsFile(join(dir, 'missing.json'))).toThrow(ProductsFileError)
      writeFileSync(path, '{not json')
      expect(() => loadProductsFile(path)).toThrow('not valid JSON')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
