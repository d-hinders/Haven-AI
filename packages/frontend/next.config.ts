import type { NextConfig } from 'next'
import { PHASE_PRODUCTION_BUILD, PHASE_DEVELOPMENT_SERVER } from 'next/constants.js'
import { generate } from './scripts/serve-docs.mjs'

/**
 * Generate the served product docs (#2532) while Next loads its config, so
 * they exist for `next build` and `next dev`.
 *
 * Deliberately here rather than in an npm `prebuild` hook. That hook fires for
 * `npm run build`, which is what CI uses — but a deployment whose build command
 * invokes `next build` directly would skip it, and every `/docs/*.md` path
 * would 404 in production with nothing failing. There is no `vercel.json` in
 * this repository, so the deployed command is not knowable from the tree.
 * Putting the call here makes the question stop mattering.
 *
 * PHASE-GATED. `next start` also loads this config — measured, not assumed:
 * deleting `public/docs/` and starting the server without rebuilding put the
 * four files back — so an unguarded call does filesystem work at server start
 * for no reason.
 *
 * It is NOT load-bearing against a standalone crash, and an earlier version of
 * this comment claimed it was. The standalone `server.js` inlines the config
 * as serialized JSON at build time (`const nextConfig = {...}`) and never
 * re-executes this file, so the deployed runtime could not have thrown here.
 * Corrected on review rather than left as a scarier-sounding justification
 * than the truth.
 *
 * The gate is still right: build and dev generate, a server does not, and
 * failure stays LOUD in exactly the two phases where a missing or
 * non-`current` source is a real defect.
 */
const GENERATING_PHASES = new Set<string>([PHASE_PRODUCTION_BUILD, PHASE_DEVELOPMENT_SERVER])

const nextConfig: NextConfig = {
  output: 'standalone',
  // `@haven_ai/core` is a private workspace package (epic #980, #983). It ships
  // a built `dist`, so Next can resolve it as-is — this entry exists so the
  // dashboard keeps building if core ever exposes untranspiled source, and so
  // core's output goes through Next's own browser-target pipeline rather than
  // being trusted verbatim.
  transpilePackages: ['@haven_ai/core'],
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        // `??` only falls back on null/undefined — an empty or whitespace
        // NEXT_PUBLIC_API_URL (e.g. a blank Vercel env var) would otherwise
        // yield a hostless `/:path*` destination and fail the build. Treat
        // blank as unset.
        destination: `${(process.env.NEXT_PUBLIC_API_URL || '').trim() || 'http://localhost:3001'}/:path*`,
      },
    ]
  },
  async redirects() {
    return [
      {
        source: '/demo/x402',
        destination: '/protocols/x402',
        permanent: true,
      },
    ]
  },
  // Security response headers (scanner follow-up). The dashboard's JWT lives in
  // localStorage — a deliberate SPA tradeoff whose blast radius is bounded by
  // non-custody (a stolen token grants dashboard access only; moving funds
  // needs the local signer/delegate key, which never touches the browser).
  // These headers shrink the XSS surface that tradeoff exposes. CSP ships in
  // REPORT-ONLY first: it cannot break rendering, surfaces real violations to
  // promote from, and avoids guessing every connect-src (backend API,
  // wallet/onramp endpoints) blind.
  async headers() {
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ')
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'Content-Security-Policy-Report-Only', value: csp },
        ],
      },
    ]
  },
}

export default function config(phase: string): NextConfig {
  if (GENERATING_PHASES.has(phase)) generate()
  return nextConfig
}
