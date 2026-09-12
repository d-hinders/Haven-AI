import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import Providers from './providers'
import DiscoverySourceCapture from '@/components/DiscoverySourceCapture'
import { havenEnvironment } from '@/lib/env'
import { INSTALLED_APP_VIEWPORT, installedAppMetadata } from '@/lib/installed-app'
import { THEME_BOOTSTRAP_SCRIPT } from '@/lib/theme-bootstrap'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Haven, agent payments within your rules',
  description:
    'An account for your agents. You set the rules; they pay within them, never beyond. No raw keys, no shared cards.',
  // Installed-app shell (#2729): the iOS title and `apple-mobile-web-app-capable`.
  // The manifest link and the icon links come from the file conventions beside
  // this layout (`manifest.ts`, `icon1.tsx`, `icon2.tsx`, `apple-icon.tsx`).
  // `havenEnvironment()` is the same reading `EnvBadge` makes, so "Haven Dev"
  // on the home screen and the DEV chip in the top bar cannot disagree.
  ...installedAppMetadata(havenEnvironment()),
}

// `themeColor` for the status bar, with the default width/scale restated so
// no mobile baseline moves (#2729). Safe-area insets are #2730's.
export const viewport: Viewport = INSTALLED_APP_VIEWPORT

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // `suppressHydrationWarning`: the bootstrap script may have stamped
    // `data-theme` on this element before React hydrates — a fact the server
    // render could not know. The warning suppression is scoped to <html>
    // itself; the bootstrap script (lib/theme-bootstrap.ts, unit-tested)
    // touches ONLY that attribute, so nothing else can hide behind it.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
          No-flash theme bootstrap (#2927). Runs BEFORE any stylesheet paints:
          reads `haven.theme` and stamps `data-theme` on <html> so the first
          paint already carries the right token block. It is the app's only
          inline script; its content is the unit-tested constant
          THEME_BOOTSTRAP_SCRIPT (parse + jsdom behaviour in
          src/lib/__tests__/theme-bootstrap.test.ts).
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
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
