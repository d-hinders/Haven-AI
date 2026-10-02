'use client'

import { useEffect, useState } from 'react'
import { Card, InlineAlert, Skeleton } from '@haven_ai/ui'
import { opsFetch } from '../lib/api'
import type { ApiSchema } from '@haven_ai/core'
import {
  OpsClientRoot,
  useOpsRegistry,
  useOpsSessionContext,
} from './OpsClientRoot'
import { OpsShell } from './OpsShell'
import { SignInView } from './SignInView'

type OpsMe = ApiSchema<'OpsSession'>

/**
 * The console, client-side (#3515). Order of authority:
 *
 *  1. A config error (no usable registry) is a full-page error screen.
 *  2. Until the session hook has consumed the URL fragment, nothing renders.
 *  3. Signed out → sign-in (with the return-fragment's error message).
 *  4. Signed in → the shell (banner + header) and the home page, which calls
 *     GET /ops/me on the selected backend's origin.
 */
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
      <Console />
    </OpsClientRoot>
  )
}

/**
 * The Storage for handler/effect use. Effects and event handlers never run in
 * the server render pass, so this only ever resolves in the browser; the
 * `typeof window` guard keeps that fact explicit and the server pass safe
 * (the same pattern AgentPanel and DelegationBudgetCard use).
 */
function browserStorage(): Storage {
  if (typeof window === 'undefined') {
    throw new Error('sessionStorage is only available in the browser')
  }
  return window.sessionStorage
}

function Console() {
  const registry = useOpsRegistry()
  const session = useOpsSessionContext()
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
  return (
    <OpsShell environments={registry}>
      {(origin) => <Home origin={origin} session={session} />}
    </OpsShell>
  )
}

/** The placeholder home page: calls GET /ops/me on the selected origin. */
function Home({ origin, session }: { origin: string; session: ReturnType<typeof useOpsSessionContext> }) {
  const [me, setMe] = useState<OpsMe | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setMe(null)
    setError(null)
    opsFetch(`${origin}/ops/me`, {
      storage: browserStorage(),
      unauthorized: session.onUnauthorized,
    })
      .then(async (response) => {
        if (!response.ok) {
          setError(`The console could not read the session (${response.status}).`)
          return
        }
        const data = (await response.json()) as OpsMe
        if (!cancelled) setMe(data)
      })
      .catch(() => {
        if (!cancelled) setError('The console could not reach the backend.')
      })
    return () => {
      cancelled = true
    }
  }, [origin, session.onUnauthorized])

  if (error) {
    return (
      <Card className="p-6" hover={false}>
        <InlineAlert>{error}</InlineAlert>
      </Card>
    )
  }
  if (!me) {
    return (
      <Card className="p-6" hover={false}>
        <Skeleton className="h-4 w-40" />
        <div className="mt-3 space-y-2">
          <Skeleton className="h-3 w-64" />
          <Skeleton className="h-3 w-52" />
        </div>
      </Card>
    )
  }
  return (
    <Card className="p-6" hover={false}>
      <h1 className="text-base font-semibold text-[var(--v2-ink)]">Signed in</h1>
      <p className="mt-2 text-sm text-[var(--v2-ink-2)]">
        GitHub user {me.login} (id {me.github_id}); the session expires at{' '}
        {new Date(me.expires_at).toLocaleString()}.
      </p>
    </Card>
  )
}
