import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildAgentSkillIndexFrom, AGENT_SKILL_INDEX_SCHEMA_VERSION } from '../agent-skill-index'
import { buildManifestFrom, type DiscoveryFacts } from '../capability-manifest'
import { AGENT_SKILL_STEPS } from '../agent-skill-steps'

/**
 * The agent-skills index at `/.well-known/agent-skills/index.json` (#3596).
 *
 * Built here against `buildManifestFrom` directly, the same pattern
 * `capability-manifest.test.ts` uses for `haven.json` — unit-testable without
 * Next machinery, no network.
 */

const ORIGIN = 'https://preview.test'
const FRONTEND_ROOT = join(__dirname, '..', '..', '..')

const FACTS: DiscoveryFacts = {
  hosted_mcp_url: 'https://mcp.test',
  connector_package: '@haven_ai/connect@dev',
  cli_package: '@haven_ai/cli@dev',
  openapi_url: 'https://api.test/openapi.json',
  chains: { default: 8453, deployable: [84532], supported: [8453, 84532] },
}

function buildIndex(facts: DiscoveryFacts | null) {
  const manifest = buildManifestFrom(ORIGIN, facts)
  return buildAgentSkillIndexFrom(ORIGIN, manifest)
}

describe('agent-skills index (#3596)', () => {
  it('answers a version, a name, and the full-runbook skill plus one per step file', () => {
    const index = buildIndex(FACTS)
    expect(index.version).toBe(AGENT_SKILL_INDEX_SCHEMA_VERSION)
    expect(index.name).toBe('haven')
    expect(index.skills).toHaveLength(1 + AGENT_SKILL_STEPS.length)
    expect(index.skills[0]).toMatchObject({ name: 'for-agents', url: `${ORIGIN}/for-agents.md` })
  })

  it('every skill URL is ABSOLUTE and resolves to a real file under public/', () => {
    const index = buildIndex(FACTS)
    for (const skill of index.skills) {
      expect(skill.url.startsWith(`${ORIGIN}/`), skill.url).toBe(true)
      const relative = skill.url.slice(ORIGIN.length)
      expect(existsSync(join(FRONTEND_ROOT, 'public', relative.replace(/^\//, ''))), relative).toBe(true)
    }
  })

  it('points at the capability manifest with an absolute URL that resolves to a real route', () => {
    const index = buildIndex(FACTS)
    expect(index.haven_manifest_url).toBe(`${ORIGIN}/.well-known/haven.json`)
    expect(
      existsSync(join(FRONTEND_ROOT, 'src/app/.well-known/haven.json/route.ts')),
      'haven.json route handler must exist for this pointer to resolve',
    ).toBe(true)
  })

  it('the openapi pointer is the frontend-relative mirror, absolute, never the backend URL directly', () => {
    // `/api/openapi.json` is a next.config.ts rewrite to the backend, not a
    // file or an app route — so unlike the skill URLs above, existence here
    // cannot be checked by `existsSync`. What IS checkable, and asserted: the
    // index never leaks the backend's own absolute `openapi_url`
    // (`facts.openapi_url`), which would be a different origin a caller has
    // no reason to trust.
    const index = buildIndex(FACTS)
    expect(index.openapi_url).toBe(`${ORIGIN}/api/openapi.json`)
    expect(index.openapi_url).not.toContain('api.test')
    const nextConfig = readFileSync(join(FRONTEND_ROOT, 'next.config.ts'), 'utf8')
    expect(nextConfig).toMatch(/source:\s*'\/api\/:path\*'/)
  })

  it('the hosted MCP URL and the connector channel come from the discovery facts, and change when they do', () => {
    const a = buildIndex(FACTS)
    expect(a.mcp.url).toBe('https://mcp.test')
    expect(a.mcp.note).toBeUndefined()
    expect(a.connector_channel).toBe('dev')

    const otherFacts: DiscoveryFacts = {
      ...FACTS,
      hosted_mcp_url: 'https://mcp-two.test',
      connector_package: '@haven_ai/connect@alpha',
    }
    const b = buildIndex(otherFacts)
    expect(b.mcp.url).toBe('https://mcp-two.test')
    expect(b.connector_channel).toBe('alpha')
    expect(b.mcp.url).not.toBe(a.mcp.url)
    expect(b.connector_channel).not.toBe(a.connector_channel)
  })

  it('never invents the MCP URL: null when the backend was unreachable, always with a note', () => {
    const index = buildIndex(null)
    expect(index.mcp.url).toBeNull()
    expect(index.mcp.note).toBeTruthy()
    expect(index.connector_channel).toBeNull()
  })

  it('carries the manifest-reported note verbatim when the backend sent one', () => {
    const facts: DiscoveryFacts = { ...FACTS, hosted_mcp_url: null, hosted_mcp_note: 'maintenance window' }
    const index = buildIndex(facts)
    expect(index.mcp.url).toBeNull()
    expect(index.mcp.note).toBe('maintenance window')
  })
})
