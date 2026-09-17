import { describe, expect, it } from 'vitest'
import {
  agentInstruction,
  freshness,
  isVerified,
  merchantInitials,
  needsUnpinnedBudget,
  networkToChainId,
  withinBudget,
} from '@/lib/marketplace'
import type { CatalogEntry } from '@/hooks/useCatalog'

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: 'cat-1',
    name: 'Text generation',
    description: 'Generate text content.',
    category: 'media',
    resource_url: 'https://mcp.merchant.example/mcp',
    merchant: {
      id: 'merchant-1',
      slug: 'merchant-example',
      name: 'Merchant Example',
      listing_status: 'live',
      is_test_merchant: false,
    },
    rail: 'x402',
    protocol: 'mcp',
    tool_arguments: null,
    asset_transfer_methods: null,
    tool_name: 'create_text',
    price_display: '$0.01 USDC',
    price_atomic: '10000',
    asset: 'USDC',
    network: 'eip155:8453',
    status: 'active',
    verified_at: new Date().toISOString(),
    source: 'operator',
    domain_verified: false,
    verified_payable: false,
    ...overrides,
  }
}

const activeAgent = {
  status: 'active',
  allowances: [{ token_symbol: 'USDC', allowance_amount: '5.00' }],
}

describe('agentInstruction', () => {
  it('uses the pay-via-tool phrasing for MCP merchants', () => {
    expect(agentInstruction(entry())).toBe(
      'Pay https://mcp.merchant.example/mcp via create_text for <what you want>',
    )
  })

  it('uses plain pay phrasing for HTTP x402 merchants', () => {
    expect(agentInstruction(entry({ protocol: 'http', tool_name: null }))).toBe(
      'Pay https://mcp.merchant.example/mcp and return the result',
    )
  })

  it('uses MPP phrasing for MPP merchants', () => {
    expect(agentInstruction(entry({ rail: 'mpp', protocol: 'http', tool_name: null }))).toContain(
      'machine-payment resource',
    )
  })
})

describe('withinBudget', () => {
  it('is true when an active agent allowance covers the price', () => {
    expect(withinBudget(entry(), [activeAgent])).toBe(true)
  })

  it('is false when every allowance is below the price', () => {
    expect(withinBudget(entry({ price_atomic: '99000000' }), [activeAgent])).toBe(false)
  })

  it('ignores paused agents and unknown assets', () => {
    expect(withinBudget(entry(), [{ ...activeAgent, status: 'paused' }])).toBe(null)
    expect(withinBudget(entry({ asset: 'EURe' }), [activeAgent])).toBe(null)
    expect(withinBudget(entry({ price_atomic: null }), [activeAgent])).toBe(null)
  })

  describe('the human-decimal wire shape of allowance_amount (#2295)', () => {
    const human = (amount: string) => [
      { status: 'active', allowances: [{ token_symbol: 'USDC', allowance_amount: amount }] },
    ]

    it('answers rather than degrading to null on a decimal budget', () => {
      expect(withinBudget(entry(), human('5.00'))).toBe(true)
      expect(withinBudget(entry(), human('250.000000'))).toBe(true)
    })

    it('scales by the token decimals rather than comparing raw digits', () => {
      expect(withinBudget(entry({ price_atomic: '1000000' }), human('5.00'))).toBe(true)
      expect(withinBudget(entry({ price_atomic: '99000000' }), human('5.00'))).toBe(false)
      expect(withinBudget(entry({ price_atomic: '1' }), human('0.000001'))).toBe(true)
      expect(withinBudget(entry({ price_atomic: '2' }), human('0.000001'))).toBe(false)
    })

    it('treats a zero budget as a real answer, not an unknown', () => {
      expect(withinBudget(entry(), human('0'))).toBe(false)
    })

    it('still says "cannot answer" when the units genuinely cannot be reconciled', () => {
      expect(withinBudget(entry({ network: 'solana' }), human('5.00'))).toBe(null)
      expect(withinBudget(entry(), human('not-a-number'))).toBe(null)
      expect(withinBudget(entry(), human('1e6'))).toBe(null)
    })
  })
})

describe('networkToChainId', () => {
  it('resolves CAIP-2 and short-name network forms, undefined otherwise', () => {
    expect(networkToChainId('eip155:8453')).toBe(8453)
    expect(networkToChainId('eip155:84532')).toBe(84532)
    expect(networkToChainId('base')).toBe(8453)
    expect(networkToChainId('base-sepolia')).toBe(84532)
    expect(networkToChainId('gnosis')).toBe(100)
    expect(networkToChainId(null)).toBeUndefined()
    expect(networkToChainId('solana')).toBeUndefined()
  })
})

describe('isVerified', () => {
  it('only treats ingestion entries as verified', () => {
    expect(isVerified({ source: 'ingestion' })).toBe(true)
    expect(isVerified({ source: 'operator' })).toBe(false)
  })
})

describe('needsUnpinnedBudget', () => {
  it('is true when the offer never advertised a transfer method', () => {
    expect(needsUnpinnedBudget(null)).toBe(true)
  })

  it('is true when erc7710 is absent from the advertised set', () => {
    expect(needsUnpinnedBudget('eip3009')).toBe(true)
  })

  it('is false once erc7710 is one of the advertised methods', () => {
    expect(needsUnpinnedBudget('eip3009,erc7710')).toBe(false)
    expect(needsUnpinnedBudget('erc7710')).toBe(false)
  })
})

describe('merchantInitials', () => {
  it('takes the first letter of the first and last word for a multi-word name', () => {
    expect(merchantInitials('Ampersend Demo API')).toBe('AA')
    expect(merchantInitials('Haven Demo Store')).toBe('HS')
  })

  it('takes the first two letters of a one-word name', () => {
    expect(merchantInitials('Minifetch')).toBe('MI')
  })
})

describe('freshness', () => {
  it('reports never verified when there is no timestamp', () => {
    expect(freshness(null)).toBe('not yet verified')
  })

  it('reports a recent verification in hours', () => {
    expect(freshness(new Date().toISOString())).toBe('verified just now')
  })
})
