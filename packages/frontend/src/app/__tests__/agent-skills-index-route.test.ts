import { describe, it, expect, vi, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET as indexGET, dynamic as indexDynamic } from '@/app/.well-known/agent-skills/index.json/route'
import { GET as manifestGET, dynamic as manifestDynamic } from '@/app/.well-known/haven.json/route'
import { AGENT_SKILL_STEPS } from '@/lib/agent-skill-steps'

/**
 * The wiring for `/.well-known/agent-skills/index.json` (#3596), the same
 * split `discovery-routes.test.ts` keeps for `/robots.txt` and
 * `/sitemap.xml`: the builder is unit-tested in isolation
 * (`agent-skill-index.test.ts`); this calls the actual route handler.
 *
 * `fetch` is stubbed to reject, same effect as a backend that is down —
 * `buildManifest` (and therefore `buildAgentSkillIndex`, which calls it)
 * tolerates that and serves the static half, which is what both route
 * handlers below are compared against. Without the stub this test would make
 * a real network call per run.
 */
function request(url: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(new Request(url, { headers }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('/.well-known/agent-skills/index.json route handler', () => {
  it('is dynamic — generated per request, like haven.json', () => {
    expect(indexDynamic).toBe('force-dynamic')
  })

  it('answers 200 JSON built from the request origin', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no backend in test')))
    const response = await indexGET(request('https://haven.example/.well-known/agent-skills/index.json'))
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    const body = JSON.parse(await response.text())
    expect(body.name).toBe('haven')
    expect(body.skills).toHaveLength(1 + AGENT_SKILL_STEPS.length)
    for (const skill of body.skills) {
      expect(skill.url.startsWith('https://haven.example/')).toBe(true)
    }
  })

  it('honours the forwarded host, exactly as haven.json does', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no backend in test')))
    const response = await indexGET(
      request('http://internal:3000/.well-known/agent-skills/index.json', {
        'x-forwarded-host': 'preview.example',
        'x-forwarded-proto': 'https',
      }),
    )
    const body = JSON.parse(await response.text())
    expect(body.haven_manifest_url).toBe('https://preview.example/.well-known/haven.json')
    expect(body.skills[0].url).toBe('https://preview.example/for-agents.md')
  })

  it('never invents the MCP URL when the (stubbed) backend is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no backend in test')))
    const response = await indexGET(request('https://haven.example/.well-known/agent-skills/index.json'))
    const body = JSON.parse(await response.text())
    expect(body.mcp.url).toBeNull()
    expect(body.mcp.note).toBeTruthy()
  })

  it('carries the same cache and vary headers as /.well-known/haven.json', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no backend in test')))
    const url = 'https://haven.example/.well-known/agent-skills/index.json'
    const indexResponse = await indexGET(request(url))
    const manifestResponse = manifestGET(request('https://haven.example/.well-known/haven.json'))
    const resolvedManifestResponse = await manifestResponse
    expect(manifestDynamic).toBe(indexDynamic)
    expect(indexResponse.headers.get('cache-control')).toBe(resolvedManifestResponse.headers.get('cache-control'))
    expect(indexResponse.headers.get('vary')).toBe(resolvedManifestResponse.headers.get('vary'))
    const cacheControl = indexResponse.headers.get('cache-control') ?? ''
    expect(cacheControl).not.toMatch(/s-maxage=[1-9]/)
    expect(cacheControl).toContain('must-revalidate')
  })
})
