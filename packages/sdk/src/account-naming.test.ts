/**
 * #2908 (naming epic #2906, phase 1) — the SDK reads BOTH names and prefers
 * the new, and emits both camelCase names with one value.
 *
 * Every reader here has an OLD-shape input (a pre-#2907 server: `safe_address`
 * / `components.safe` only), a NEW-shape input (`account_address` /
 * `components.payer_account` only — what the server emits after #2914) and a
 * BOTH-shape input (the window). The mutations these fail on, each run by
 * hand before the PR:
 *   - drop `account_address` from `readAccountAddress`  → the new-only cases fail
 *   - drop the `safe_address` fallback                  → the old-only cases fail
 *   - read `components.account` instead of `payer_account` in the receipt
 *     builder                                           → the delegate-trap
 *                                                          fixture fails
 */
import { describe, expect, it } from 'vitest'
import {
  accountAddressTwins,
  readAccountAddress,
  readAccountId,
  readX402ReceiptPayer,
} from './account-naming.js'
import { AccountReads } from './account-reads.js'
import { X402FundingLeg } from './x402-funding-leg.js'
import type { HavenApiTransport } from './haven-api-transport.js'
import {
  AgentPaymentNextAction,
  AgentPaymentNextActionAccountAlias,
  canonicalAgentPaymentNextAction,
  isFundAccountOrRaiseAllowance,
  type AgentNextStep,
  type RawX402AuthorizeResponse,
  type X402PaymentOption,
  type X402PaymentRequired,
} from './types.js'
import { mapPaymentStatusResult } from './payment-mappers.js'
import { paymentStateFromRaw } from './payment-state.js'

const PAYER = '0x' + 'a1'.repeat(20)
const DELEGATE = '0x' + 'd3'.repeat(20)

describe('readAccountAddress / readAccountId — new name first, old name kept', () => {
  it('old shape: safe_address only', () => {
    expect(readAccountAddress({ safe_address: PAYER })).toBe(PAYER)
    expect(readAccountId({ safe_id: 's1' })).toBe('s1')
  })
  it('new shape: account_address only', () => {
    expect(readAccountAddress({ account_address: PAYER })).toBe(PAYER)
    expect(readAccountId({ account_id: 'a1' })).toBe('a1')
  })
  it('both: the new name wins', () => {
    expect(readAccountAddress({ account_address: PAYER, safe_address: '0xold' })).toBe(PAYER)
    expect(readAccountId({ account_id: 'a1', safe_id: 's1' })).toBe('a1')
  })
  it('neither: undefined, never an empty string', () => {
    expect(readAccountAddress({})).toBeUndefined()
    expect(readAccountAddress({ safe_address: null, account_address: null })).toBeUndefined()
  })
  it('accountAddressTwins with NEITHER name present yields undefined under both keys, never a blank string', () => {
    // Off-contract server (no `safe_address`, no `account_address`): the
    // pre-#2908 read produced `undefined`; a fabricated '' would be a
    // present-but-blank address for the hosted MCP output and the sweep.
    const out = accountAddressTwins(undefined)
    expect(out.accountAddress).toBeUndefined()
    expect(out.safeAddress).toBeUndefined()
    expect(out.accountAddress).not.toBe('')
  })

  it('accountAddressTwins puts one value under both keys', () => {
    expect(accountAddressTwins(PAYER)).toEqual({ accountAddress: PAYER, safeAddress: PAYER })
  })
})

describe('AccountReads mappers emit both camelCase names (the hosted haven_get_agent shape)', () => {
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

  it.each([
    ['old-only', { safe_address: PAYER }],
    ['new-only', { account_address: PAYER }],
    ['both', { account_address: PAYER, safe_address: PAYER }],
  ] as const)('getAgent — %s server shape → accountAddress === safeAddress', async (_label, twins) => {
    const reads = readsWith({ ...agentBase, ...twins }, { ...allowanceBase, ...twins })
    const agent = await reads.getAgent()
    expect(agent.accountAddress).toBe(PAYER)
    expect(agent.safeAddress).toBe(PAYER)
    const summary = await reads.getAllowances()
    expect(summary.accountAddress).toBe(PAYER)
    expect(summary.safeAddress).toBe(PAYER)
    const full = await reads.getAgentSummary()
    expect(full.accountAddress).toBe(full.safeAddress)
  })
})

