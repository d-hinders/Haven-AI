import type { Metadata } from 'next'
import AuthenticatedShell from '@/components/AuthenticatedShell'
import { AUTH_MARKER_CONTENT, AUTH_MARKER_NAME } from '@/lib/discovery-surfaces'

/**
 * Auth-wall marker for non-browser clients (#2521, pulled forward from A4).
 *
 * Every page under this layout answers HTTP 200 with an SSR shell and only
 * redirects to /login once React has hydrated. To `curl` that is
 * indistinguishable from a public page — the 2026-09-04 cold test read
 * /dashboard, /agents and /agents/connect as 200s titled like the marketing
 * site and could not tell it had hit a wall.
 *
 * `metadata.other` puts the marker in <head>, which is why this file is a
 * server component; the chrome moved to <AuthenticatedShell> unchanged. The
 * client-side redirect is untouched.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  other: { [AUTH_MARKER_NAME]: AUTH_MARKER_CONTENT },
}

export default function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <>
      {/*
        The human-readable half of the marker. In <noscript> deliberately: a
        browser reaching here is one hydration away from the /login redirect, so
        a visible banner would be a flash of wrong content on every authenticated
        page load — and it would move pixels under the visual baselines. A
        non-browser client, which is who this sentence is for, sees it in the
        HTML either way.
      */}
      <noscript>
        <p>
          Sign in required — this page needs an authenticated Haven session. If you are an
          AI agent, you cannot sign in here; ask the person you are acting for to sign in
          at /login. Start at <a href="/llms.txt">/llms.txt</a>.
        </p>
      </noscript>
      <AuthenticatedShell>{children}</AuthenticatedShell>
    </>
  )
}
