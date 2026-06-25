import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',
  async rewrites() {
    return [
      {
        source: '/api/:path*',
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
