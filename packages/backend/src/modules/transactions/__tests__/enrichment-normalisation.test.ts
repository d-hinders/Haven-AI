/**
 * Enrichment must not UN-normalise what the row boundary settled (#3129).
 *
 * `enrichTransactionsWithAgents` overwrites `x402MerchantAddress` with the
 * value from `payment_intents`, which the issue's own field observation found
 * lowercase. So normalising only at the two row-producing boundaries was not
 * enough: this pass runs after them and could put the mixed casing back.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ethers } from 'ethers'
import type { EnrichedTransaction } from '../types.js'

const mockFindPaymentIntentAgentMatches = vi.fn()
const mockFindDelegateSweepAgentMatches = vi.fn()

// The repository is the collaborator this test does not own (the pattern
// `initiator-record.test.ts` established): SQL truth stays in the real-DB
// repository suite, the assertion here is about the enrichment mapping.
vi.mock('../../../infra/repositories/transaction-history.js', () => ({
  findPaymentIntentAgentMatches: mockFindPaymentIntentAgentMatches,
  findDelegateSweepAgentMatches: mockFindDelegateSweepAgentMatches,
}))

const { enrichTransactionsWithAgents } = await import('../enrichment.js')

const MERCHANT = ethers.getAddress('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
const HASH = '0x' + 'ab'.repeat(32)

const ROW: EnrichedTransaction = {
  hash: HASH,
  type: 'erc20',
  from: ethers.getAddress('0xab5801a7d398351b8be11c439e05c5b3259aec9b'),
  to: MERCHANT,
  value: '1000000',
  valueFormatted: '1.00',
  asset: 'USDC',
  decimals: 6,
  direction: 'out',
  timestamp: 1_758_189_600,
  timestampSource: 'block',
  blockNumber: 31_337,
  isError: false,
  x402MerchantAddress: MERCHANT,
  chainId: 8453,
  accountId: 'account-1',
  accountAddress: ethers.getAddress('0xab5801a7d398351b8be11c439e05c5b3259aec9b'),
  accountName: 'Main',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFindDelegateSweepAgentMatches.mockResolvedValue([])
})

describe('enrichTransactionsWithAgents address casing (#3129)', () => {
  it('canonicalises the merchant address it overwrites the row with', async () => {
    mockFindPaymentIntentAgentMatches.mockResolvedValue([
      {
        id: 'pi-1',
        tx_hash: HASH,
        account_id: 'account-1',
        chain_id: 8453,
        agent_id: 'agent-1',
        agent_name: 'Buyer',
        source: 'x402',
        payment_resource_url: 'https://merchant.example/r',
        // The form the field run found in this column.
        merchant_address: MERCHANT.toLowerCase(),
        payment_proof_status: 'payment_confirmed',
        payment_reconciliation_event_type: null,
        amount_sek: null,
        fx_rate_sek: null,
        fx_source: null,
      },
    ])

    const [enriched] = await enrichTransactionsWithAgents('user-1', [ROW])

    expect(enriched.agentId).toBe('agent-1') // the overwrite really happened
    expect(enriched.x402MerchantAddress).toBe(MERCHANT)
  })

  it('CONTROL: the fixture supplies the lowercase form, so the assertion can fail', () => {
    expect(MERCHANT).not.toBe(MERCHANT.toLowerCase())
  })

  it('leaves a null merchant address null, keeping the row value', async () => {
    mockFindPaymentIntentAgentMatches.mockResolvedValue([
      {
        id: 'pi-1',
        tx_hash: HASH,
        account_id: 'account-1',
        chain_id: 8453,
        agent_id: 'agent-1',
        agent_name: 'Buyer',
        source: 'x402',
        payment_resource_url: null,
        merchant_address: null,
        payment_proof_status: 'payment_confirmed',
        payment_reconciliation_event_type: null,
        amount_sek: null,
        fx_rate_sek: null,
        fx_source: null,
      },
    ])

    const [enriched] = await enrichTransactionsWithAgents('user-1', [ROW])

    expect(enriched.x402MerchantAddress).toBe(MERCHANT)
  })
})
