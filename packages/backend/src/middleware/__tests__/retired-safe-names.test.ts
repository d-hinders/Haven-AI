import { describe, expect, it } from 'vitest'
import {
  retiredNameVerdict,
  retiredSafeField,
  retiredSafeQuery,
  withRetiredAccountNameTwin,
  withRetiredAccountsEnvelopeTwin,
} from '../retired-safe-names.js'

const ID = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

describe('retiredNameVerdict — the reliance rule (#2914)', () => {
  it('accepts a request that never mentions the retired name', () => {
    expect(retiredNameVerdict(undefined, ID)).toEqual({ kind: 'ok' })
    expect(retiredNameVerdict(undefined, undefined)).toEqual({ kind: 'ok' })
  })

  it('refuses the retired name ALONE — that caller has not migrated', () => {
    expect(retiredNameVerdict(ID, undefined)).toEqual({ kind: 'refuse', reason: 'retired-only' })
  })

  it('accepts a dual-send that agrees — #2908 told clients to do exactly this', () => {
    expect(retiredNameVerdict(ID, ID)).toEqual({ kind: 'ok' })
  })

  it('refuses a dual-send that disagrees — two answers to one question', () => {
    expect(retiredNameVerdict(ID, OTHER)).toEqual({ kind: 'refuse', reason: 'disagree' })
  })

  // The empty-string cases are the ones a hand-built querystring produces:
  // `?safeId=${id}` with an undefined `id` interpolates to `?safeId=`, and
  // Fastify hands the handler `''`, not `undefined`. Refusing is deliberate
  // — a caller that built an empty filter believes it is filtering, and the
  // whole point of this module is that such a caller hears about it.
  it('treats an EMPTY retired value as present, not absent', () => {
    expect(retiredNameVerdict('', undefined)).toEqual({ kind: 'refuse', reason: 'retired-only' })
    expect(retiredNameVerdict('', ID)).toEqual({ kind: 'refuse', reason: 'disagree' })
    expect(retiredNameVerdict('', '')).toEqual({ kind: 'ok' })
  })
})

describe('refusal bodies carry a routable `replacement`', () => {
  it('names the replacement as a FIELD, not only in prose', () => {
    expect(retiredSafeQuery('safeId', 'accountId').replacement).toBe('accountId')
    expect(retiredSafeField('safe_id', 'account_id').replacement).toBe('account_id')
  })

  it('says WHICH failure it is, so a caller can tell a stale client from a buggy one', () => {
    expect(retiredSafeQuery('safeId', 'accountId', 'retired-only').error).toMatch(/retired \(#2906\)/)
    expect(retiredSafeQuery('safeId', 'accountId', 'disagree').error).toMatch(/different values/)
    expect(retiredSafeField('safe_id', 'account_id', 'disagree').error).toMatch(/different values/)
  })
})

describe('response twins kept for one more release', () => {
  // These are the ONLY two retired names still emitted. `@haven_ai/cli` on
  // `latest` reads both and, unlike a request parameter, cannot dual-read.
  it('`safes` is the SAME array as `accounts`, not a copy with a stale shape', () => {
    const accounts = [{ id: ID }, { id: OTHER }]
    const body = withRetiredAccountsEnvelopeTwin({ accounts })
    expect(body.safes).toEqual(accounts)
    expect(body.safes).toBe(body.accounts)
  })

  it('`safeName` carries the same value as `accountName`, including null', () => {
    expect(withRetiredAccountNameTwin({ accountName: 'Treasury' }).safeName).toBe('Treasury')
    expect(withRetiredAccountNameTwin({ accountName: null }).safeName).toBeNull()
  })

  it('leaves every other field on the row untouched', () => {
    const row = { accountName: 'Treasury', asset: 'USDC', valueFormatted: '1.00' }
    expect(withRetiredAccountNameTwin(row)).toMatchObject(row)
  })
})
