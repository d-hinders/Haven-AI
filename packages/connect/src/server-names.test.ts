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

  it('MUTATION PROOF: the reserved-prefix rule closes every cross-pair name collision', () => {
    // The exact family from the #1695 review: slug "signer" collides with the
    // BARE pair's signer entry, and slug "signer-x" collides with slug "x"'s
    // signer entry — a later setup would silently replace another agent's
    // signer registration with a hosted entry under the same name.
    expect(() => serverNamesFor('signer')).toThrow(/reserved/)
    expect(() => serverNamesFor('signer-x')).toThrow(/reserved/)
    // With the rule in place, adversarial neighbours cannot collide: every
    // derived name of "x" differs from every derived name of any other valid
    // slug and from the bare pair.
    // codexHosted/codexSigner intentionally repeat hosted/signer within a
    // named pair, so dedupe per pair first — cross-PAIR overlap is the bug.
    const pairs = [undefined, 'x', 'x2', 'sig', 'signerx'].map((s) => {
      const n = serverNamesFor(s)
      return new Set([n.hosted, n.signer, n.codexHosted, n.codexSigner])
    })
    const total = pairs.reduce((sum, p) => sum + p.size, 0)
    const union = new Set(pairs.flatMap((p) => [...p]))
    expect(union.size).toBe(total)
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
