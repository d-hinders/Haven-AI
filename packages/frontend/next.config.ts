import type { NextConfig } from 'next'

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

export default nextConfig
