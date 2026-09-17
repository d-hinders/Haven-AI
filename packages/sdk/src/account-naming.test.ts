/**
 * #2914 (naming epic #2906, phase 5 — the CONTRACTION): the #2908
 * compatibility window (read both server-response names, prefer the new;
 * emit both camelCase names; write only the new) is closed. The SDK now
 * reads and emits the account-vocabulary name ONLY — `safe_address` /
 * `safe_id` / `sign_data.components.safe` are no longer read from a server
 * response, and `safeAddress` is no longer emitted on any SDK public shape.
 *
 * Every case below proves the NEW-shape read still works, and a dedicated
 * "old shape is refused" case proves an old-only server response no longer
 * resolves an address rather than silently reading a stale field. The
 * mutations these fail on, each run by hand before the PR:
 *   - reintroduce a `safe_address` fallback on `raw.account_address`
 *     → the "old shape is refused" case fails (it would resolve again)
 *   - read `components.account` instead of `payer_account` in the receipt
 *     builder                                           → the delegate-trap
 *                                                          fixture fails
 *   - reintroduce `fund_safe_or_raise_allowance` as an accepted next_action
 *     value                                              → the enum-rejection
 *                                                          case fails
 */
import { describe, expect, it } from 'vitest'
import { readX402ReceiptPayer } from './account-naming.js'
import { AccountReads } from './account-reads.js'
import { X402FundingLeg } from './x402-funding-leg.js'
import type { HavenApiTransport } from './haven-api-transport.js'
import {
  AgentPaymentNextAction,
  type AgentNextStep,
  type RawX402AuthorizeResponse,
  type X402PaymentOption,
  type X402PaymentRequired,
} from './types.js'
import { mapPaymentStatusResult } from './payment-mappers.js'
import { paymentStateFromRaw } from './payment-state.js'

const PAYER = '0x' + 'a1'.repeat(20)
const DELEGATE = '0x' + 'd3'.repeat(20)

describe('AccountReads mappers emit the account-vocabulary name only (the hosted haven_get_agent shape)', () => {
  function readsWith(agentRaw: Record<string, unknown>, allowanceRaw: Record<string, unknown>) {
    const transport = {
      get: async (path: string) => {
        if (path === '/machine-payments/agent') return agentRaw
        if (path === '/machine-payments/allowances') return allowanceRaw
        throw new Error(`unexpected ${path}`)
      },
    } as unknown as HavenApiTransport
    return new AccountReads({ transport, getPaymentStatus: async () => { throw new Error('unused') } })
  }
  const agentBase = { id: 'a1', name: 'n', status: 'active', delegate_address: DELEGATE, chain_id: 84532, execution_rail: 'delegation' }
  const allowanceBase = { agent_id: 'a1', delegate_address: DELEGATE, chain_id: 84532, allowances: [] }

  it('new-shape server: account_address resolves accountAddress, and no safeAddress key is emitted', async () => {
    const reads = readsWith({ ...agentBase, account_address: PAYER }, { ...allowanceBase, account_address: PAYER })
    const agent = await reads.getAgent()
    expect(agent.accountAddress).toBe(PAYER)
    expect(agent).not.toHaveProperty('safeAddress')
    const summary = await reads.getAllowances()
    expect(summary.accountAddress).toBe(PAYER)
    expect(summary).not.toHaveProperty('safeAddress')
  })

  it('OLD-shape server (safe_address only, the pre-#2907 shape) no longer resolves an address', async () => {
    // The compat window is closed: `safe_address` is not read at all, so an
    // old-only server response resolves to `undefined` — explicit absence,
    // never a silently-reused stale field.
    const reads = readsWith({ ...agentBase, safe_address: PAYER }, { ...allowanceBase, safe_address: PAYER })
    const agent = await reads.getAgent()
    expect(agent.accountAddress).toBeUndefined()
    const summary = await reads.getAllowances()
    expect(summary.accountAddress).toBeUndefined()
  })
})

