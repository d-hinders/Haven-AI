import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { STRICT_INPUT_TOOLS, TOOL_ARGUMENT_ALIASES } from './tools/contracts.js'
import { declaredAliasFor, strictRefusalMessage, toolInputSchema } from './tools/registry.js'
import { parseStrict } from './tools/parsing.js'

/**
 * #3100 (epic #3105, decision 5) — a strict refusal names the declared keys and
 * the DECLARED alias of a rejected key, on both parse paths. The rule is exact:
 * folded-spelling equality (`merchantUrl` → `merchant_url`) or a table entry
 * (`resource_url` → `url`, `id` → `catalog_id`); never containment.
 */
describe('declaredAliasFor', () => {
  it('resolves the table aliases discovery hands out', () => {
    expect(declaredAliasFor('haven_quote_x402', 'resource_url')).toBe('url')
    expect(declaredAliasFor('haven_quote_catalog_purchase', 'id')).toBe('catalog_id')
    expect(declaredAliasFor('haven_prepare_catalog_purchase', 'id')).toBe('catalog_id')
    expect(declaredAliasFor('haven_pay_mcp_tool', 'resource_url')).toBe('merchant_url')
  })

  it('resolves folded spellings without a table entry', () => {
    expect(declaredAliasFor('haven_pay_mcp_tool', 'merchantUrl')).toBe('merchant_url')
    expect(declaredAliasFor('haven_pay_mcp_tool', 'merchant-url')).toBe('merchant_url')
    expect(declaredAliasFor('haven_pay_x402_quote', 'paymentRequired')).toBe('payment_required')
  })

  it('never guesses by containment or similarity', () => {
    expect(declaredAliasFor('haven_quote_x402', 'urls')).toBeUndefined()
    expect(declaredAliasFor('haven_quote_x402', 'the_url')).toBeUndefined()
    expect(declaredAliasFor('haven_quote_catalog_purchase', 'catalog')).toBeUndefined()
  })
})

describe('strictRefusalMessage', () => {
  it('names the rejected key, its alias and the declared keys', () => {
    const text = strictRefusalMessage('haven_quote_x402', ['resource_url'])
    expect(text).toContain('does not accept "resource_url"')
    expect(text).toContain('send "resource_url" as "url"')
    expect(text).toContain('It declares: url, method, headers, body')
    expect(text.toLowerCase()).not.toContain('no body field')
  })

  it('omits the alias clause when nothing declared matches', () => {
    const text = strictRefusalMessage('haven_quote_x402', ['idempotency_key'])
    expect(text).not.toContain(' as "')
    expect(text).toContain('It declares: url, method, headers, body')
  })
})

describe('both parse paths carry the hint', () => {
  it('parseStrict (the handler path)', () => {
    let message = ''
    try {
      parseStrict('haven_quote_x402', { resource_url: 'https://merchant.test/paid' })
    } catch (err) {
      message = (err as { message: string }).message
    }
    expect(message).toContain('send "resource_url" as "url"')
  })

  it('toolInputSchema (the transport path, before the handler runs)', () => {
    const schema = toolInputSchema('haven_quote_x402') as z.ZodTypeAny
    const result = schema.safeParse({ resource_url: 'https://merchant.test/paid' })
    expect(result.success).toBe(false)
    const issue = result.success ? undefined : result.error.issues.find((i) => i.code === 'unrecognized_keys')
    expect(issue?.message).toContain('send "resource_url" as "url"')
    expect(schema.safeParse({ url: 'https://merchant.test/paid' }).success).toBe(true)
  })
})

describe('the false sentence is gone and the table is honest', () => {
  it('STRICT_INPUT_TOOLS.haven_quote_x402 no longer says the hosted surface has no body field', () => {
    expect(STRICT_INPUT_TOOLS.haven_quote_x402).not.toContain('no body field')
    expect(STRICT_INPUT_TOOLS.haven_quote_x402).toContain('body')
  })

  it('every table alias points at a key the tool actually declares', () => {
    for (const [tool, table] of Object.entries(TOOL_ARGUMENT_ALIASES)) {
      const declared = Object.keys((toolInputSchema(tool as never) as z.ZodObject<z.ZodRawShape>).shape ?? toolInputSchema(tool as never))
      for (const alias of Object.values(table)) expect(declared, `${tool} → ${alias}`).toContain(alias)
    }
  })
})
