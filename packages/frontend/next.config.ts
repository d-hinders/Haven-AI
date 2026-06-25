import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',
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
}

export default nextConfig
