import type { NextConfig } from 'next'
import { PHASE_PRODUCTION_BUILD, PHASE_DEVELOPMENT_SERVER } from 'next/constants.js'

/**
 * Security headers (#3515, epic #3507 hardening).
 *
 * The static set: `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
 * `X-Robots-Tag: noindex` and `X-Content-Type-Options: nosniff`.
 * The Content-Security-Policy is NOT here: it carries a per-request script
 * nonce, so `src/middleware.ts` sets it (#3581). A static CSP here as well
 * would be a second policy, and the browser enforces both.
 */
const nextConfig: NextConfig = {
  // `@haven_ai/core` ships a built `dist` and `@haven_ai/ui` ships TS source;
  // both go through Next's own pipeline rather than being trusted verbatim,
  // matching packages/frontend.
  transpilePackages: ['@haven_ai/core', '@haven_ai/ui'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Robots-Tag', value: 'noindex' },
        ],
      },
    ]
  },
}

// The build/dev phases are named for the same reason frontend's config gates
// its doc generation: make the loading phase explicit.
export default function config(_phase: string): NextConfig {
  void PHASE_PRODUCTION_BUILD
  void PHASE_DEVELOPMENT_SERVER
  return nextConfig
}
