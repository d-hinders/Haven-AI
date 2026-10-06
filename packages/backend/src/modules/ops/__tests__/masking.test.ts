import { describe, expect, it } from 'vitest'
import { maskEmail, maskFreeText, maskHex, maskName, maskSearchTerm } from '../masking.js'

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

  it('masks free text to a length only — no prefix, no excerpt (#3602)', () => {
    // Nothing from the content survives: not the first characters, not a hash, only the count.
    const leaky = 'the bundler url is https://rpc.example/v2/84532?apikey=LEAKED_SECRET_123'
    const masked = maskFreeText(leaky)
    expect(masked).toBe('72 characters')
    expect(masked).not.toContain('rpc.example')
    expect(masked).not.toContain('LEAKED')
    expect(maskFreeText('hi')).toBe('2 characters')
    expect(maskFreeText('')).toBe('(empty)')
    expect(maskFreeText('   ')).toBe('(empty)')
  })
})
