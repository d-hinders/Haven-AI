/**
 * MCP server-name pairs (#1695, epic #1694).
 *
 * One runtime config can hold several Haven agents, each as its own
 * hosted+signer MCP pair keyed by server name. The names are the wiring
 * contract every host depends on (server name = tool prefix), so:
 *
 * - The UNNAMED pair keeps today's exact names — bare `haven` /
 *   `haven-signer`, and Codex's historical `haven_signer` table — because a
 *   rename would break every currently-wired host (#1694 owner decision).
 * - A NAMED pair suffixes the slug: `haven-<slug>` / `haven-signer-<slug>`.
 *   The slug is fixed at connect time and never changes (#1694: editable
 *   display name, immutable wiring slug). #1696 wires the `--name` flag.
 *
 * Hermes stores each pair's API key in its dotenv file, so a named pair also
 * needs its own env key — two agents sharing `MCP_HAVEN_API_KEY` would both
 * authenticate as whichever setup ran last.
 */

export interface ServerNames {
  /** Hosted MCP entry name in JSON/YAML configs and the Claude Code registry. */
  hosted: string
  /** Signer entry name in JSON/YAML configs and the Claude Code registry. */
  signer: string
  /** Codex TOML table name for the hosted entry (`mcp_servers.<name>`). */
  codexHosted: string
  /** Codex TOML table name for the signer entry. */
  codexSigner: string
  /** Hermes dotenv key holding this pair's hosted API key. */
  hermesEnvKey: string
}

/**
 * Slug shape: lowercase alphanumerics and single hyphens, 1–32 chars. Strict
 * on purpose — the slug becomes a server name, a TOML bare key, part of an
 * env var, and a tool prefix, and it is immutable once wired.
 */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function assertValidServerSlug(slug: string): void {
  if (slug.length === 0 || slug.length > 32 || !SLUG_RE.test(slug)) {
    throw new Error(
      `Invalid server name ${JSON.stringify(slug)}: use 1-32 lowercase letters, digits, and single hyphens (e.g. "research").`,
    )
  }
  // Collision-freedom (#1695 review, blocking finding): every derived name
  // must be unique across ALL valid slugs and the bare pair, or "a writer
  // touches only its own pair" is false. The only cross-collisions the
  // haven-<slug> / haven-signer-<slug> scheme admits are:
  //   hosted(A) === bare signer      ⇔ A === 'signer'
  //   hosted(A) === signer(B), A≠B   ⇔ A === `signer-${B}`
  // (signer(A) === signer(B) and hosted(A) === hosted(B) already force A===B.)
  // Rejecting 'signer' and the 'signer-' prefix therefore closes the whole
  // family, not just the literal case — proven by the adversarial-pair test.
  // #1696: the bare pair's own names are refused as slugs outright — not a
  // collision ('haven' would yield 'haven-haven'), but an operator typing
  // --name haven means the bare pair, and silently minting a doubled name
  // would wire an agent nobody can find again.
  if (slug === 'haven' || slug === 'haven-signer') {
    throw new Error(
      `Invalid server name ${JSON.stringify(slug)}: "haven" and "haven-signer" are the unnamed pair's own names — omit --name for the bare pair.`,
    )
  }
  if (slug === 'signer' || slug.startsWith('signer-')) {
    throw new Error(
      `Invalid server name ${JSON.stringify(slug)}: "signer" and "signer-*" are reserved — ` +
        "they would collide with another pair's haven-signer-* entry.",
    )
  }
}

export function serverNamesFor(slug?: string): ServerNames {
  if (slug === undefined) {
    return {
      hosted: 'haven',
      signer: 'haven-signer',
      // Historical Codex table names — every wired Codex host has these.
      codexHosted: 'haven',
      codexSigner: 'haven_signer',
      hermesEnvKey: 'MCP_HAVEN_API_KEY',
    }
  }
  assertValidServerSlug(slug)
  return {
    hosted: `haven-${slug}`,
    signer: `haven-signer-${slug}`,
    // Hyphens are valid TOML bare keys, so named Codex tables match the
    // JSON/YAML names instead of inheriting the legacy underscore.
    codexHosted: `haven-${slug}`,
    codexSigner: `haven-signer-${slug}`,
    hermesEnvKey: `MCP_HAVEN_${slug.toUpperCase().replace(/-/g, '_')}_API_KEY`,
  }
}
