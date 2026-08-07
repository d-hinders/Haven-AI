import { describe, expect, it } from 'vitest'
import { predictSafePasskeySignerAddress } from '../passkey-signer.js'

const FIXTURE_X = '0x11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff' as const
const FIXTURE_Y = '0xffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100' as const

describe('passkey-signer', () => {
  it('matches the frontend-validated Base fixture', () => {
    expect(
      predictSafePasskeySignerAddress({
        x: FIXTURE_X,
        y: FIXTURE_Y,
        chainId: 8453,
      }),
    ).toBe('0xe54122F41f7ADF87fB6d5Ab36BAe42FC2AAc882C')
  })

  it('matches the frontend-validated Gnosis fixture', () => {
    expect(
      predictSafePasskeySignerAddress({
        x: FIXTURE_X,
        y: FIXTURE_Y,
        chainId: 100,
      }),
    ).toBe('0x0802E96a6dd7e1DD80620CF5D759d41B714c0ce2')
  })

  it('is deterministic for repeated inputs', () => {
    const first = predictSafePasskeySignerAddress({
      x: FIXTURE_X,
      y: FIXTURE_Y,
      chainId: 8453,
    })
    const second = predictSafePasskeySignerAddress({
      x: FIXTURE_X,
      y: FIXTURE_Y,
      chainId: 8453,
    })

    expect(second).toBe(first)
  })

  it('throws on unsupported chains', () => {
    expect(() =>
      predictSafePasskeySignerAddress({
        x: FIXTURE_X,
        y: FIXTURE_Y,
        chainId: 1,
      }),
    ).toThrow(/Unsupported chain/)
  })
})
