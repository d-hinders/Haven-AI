// db-mock-exempt: pure builder test — no DB, no chain
/**
 * #3616 — the `delegation_budget_exceeded` builder, table-tested FIELD FOR
 * FIELD against the nine current sites' output for the same inputs (the
 * hosted MCP parses this body, #3504 — field names are wire).
 *
 * Every expected literal below is composed from the exact call the site
 * makes, with the sites' own formatters (`formatTokenAmount` for the direct
 * route and the sign-leg fallback, `formatTokenValue` for the x402 legs and
 * the hosted pre-check) and the shared taxonomy enums. The per-flavor
 * differences are the ones the sites actually exhibit (see refusal-body.ts's
 * header table):
 *
 * - prose: 4 spellings (direct / x402 / mpp / sign-leg past tense);
 * - formatting: bigint-spelling vs string-spelling — observable at 0
 *   ('0.0' vs '0');
 * - rail: direct + x402 + sign-leg (the intent's own), never mpp;
 * - payee fields: `recipient` vs `network`+`resource_url`+`merchant_address`
 *   vs `resource_url`(+optional `merchant_address`).
 */
import { describe, expect, it } from 'vitest'
import {
  buildPeriodExceededBody,
  periodExceededLedgerDetail,
  taskCapExceededLedgerDetail,
} from '../refusal-body.js'
import { AgentPaymentNextAction, AgentPaymentPhase } from '../../../domain/agent-payment-taxonomy.js'

// 0.005 USDC = 5000 atomic; remaining 500 = 0.0005; shortfall 4500 = 0.0045.
const BASE = {
  chainId: 84532,
  tokenSymbol: 'USDC',
  tokenAddress: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  decimals: 6,
  amountAtomic: '5000',
  remainingAtomic: '500',
}

const DIRECT_PROSE =
  'This payment of 0.005 USDC exceeds the agent\'s remaining budget for this ' +
  'period (0.0005 USDC, short by 0.0045). There is no approval ' +
  'queue on the delegation rail — an over-budget redemption reverts on-chain. Ask the wallet owner ' +
  'to grant or raise the budget in Haven, or wait for the period to reset.'
const X402_PROSE =
  'This x402 payment of 0.005 USDC exceeds the agent\'s remaining ' +
  'budget for this period (0.0005 USDC, short by 0.0045). ' +
  'There is no approval queue on the delegation rail — an over-budget redemption reverts ' +
  'on-chain. Ask the wallet owner to grant or raise the budget in Haven, then retry.'
const MPP_PROSE =
  'This payment of 0.005 USDC exceeds the agent\'s remaining ' +
  'budget for this period (0.0005 USDC, short by 0.0045 USDC). ' +
  'There is no approval queue on the delegation rail — an over-budget redemption reverts ' +
  'on-chain. Ask the wallet owner to grant or raise the budget in Haven, then retry.'
const SIGN_LEG_PROSE =
  'This payment of 0.005 USDC exceeded the agent\'s ' +
  'remaining budget for this period by the time it was signed. There is no approval ' +
  'queue on the delegation rail — ask the wallet owner to grant or raise the budget in ' +
  'Haven, or wait for the period to reset, then sign a NEW payment.'

