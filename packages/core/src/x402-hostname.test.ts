import { describe, expect, it } from 'vitest'
import { parseX402Hostname } from './x402-hostname.js'

describe('parseX402Hostname', () => {
  it('returns the hostname of a parseable URL, query string included', () => {
    expect(parseX402Hostname('https://research.example/report?q=1')).toBe('research.example')
  })

  it('returns null for an unparseable URL', () => {
    expect(parseX402Hostname('not a url')).toBeNull()
  })

  it('returns null for absent and empty values', () => {
    expect(parseX402Hostname(null)).toBeNull()
    expect(parseX402Hostname(undefined)).toBeNull()
    expect(parseX402Hostname('')).toBeNull()
  })

  it('returns the bare hostname without port, scheme or path', () => {
    expect(parseX402Hostname('http://api.example:8080/x402/pay')).toBe('api.example')
  })
})
