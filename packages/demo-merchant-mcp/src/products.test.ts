import { describe, expect, it } from 'vitest'
import {
  PRODUCTS,
  buildProductMetadata,
  formatUsdc,
  merchantEnvironmentForChain,
  productArgumentsSchema,
  productToolArgs,
  settlementMethodsForProduct,
  type SettlementMethod,
} from './products.js'

describe('productToolArgs (#1274)', () => {
  it('derives the buy_cloud_storage call for a storage product', () => {
    expect(productToolArgs(PRODUCTS.storage_50gb)).toEqual({
      toolName: 'buy_cloud_storage',
      argumentName: 'tier',
      argumentValue: '50gb',
      argumentEnum: ['50gb', '200gb', '1tb'],
    })
  })

  it('derives the buy_vpn call for a VPN product', () => {
    expect(productToolArgs(PRODUCTS.vpn_pro)).toEqual({
      toolName: 'buy_vpn',
      argumentName: 'plan',
      argumentValue: 'pro',
      argumentEnum: ['basic', 'legacy', 'pro', 'ultra'],
    })
  })
})

describe('productArgumentsSchema (#1274)', () => {
  it('pins the exact argument value an agent must send to select this product', () => {
    const schema = productArgumentsSchema(PRODUCTS.storage_50gb) as {
      properties: { tier: { const: string; enum: string[] } }
      required: string[]
    }
    expect(schema.properties.tier.const).toBe('50gb')
    expect(schema.properties.tier.enum).toEqual(['50gb', '200gb', '1tb'])
    expect(schema.required).toEqual(['tier'])
  })
})

describe('settlementMethodsForProduct (#1274) — preserves #1266 ordering', () => {
  it('keeps EIP-3009 first even when erc7710 is listed first in the enabled set', () => {
    const enabled: SettlementMethod[] = ['erc7710', 'eip3009']
    expect(settlementMethodsForProduct(PRODUCTS.vpn_basic, enabled)).toEqual(['eip3009', 'erc7710'])
  })

  it('degrades to eip3009-only when erc7710 is not in the enabled set', () => {
    expect(settlementMethodsForProduct(PRODUCTS.vpn_basic, ['eip3009'])).toEqual(['eip3009'])
  })

  it('never advertises a settlement method the merchant did not enable', () => {
    expect(settlementMethodsForProduct(PRODUCTS.vpn_basic, [])).toEqual([])
  })

  it('reorders when the PRODUCT declares erc7710 first — the guard owns eip3009-first, not filter order', () => {
    // Every real PRODUCTS entry happens to list eip3009 first, so without this
    // fixture the reorder branch is only ever exercised vacuously (review
    // finding on #1302: deleting the branch survived the other tests). A
    // future product authored erc7710-first must still advertise eip3009 first.
    const reversed = {
      ...PRODUCTS.vpn_basic,
      x402: {
        ...PRODUCTS.vpn_basic.x402,
        settlementMethods: ['erc7710', 'eip3009'] as SettlementMethod[],
      },
    }
    expect(settlementMethodsForProduct(reversed, ['erc7710', 'eip3009'])).toEqual([
      'eip3009',
      'erc7710',
    ])
  })
})

describe('buildProductMetadata (#1274) — machine-readable product contract', () => {
  const metadata = buildProductMetadata(PRODUCTS.storage_50gb, {
    enabledSettlementMethods: ['eip3009', 'erc7710'],
    mcpUrl: 'https://example.invalid/mcp',
    chainId: 8453,
  })

  it('exposes every field an agent needs to select and buy without parsing prose', () => {
    expect(metadata).toMatchObject({
      product_id: 'storage_50gb',
      display_name: 'CloudNest 50 GB',
      price_atomic: '500',
      asset: 'USDC',
      network: 'eip155:8453',
      billing_period: 'monthly',
      tool_name: 'buy_cloud_storage',
      supported_settlement_methods: ['eip3009', 'erc7710'],
      default_settlement_method: 'eip3009',
      mcp_url: 'https://example.invalid/mcp',
      environment: merchantEnvironmentForChain(8453),
    })
    expect(metadata.arguments_schema).toBeTruthy()
    expect(metadata.display.price_formatted).toBe(`$${formatUsdc(500n)} USDC`)
  })

  it('reports price_atomic as the exact base-unit bigint string (no Number round-trip)', () => {
    // #1279 lesson: this must be a bigint-derived string, not a Number() cast.
    expect(metadata.price_atomic).toBe(PRODUCTS.storage_50gb.price_usdc.toString())
  })

  it('degrades to eip3009-only metadata when erc7710 is not enabled (missing/unpinned config)', () => {
    const eip3009Only = buildProductMetadata(PRODUCTS.storage_50gb, {
      enabledSettlementMethods: ['eip3009'],
      mcpUrl: 'https://example.invalid/mcp',
    })
    expect(eip3009Only.supported_settlement_methods).toEqual(['eip3009'])
    expect(eip3009Only.default_settlement_method).toBe('eip3009')
  })

  it('never lets erc7710 lead supported_settlement_methods, regardless of input order', () => {
    const reordered = buildProductMetadata(PRODUCTS.vpn_ultra, {
      enabledSettlementMethods: ['erc7710', 'eip3009'],
      mcpUrl: 'https://example.invalid/mcp',
    })
    expect(reordered.supported_settlement_methods[0]).toBe('eip3009')
    expect(reordered.default_settlement_method).toBe('eip3009')
  })
})

describe('vpn_legacy is the EIP-3009-only product (#1441)', () => {
  /**
   * `x402-hosted-mcp-signer` covers the funding-leg topology from the
   * `haven_pay_mcp_tool` entry point, and that topology only exists on
   * eip3009. Every other product also advertises erc7710, and #1450's
   * preference rule then picks it — which has no funding leg, so the leg had
   * nothing to assert and skipped permanently, which under
   * QA_REQUIRE_ALL_LEGS=1 meant the suite could never report green.
   *
   * A prose comment on the product said "do not tidy this back to
   * SUPPORTED_SETTLEMENT_METHODS". Nothing enforced it — verified by mutation:
   * widening it broke no test. This is the guard.
   */
  it('advertises eip3009 alone, so the funding-leg topology stays reachable', () => {
    expect(PRODUCTS.vpn_legacy.x402.settlementMethods).toEqual(['eip3009'])
    expect(PRODUCTS.vpn_legacy.x402.defaultSettlementMethod).toBe('eip3009')
  })

  it('stays 3009-only even when the merchant has erc7710 enabled', () => {
    // The merchant intersects the product's methods with the enabled set, so a
    // product offering only eip3009 must survive erc7710 being switched on.
    expect(settlementMethodsForProduct(PRODUCTS.vpn_legacy, ['eip3009', 'erc7710'])).toEqual([
      'eip3009',
    ])
  })

  it('is the ONLY product with that property, so the leg has one unambiguous target', () => {
    const threeThousandNineOnly = Object.values(PRODUCTS)
      .filter((p) => p.x402.settlementMethods.length === 1 && p.x402.settlementMethods[0] === 'eip3009')
      .map((p) => p.id)
    expect(threeThousandNineOnly).toEqual(['vpn_legacy'])
  })
})
