/**
 * The fallback-word list (#4932) is one definition with two consumers: the
 * frontend renders these literals, the backend refuses a receipt seller name
 * equal to one. Pinned here so a change to the list is a deliberate change to
 * a documented set, not a side effect.
 */
import { describe, expect, it } from 'vitest'
import {
  HAVEN_FALLBACK_NAME,
  HAVEN_FALLBACK_NAMES,
  HAVEN_FALLBACK_NAME_PREFIXES,
} from './fallback-names.js'

describe('HAVEN_FALLBACK_NAMES', () => {
  it('is the eight literals the frontend renders for an unnamed counterparty', () => {
    expect([...HAVEN_FALLBACK_NAMES]).toEqual([
      'New recipient',
      'Unknown recipient',
      'Deposit',
      'Sale',
      'Agent payment',
      'Machine payment',
      'Moved between your accounts',
      'None in this range',
    ])
  })

  it('is derived from the named object, so the two cannot disagree', () => {
    expect([...HAVEN_FALLBACK_NAMES]).toEqual(Object.values(HAVEN_FALLBACK_NAME))
  })

  it('carries the three templated prefixes, each with its trailing space', () => {
    expect([...HAVEN_FALLBACK_NAME_PREFIXES]).toEqual(['From ', 'Returned from ', 'Sale · '])
  })
})
