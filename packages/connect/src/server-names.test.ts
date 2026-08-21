/**
 * #1695 — the naming contract. The names ARE the wiring: server name = tool
 * prefix = what every host loads at startup, and the slug is immutable once
 * wired. What is pinned here: the unnamed pair keeps today's exact names
 * (including Codex's historical underscore), a named pair derives all five
 * identifiers from one slug, and invalid slugs are refused before they can
 * become a config key.
 */
import { describe, it, expect } from 'vitest'
import { assertValidServerSlug, serverNamesFor } from './server-names.js'

describe('serverNamesFor', () => {
  it('MUTATION PROOF: unnamed keeps the exact legacy names, Codex underscore included', () => {
    expect(serverNamesFor()).toEqual({
      hosted: 'haven',
      signer: 'haven-signer',
      codexHosted: 'haven',
      codexSigner: 'haven_signer',
      hermesEnvKey: 'MCP_HAVEN_API_KEY',
    })
  })

  it('a named pair derives every identifier from the slug', () => {
    expect(serverNamesFor('research-2')).toEqual({
      hosted: 'haven-research-2',
      signer: 'haven-signer-research-2',
      codexHosted: 'haven-research-2',
      codexSigner: 'haven-signer-research-2',
      hermesEnvKey: 'MCP_HAVEN_RESEARCH_2_API_KEY',
    })
  })

  it('refuses slugs that would break a config key, env var, or TOML table', () => {
    for (const bad of ['', 'Research', 'a b', 'a_b', '-lead', 'trail-', 'a--b', 'ä', 'x'.repeat(33)]) {
      expect(() => assertValidServerSlug(bad), bad).toThrow(/Invalid server name/)
    }
    for (const good of ['a', 'research', 'agent-2', 'x'.repeat(32)]) {
      expect(() => assertValidServerSlug(good), good).not.toThrow()
    }
  })
})
