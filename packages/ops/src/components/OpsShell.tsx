'use client'

/**
 * The console shell (#3515): header (wordmark, env switcher, sign-out) over
 * page content, with the prod banner pinned full-width ABOVE the header
 * whenever `prod` is selected — on every page, because the shell wraps every
 * page.
 *
 * The selected environment lives here as the single source for the banner
 * and for the origin data calls resolve against.
 */
import { useState } from 'react'
import { Button } from '@haven_ai/ui'
import { defaultEnvironment } from '../lib/environments'
import type { OpsEnvironment } from '../lib/environments'
import { useOpsSessionContext } from './OpsClientRoot'
import { EnvSwitcher } from './EnvSwitcher'
import { ProdBanner } from './ProdBanner'

export function OpsShell({
  environments,
  children,
}: {
  environments: OpsEnvironment[]
  children: (selectedOrigin: string) => React.ReactNode
}) {
  const [selectedKey, setSelectedKey] = useState(() => defaultEnvironment(environments))
  const session = useOpsSessionContext()
  const selected = environments.find((environment) => environment.key === selectedKey)
  return (
    <div className="flex min-h-screen flex-col bg-[var(--v2-bg)]">
      <ProdBanner selectedKey={selectedKey} />
      <header className="border-b border-[var(--v2-border)] bg-[var(--v2-bg)]">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-3">
          <span className="text-sm font-semibold text-[var(--v2-ink)]">Haven Ops</span>
          <div className="flex items-center gap-3">
            <EnvSwitcher
              environments={environments}
              selectedKey={selectedKey}
              onSelect={setSelectedKey}
            />
            <Button variant="ghost" size="sm" onClick={session.signOut}>
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        {selected ? children(selected.origin) : null}
      </main>
    </div>
  )
}
