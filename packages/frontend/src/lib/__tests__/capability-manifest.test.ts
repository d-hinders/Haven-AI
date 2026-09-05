import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  backendBaseUrl,
  buildManifestFrom,
  MANIFEST_SCHEMA_VERSION,
  DEFERRED_MANIFEST_KEYS,
  HUMAN_ONLY_STEPS,
  type DiscoveryFacts,
} from '../capability-manifest'
import { PUBLIC_SURFACES } from '../discovery-surfaces'

/**
 * The capability manifest at `/.well-known/haven.json` (#2531).
 *
 * `llms.txt` is prose for a model; this is the same environment as data, for
 * an agent's code. Its whole value is that the code can follow it without
 * guessing — so the rule this file exists to enforce is that every path it
 * names is a surface that actually answers.
 */

const ORIGIN = 'https://preview.test'

const FACTS: DiscoveryFacts = {
  hosted_mcp_url: 'https://mcp.test',
  connector_package: '@haven_ai/connect@dev',
  openapi_url: 'https://api.test/openapi.json',
  chains: { deployable: [84532], supported: [8453, 84532, 100] },
}

/** Every own-origin path the manifest names. They are relative by design. */
function manifestPaths(manifest: unknown): string[] {
  const out: string[] = []
  const walk = (value: unknown): void => {
    if (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')) out.push(value)
    else if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object') Object.values(value).forEach(walk)
  }
  walk(manifest)
  return out
}

describe('capability manifest', () => {
  it('every same-origin path it names is a surface that actually answers', () => {
    // The rule. A key naming a 404 is worse than a missing key: an agent
    // cannot tell "not offered here" from "offered and broken", which is the
    // defect #2520 spent a pull request removing from the artifacts.
    const paths = manifestPaths(buildManifestFrom(ORIGIN, FACTS))
    expect(paths.length).toBeGreaterThan(3)
    for (const path of paths) {
      expect(PUBLIC_SURFACES, `${path} is advertised but is not a public surface`).toContain(path)
    }
  })

  it('positive control: the check would catch a path that is not served', () => {
    // Without this, the assertion above passes just as well on an empty list
    // or a broken extractor.
    const paths = manifestPaths({ docs: { bogus: '/not-a-real-surface' } })
    expect(paths).toEqual(['/not-a-real-surface'])
    expect(PUBLIC_SURFACES).not.toContain('/not-a-real-surface')
  })

  it('REFLECTION: own-origin fields are paths, so no caller-supplied host reaches them', () => {
    // The residual the reviewer named. `dashboard.signup` is the field an
    // agent would send a human to, and building it from `x-forwarded-host`
    // echoed a caller-chosen host into exactly the actionable place. A path is
    // resolved by the agent against the URL it actually fetched — unspoofable
    // by construction — and is the same-origin rule the rest of the epic
    // already follows (#2520, #2521).
    const manifest = buildManifestFrom('https://attacker.example', FACTS)
    expect(JSON.stringify(manifest)).not.toContain('attacker.example')
    expect(manifest.dashboard.signup).toBe('/signup')
    expect(manifest.docs.llms).toBe('/llms.txt')
  })

  it('the two absolute fields name a different origin, from configuration', () => {
    // Positive control for the case above: if EVERY field were relative, the
    // no-reflection assertion would prove nothing about the fields that must
    // stay absolute because they name another host.
    const manifest = buildManifestFrom('https://attacker.example', FACTS)
    expect(manifest.api.base).toBe('https://api.test')
    expect(manifest.hosted_mcp.url).toBe('https://mcp.test')
  })

  it('omits the keys whose targets do not exist yet, and names what lands them', () => {
    // Recorded as data rather than as a comment so this is assertable: the
    // omissions are deliberate, and adding one is an edit somebody makes.
    const manifest = buildManifestFrom(ORIGIN, FACTS) as unknown as Record<string, Record<string, unknown>>
    expect(manifest.dashboard).not.toHaveProperty('device_approval')
    expect(Object.keys(DEFERRED_MANIFEST_KEYS)).toEqual(['dashboard.device_approval'])
    // #2523 landed while this PR was open, so `/for-agents.md` is a real
    // surface now and the key is PRESENT. Its entry leaving the deferred map
    // is the mechanism working as built — a key appears exactly when the thing
    // it names starts answering.
    expect(manifest.docs).toHaveProperty('for_agents')
    expect(manifest.docs.for_agents).toBe('/for-agents.md')
    for (const entry of Object.values(DEFERRED_MANIFEST_KEYS)) {
      expect(entry.lands_in).toBeGreaterThan(0)
    }
  })

  it('names the human-only steps, in order', () => {
    // An agent that knows WHICH steps it cannot perform stops trying to.
    expect(buildManifestFrom(ORIGIN, FACTS).human_only_steps).toEqual([
      'signup_and_passkey',
      'fund',
      'approve_budget',
    ])
    expect(HUMAN_ONLY_STEPS).toContain('approve_budget')
  })

  it('takes the environment-dependent values from the backend, never a literal', () => {
    const manifest = buildManifestFrom(ORIGIN, FACTS)
    expect(manifest.packages.connect.channel).toBe('@haven_ai/connect@dev')
    expect(manifest.packages.connect.one_liner).toBe('npx @haven_ai/connect@dev')
    expect(manifest.hosted_mcp.url).toBe('https://mcp.test')
    expect(manifest.chains).toEqual(FACTS.chains)
    expect(manifest.api.openapi).toBe('https://api.test/openapi.json')
  })

  it('SSRF: the backend fetch target comes from configuration, never a request header', () => {
    // Measured before it was fixed, not theorised: the first version fetched
    // `${origin}/api/discovery`, and `curl -H 'x-forwarded-host: localhost:3154'`
    // made the Next server issue a server-side request to that host — the
    // listener logged it. A caller could have aimed it at a cloud metadata
    // endpoint and read the reply back out of the manifest.
    //
    // The DISPLAYED origin is still request-derived; that is a string echoed
    // to the caller who sent the header, the posture robots.txt and
    // sitemap.xml already take. What must never be request-derived is a URL
    // this server FETCHES.
    process.env.NEXT_PUBLIC_API_URL = 'https://backend.configured.test'
    try {
      expect(backendBaseUrl()).toBe('https://backend.configured.test')
      // The attacker-controlled origin does not appear in the fetch target.
      expect(backendBaseUrl()).not.toContain('preview.test')
      expect(backendBaseUrl()).not.toContain('169.254')
    } finally {
      delete process.env.NEXT_PUBLIC_API_URL
    }
  })

  it('falls back to the local backend, and strips a trailing slash', () => {
    // Same variable the `/api` rewrite in next.config.ts reads, so the manifest
    // and the proxy cannot point at different backends.
    delete process.env.NEXT_PUBLIC_API_URL
    expect(backendBaseUrl()).toBe('http://localhost:3001')
    process.env.NEXT_PUBLIC_API_URL = 'https://b.test/'
    try {
      expect(backendBaseUrl()).toBe('https://b.test')
    } finally {
      delete process.env.NEXT_PUBLIC_API_URL
    }
  })

  it('degrades honestly when the backend is unreachable', () => {
    // A manifest that fails because the backend is down tells an agent
    // nothing; one that omits the environment-dependent half still says where
    // to sign up and which docs to read. `null` is distinguishable from wrong.
    const manifest = buildManifestFrom(ORIGIN, null)
    expect(manifest.hosted_mcp.url).toBeNull()
    expect(manifest.chains).toBeNull()
    expect(manifest.packages.connect).not.toHaveProperty('channel')
    expect(manifest.dashboard.signup).toBe('/signup')
    expect(manifest.docs.llms).toBe('/llms.txt')
  })

  it('never guesses a connector channel when it does not know one', () => {
    // The failure this prevents: a hard-coded `@alpha` that is right on
    // production by coincidence and wrong on dev (#2422).
    const manifest = buildManifestFrom(ORIGIN, null)
    expect(JSON.stringify(manifest)).not.toContain('@alpha')
  })

  it('carries a schema version, so adding a deferred key later is not breaking', () => {
    expect(buildManifestFrom(ORIGIN, FACTS).schema_version).toBe(MANIFEST_SCHEMA_VERSION)
    expect(MANIFEST_SCHEMA_VERSION).toBeGreaterThan(0)
  })

  it('is advertised in llms.txt and observed by the middleware', () => {
    const frontend = join(__dirname, '../../..')
    expect(readFileSync(join(frontend, 'public/llms.txt'), 'utf8')).toContain('/.well-known/haven.json')
    expect(readFileSync(join(frontend, 'src/middleware.ts'), 'utf8')).toContain("'/.well-known/haven.json'")
  })
})