describe('x402 receipt payer — the post-contraction fallback chain', () => {
  const option: X402PaymentOption = {
    scheme: 'exact', network: 'base-sepolia', amount: '1000', asset: '0x' + 'ee'.repeat(20),
    payTo: '0x' + 'be'.repeat(20), maxTimeoutSeconds: 60,
  }
  const required: X402PaymentRequired = { x402Version: 1, resource: { url: 'https://m.example/x' }, accepts: [option] }
  const leg = new X402FundingLeg({
    delegateKey: undefined, delegateAddress: DELEGATE, x402Wallet: undefined, chainRpcs: {},
    post: async () => { throw new Error('unused') },
    signForData: async () => { throw new Error('unused') },
    assertSignableAuthorizationState: () => undefined,
  })
  const base: RawX402AuthorizeResponse = { payment_id: 'p1', status: 'confirmed', tx_hash: '0xtx', chain_id: 84532 }
  const components = (over: Record<string, string>) => ({
    hash: '0xhash', instructions: '',
    components: { token: 't', to: 'x', amount: '1', payment_token: 't', payment: 'p', nonce: 1, ...over },
  })

  it('reads payer from account_address', () => {
    expect(readX402ReceiptPayer({ ...base, account_address: PAYER })).toBe(PAYER)
    expect(leg.receiptFromAuthorization(required, option, undefined, { ...base, account_address: PAYER }).payer).toBe(PAYER)
  })

  it('reads payer from components.payer_account when no top-level address is present', () => {
    const raw = { ...base, sign_data: components({ payer_account: PAYER }) } as RawX402AuthorizeResponse
    expect(leg.receiptFromAuthorization(required, option, undefined, raw).payer).toBe(PAYER)
  })

  it('the explicit payer wins over account_address, which wins over components.payer_account', () => {
    expect(readX402ReceiptPayer({ payer: PAYER, account_address: '0xnew' })).toBe(PAYER)
    expect(readX402ReceiptPayer({ account_address: PAYER })).toBe(PAYER)
    expect(
      readX402ReceiptPayer({ sign_data: { components: { payer_account: PAYER } } }),
    ).toBe(PAYER)
  })

  it('OLD-shape input (safe_address / components.safe) no longer resolves a payer', () => {
    // The compat window is closed: neither old key is read any more, so an
    // old-only server response resolves to `undefined` rather than silently
    // reusing the field.
    expect(readX402ReceiptPayer({ safe_address: PAYER } as unknown as Parameters<typeof readX402ReceiptPayer>[0])).toBeUndefined()
    expect(
      readX402ReceiptPayer(
        { sign_data: { components: { safe: PAYER } } } as unknown as Parameters<typeof readX402ReceiptPayer>[0],
      ),
    ).toBeUndefined()
  })

  it('never reads components.account — that is the DELEGATE, a different address', () => {
    // The trap the epic names: the funding shapes already carry
    // `components.account` = delegate account address. A builder that read it
    // (mutation c) would put the delegate on the receipt as the payer.
    const raw = {
      ...base,
      sign_data: components({ payer_account: PAYER, account: DELEGATE }),
    } as RawX402AuthorizeResponse
    const receipt = leg.receiptFromAuthorization(required, option, undefined, raw)
    expect(receipt.payer).toBe(PAYER)
    expect(receipt.payer).not.toBe(DELEGATE)
    // And with ONLY the delegate present, the chain yields nothing rather
    // than the wrong address.
    expect(readX402ReceiptPayer({ sign_data: { components: { account: DELEGATE } } })).toBeUndefined()
  })
})

describe('AgentPaymentNextAction — the account-vocabulary spelling is the only one (#2914)', () => {
  it('the taxonomy carries only the new wire value', () => {
    expect(AgentPaymentNextAction.FundAccountOrRaiseAllowance).toBe('fund_account_or_raise_allowance')
    expect(Object.values(AgentPaymentNextAction)).not.toContain('fund_safe_or_raise_allowance')
  })

  it('a switch on the sole literal matches the new spelling and nothing else', () => {
    const route = (wire: AgentNextStep['next_action']): 'fund' | 'other' => {
      switch (wire) {
        case AgentPaymentNextAction.FundAccountOrRaiseAllowance:
          return 'fund'
        default:
          return 'other'
      }
    }
    expect(route('fund_account_or_raise_allowance')).toBe('fund')
    // The retired spelling is an unknown string now — never routed as "fund".
    expect(route('fund_safe_or_raise_allowance' as AgentNextStep['next_action'])).toBe('other')
    expect(route('stop_and_tell_user')).toBe('other')
  })

  it('the read boundaries pass next_action through verbatim — no collapsing seam remains', () => {
    const status = mapPaymentStatusResult({
      payment_id: 'p1', kind: 'x402', rail: 'x402', status: 'failed', phase: 'insufficient_funds',
      next_action: 'fund_account_or_raise_allowance', amount: '1', token: 'USDC', resource_url: null,
      merchant_address: null, tx_hash: null, expires_at: null, chain_id: 84532, message: null, fee: null,
    } as never)
    expect(status.nextAction).toBe(AgentPaymentNextAction.FundAccountOrRaiseAllowance)

    const state = paymentStateFromRaw('x402', {
      payment_id: 'p1', status: 'failed', phase: 'insufficient_funds', next_action: 'fund_account_or_raise_allowance',
    } as RawX402AuthorizeResponse)
    expect(state?.nextAction).toBe(AgentPaymentNextAction.FundAccountOrRaiseAllowance)

    // The retired spelling is no longer canonicalized to anything — it comes
    // through exactly as received, an explicit signal that a caller comparing
    // against the taxonomy constant will not match it.
    const old = paymentStateFromRaw('x402', {
      payment_id: 'p1', status: 'failed', phase: 'insufficient_funds', next_action: 'fund_safe_or_raise_allowance',
    } as RawX402AuthorizeResponse)
    expect(old?.nextAction).toBe('fund_safe_or_raise_allowance')
    expect(old?.nextAction).not.toBe(AgentPaymentNextAction.FundAccountOrRaiseAllowance)
  })
})
