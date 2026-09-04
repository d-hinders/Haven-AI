/**
 * The capability manifest served at `/.well-known/haven.json` (#2531).
 *
 * Built here rather than in the route handler so the shape is unit-testable
 * without Next machinery, and so the ONE rule that matters is enforceable in
 * one place: every path this document names must be a surface that actually
 * answers.
 */

/**
 * Bumped when a key is REMOVED or changes meaning. Adding a key is not a
 * breaking change, which is what lets the omissions below land later without
 * a version bump.
 */
export const MANIFEST_SCHEMA_VERSION = 1

/**
 * Paths deliberately ABSENT, with the issue that lands each one.
 *
 * The manifest's whole value is that an agent's code can follow it without
 * guessing. A key naming a 404 is worse than a missing key: the agent cannot
 * tell "not offered here" from "offered and broken", and this is exactly the
 * defect #2520 spent a pull request removing from the artifacts.
 *
 * Recorded as data, not as a comment, so the guard test can assert they are
 * still absent — and so adding one is a deliberate edit rather than something
 * that silently drifts back in.
 */
export const DEFERRED_MANIFEST_KEYS = {
  'docs.for_agents': { path: '/for-agents.md', lands_in: 2523 },
  'dashboard.device_approval': { path: '/device', lands_in: 2526 },
} as const

/** What the backend's `GET /discovery` contributes. */
export interface DiscoveryFacts {
  hosted_mcp_url: string | null
  hosted_mcp_note?: string
  connector_package: string
  openapi_url: string
  chains: { deployable: number[]; supported: readonly number[] }
}

export interface CapabilityManifest {
  schema_version: number
  name: string
  summary: string
  human_only_steps: readonly string[]
  dashboard: Record<string, string>
  api: { base: string; openapi: string; root: string }
  hosted_mcp: { url: string | null; note?: string; auth: string; signer: string }
  packages: Record<string, { name: string; channel?: string; one_liner?: string }>
  chains: DiscoveryFacts['chains'] | null
  docs: Record<string, string>
  environment: string
}

/**
 * The steps a human must perform, in order. Named because an agent that knows
 * WHICH steps it cannot do stops trying to do them — the owner constraint for
 * this epic is that the human keeps every signature.
 */
export const HUMAN_ONLY_STEPS = ['signup_and_passkey', 'fund', 'approve_budget'] as const

export function buildManifestFrom(origin: string, facts: DiscoveryFacts | null): CapabilityManifest {
  const apiBase = facts ? new URL(facts.openapi_url).origin : `${origin}/api`
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    name: 'haven',
    summary:
      'Give an agent a budget, not your wallet. Agents pay x402 merchants within owner-set, ' +
      'on-chain-enforced limits; Haven never holds funds and the agent never holds a key.',
    human_only_steps: HUMAN_ONLY_STEPS,
    dashboard: { signup: `${origin}/signup`, login: `${origin}/login` },
    api: {
      base: apiBase,
      openapi: facts?.openapi_url ?? `${origin}/api/openapi.json`,
      root: apiBase,
    },
    hosted_mcp: {
      url: facts?.hosted_mcp_url ?? null,
      ...(facts?.hosted_mcp_note ? { note: facts.hosted_mcp_note } : {}),
      auth: 'bearer agent credential',
      signer: 'local @haven_ai/signer',
    },
    packages: {
      connect: {
        name: '@haven_ai/connect',
        ...(facts?.connector_package ? { channel: facts.connector_package } : {}),
        ...(facts?.connector_package ? { one_liner: `npx ${facts.connector_package}` } : {}),
      },
      cli: { name: '@haven_ai/cli' },
      sdk: { name: '@haven_ai/sdk' },
      mcp: { name: '@haven_ai/mcp' },
      signer: { name: '@haven_ai/signer' },
    },
    chains: facts?.chains ?? null,
    docs: {
      llms: `${origin}/llms.txt`,
      llms_full: `${origin}/llms-full.txt`,
      pay_402: `${origin}/402.md`,
      exit: `${origin}/exit`,
    },
    environment: process.env.NEXT_PUBLIC_HAVEN_ENV ?? 'unknown',
  }
}

/**
 * Fetch the backend facts, tolerating their absence.
 *
 * A manifest that 500s because the backend is down tells an agent nothing; one
 * that omits the environment-dependent half still tells it where to sign up
 * and which docs to read. `chains: null` and `hosted_mcp.url: null` are
 * honest answers, and are distinguishable from a wrong one.
 */
export async function buildManifest(origin: string): Promise<CapabilityManifest> {
  let facts: DiscoveryFacts | null = null
  try {
    const res = await fetch(`${origin}/api/discovery`, { cache: 'no-store' })
    if (res.ok) facts = (await res.json()) as DiscoveryFacts
  } catch {
    // Backend unreachable — the static half of the manifest is still true.
  }
  return buildManifestFrom(origin, facts)
}
