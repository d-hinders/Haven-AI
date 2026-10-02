/**
 * The agent-skills index served at `/.well-known/agent-skills/index.json`
 * (#3596).
 *
 * The pattern comes from Circle's agent stack
 * (`https://agents.circle.com/.well-known/agent-skills/index.json`): one
 * small skill per step, each linking to the next. This document is the
 * index into Haven's own set — the full runbook (`/for-agents.md`) plus its
 * step files (`/agent-skills/<step>.md`, `agent-skill-steps.ts`) — alongside
 * pointers to the other agent-readable artifacts: the capability manifest
 * (`/.well-known/haven.json`), the OpenAPI spec (`/api/openapi.json`), and
 * the hosted MCP URL.
 *
 * Built here rather than in the route handler, same reasoning as
 * `capability-manifest.ts`: unit-testable without Next machinery.
 *
 * Served on our own host only — no registry listing, no submission anywhere
 * (stealth, owner decision). Deliberately kept OUT of `PUBLIC_SURFACES`
 * (`discovery-surfaces.ts`), matching `/.well-known/haven.json` and
 * `/api/openapi.json`, both excluded there on purpose: a sitemap lists
 * documents a crawler should index, and this is a machine artifact reached by
 * an agent that was told the convention, not a page.
 *
 * Every URL here is ABSOLUTE, unlike the capability manifest's own-origin
 * fields (which are deliberately relative, #2531) — this index exists
 * specifically so an agent can fetch a listed skill directly, and a relative
 * path in this document would resolve against `/.well-known/agent-skills/`,
 * not the site root, which is wrong for every entry.
 */

import { buildManifest, type CapabilityManifest } from './capability-manifest'
import { AGENT_SKILL_STEPS } from './agent-skill-steps'

/**
 * `manifest.packages.connect.channel` is the full package spec
 * (`@haven_ai/connect@dev`) — `capability-manifest.ts`'s own `channelFrom`
 * parses the bare channel out of `DiscoveryFacts.connector_package`, which is
 * the SAME string, by construction (`buildManifestFrom` assigns one from the
 * other verbatim). Re-run the identical pattern here rather than constructing
 * a fake `DiscoveryFacts` to call that function with.
 */
const CONNECTOR_SPEC_RE = /^@haven_ai\/connect@([a-z][a-z0-9-]{0,31})$/

export const AGENT_SKILL_INDEX_SCHEMA_VERSION = 1

export interface AgentSkillEntry {
  name: string
  title: string
  description: string
  url: string
}

export interface AgentSkillIndex {
  version: number
  name: string
  skills: AgentSkillEntry[]
  /** Absolute. The capability manifest this index is served beside. */
  haven_manifest_url: string
  /** Absolute. Null only if the manifest itself could not source one (never invented). */
  openapi_url: string | null
  /**
   * The hosted MCP endpoint, read from the SAME discovery facts
   * `buildManifestFrom` already reads (`hosted_mcp_url`,
   * `capability-manifest.ts`). Null with `note` when the backend was
   * unreachable — never invented.
   */
  mcp: { url: string | null; note?: string }
  /**
   * The connector's npm dist-tag channel (`@haven_ai/connect@<channel>`),
   * read from the manifest's own `packages.connect.channel` — never a
   * literal package name, same rule `buildManifestFrom` follows. Null when
   * the backend was unreachable.
   */
  connector_channel: string | null
}

/** Pure function of an already-built capability manifest — no fetch, unit-testable. */
export function buildAgentSkillIndexFrom(origin: string, manifest: CapabilityManifest): AgentSkillIndex {
  const skills: AgentSkillEntry[] = [
    {
      name: 'for-agents',
      title: 'Haven for agents (full runbook)',
      description: 'The whole onboarding runbook in one file, for an agent that can afford the larger fetch.',
      url: `${origin}/for-agents.md`,
    },
    ...AGENT_SKILL_STEPS.map((step) => ({
      name: step.slug,
      title: step.title,
      description: step.description,
      url: `${origin}/agent-skills/${step.slug}.md`,
    })),
  ]
  return {
    version: AGENT_SKILL_INDEX_SCHEMA_VERSION,
    name: 'haven',
    skills,
    haven_manifest_url: `${origin}/.well-known/haven.json`,
    openapi_url: manifest.api.openapi ? `${origin}/api/openapi.json` : null,
    // Never invented: a null URL always carries a note, even on the rare path
    // where the manifest's own `hosted_mcp.note` was itself empty (facts
    // present but no note) — "unavailable" is an honest default, never a
    // guessed endpoint.
    mcp:
      manifest.hosted_mcp.url === null
        ? { url: null, note: manifest.hosted_mcp.note ?? 'hosted MCP URL unavailable: the backend was unreachable' }
        : { url: manifest.hosted_mcp.url },
    connector_channel: manifest.packages.connect.channel?.match(CONNECTOR_SPEC_RE)?.[1] ?? null,
  }
}

/** Same discovery-facts fetch `buildManifest` already does, reused rather than duplicated. */
export async function buildAgentSkillIndex(origin: string): Promise<AgentSkillIndex> {
  const manifest = await buildManifest(origin)
  return buildAgentSkillIndexFrom(origin, manifest)
}
