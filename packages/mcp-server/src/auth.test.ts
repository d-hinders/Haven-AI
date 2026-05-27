import { describe, it, expect } from 'vitest'
import { extractBearerToken } from './auth.js'

describe('extractBearerToken', () => {
  it('extracts a bearer token', () => {
    expect(extractBearerToken({ headers: { authorization: 'Bearer sk_agent_abc' } })).toBe('sk_agent_abc')
  })

  it('is case-insensitive on the scheme', () => {
    expect(extractBearerToken({ headers: { authorization: 'bearer sk_agent_x' } })).toBe('sk_agent_x')
  })

  it('returns null when the header is missing', () => {
    expect(extractBearerToken({ headers: {} })).toBeNull()
  })

  it('returns null for a non-bearer scheme', () => {
    expect(extractBearerToken({ headers: { authorization: 'Basic abc' } })).toBeNull()
  })

  it('returns null for an empty token', () => {
    expect(extractBearerToken({ headers: { authorization: 'Bearer ' } })).toBeNull()
  })
})
