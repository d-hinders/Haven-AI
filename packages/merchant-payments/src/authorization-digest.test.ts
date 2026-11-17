import { describe, expect, it } from 'vitest'
import { authorizationDigest } from './authorization-digest.js'

const authorization = {
  from: '0x1111111111111111111111111111111111111111',
  to: '0x2222222222222222222222222222222222222222',
  value: '10000',
  validAfter: '0',
  validBefore: '1900000000',
  nonce: `0x${'ab'.repeat(32)}`,
}
const signature = `0x${'cd'.repeat(65)}`

describe('authorizationDigest (#4893, design 12 section 6)', () => {
  it('is a SHA-256 hex digest', () => {
    expect(authorizationDigest(authorization, signature)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('does not depend on address, nonce or signature letter case, or on integer notation', () => {
    const same = authorizationDigest(
      {
        ...authorization,
        from: authorization.from.toUpperCase().replace('0X', '0x'),
        nonce: authorization.nonce.toUpperCase().replace('0X', '0x'),
        value: '0x2710',
      },
      signature.toUpperCase().replace('0X', '0x'),
    )
    expect(same).toBe(authorizationDigest(authorization, signature))
  })

  it.each([
    ['from', { from: '0x3333333333333333333333333333333333333333' }],
    ['to', { to: '0x3333333333333333333333333333333333333333' }],
    ['value', { value: '10001' }],
    ['validAfter', { validAfter: '1' }],
    ['validBefore', { validBefore: '1900000001' }],
    ['nonce', { nonce: `0x${'ac'.repeat(32)}` }],
  ])('changes when %s changes', (_field, change) => {
    expect(authorizationDigest({ ...authorization, ...change }, signature)).not.toBe(
      authorizationDigest(authorization, signature),
    )
  })

  it('changes when the signature changes', () => {
    expect(authorizationDigest(authorization, `0x${'ce'.repeat(65)}`)).not.toBe(
      authorizationDigest(authorization, signature),
    )
  })
})
