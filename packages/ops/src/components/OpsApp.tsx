'use client'

/**
 * The console, client-side (#3515; pages #3516). Order of authority:
 *
 *  1. A config error (no usable registry) is a full-page error screen.
 *  2. Until the session hook has consumed the URL fragment, nothing renders.
 *  3. Signed out → sign-in (with the return-fragment's error message).
 *  4. Signed in → the shell (banner + header + nav) and the routed page.
 *
 * The pages are real routes (`/overview`, `/search`, `/customer/[id]`,
 * `/health`, `/doc-health`) so a deep link lands where the operator meant.
 * The root route redirects to `/overview`; its own file renders null and the
 * shell above this point still renders the sign-in gate for it.
 */
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Card } from '@haven_ai/ui'
import {
  OpsClientRoot,
  useOpsRegistry,
  useOpsSessionContext,
} from './OpsClientRoot'
import { OpsShell } from './OpsShell'
import { SignInView } from './SignInView'
import { browserStorage } from './browserStorage'

export function OpsApp({
  registry,
  children,
}: {
  registry: import('../lib/environments').EnvironmentRegistry
  children?: React.ReactNode
}) {
  if (registry.error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--v2-bg)] px-4">
        <Card className="max-w-md p-6" hover={false}>
          <h1 className="text-lg font-semibold text-[var(--v2-ink)]">Configuration error</h1>
          <p className="mt-2 text-sm text-[var(--v2-ink-2)]">{registry.error}</p>
        </Card>
      </div>
    )
  }
  return (
    <OpsClientRoot registry={registry.environments}>
      <Console>{children}</Console>
    </OpsClientRoot>
  )
}

function Console({ children }: { children?: React.ReactNode }) {
  const registry = useOpsRegistry()
  const session = useOpsSessionContext()
  const router = useRouter()

  // The root route has no page of its own (#3516): a console opens on the
  // overview. The redirect runs as an effect, after the session gate above
  // has already decided what this render shows.
  useEffect(() => {
    if (window.location.pathname === '/' || window.location.pathname === '') {
      router.replace('/overview')
    }
  }, [router])

  if (session.outcome.state !== 'ready') {
    return (
      <SignInView
        environments={registry}
        storage={browserStorage()}
        // The hook resolves codes to human copy (signInErrorMessage); the raw
        // string it carries is final copy, never a code to translate again.
        error={session.outcome.error}
      />
    )
  }
  return <OpsShell environments={registry}>{children}</OpsShell>
}
