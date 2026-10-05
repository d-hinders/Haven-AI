import { describe, expect, it } from 'vitest'
import { maskEmail, maskHex, maskName, maskSearchTerm } from '../masking.js'

describe('ops masking (#3509)', () => {
  it('masks emails to two leading characters and the domain', () => {
    expect(maskEmail('daniel@gmail.com')).toBe('da•••@gmail.com')
    expect(maskEmail('al@x.io')).toBe('a•••@x.io')
    expect(maskEmail('not-an-email')).toBe('•••')
  })

  it('masks addresses and hashes to head and tail', () => {
    expect(maskHex('0x12ab34cd56ef7890aabbccddeeff00119f3c')).toBe('0x12ab…9f3c')
    expect(maskHex('0x1234')).toBe('•••')
  })

  it('masks names to their first character', () => {
    expect(maskName('Ada Lovelace')).toBe('A•••')
    expect(maskName('  ')).toBe('')
  })

  it('never writes a raw search term into the audit form', () => {
    const term = 'customer.person@example.com'
    expect(maskSearchTerm(term)).not.toContain('customer.person')
    expect(maskSearchTerm('0x12ab34cd56ef7890aabbccddeeff00119f3c')).toBe('0x12ab…9f3c')
    expect(maskSearchTerm('abcd')).toBe('•••')
  })
})
