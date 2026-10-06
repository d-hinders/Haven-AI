import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import '@haven_ai/ui/tokens.css'
import './globals.css'
import '@haven_ai/ui/type.css'
import { deploymentRegistry } from '../lib/deployment'
import { OpsApp } from '../components/OpsApp'

// Inter, loaded the way the dashboard loads it (#3584). `next/font` downloads
// the files at BUILD time and self-hosts them under `/_next/static/media`, so
// the browser never contacts Google and the CSP's `font-src 'self'` holds.
// The cost is a build-time fetch: a Google Fonts outage fails `ops_checks`'
// build, not the deployed page.
const inter = Inter({ subsets: ['latin'] })

// noindex (#3515): a private console must not be crawled. The robots
// directive rides the layout metadata so every page inherits it; the
// headers in next.config.ts set `X-Robots-Tag: noindex` on the wire as well.
export const metadata: Metadata = {
  title: 'Haven Ops',
  description: 'The Haven operations console.',
  robots: { index: false, follow: false },
}

// Dynamic rendering (#3581): the middleware's CSP carries a per-request script
// nonce, and Next stamps it on its scripts only while rendering a request. A
// prerendered page is rendered at build time with no request, so its HTML
// carries no nonce and the browser refuses every script.
export const dynamic = 'force-dynamic'

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // The registry is resolved once, server-side, and preview-filtered there;
  // the client never re-derives it, so a preview deployment's prod exclusion
  // cannot hydration-mismatch against a client that did not exclude it.
  const registry = deploymentRegistry()
  return (
    <html lang="en">
      <body className={`${inter.className} antialiased`}>
        <OpsApp registry={registry}>{children}</OpsApp>
      </body>
    </html>
  )
}
