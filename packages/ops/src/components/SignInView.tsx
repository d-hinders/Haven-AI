'use client'

/**
 * Sign-in (#3515).
 *
 * One button: it starts the GitHub handoff against the backend origin the
 * operator picks (or the only one the registry offers). On return the shell
 * consumes the fragment — see lib/ops-session.ts — and flips to the console.
 *
 * Every sign-in error code the #3509 backend can return is surfaced here as
 * a message, via InlineAlert.
 */
import { useState } from 'react'
import { Button, Card, InlineAlert } from '@haven_ai/ui'
import { startSignIn, signInErrorMessage } from '../lib/ops-session'
import { useOpsSessionContext } from './OpsClientRoot'
import type { OpsEnvironment } from '../lib/environments'

export function SignInView({
  environments,
  storage,
  error,
}: {
  environments: OpsEnvironment[]
  storage: Storage
  /** The error message from the return fragment, already rendered to copy. */
  error: string | null
}) {
  const [selectedKey, setSelectedKey] = useState(() => environments[0]?.key ?? '')
  const selected = environments.find((environment) => environment.key === selectedKey)

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--v2-bg)] px-4">
      <Card className="w-full max-w-sm p-6" hover={false}>
        <h1 className="text-lg font-semibold text-[var(--v2-ink)]">Haven Ops</h1>
        <p className="mt-1 text-sm text-[var(--v2-ink-2)]">
          Sign in with GitHub to open the operations console.
        </p>
        {error ? (
          <div className="mt-4">
            <InlineAlert>{error}</InlineAlert>
          </div>
        ) : null}
        {environments.length > 1 ? (
          <label className="mt-4 block text-sm text-[var(--v2-ink-2)]">
            Backend
            <select
              className="mt-1 w-full rounded-md border border-[var(--v2-border)] bg-[var(--v2-surface)] px-3 py-2 text-sm text-[var(--v2-ink)]"
              value={selectedKey}
              onChange={(event) => setSelectedKey(event.target.value)}
            >
              {environments.map((environment) => (
                <option key={environment.key} value={environment.key}>
                  {environment.key}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="mt-5">
          {/* size="lg" (#3584): the lone CTA paints 44 px. The shared `md`
              size already has a 44 px hit area (#1726); this is an ops-only
              density choice for a sign-in card with nothing else on it. */}
          <Button
            size="lg"
            className="w-full"
            disabled={!selected}
            onClick={() => {
              if (selected) startSignIn(storage, selected.origin, (url) => window.location.assign(url))
            }}
          >
            Continue with GitHub
          </Button>
        </div>
      </Card>
    </div>
  )
}
