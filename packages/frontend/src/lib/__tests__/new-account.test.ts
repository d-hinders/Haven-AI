import { describe, expect, it } from 'vitest'
import { toHex } from 'viem'
import { ApiRequestError } from '@/lib/api'
import { base64UrlEncode } from '@/lib/passkey'
import type { SmartAccount } from '@/context/AuthContext'
import {
  ACCOUNT_CAP_REACHED,
  KEY_NOT_ON_SOURCE,
  SOURCE_ACCOUNT_NOT_FOUND,
  SOURCE_HAS_NO_PASSKEY,
  allowCredentialIdsFor,
  classifyCreateAccountError,
  defaultSource,
  findCreatedAccount,
  keyIdFromCredentialId,
  passkeySources,
  sourceChoiceMatters,
  sourceHoldsKey,
} from '@/lib/new-account'

function account(id: string, isDefault = false, chainId = 84532): SmartAccount {
  return {
    id,
    account_address: `0x${id.padEnd(40, '0')}`,
    chain_id: chainId,
    name: `Account ${id}`,
    is_default: isDefault,
    created_at: '2026-06-01T00:00:00Z',
  }
}

const KEY_A = toHex(new TextEncoder().encode('passkey-a'))
const KEY_B = toHex(new TextEncoder().encode('passkey-b'))

function approved(a: SmartAccount) {
  return { account_id: a.id, account_address: a.account_address, account_name: a.name, chain_id: a.chain_id }
}

const ONE = account('one', true)
const TWO = account('two')
const WALLET_ONLY = account('wallet')

const SIGNERS = [
  { kind: 'passkey' as const, key_id: KEY_A, created_at: null, accounts: [approved(ONE), approved(TWO)] },
  { kind: 'passkey' as const, key_id: KEY_B, created_at: null, accounts: [approved(TWO)] },
  { kind: 'wallet' as const, address: '0x1111111111111111111111111111111111111111', accounts: [approved(WALLET_ONLY)] },
]

describe('passkeySources', () => {
  it('lists only accounts with a passkey, in the account list order, with each one’s key ids', () => {
    const sources = passkeySources([WALLET_ONLY, TWO, ONE], SIGNERS)
    expect(sources.map((s) => s.account.id)).toEqual(['two', 'one'])
    expect(sources[0]!.keyIds).toEqual([KEY_A, KEY_B])
    expect(sources[1]!.keyIds).toEqual([KEY_A])
  })

  it('is empty when every account is wallet-only', () => {
    expect(passkeySources([WALLET_ONLY], SIGNERS)).toEqual([])
  })
})

describe('defaultSource', () => {
  const sources = passkeySources([TWO, ONE], SIGNERS)

  it('starts on the scoped account when it has a passkey', () => {
    expect(defaultSource(sources, 'two')?.account.id).toBe('two')
  })

  it('falls back to the default account, not the first in the list', () => {
    expect(defaultSource(sources, null)?.account.id).toBe('one')
    // A scoped account with no passkey is not a source.
    expect(defaultSource(sources, 'wallet')?.account.id).toBe('one')
  })

  it('falls back to the first source when the default has no passkey', () => {
    const withWalletDefault = passkeySources([{ ...WALLET_ONLY, is_default: true }, TWO], SIGNERS)
    expect(defaultSource(withWalletDefault)?.account.id).toBe('two')
  })

  it('is null with no source', () => {
    expect(defaultSource([])).toBeNull()
  })
})

describe('sourceChoiceMatters', () => {
  it('is false when every source holds the same passkeys', () => {
    const sameSet = passkeySources([ONE, account('three')], [
      { kind: 'passkey', key_id: KEY_A, created_at: null, accounts: [approved(ONE), approved(account('three'))] },
    ])
    expect(sameSet).toHaveLength(2)
    expect(sourceChoiceMatters(sameSet)).toBe(false)
  })

  it('is true when the sources hold different passkeys', () => {
    expect(sourceChoiceMatters(passkeySources([ONE, TWO], SIGNERS))).toBe(true)
  })
})

describe('credential id ↔ key_id', () => {
  it('round-trips: the allow-list is base64url of each key_id, and an asserted id maps back to it', () => {
    const [source] = passkeySources([ONE], SIGNERS)
    const [allowed] = allowCredentialIdsFor(source!)
    expect(allowed).toBe(base64UrlEncode(new TextEncoder().encode('passkey-a')))
    expect(keyIdFromCredentialId(allowed!)).toBe(KEY_A)
  })

  it('matches key ids case-insensitively, like the server', () => {
    const [source] = passkeySources([ONE], SIGNERS)
    expect(sourceHoldsKey(source!, KEY_A.toUpperCase().replace('0X', '0x'))).toBe(true)
    expect(sourceHoldsKey(source!, KEY_B)).toBe(false)
  })
})

