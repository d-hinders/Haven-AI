/**
 * #2907: equality tests for the dual-emit mappers — every new field must
 * equal its old twin, and the old field must be untouched. Each test
 * mutation-proves itself by asserting a DIFFERENT source field would produce
 * a different (wrong) twin, so a copy-paste that aliases the wrong source
 * field fails here too.
 */
import { describe, expect, it } from 'vitest'
import {
  withAccountAddressAlias,
  withActivityPaymentAccountAlias,
  withAgentAccountAlias,
  withDashboardAgentAccountAlias,
  withFailedAccountIdsAlias,
  withSessionAccountAddressAlias,
  withTransactionAccountAlias,
} from './wire-aliases.js'

describe('#2907 wire-alias mappers — old === new, old untouched', () => {
  it('withAccountAddressAlias', () => {
    const row = { id: 'x', safe_address: '0xabc', chain_id: 8453 }
    const out = withAccountAddressAlias(row)
    expect(out.account_address).toBe(out.safe_address)
    expect(out.account_address).toBe('0xabc')
    expect(out.safe_address).toBe('0xabc')
  })

  it('withAgentAccountAlias — all four twins equal their source', () => {
    const agent = {
      safe_id: 'id-1',
      safe_address: '0xabc',
      safe_name: 'My account',
      safe_chain_id: 8453,
    }
    const out = withAgentAccountAlias(agent)
    expect(out.account_id).toBe(agent.safe_id)
    expect(out.account_address).toBe(agent.safe_address)
    expect(out.account_name).toBe(agent.safe_name)
    expect(out.account_chain_id).toBe(agent.safe_chain_id)
    // Old fields untouched.
    expect(out.safe_id).toBe('id-1')
    expect(out.safe_address).toBe('0xabc')
  })

  it('withAgentAccountAlias — a null-safe agent dual-emits null, not a crash', () => {
    const agent = { safe_id: null, safe_address: null, safe_name: null, safe_chain_id: null }
    const out = withAgentAccountAlias(agent)
    expect(out.account_id).toBeNull()
    expect(out.account_address).toBeNull()
  })

  it('withTransactionAccountAlias', () => {
    const tx = { safeId: 'id-1', safeAddress: '0xabc', safeName: 'My account', hash: '0x1' }
    const out = withTransactionAccountAlias(tx)
    expect(out.accountId).toBe(tx.safeId)
    expect(out.accountAddress).toBe(tx.safeAddress)
    expect(out.accountName).toBe(tx.safeName)
    expect(out.hash).toBe('0x1')
  })

  it('withDashboardAgentAccountAlias', () => {
    const agent = { id: 'a-1', safeId: 'id-1', safeName: 'My account', safeChainId: 8453 }
    const out = withDashboardAgentAccountAlias(agent)
    expect(out.accountId).toBe(agent.safeId)
    expect(out.accountName).toBe(agent.safeName)
    expect(out.accountChainId).toBe(agent.safeChainId)
  })

  it('withFailedAccountIdsAlias', () => {
    const body = { failedSafeIds: ['id-1', 'id-2'], total: 2 }
    const out = withFailedAccountIdsAlias(body)
    expect(out.failedAccountIds).toEqual(out.failedSafeIds)
    expect(out.failedAccountIds).toEqual(['id-1', 'id-2'])
  })

  it('withActivityPaymentAccountAlias', () => {
    const payment = { safe_id: 'id-1', safe_address: '0xabc', safe_name: 'My account', id: 'p-1' }
    const out = withActivityPaymentAccountAlias(payment)
    expect(out.account_id).toBe(payment.safe_id)
    expect(out.account_address).toBe(payment.safe_address)
    expect(out.account_name).toBe(payment.safe_name)
    expect(out.id).toBe('p-1')
  })

  it('withActivityPaymentAccountAlias — null-safe payment dual-emits null', () => {
    const payment = { safe_id: null, safe_address: null, safe_name: null }
    const out = withActivityPaymentAccountAlias(payment)
    expect(out.account_id).toBeNull()
    expect(out.account_address).toBeNull()
    expect(out.account_name).toBeNull()
  })

  it('withSessionAccountAddressAlias', () => {
    const user = { id: 'u-1', safe_address: '0xabc' }
    const out = withSessionAccountAddressAlias(user)
    expect(out.account_address).toBe(user.safe_address)
  })

  // Mutation proof: if a mapper were edited to alias the WRONG source field
  // (a plausible copy-paste mistake — e.g. safe_name instead of safe_id),
  // this test's shape would catch it because the two source values differ.
  it('mutation proof — distinct source values catch a swapped-field mapper', () => {
    const agent = {
      safe_id: 'id-1',
      safe_address: '0xabc',
      safe_name: 'distinct-name',
      safe_chain_id: 8453,
    }
    const out = withAgentAccountAlias(agent)
    expect(out.account_id).not.toBe(out.account_name)
    expect(out.account_id).toBe('id-1')
    expect(out.account_name).toBe('distinct-name')
  })
})
