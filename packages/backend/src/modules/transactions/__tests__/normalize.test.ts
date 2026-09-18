/**
 * The value-normalisation boundary for transaction rows (#3129).
 */
import { describe, expect, it } from 'vitest'
import { ethers } from 'ethers'
import { getChain } from '../../../domain/chains.js'
import { toBlockNumber, toCanonicalAddress, toUnixSeconds } from '../normalize.js'


const LOWER = '0xab5801a7d398351b8be11c439e05c5b3259aec9b'
const CHECKSUMMED = ethers.getAddress(LOWER)

describe('toCanonicalAddress (#3129)', () => {
  it('checksums a lowercase address — the Etherscan/Gnosis form', () => {
    expect(toCanonicalAddress(LOWER)).toBe(CHECKSUMMED)
  })

  it('leaves an already-checksummed address alone — the Blockscout/Base form', () => {
    expect(toCanonicalAddress(CHECKSUMMED)).toBe(CHECKSUMMED)
  })

  it('canonicalises a MIS-cased address instead of throwing', () => {
    // `ethers.getAddress` rejects a MIXED-case string whose EIP-55 checksum is
    // wrong (an all-lower or all-upper string carries no checksum and is
    // accepted). That is why the implementation lowercases first: a merely
    // miscased value is a casing problem, which is this function's whole job.
    //
    // Derive the bad form rather than hard-coding it: flip exactly one
    // checksum-bearing character, which is guaranteed to break EIP-55.
    const flipAt = [...CHECKSUMMED].findIndex(
      (char, index) => index > 1 && char >= 'A' && char <= 'F',
    )
    expect(flipAt).toBeGreaterThan(1)
    const miscased =
      CHECKSUMMED.slice(0, flipAt) +
      CHECKSUMMED[flipAt].toLowerCase() +
      CHECKSUMMED.slice(flipAt + 1)

    expect(() => ethers.getAddress(miscased)).toThrow()
    expect(toCanonicalAddress(miscased)).toBe(CHECKSUMMED)
  })

  it('accepts an all-uppercase address — no checksum to disagree with', () => {
    // Recorded because it is the surprise: EIP-55 treats an all-caps address
    // as unchecksummed, so this is a casing variant the helper must still
    // settle rather than a value it should reject.
    expect(toCanonicalAddress(LOWER.toUpperCase().replace('0X', '0x'))).toBe(CHECKSUMMED)
  })

  it('passes the empty string through — the documented no-counterparty value', () => {
    // The spec says `from`/`to` are "the empty string when the explorer
    // reported none", and `explorer-api.ts` emits exactly that
    // (`tx.from?.hash ?? ''`). Checksumming it would throw and take down a
    // history read.
    expect(toCanonicalAddress('')).toBe('')
  })

  it('passes null and undefined through — `x402MerchantAddress` is nullable', () => {
    expect(toCanonicalAddress(null)).toBeNull()
    expect(toCanonicalAddress(undefined)).toBeUndefined()
  })

  it('returns a non-address unchanged rather than coercing it', () => {
    // Settling casing is not validating. Rewriting an unexpected value would
    // hide the real defect behind a plausible-looking address.
    for (const notAnAddress of ['not-an-address', '0x', '0xdead', 'native']) {
      expect(toCanonicalAddress(notAnAddress)).toBe(notAnAddress)
    }
  })

  it('is idempotent', () => {
    expect(toCanonicalAddress(toCanonicalAddress(LOWER))).toBe(CHECKSUMMED)
  })
})

describe('toBlockNumber (#3129)', () => {
  it('parses the numeric string both providers send', () => {
    expect(toBlockNumber('45725826')).toBe(45_725_826)
  })

  it('returns null for an unparseable block instead of NaN', () => {
    // This is the whole point: `parseInt('', 10)` is `NaN`, and
    // `JSON.stringify({ blockNumber: NaN })` writes `null` — so the wire
    // already carried null on a field the spec called a required integer.
    // Now it is null on purpose, and the same null the x402 row uses.
    for (const bad of ['', 'null', 'undefined', 'n/a']) {
      expect(toBlockNumber(bad), bad).toBeNull()
    }
    expect(JSON.stringify({ blockNumber: parseInt('', 10) })).toBe('{"blockNumber":null}')
  })

  it('keeps block zero, which is a real block, distinct from unknown', () => {
    expect(toBlockNumber('0')).toBe(0)
  })

  it('rejects a partly-parseable string rather than answering its prefix', () => {
    // `parseInt` is prefix-greedy, so the bare version answered `0` for
    // `'0x1f'` and `12` for `'12abc'` — a wrong number presented as a real
    // block, which is worse than the `0` this issue set out to remove.
    expect(parseInt('0x1f', 10)).toBe(0)
    expect(parseInt('12abc', 10)).toBe(12)
    expect(toBlockNumber('0x1f')).toBeNull()
    expect(toBlockNumber('12abc')).toBeNull()
  })

  it('rejects a block beyond exact integer range', () => {
    expect(toBlockNumber('9007199254740993')).toBeNull()
  })
})

describe('toUnixSeconds (#3129)', () => {
  it('parses the numeric string both providers send', () => {
    expect(toUnixSeconds('1758189600')).toBe(1_758_189_600)
  })

  it('falls back to 0, not null — `timestamp` is sorted on', () => {
    // `compareTransactions` subtracts timestamps. A NaN there makes the
    // comparator inconsistent, and `Array.prototype.sort` with an
    // inconsistent comparator has an implementation-defined result.
    expect(toUnixSeconds('')).toBe(0)
    expect(Number.isNaN(1 - toUnixSeconds(''))).toBe(false)
    // Matches the sibling fallbacks: `isoToUnix` and `parseIsoTimestamp`.
    expect(toUnixSeconds('not-a-time')).toBe(0)
    // Prefix-greedy `parseInt` would answer 1758 here; 0 says "unknown".
    expect(toUnixSeconds('1758-09-18')).toBe(0)
  })
})

/**
 * The provider↔chain map that `normalize.ts`'s header rests on, as a test
 * rather than a sentence (#3129).
 *
 * The first draft of that header had it backwards — it named Gnosis as the
 * Blockscout chain and Base as the Etherscan one — and nothing could catch
 * that, because a comment has no instrument. It matters: which provider
 * serves which chain is what decides whose rows arrive checksummed and which
 * leg is unvalidated passthrough, and Base is the default chain.
 */
describe('provider ↔ chain map the header depends on (#3129)', () => {
  it('Base (the default chain) is served by Blockscout, which checksums', () => {
    expect(getChain(8453).explorerApiProvider).toBe('blockscout-v2')
  })

  it('Gnosis is served by Etherscan, which lowercases — the unvalidated leg', () => {
    expect(getChain(100).explorerApiProvider).toBe('etherscan-v2')
  })
})
