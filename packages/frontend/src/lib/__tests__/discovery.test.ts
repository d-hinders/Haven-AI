import { describe, expect, it } from 'vitest'
import {
  captureDiscoverySource,
  classifyAgentUserAgent,
  discoverySourceFromSearch,
  parseDiscoverySource,
  readStoredDiscoverySource,
  resolveDiscoverySource,
} from '../discovery'

describe('parseDiscoverySource', () => {
  it('accepts a well-formed slug and normalizes case/whitespace', () => {
    expect(parseDiscoverySource('402-page')).toBe('402-page')
    expect(parseDiscoverySource('  Registry ')).toBe('registry')
    expect(parseDiscoverySource('n8n_template')).toBe('n8n_template')
  })

  it('degrades malformed values to null instead of throwing — attribution never blocks', () => {
    expect(parseDiscoverySource('')).toBeNull()
    expect(parseDiscoverySource('   ')).toBeNull()
    expect(parseDiscoverySource('-leading-dash')).toBeNull()
    expect(parseDiscoverySource('has spaces')).toBeNull()
    expect(parseDiscoverySource('<script>')).toBeNull()
    expect(parseDiscoverySource('a'.repeat(33))).toBeNull()
    expect(parseDiscoverySource(null)).toBeNull()
    expect(parseDiscoverySource(undefined)).toBeNull()
  })

  it('caps at 32 chars inclusive', () => {
    expect(parseDiscoverySource('a'.repeat(32))).toBe('a'.repeat(32))
  })
})

describe('discoverySourceFromSearch', () => {
  it('reads ?src= from a search string', () => {
    expect(discoverySourceFromSearch('?src=402-page')).toBe('402-page')
    expect(discoverySourceFromSearch('?foo=1&src=registry')).toBe('registry')
  })

  it('returns null when absent or malformed', () => {
    expect(discoverySourceFromSearch('')).toBeNull()
    expect(discoverySourceFromSearch('?src=')).toBeNull()
    expect(discoverySourceFromSearch('?src=bad value')).toBeNull()
  })
})

describe('classifyAgentUserAgent', () => {
  it('classifies known agent crawlers into families', () => {
    expect(
      classifyAgentUserAgent('Mozilla/5.0 AppleWebKit/537.36 (compatible; GPTBot/1.2; +https://openai.com/gptbot)'),
    ).toBe('openai')
    expect(
      classifyAgentUserAgent('Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)'),
    ).toBe('anthropic')
    expect(classifyAgentUserAgent('Mozilla/5.0 (compatible; PerplexityBot/1.0)')).toBe('perplexity')
    expect(classifyAgentUserAgent('Mozilla/5.0 (compatible; Google-Extended)')).toBe('google-ai')
    expect(classifyAgentUserAgent('meta-externalagent/1.1')).toBe('meta-ai')
    expect(classifyAgentUserAgent('CCBot/2.0 (https://commoncrawl.org/faq/)')).toBe('commoncrawl')
  })

  it('prefers the specific needle over the generic vendor name', () => {
    expect(classifyAgentUserAgent('Mozilla/5.0; OAI-SearchBot/1.0; +https://openai.com/searchbot')).toBe('openai')
    expect(classifyAgentUserAgent('ChatGPT-User/1.0')).toBe('openai')
  })

  it('returns null for browsers and unknown bots — under-count, never over-count', () => {
    expect(
      classifyAgentUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15'),
    ).toBeNull()
    expect(classifyAgentUserAgent('curl/8.4.0')).toBeNull()
    expect(classifyAgentUserAgent('')).toBeNull()
    expect(classifyAgentUserAgent(null)).toBeNull()
  })
})

describe('first-touch persistence (#2302)', () => {
  const DAY = 24 * 60 * 60 * 1000

  it('captures a valid slug and reads it back within the TTL', () => {
    window.localStorage.clear()
    captureDiscoverySource('?src=registry', 1_000)
    expect(readStoredDiscoverySource(1_000 + 29 * DAY)).toBe('registry')
  })

  it('expires after 30 days and ignores malformed/absent params', () => {
    window.localStorage.clear()
    captureDiscoverySource('?src=registry', 1_000)
    expect(readStoredDiscoverySource(1_000 + 31 * DAY)).toBeNull()
    window.localStorage.clear()
    captureDiscoverySource('?src=bad value')
    expect(readStoredDiscoverySource()).toBeNull()
  })

  it('survives corrupted storage without throwing', () => {
    window.localStorage.setItem('haven.discovery_source', 'not-json{{')
    expect(readStoredDiscoverySource()).toBeNull()
  })

  it('resolveDiscoverySource: URL param wins over stored first touch', () => {
    window.localStorage.clear()
    captureDiscoverySource('?src=registry')
    expect(resolveDiscoverySource('?src=402-page')).toBe('402-page')
    expect(resolveDiscoverySource('')).toBe('registry')
  })
})
