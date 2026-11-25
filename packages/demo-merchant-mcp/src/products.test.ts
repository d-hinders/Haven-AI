import { describe, expect, it } from 'vitest'
import {
  CHECKOUT_DETAILS_REQUIRED_FIELD_ENV,
  PRODUCTS,
  buildProductMetadata,
  checkoutDetailsForProduct,
  formatUsdc,
  merchantEnvironmentForChain,
  offeredProducts,
  productArgumentsSchema,
  productBillingPeriod,
  productReceivingAddress,
  productSettlementKind,
  productToolArgs,
  requiredCheckoutFieldFromEnv,
  settlementMethodsForProduct,
  type SettlementMethod,
} from './products.js'

const MERCHANT_DEFAULT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a' as const

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

describe('vpn_legacy is the self-settled EIP-3009-only product (#1441)', () => {
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

  // #4851 rewrote this on purpose. The joke is EIP-3009-only too, but Coinbase's
  // facilitator settles it, and the QA leg exists to exercise the merchant's
  // OWN settlement of the funding-leg topology. So the property that must stay
  // unique is "EIP-3009-only AND self-settled", and vpn_legacy must keep it.
  it('is the ONLY self-settled EIP-3009-only product, so the leg has one unambiguous target', () => {
    const selfSettledThreeThousandNineOnly = Object.values(PRODUCTS)
      .filter((p) => p.x402.settlementMethods.length === 1 && p.x402.settlementMethods[0] === 'eip3009')
      .filter((p) => productSettlementKind(p) === 'self')
      .map((p) => p.id)
    expect(selfSettledThreeThousandNineOnly).toEqual(['vpn_legacy'])
  })
})

describe('the CDP-settled joke product (#4851)', () => {
  it('is 0.01 USDC, EIP-3009 only, settled by CDP, paid to the merchant default, one-time', () => {
    const joke = PRODUCTS.joke
    expect(joke.price_usdc).toBe(10_000n)
    expect(joke.x402.settlementMethods).toEqual(['eip3009'])
    expect(settlementMethodsForProduct(joke, ['eip3009', 'erc7710'])).toEqual(['eip3009'])
    expect(productSettlementKind(joke)).toBe('cdp')
    expect(productReceivingAddress(joke, MERCHANT_DEFAULT)).toBe(MERCHANT_DEFAULT)
    expect(productBillingPeriod(joke)).toBe('one_time')
  })

  it('is the only CDP-settled product, and is offered only with CDP configured', () => {
    expect(Object.values(PRODUCTS).filter((p) => productSettlementKind(p) === 'cdp').map((p) => p.id)).toEqual(['joke'])
    expect(offeredProducts({ cdpConfigured: false }).map((p) => p.id)).not.toContain('joke')
    expect(offeredProducts({ cdpConfigured: true }).map((p) => p.id)).toContain('joke')
    // Every other product is offered either way, in the same order.
    expect(offeredProducts({ cdpConfigured: false }).map((p) => p.id)).toEqual(
      offeredProducts({ cdpConfigured: true }).map((p) => p.id).filter((id) => id !== 'joke'),
    )
  })

  it('has a buy_joke tool with no arguments, and one-time metadata', () => {
    expect(productToolArgs(PRODUCTS.joke)).toEqual({ toolName: 'buy_joke' })
    const metadata = buildProductMetadata(PRODUCTS.joke, {
      enabledSettlementMethods: ['eip3009', 'erc7710'],
      mcpUrl: 'http://127.0.0.1/mcp',
    })
    expect(metadata).toMatchObject({
      product_id: 'joke',
      price_atomic: '10000',
      billing_period: 'one_time',
      tool_name: 'buy_joke',
      supported_settlement_methods: ['eip3009'],
      default_settlement_method: 'eip3009',
      arguments_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    })
  })
})

