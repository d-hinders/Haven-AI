/**
 * #4988: a product's input_schema, compiled at load and checked on the body.
 * The end-to-end refusals (before the challenge, before the facilitator) are in
 * proxy.test.ts; this file pins the validator and the products-file load.
 */
import { describe, expect, it } from 'vitest'
import { MAX_INPUT_ERRORS, MAX_INPUT_ERROR_TEXT, compileInputSchema, isJsonContentType } from './input-schema.js'
import { ProductsFileError, parseProducts } from './products.js'

const SEARCH_SCHEMA = {
  type: 'object',
  required: ['query'],
  properties: { query: { type: 'string' }, max_results: { type: 'integer', maximum: 10 } },
}
const search = { id: 'search', route: 'POST /v1/search', price: '30000', description: 'One search.', input_schema: SEARCH_SCHEMA }

function problems(products: unknown[]): string[] {
  try {
    parseProducts({ version: 1, products })
  } catch (err) {
    if (err instanceof ProductsFileError) return [...err.problems]
    throw err
  }
  return []
}

describe('the validator', () => {
  it('names the failing field as a JSON pointer and the rule, and a missing property by its name', () => {
    const validate = compileInputSchema(SEARCH_SCHEMA)
    expect(validate({ query: 'q', max_results: 5 })).toEqual([])
    expect(validate({})).toEqual([{ path: '/query', rule: 'required' }])
    expect(validate({ query: 'q', max_results: 99 })).toEqual([{ path: '/max_results', rule: 'maximum' }])
    expect(validate([])).toEqual([{ path: '', rule: 'type' }])
  })

  it('never carries a value from the body', () => {
    for (const [schema, rule] of [[{ const: 'x' }, 'const'], [{ enum: ['y'] }, 'enum'], [{ type: 'integer' }, 'type'], [{ maxLength: 2 }, 'maxLength']] as const) {
      const errors = compileInputSchema({ type: 'object', properties: { a: schema } })({ a: 'SECRET-A-77' })
      expect(errors).toEqual([{ path: '/a', rule }])
      expect(JSON.stringify(errors)).not.toMatch(/SECRET/)
    }
  })

  it('is bounded: it stops at the first failure (never more than 10 entries), and each string is at most 200 characters', () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}`, { type: 'string' }]))
    const validate = compileInputSchema({ type: 'object', required: Object.keys(many), properties: many })
    expect(validate({})).toEqual([{ path: '/f0', rule: 'required' }])
    expect(validate({}).length).toBeLessThanOrEqual(MAX_INPUT_ERRORS)
    // A large array failing an items rule reports one entry, not one per element.
    const items = compileInputSchema({ type: 'object', properties: { a: { type: 'array', items: { type: 'string' } } } })
    expect(items({ a: Array.from({ length: 100_000 }, () => 1) })).toEqual([{ path: '/a/0', rule: 'type' }])
    const long = 'k'.repeat(500)
    const deep = compileInputSchema({ type: 'object', required: [long] })
    const [entry] = deep({})
    expect([...entry!.path].length).toBe(MAX_INPUT_ERROR_TEXT)
  })

  it('refuses a $ref outside the schema without fetching it, and compiles an internal one', () => {
    expect(() => compileInputSchema({ $ref: 'https://schemas.example/body.json' })).toThrow(/outside the schema/)
    expect(() => compileInputSchema({ properties: { a: { $ref: 'other.json#/x' } } })).toThrow(/outside the schema/)
    const validate = compileInputSchema({ $defs: { q: { type: 'string' } }, type: 'object', properties: { query: { $ref: '#/$defs/q' } } })
    expect(validate({ query: 1 })).toEqual([{ path: '/query', rule: 'type' }])
    // A "$ref" key inside data (const, enum, default, examples) is not a reference.
    expect(() => compileInputSchema({ type: 'object', examples: [{ $ref: 'https://x.example/a' }], properties: { a: { const: { $ref: 'b.json' } } } })).not.toThrow()
  })

  it('refuses what it cannot enforce: not a schema, another dialect, an unknown keyword', () => {
    expect(() => compileInputSchema('object')).toThrow(/draft 2020-12/)
    expect(() => compileInputSchema({ type: 'objekt' })).toThrow(/draft 2020-12/)
    expect(() => compileInputSchema({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' })).toThrow(/draft 2020-12/)
    expect(() => compileInputSchema({ type: 'object', requried: ['q'] })).toThrow(/draft 2020-12/)
  })

  it('treats format as an annotation, as 2020-12 does by default', () => {
    expect(compileInputSchema({ type: 'string', format: 'email' })('not an email')).toEqual([])
  })

  it('accepts a JSON Content-Type or none, and refuses any other', () => {
    for (const ok of [undefined, '', 'application/json', 'application/json; charset=utf-8', 'Application/JSON', 'application/vnd.api+json']) {
      expect(isJsonContentType(ok)).toBe(true)
    }
    for (const bad of ['text/plain', 'text/plain; charset=utf-8', 'application/x-www-form-urlencoded', 'multipart/form-data', 'text/json']) {
      expect(isJsonContentType(bad)).toBe(false)
    }
  })
})

describe('the products file load', () => {
  it('loads a product whose schema compiles and whose example passes it', () => {
    const [p] = parseProducts({ version: 1, products: [{ ...search, input_example: { query: 'haven' } }] })
    expect(p).toMatchObject({ id: 'search', inputSchema: SEARCH_SCHEMA, inputExample: { query: 'haven' } })
  })

  it('fails startup naming the product for an uncompilable schema', () => {
    expect(problems([{ ...search, input_schema: { type: 'objekt' } }])).toEqual([expect.stringMatching(/^product "search": "input_schema" is not a JSON Schema/)])
  })

  it('fails startup naming the product for a remote $ref', () => {
    expect(problems([{ ...search, input_schema: { $ref: 'https://schemas.example/body.json' } }])).toEqual([
      expect.stringMatching(/^product "search": "input_schema" has a \$ref outside the schema/),
    ])
  })

  it('fails startup naming the product for input_schema on a GET or DELETE route', () => {
    for (const method of ['GET', 'DELETE']) {
      expect(problems([{ ...search, route: `${method} /v1/search` }])).toEqual([
        `product "search": "input_schema" is for a request body, and a ${method} request has none: remove it or sell the route with a method that carries a body`,
      ])
    }
    for (const method of ['POST', 'PUT', 'PATCH']) expect(problems([{ ...search, route: `${method} /v1/search` }])).toEqual([])
  })

  it('fails startup naming the product for an input_example that fails its schema', () => {
    expect(problems([{ ...search, input_example: { max_results: 99 } }])).toEqual([
      'product "search": "input_example" does not pass "input_schema": /query fails "required"',
    ])
  })

  it('the Opper demo file loads, and its schemas accept real chat-completions bodies', async () => {
    const { loadProductsFile } = await import('./products.js')
    const { fileURLToPath } = await import('node:url')
    const products = loadProductsFile(fileURLToPath(new URL('../demo/opper-products.json', import.meta.url)))
    for (const product of products) {
      const validate = compileInputSchema(product.inputSchema)
      expect(validate({ model: product.model, messages: [{ role: 'user', content: 'hi' }] })).toEqual([])
      expect(validate({ model: product.model, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }], max_tokens: 5000, temperature: 0.2, stream: false })).toEqual([])
      expect(validate({ model: product.model, prompt: 'hi' })).toEqual([{ path: '/messages', rule: 'required' }])
    }
  })
})