describe('buildPeriodExceededBody — field-for-field against the nine sites (#3616)', () => {
  it('site 1 — routes/payments.ts:783 create-time pre-check (direct)', () => {
    const body = buildPeriodExceededBody({
      ...BASE,
      flavor: 'direct',
      amount: '0.005',
      recipient: '0xcccccccccccccccccccccccccccccccccccccccc',
    })
    // routes/payments.ts composes the body in this exact field set; formatTokenAmount
    // (bigint in) formats remaining/shortfall.
    expect(body).toEqual({
      error: DIRECT_PROSE,
      error_code: 'delegation_budget_exceeded',
      phase: AgentPaymentPhase.InsufficientFunds,
      next_action: AgentPaymentNextAction.FundAccountOrRaiseAllowance,
      rail: 'direct',
      chain_id: 84532,
      token: 'USDC',
      asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
      amount: '0.005',
      amount_atomic: '5000',
      remaining: '0.0005',
      remaining_atomic: '500',
      shortfall: '0.0045',
      shortfall_atomic: '4500',
      recipient: '0xcccccccccccccccccccccccccccccccccccccccc',
    })
  })

  it('sites 3+4 — delegation-authorize.ts:486/:930 x402 legs (network, resource, merchant)', () => {
    const body = buildPeriodExceededBody({
      ...BASE,
      flavor: 'x402',
      amount: '0.005',
      network: 'base-sepolia',
      resourceUrl: 'https://merchant.example/resource',
      merchantAddress: '0x' + 'ee'.repeat(20),
    })
    expect(body).toEqual({
      error: X402_PROSE,
      error_code: 'delegation_budget_exceeded',
      phase: AgentPaymentPhase.InsufficientFunds,
      next_action: AgentPaymentNextAction.FundAccountOrRaiseAllowance,
      rail: 'x402',
      chain_id: 84532,
      token: 'USDC',
      asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
      network: 'base-sepolia',
      amount: '0.005',
      amount_atomic: '5000',
      remaining: '0.0005',
      remaining_atomic: '500',
      shortfall: '0.0045',
      shortfall_atomic: '4500',
      resource_url: 'https://merchant.example/resource',
      merchant_address: '0x' + 'ee'.repeat(20),
    })
  })

  it('site 5 — mpp/budget-precheck.ts:404 hosted prepare (no rail, derived amount, optional merchant)', () => {
    // No payee named: no merchant_address field (the site spreads it conditionally).
    const body = buildPeriodExceededBody({
      ...BASE,
      flavor: 'mpp',
      resourceUrl: 'https://catalog.example/item',
    })
    expect(body).toEqual({
      error: MPP_PROSE,
      error_code: 'delegation_budget_exceeded',
      phase: AgentPaymentPhase.InsufficientFunds,
      next_action: AgentPaymentNextAction.FundAccountOrRaiseAllowance,
      chain_id: 84532,
      token: 'USDC',
      asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
      // The hosted site derives the human amount from the atomic figure.
      amount: '0.005',
      amount_atomic: '5000',
      remaining: '0.0005',
      remaining_atomic: '500',
      shortfall: '0.0045',
      shortfall_atomic: '4500',
      resource_url: 'https://catalog.example/item',
    })

    // With a payee: merchant_address appears.
    const withMerchant = buildPeriodExceededBody({
      ...BASE,
      flavor: 'mpp',
      resourceUrl: 'https://catalog.example/item',
      merchantAddress: '0x' + 'ee'.repeat(20),
    })
    expect(withMerchant.merchant_address).toBe('0x' + 'ee'.repeat(20))
    expect(Object.keys(withMerchant).length).toBe(Object.keys(body).length + 1)
  })

  it('site 5 — the #3518 budget-report block rides extraFields verbatim', () => {
    const body = buildPeriodExceededBody({
      ...BASE,
      flavor: 'mpp',
      resourceUrl: 'https://catalog.example/item',
      merchantAddress: '0x' + 'ee'.repeat(20),
      extraFields: {
        budget_id: 'bd-1',
        budget_delegation_hash: `0x${'ab'.repeat(32)}`,
        budget_recipient_address: '0x' + 'ee'.repeat(20),
        budget_merchant_id: 'm-1',
      },
    })
    expect(body).toMatchObject({
      budget_id: 'bd-1',
      budget_delegation_hash: `0x${'ab'.repeat(32)}`,
      budget_recipient_address: '0x' + 'ee'.repeat(20),
      budget_merchant_id: 'm-1',
      merchant_address: '0x' + 'ee'.repeat(20),
    })
  })

  it('site 2 — routes/payments.ts:1445 sign-leg fallback (502 body under the site wrapper)', () => {
    const body = buildPeriodExceededBody({
      ...BASE,
      flavor: 'payments-sign-leg',
      amount: '0.005',
      rail: 'x402', // intent.payment_rail ?? intent.source ?? Direct — never hardcoded
      recipient: '0x' + 'cc'.repeat(20),
    })
    expect(body).toEqual({
      error: SIGN_LEG_PROSE,
      error_code: 'delegation_budget_exceeded',
      phase: AgentPaymentPhase.InsufficientFunds,
      next_action: AgentPaymentNextAction.FundAccountOrRaiseAllowance,
      rail: 'x402',
      chain_id: 84532,
      token: 'USDC',
      asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
      amount: '0.005',
      amount_atomic: '5000',
      remaining: '0.0005',
      remaining_atomic: '500',
      shortfall: '0.0045',
      shortfall_atomic: '4500',
      recipient: '0x' + 'cc'.repeat(20),
    })
    // The 502 wrapper fields stay at the site ({ payment_id, status: 'failed', …body }).
    expect(body.payment_id).toBeUndefined()
    expect(body.status).toBeUndefined()
  })

  it('formatting flavors: direct spells 0 as 0.0 (formatTokenAmount), x402/mpp as 0 (formatTokenValue)', () => {
    // Both formatters are the sites' own units; at remaining 0 the two
    // spellings visibly differ — the builder keeps each flavor's spelling.
    const direct = buildPeriodExceededBody({
      ...BASE,
      remainingAtomic: '0',
      flavor: 'direct',
      amount: '0.005',
      recipient: '0x' + 'cc'.repeat(20),
    })
    expect(direct.remaining).toBe('0.0')
    expect(direct.shortfall).toBe('0.005')

    const x402 = buildPeriodExceededBody({
      ...BASE,
      remainingAtomic: '0',
      flavor: 'x402',
      amount: '0.005',
      network: 'base-sepolia',
      resourceUrl: 'https://merchant.example/resource',
      merchantAddress: '0x' + 'ee'.repeat(20),
    })
    expect(x402.remaining).toBe('0')
    expect(x402.shortfall).toBe('0.005')

    const mpp = buildPeriodExceededBody({ ...BASE, remainingAtomic: '0', flavor: 'mpp' })
    expect(mpp.remaining).toBe('0')
    expect(mpp.amount).toBe('0.005')
  })

  it('the field-name SET per flavor is exactly the current site\'s (no drift in either direction)', () => {
    const direct = buildPeriodExceededBody({
      ...BASE,
      flavor: 'direct',
      amount: '0.005',
      recipient: '0xcccccccccccccccccccccccccccccccccccccccc',
    })
    expect(Object.keys(direct).sort()).toEqual(
      [
        'error', 'error_code', 'phase', 'next_action', 'rail', 'chain_id', 'token', 'asset',
        'amount', 'amount_atomic', 'remaining', 'remaining_atomic', 'shortfall', 'shortfall_atomic',
        'recipient',
      ].sort(),
    )

    const x402 = buildPeriodExceededBody({
      ...BASE,
      flavor: 'x402',
      amount: '0.005',
      network: 'base-sepolia',
      resourceUrl: 'u',
      merchantAddress: '0x' + 'ee'.repeat(20),
    })
    expect(Object.keys(x402).sort()).toEqual(
      [
        'error', 'error_code', 'phase', 'next_action', 'rail', 'chain_id', 'token', 'asset', 'network',
        'amount', 'amount_atomic', 'remaining', 'remaining_atomic', 'shortfall', 'shortfall_atomic',
        'resource_url', 'merchant_address',
      ].sort(),
    )

    const mpp = buildPeriodExceededBody({ ...BASE, flavor: 'mpp', resourceUrl: 'u' })
    expect(Object.keys(mpp).sort()).toEqual(
      [
        'error', 'error_code', 'phase', 'next_action', 'chain_id', 'token', 'asset',
        'amount', 'amount_atomic', 'remaining', 'remaining_atomic', 'shortfall', 'shortfall_atomic',
        'resource_url',
      ].sort(),
    )
  })
})

describe('the ledger details (sites 2/5/7/9 + the task-cap writers)', () => {
  it('periodExceededLedgerDetail — the 086/087 allowlist subset, exact', () => {
    expect(periodExceededLedgerDetail('500')).toEqual({
      error_code: 'delegation_budget_exceeded',
      phase: AgentPaymentPhase.InsufficientFunds,
      next_action: AgentPaymentNextAction.FundAccountOrRaiseAllowance,
      remaining_atomic: '500',
    })
  })

  it('taskCapExceededLedgerDetail — routes/payments.ts:659 and the x402 cap refusal, exact', () => {
    expect(taskCapExceededLedgerDetail('0')).toEqual({
      error_code: 'task_budget_exceeded',
      remaining_atomic: '0',
    })
  })
})