describe('classifyCreateAccountError — error_code first, never the sentence', () => {
  const refusal = (status: number, body: Record<string, unknown>) =>
    new ApiRequestError(String(body.error ?? ''), status, body)

  it('maps each requested code, whatever the status', () => {
    expect(classifyCreateAccountError(refusal(422, { error: 'x', error_code: ACCOUNT_CAP_REACHED, cap: 10 }))).toEqual({
      kind: 'cap_reached',
      cap: 10,
    })
    expect(classifyCreateAccountError(refusal(422, { error: 'x', error_code: ACCOUNT_CAP_REACHED }))).toEqual({
      kind: 'cap_reached',
      cap: null,
    })
    expect(classifyCreateAccountError(refusal(422, { error: 'x', error_code: SOURCE_HAS_NO_PASSKEY }))).toEqual({
      kind: 'source_has_no_passkey',
    })
    expect(classifyCreateAccountError(refusal(422, { error: 'x', error_code: KEY_NOT_ON_SOURCE }))).toEqual({
      kind: 'key_not_on_source',
    })
    expect(classifyCreateAccountError(refusal(404, { error: 'x', error_code: SOURCE_ACCOUNT_NOT_FOUND }))).toEqual({
      kind: 'source_not_found',
    })
  })

  it('does not read the cap out of the sentence: a code-less 422 is "could not create" with the sentence as detail', () => {
    // The exact sentence #4023's route sends at the cap today.
    const sentence = 'This user already has 10 accounts on chain 84532'
    expect(classifyCreateAccountError(refusal(422, { error: sentence }))).toEqual({
      kind: 'could_not_create',
      detail: sentence,
    })
  })

  it('bounds the passed-through sentence, and drops an empty one', () => {
    const long = classifyCreateAccountError(refusal(422, { error: 'a'.repeat(500) }))
    expect(long).toEqual({ kind: 'could_not_create', detail: 'a'.repeat(200) })
    expect(classifyCreateAccountError(refusal(422, {}))).toEqual({ kind: 'could_not_create', detail: null })
  })

  it('maps the rate limit by status, and every other code-less 4xx to a definite "could not create"', () => {
    expect(classifyCreateAccountError(refusal(429, { error: 'Too Many Requests' }))).toEqual({ kind: 'rate_limited' })
    expect(classifyCreateAccountError(refusal(404, { error: 'Source account not found' }))).toEqual({
      kind: 'could_not_create',
      detail: 'Source account not found',
    })
    expect(classifyCreateAccountError(refusal(409, { error: 'Account already registered' }))).toEqual({
      kind: 'could_not_create',
      detail: 'Account already registered',
    })
    expect(classifyCreateAccountError(refusal(400, { error: 'chain_id is required' }))).toEqual({
      kind: 'could_not_create',
      detail: 'chain_id is required',
    })
    // An unknown code is not guessed at: the status decides.
    expect(classifyCreateAccountError(refusal(400, { error: 'x', error_code: 'SOMETHING_NEW' }))).toEqual({
      kind: 'could_not_create',
      detail: 'x',
    })
  })

  it('reads no answer, or a 5xx, as an UNKNOWN outcome — the account may exist', () => {
    expect(classifyCreateAccountError(refusal(502, { error: 'Could not derive the account address' }))).toEqual({
      kind: 'unknown_outcome',
    })
    expect(classifyCreateAccountError(refusal(500, {}))).toEqual({ kind: 'unknown_outcome' })
    expect(classifyCreateAccountError(new TypeError('Failed to fetch'))).toEqual({ kind: 'unknown_outcome' })
    expect(classifyCreateAccountError(undefined)).toEqual({ kind: 'unknown_outcome' })
  })
})

describe('findCreatedAccount — the unknown-outcome check', () => {
  const before = [account('one', true), account('two')]
  const baseline = new Set(before.map((a) => a.id))

  it('finds an account that was not in the baseline, on the chain the create was sent to', () => {
    const fresh = { ...account('new'), name: 'Reserve' }
    expect(findCreatedAccount([...before, fresh], baseline, 84532, 'Reserve')?.id).toBe('new')
  })

  it('ignores accounts that were already in the baseline, even with the submitted name', () => {
    const renamed = [{ ...before[0]!, name: 'Reserve' }, before[1]!]
    expect(findCreatedAccount(renamed, baseline, 84532, 'Reserve')).toBeNull()
  })

  it('ignores a new account on another chain', () => {
    const elsewhere = { ...account('new', false, 8453), name: 'Reserve' }
    expect(findCreatedAccount([...before, elsewhere], baseline, 84532, 'Reserve')).toBeNull()
  })

  it('never takes a new account with another name: it is not ours', () => {
    const other = { ...account('other'), name: 'Something else' }
    expect(findCreatedAccount([...before, other], baseline, 84532, 'Reserve')).toBeNull()
    const ours = { ...account('ours'), name: 'Reserve' }
    expect(findCreatedAccount([...before, other, ours], baseline, 84532, ' Reserve ')?.id).toBe('ours')
  })
})
