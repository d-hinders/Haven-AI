import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import Providers from './providers'
import DiscoverySourceCapture from '@/components/DiscoverySourceCapture'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Haven, agent payments within your rules',
  description:
    'An account for your agents. You set the rules; they pay within them, never beyond. No raw keys, no shared cards.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/*
          Agent-discovery hooks (#2521). An agent that fetches this page can now
          find the agent-readable artifacts from the HTML instead of guessing the
          convention, which is all the 2026-09-04 cold test had to go on.

          Written as literal tags rather than Metadata `alternates.types`, because
          Next resolves metadata URLs against `metadataBase` and would emit an
          absolute host here — the one thing epic #2519 forbids. A relative href
          is correct on the dev preview, on production, and on any future custom
          domain without configuration. React hoists these into <head>.

          Footgun for whoever comes next: Next de-dupes and merges metadata
          across nested layouts by FIELD, and a hand-written tag is invisible to
          that merge. If you ever add `alternates.types` to a nested route's
          metadata, it will emit a SECOND `rel="alternate"` link beside these
          rather than replacing them. Nothing in the tree does today.
        */}
        <link rel="alternate" type="text/plain" href="/llms.txt" title="llms.txt" />
        <link
          rel="alternate"
          type="application/json"
          href="/api/openapi.json"
          title="OpenAPI"
        />
      </head>
      <body className={`${inter.className} bg-[var(--v2-bg)] text-[var(--v2-ink)] antialiased`}>
        <DiscoverySourceCapture />
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
