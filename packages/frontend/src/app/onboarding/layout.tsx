import type { Metadata } from 'next'
import { AUTH_MARKER_CONTENT, AUTH_MARKER_NAME } from '@/lib/discovery-surfaces'

/**
 * `/onboarding` is an auth wall like everything under `(authenticated)` — it
 * reads `useAuth`, and /login redirects into it — but it sits outside that route
 * group, so it needs its own marker (#2521). Without this layout the claim "every
 * authenticated route carries the marker" would be false for exactly one route,
 * which is the kind of near-miss the marker exists to prevent.
 *
 * Layout only: the page, its client component and the redirect are untouched.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  other: { [AUTH_MARKER_NAME]: AUTH_MARKER_CONTENT },
}

export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
