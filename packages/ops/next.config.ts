import type { NextConfig } from 'next'
import { PHASE_PRODUCTION_BUILD, PHASE_DEVELOPMENT_SERVER } from 'next/constants.js'
import { parseEnvironments } from './src/lib/environments'

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
const NO_REGISTRY_FALLBACK = "'self'"

const nextConfig: NextConfig = {
  // `@haven_ai/core` ships a built `dist` and `@haven_ai/ui` ships TS source;
  // both go through Next's own pipeline rather than being trusted verbatim,
  // matching packages/frontend.
  transpilePackages: ['@haven_ai/core', '@haven_ai/ui'],
  async headers() {
    const registry = parseEnvironments(process.env.NEXT_PUBLIC_OPS_ENVIRONMENTS)
    const connectSrc = registry.environments.map((environment) => environment.origin)
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
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
export default function config(_phase: string): NextConfig {
  void PHASE_PRODUCTION_BUILD
  void PHASE_DEVELOPMENT_SERVER
  return nextConfig
}
