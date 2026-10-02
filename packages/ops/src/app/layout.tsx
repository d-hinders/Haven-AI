import type { Metadata, Viewport } from 'next'
import '@haven_ai/ui/tokens.css'
import './globals.css'
import { deploymentRegistry } from '../lib/deployment'
import { OpsApp } from '../components/OpsApp'

// noindex (#3515): a private console must not be crawled. The robots
// directive rides the layout metadata so every page inherits it; the
// headers in next.config.ts set `X-Robots-Tag: noindex` on the wire as well.
export const metadata: Metadata = {
  title: 'Haven Ops',
  description: 'The Haven operations console.',
  robots: { index: false, follow: false },
}

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
      <body>
        <OpsApp registry={registry}>{children}</OpsApp>
      </body>
    </html>
  )
}