describe('x402 receipt payer — the #2908 fallback chain', () => {
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
    components: { token: 't', to: 'x', amount: '1', payment_token: 't', payment: 'p', nonce: 1, safe: '', ...over },
  })

  it('old-only server: payer from safe_address', () => {
    expect(readX402ReceiptPayer({ ...base, safe_address: PAYER })).toBe(PAYER)
    expect(leg.receiptFromAuthorization(required, option, undefined, { ...base, safe_address: PAYER }).payer).toBe(PAYER)
  })
  it('old-only server, address only inside sign_data: payer from components.safe', () => {
    const raw = { ...base, sign_data: components({ safe: PAYER }) } as RawX402AuthorizeResponse
    expect(leg.receiptFromAuthorization(required, option, undefined, raw).payer).toBe(PAYER)
  })
  it('new-only server: payer from account_address', () => {
    expect(leg.receiptFromAuthorization(required, option, undefined, { ...base, account_address: PAYER }).payer).toBe(PAYER)
  })
  it('new-only server, address only inside sign_data: payer from components.payer_account', () => {
    const raw = { ...base, sign_data: components({ safe: '', payer_account: PAYER }) } as RawX402AuthorizeResponse
    // `safe: ''` is what an empty-string old key would look like; the chain
    // uses `??`, so an empty string is NOT skipped — only absence is. Delete
    // it to model a post-#2914 server that no longer sends the key at all.
    delete (raw.sign_data!.components as { safe?: string }).safe
    expect(leg.receiptFromAuthorization(required, option, undefined, raw).payer).toBe(PAYER)
  })
  it('both: the explicit payer wins, then the new names before the old', () => {
    expect(readX402ReceiptPayer({ payer: PAYER, account_address: '0xnew', safe_address: '0xold' })).toBe(PAYER)
    expect(readX402ReceiptPayer({ account_address: PAYER, safe_address: '0xold' })).toBe(PAYER)
    expect(
      readX402ReceiptPayer({ safe_address: '0xold', sign_data: { components: { payer_account: PAYER, safe: '0xold' } } }),
    ).toBe(PAYER)
  })
  it('never reads components.account — that is the DELEGATE, a different address', () => {
    // The trap the epic names: the funding shapes already carry
    // `components.account` = delegate account address. A builder that read it
    // (mutation c) would put the delegate on the receipt as the payer.
    const raw = {
      ...base,
      sign_data: components({ safe: PAYER, payer_account: PAYER, account: DELEGATE }),
    } as RawX402AuthorizeResponse
    const receipt = leg.receiptFromAuthorization(required, option, undefined, raw)
    expect(receipt.payer).toBe(PAYER)
    expect(receipt.payer).not.toBe(DELEGATE)
    // And with ONLY the delegate present, the chain yields nothing rather
    // than the wrong address.
    expect(readX402ReceiptPayer({ sign_data: { components: { account: DELEGATE } } })).toBeUndefined()
  })
})

describe('AgentPaymentNextAction — both enum spellings are handled (#2908)', () => {
  it('the alias collapses onto the canonical value; everything else passes through', () => {
    expect(canonicalAgentPaymentNextAction('fund_account_or_raise_allowance')).toBe('fund_safe_or_raise_allowance')
    expect(canonicalAgentPaymentNextAction('fund_safe_or_raise_allowance')).toBe('fund_safe_or_raise_allowance')
    expect(canonicalAgentPaymentNextAction('stop_and_tell_user')).toBe('stop_and_tell_user')
    expect(canonicalAgentPaymentNextAction(undefined)).toBeUndefined()
    expect(canonicalAgentPaymentNextAction(null)).toBeNull()
    expect(canonicalAgentPaymentNextAction('something_unknown')).toBe('something_unknown')
  })

  it('isFundAccountOrRaiseAllowance matches either spelling and nothing else', () => {
    expect(isFundAccountOrRaiseAllowance(AgentPaymentNextAction.FundSafeOrRaiseAllowance)).toBe(true)
    expect(isFundAccountOrRaiseAllowance(AgentPaymentNextActionAccountAlias.FundAccountOrRaiseAllowance)).toBe(true)
    expect(isFundAccountOrRaiseAllowance(AgentPaymentNextAction.StopAndTellUser)).toBe(false)
    expect(isFundAccountOrRaiseAllowance(undefined)).toBe(false)
  })

  it('a switch on the old literal does not fall through on the new one, and vice versa', () => {
    // The AC's exact sentence. Both directions: a switch written against the
    // taxonomy const, fed each wire spelling through the canonical seam.
    const route = (wire: AgentNextStep['next_action']): 'fund' | 'other' => {
      switch (canonicalAgentPaymentNextAction(wire)) {
        case AgentPaymentNextAction.FundSafeOrRaiseAllowance:
          return 'fund'
        default:
          return 'other'
      }
    }
    expect(route('fund_safe_or_raise_allowance')).toBe('fund')
    expect(route('fund_account_or_raise_allowance')).toBe('fund')
    expect(route('stop_and_tell_user')).toBe('other')
    // Type-level: AgentNextStep.next_action accepts BOTH spellings.
    const step: AgentNextStep = { next_action: 'fund_account_or_raise_allowance', safe_to_continue: false, reason: 'r' }
    expect(step.next_action).toBe('fund_account_or_raise_allowance')
  })

  it('the read boundaries canonicalize: status mapper and raw payment state', () => {
    const status = mapPaymentStatusResult({
      payment_id: 'p1', kind: 'x402', rail: 'x402', status: 'failed', phase: 'insufficient_funds',
      next_action: 'fund_account_or_raise_allowance', amount: '1', token: 'USDC', resource_url: null,
      merchant_address: null, tx_hash: null, expires_at: null, chain_id: 84532, message: null, fee: null,
    } as never)
    expect(status.nextAction).toBe(AgentPaymentNextAction.FundSafeOrRaiseAllowance)

    const state = paymentStateFromRaw('x402', {
      payment_id: 'p1', status: 'failed', phase: 'insufficient_funds', next_action: 'fund_account_or_raise_allowance',
    } as RawX402AuthorizeResponse)
    expect(state?.nextAction).toBe(AgentPaymentNextAction.FundSafeOrRaiseAllowance)
    // And the old spelling is untouched.
    const old = paymentStateFromRaw('x402', {
      payment_id: 'p1', status: 'failed', phase: 'insufficient_funds', next_action: 'fund_safe_or_raise_allowance',
    } as RawX402AuthorizeResponse)
    expect(old?.nextAction).toBe(AgentPaymentNextAction.FundSafeOrRaiseAllowance)
  })
})
