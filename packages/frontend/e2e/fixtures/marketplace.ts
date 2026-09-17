import type { CatalogEntry, Merchant } from '../../src/hooks/useCatalog'

/**
 * Marketplace fixtures (#3079, epic #3077): three merchants that exercise
 * every rendering branch the grid and merchant page have —
 *
 *   - `ampersendDemoApi`  — live, real third-party content, Sepolia + Base,
 *     three offers, none advertising `erc7710` (the unpinned-budget line).
 *   - `havenDemoStore`    — live, `is_test_merchant`, the "Haven test
 *     merchant" footer/label.
 *   - `bergetAi`          — `coming_soon`, no offers, the merchant-page
 *     "Coming soon — not payable yet" branch. (The real seed is #3080's; this
 *     fixture only exercises the `listing_status` branch this issue builds.)
 */
export const ampersendDemoApi: Merchant = {
  id: 'merchant-ampersend',
  slug: 'ampersend-demo-api',
  name: 'Ampersend Demo API',
  description: 'Fact, joke and quote endpoints — a live x402 sandbox on Base and Base Sepolia.',
  website: 'https://app.ampersend.ai',
  logo_url: null,
  category: 'api',
  country: null,
  listing_status: 'live',
  is_test_merchant: false,
  offer_count: 3,
  networks: ['eip155:84532', 'eip155:8453'],
  verified_payable: true,
}

export const ampersendOffers: CatalogEntry[] = [
  {
    id: 'offer-ampersend-fact',
    name: 'Fact',
    description: 'Returns one random fact.',
    category: 'api',
    resource_url: 'https://services.sandbox.ampersend.ai/api/fact',
    merchant: {
      id: ampersendDemoApi.id,
      slug: ampersendDemoApi.slug,
      name: ampersendDemoApi.name,
      listing_status: 'live',
      is_test_merchant: false,
    },
    rail: 'x402',
    protocol: 'http',
    tool_name: null,
    tool_arguments: null,
    price_display: '$0.001 USDC',
    price_atomic: '1000',
    asset: 'USDC',
    network: 'eip155:84532',
    asset_transfer_methods: null,
    status: 'active',
    verified_at: '2026-09-15T12:00:00.000Z',
    source: 'operator',
    domain_verified: false,
    verified_payable: true,
  },
  {
    id: 'offer-ampersend-joke',
    name: 'Joke',
    description: 'Returns one random joke.',
    category: 'api',
    resource_url: 'https://services.sandbox.ampersend.ai/api/joke',
    merchant: {
      id: ampersendDemoApi.id,
      slug: ampersendDemoApi.slug,
      name: ampersendDemoApi.name,
      listing_status: 'live',
      is_test_merchant: false,
    },
    rail: 'x402',
    protocol: 'http',
    tool_name: null,
    tool_arguments: null,
    price_display: '$0.001 USDC',
    price_atomic: '1000',
    asset: 'USDC',
    network: 'eip155:84532',
    asset_transfer_methods: null,
    status: 'active',
    verified_at: '2026-09-15T12:00:00.000Z',
    source: 'operator',
    domain_verified: false,
    verified_payable: true,
  },
  {
    id: 'offer-ampersend-quote',
    name: 'Quote',
    description: 'Returns one inspirational quote.',
    category: 'api',
    resource_url: 'https://services.ampersend.ai/api/quote',
    merchant: {
      id: ampersendDemoApi.id,
      slug: ampersendDemoApi.slug,
      name: ampersendDemoApi.name,
      listing_status: 'live',
      is_test_merchant: false,
    },
    rail: 'x402',
    protocol: 'http',
    tool_name: null,
    tool_arguments: null,
    price_display: '$0.001 USDC',
    price_atomic: '1000',
    asset: 'USDC',
    network: 'eip155:8453',
    asset_transfer_methods: null,
    status: 'active',
    verified_at: '2026-09-15T12:00:00.000Z',
    source: 'operator',
    domain_verified: false,
    verified_payable: true,
  },
]

export const havenDemoStore: Merchant = {
  id: 'merchant-haven-demo-store',
  slug: 'haven-demo-store',
  name: 'Haven Demo Store',
  description: 'CloudNest and NordShield — Haven-run fixtures for real payments against demo goods.',
  website: null,
  logo_url: null,
  category: 'infrastructure',
  country: null,
  listing_status: 'live',
  is_test_merchant: true,
  offer_count: 1,
  networks: ['eip155:84532'],
  verified_payable: true,
}

export const havenDemoStoreOffers: CatalogEntry[] = [
  {
    id: 'offer-nordshield-vpn',
    name: 'buy_vpn',
    description: 'One month of VPN access.',
    category: 'infrastructure',
    resource_url: 'https://demo-merchant-dev.example/mcp',
    merchant: {
      id: havenDemoStore.id,
      slug: havenDemoStore.slug,
      name: havenDemoStore.name,
      listing_status: 'live',
      is_test_merchant: true,
    },
    rail: 'x402',
    protocol: 'mcp',
    tool_name: 'buy_vpn',
    tool_arguments: null,
    price_display: '$0.05 USDC',
    price_atomic: '50000',
    asset: 'USDC',
    network: 'eip155:84532',
    asset_transfer_methods: 'eip3009,erc7710',
    status: 'active',
    verified_at: '2026-09-15T12:00:00.000Z',
    source: 'operator',
    domain_verified: false,
    verified_payable: true,
  },
]

export const bergetAi: Merchant = {
  id: 'merchant-berget-ai',
  slug: 'berget-ai',
  name: 'Berget AI',
  description: 'Sovereign Swedish inference — OpenAI-compatible API on Swedish data centres.',
  website: 'https://berget.ai',
  logo_url: null,
  category: 'ai',
  country: 'SE',
  listing_status: 'coming_soon',
  is_test_merchant: false,
  offer_count: 0,
  networks: [],
  verified_payable: false,
}

export const marketplaceMerchants: Merchant[] = [ampersendDemoApi, havenDemoStore, bergetAi]