describe('checkout details (#4873)', () => {
  it('one product asks, and every other product asks for nothing', () => {
    const asking = Object.values(PRODUCTS)
      .filter((product) => checkoutDetailsForProduct(product) !== undefined)
      .map((product) => product.id)
    expect(asking).toEqual(['vpn_pro'])
  })

  it('the asking product wants a receipt email and a billing address, both optional', () => {
    expect(checkoutDetailsForProduct(PRODUCTS.vpn_pro)).toEqual({
      fields: {
        receipt_email: { required: false },
        billing_address: { required: false },
      },
    })
  })

  it('the dev-only hook turns one of the product’s optional fields into a required one', () => {
    expect(checkoutDetailsForProduct(PRODUCTS.vpn_pro, { requiredField: 'receipt_email' })).toEqual({
      fields: {
        receipt_email: { required: true },
        billing_address: { required: false },
      },
    })
    // A field the product does not ask for is not added by the hook.
    expect(checkoutDetailsForProduct(PRODUCTS.vpn_pro, { requiredField: 'shipping_address' })).toEqual(
      checkoutDetailsForProduct(PRODUCTS.vpn_pro),
    )
    // A product that asks for nothing stays that way.
    expect(checkoutDetailsForProduct(PRODUCTS.vpn_basic, { requiredField: 'receipt_email' })).toBeUndefined()
  })

  it('reads the dev-only hook from the environment, testnet-only', () => {
    expect(requiredCheckoutFieldFromEnv({}, 84532)).toBeNull()
    expect(requiredCheckoutFieldFromEnv({ [CHECKOUT_DETAILS_REQUIRED_FIELD_ENV]: '  ' }, 84532)).toBeNull()
    expect(requiredCheckoutFieldFromEnv({ [CHECKOUT_DETAILS_REQUIRED_FIELD_ENV]: 'receipt_email' }, 84532)).toBe(
      'receipt_email',
    )
    expect(() => requiredCheckoutFieldFromEnv({ [CHECKOUT_DETAILS_REQUIRED_FIELD_ENV]: 'receipt_email' }, 8453)).toThrow(
      /dev-only hook/,
    )
    expect(() => requiredCheckoutFieldFromEnv({ [CHECKOUT_DETAILS_REQUIRED_FIELD_ENV]: 'phone' }, 84532)).toThrow(
      /must be one of/,
    )
  })
})

describe('MERCHANT_SALES_ALL_PRODUCTS', () => {
  const SALES = '0x3333333333333333333333333333333333333333' as const
  const DEPOSIT = '0x4444444444444444444444444444444444444444' as const

  it('pays every product into the Sales account when on', () => {
    for (const product of Object.values(PRODUCTS)) {
      expect(productReceivingAddress(product, MERCHANT_DEFAULT, { salesAddress: SALES, allProductsToSales: true })).toBe(
        SALES,
      )
    }
  })

  it('leaves every product on the merchant default when off', () => {
    expect(productReceivingAddress(PRODUCTS.vpn_basic, MERCHANT_DEFAULT, { salesAddress: SALES })).toBe(MERCHANT_DEFAULT)
    expect(
      productReceivingAddress(PRODUCTS.vpn_basic, MERCHANT_DEFAULT, { salesAddress: SALES, allProductsToSales: false }),
    ).toBe(MERCHANT_DEFAULT)
  })

  it('still pays a Stripe-recorded product to the deposit address', () => {
    expect(
      productReceivingAddress(PRODUCTS.joke, MERCHANT_DEFAULT, {
        salesAddress: SALES,
        stripeDepositAddress: DEPOSIT,
        allProductsToSales: true,
      }),
    ).toBe(DEPOSIT)
  })

  it('does nothing without a Sales address', () => {
    expect(productReceivingAddress(PRODUCTS.vpn_basic, MERCHANT_DEFAULT, { allProductsToSales: true })).toBe(
      MERCHANT_DEFAULT,
    )
  })
})
