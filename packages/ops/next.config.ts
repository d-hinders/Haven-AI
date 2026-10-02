import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NextConfig } from 'next'
import { PHASE_PRODUCTION_BUILD, PHASE_DEVELOPMENT_SERVER } from 'next/constants.js'
import { parseEnvironments } from './src/lib/environments'

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))

/**
 * The doc-health JSON (#3516, from #3511): `public/ops-doc-health.json` is
 * regenerated here, BEFORE the config resolves, so `next build` and
 * `next dev` both serve a fresh report. Deliberately in this file rather
 * than an npm `prebuild` hook, for the SAME reason packages/frontend's
 * next.config generates the served docs there: a deployment whose build
 * command invokes `next build` directly would skip a prebuild, and the Doc
 * health page would 404 with nothing failing. `next start` does NOT
 * regenerate (phase gate): it re-reads the file this build wrote.
 *
 * The generator reads `../../docs` and `../../scripts` — the Vercel project
 * needs "include files outside root directory" left on (#3517's runbook).
 */
const GENERATING_PHASES = new Set<string>([PHASE_PRODUCTION_BUILD, PHASE_DEVELOPMENT_SERVER])

async function writeDocHealthJson(): Promise<void> {
  const { buildDocHealth, readRepoDocs } = await import('../../scripts/docs/doc-health.mjs')
  const { GOVERNED_PACKAGE_DOCS } = await import('../../scripts/docs/package-docs.mjs')
  const report = buildDocHealth({
    docs: await readRepoDocs(),
    packageDocs: GOVERNED_PACKAGE_DOCS,
    generatedAt: new Date().toISOString(),
  })
  const publicDir = join(PACKAGE_ROOT, 'public')
  await mkdir(publicDir, { recursive: true })
  await writeFile(join(publicDir, 'ops-doc-health.json'), `${JSON.stringify(report, null, 2)}\n`)
}

/**
 * Security headers (#3515, epic #3507 hardening).
 *
 * The pages render customer-controlled strings and ops tokens are valid for
 * 8 h, so unlike the dashboard this console ships an ENFORCING CSP on day
 * one — there is no legacy surface that needs report-only. `connect-src` is
 * limited to the registry origins (parsed by the same module the app uses,
 * so the header and the switcher cannot disagree); everything else is the
 * strict default set. `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`
 * and `X-Robots-Tag: noindex` ride the same headers block.
 *
 * A registry with no usable origin yields no `connect-src` extension: the
 * console cannot talk anywhere, which is exactly what the config-error screen
 * says.
 */
const nextConfig: NextConfig = {
  // `@haven_ai/core` ships a built `dist` and `@haven_ai/ui` ships TS source;
  // both go through Next's own pipeline rather than being trusted verbatim,
  // matching packages/frontend.
  transpilePackages: ['@haven_ai/core', '@haven_ai/ui'],
  // The screenshot harness (OPS_SCREENSHOT_BUILD=1, scripts/screenshot.mjs)
  // builds a THROWAWAY prod bundle with the fixture registry inlined into
  // this scratch distDir, so a capture run never overwrites the repo's own
  // `.next` and never serves it. Absent the flag this is undefined and the
  // default `.next` applies — one code path in production.
  ...(process.env.OPS_SCREENSHOT_BUILD === '1' ? { distDir: 'next-screenshot-build' } : {}),
  async headers() {
    const registry = parseEnvironments(process.env.NEXT_PUBLIC_OPS_ENVIRONMENTS)
    const connectSrc = registry.environments.map((environment) => environment.origin)
    const csp = [
      "default-src 'self'",
      // The app router bootstraps hydration with INLINE same-origin scripts
      // (Next 15 injects them into every page); 'unsafe-inline' here is those
      // framework scripts only — no other inline script exists in this app, and
      // the console renders no third-party content. packages/frontend's CSP
      // ships the same keyword for the same reason.
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      `connect-src 'self' ${connectSrc.join(' ')}`.trim(),
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; ')
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Robots-Tag', value: 'noindex' },
          { key: 'Content-Security-Policy', value: csp },
        ],
      },
    ]
  },
}

// The registry parse above reads process.env at config load. `next start`
// also loads this file; parsing twice is harmless (pure), and gating by phase
// would only hide that. The build/dev phases are named for the same reason
// frontend's config gates its doc generation: make the loading phase explicit.
export default async function config(phase: string): Promise<NextConfig> {
  if (GENERATING_PHASES.has(phase)) {
    // The generator is deterministic and fast (a directory walk); a failure
    // fails the build loudly — a Doc health page answering 404 would be the
    // silent kind of broken this file exists to prevent.
    await writeDocHealthJson()
  } else {
    void phase
  }
  return nextConfig
}
