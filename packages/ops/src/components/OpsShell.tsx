'use client'

/**
 * The console shell (#3515, pages #3516): header (wordmark, env switcher,
 * sign-out) over page content, with the prod banner pinned full-width ABOVE
 * the header whenever `prod` is selected — on every page, because the shell
 * wraps every page (the banner AC is pinned by a test that renders every
 * route inside this shell).
 *
 * #3516 adds the page nav under the header and provides the selected origin
 * to the pages through `OpsPageProvider` — the one place the selection is
 * resolved, so a page cannot render against a stale origin.
 */
import { useState } from 'react'
import { Button } from '@haven_ai/ui'
import { defaultEnvironment } from '../lib/environments'
import type { OpsEnvironment } from '../lib/environments'
import { useOpsSessionContext } from './OpsClientRoot'
import { EnvSwitcher } from './EnvSwitcher'
import { ProdBanner } from './ProdBanner'
import { OpsNav } from './OpsNav'
import { OpsPageProvider } from './OpsPageContext'

export function OpsShell({
  environments,
  children,
}: {
  environments: OpsEnvironment[]
  children: React.ReactNode
}) {
  const [selectedKey, setSelectedKey] = useState(() => defaultEnvironment(environments))
  const session = useOpsSessionContext()
  const selected = environments.find((environment) => environment.key === selectedKey)
  return (
    <OpsPageProvider
      value={{
        origin: selected?.origin ?? '',
        onUnauthorized: session.onUnauthorized,
      }}
    >
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
        <OpsNav />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
          {selected ? children : null}
        </main>
      </div>
    </OpsPageProvider>
  )
}
