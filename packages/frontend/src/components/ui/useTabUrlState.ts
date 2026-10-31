'use client'

import { useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

/**
 * A page's `?tab=` state, mirrored to the URL (#4573).
 *
 * Account, Agent and Settings each carried their own `*TabFromUrl` parser and
 * `handleTabChange` — three copies of one rule, and the copies had already
 * drifted on the one point that matters: what happens to the OTHER query
 * parameters when the tab changes.
 *
 * The rule, stated once here:
 *
 * - **A tab switch clears the other parameters** (`keepOtherParams` defaults
 *   to `false`). This is the #4226 rule: a tab's filters belong to that tab,
 *   so switching tabs drops them rather than carrying a filter into a tab that
 *   does not read it. A parameter a component reads from the window rather
 *   than from `useSearchParams` (`?grant=` on the agent page) survives on its
 *   own, because nothing here can reach it.
 * - **Settings opts in to keeping them** (`keepOtherParams: true`). Its
 *   Business tab's `ConnectionsCard` is still reading the OAuth outcome
 *   (`provider`/`connect`/`reason`) when it strips them, so a tab switch must
 *   not take them away first.
 * - **The default tab carries no parameter** (`defaultTab`). It is the page's
 *   canonical address, so switching back to it DELETES `tab` rather than
 *   writing `?tab=<default>`.
 * - **An unknown or absent `tab` falls back to the default**, and `urlTab`
 *   reports `null` for both — Settings needs to tell "no tab named" from
 *   "`tab=general`" because an OAuth outcome selects Business when the URL
 *   names no tab at all.
 *
 * Writes use `router.replace`, so a tab switch adds no history entry: Back
 * leaves the page rather than walking back through its tabs.
 *
 * The hook writes what it is given. Whether the requested tab is ALREADY on
 * screen is the page's question, not the URL's: Settings' active tab can
 * differ from the URL's (an OAuth outcome selects Business with no `tab` in
 * the URL, and a Business tab with nothing to show falls back to the General
 * body while `tab=business` stays), so each page keeps its own one-line
 * comparison before calling `setTab`.
 *
 * `basePath` is the page's own path (`/settings`, `/accounts/<id>`) rather
 * than `usePathname()`: the account and agent pages encode their own id into
 * it, and the hook writes onto the address the page already owns.
 */
export interface UseTabUrlStateOptions<T extends string> {
  /** The tabs this page accepts; anything else in the URL falls back to `defaultTab`. */
  tabs: readonly T[]
  /** The tab that carries no `?tab=` parameter — the page's canonical address. */
  defaultTab: T
  /** The page's own path, e.g. `/settings` or `/accounts/<id>`. */
  basePath: string
  /**
   * Keep the other query parameters on a tab switch. Default `false`: a tab
   * switch clears them (#4226).
   */
  keepOtherParams?: boolean
}

export interface UseTabUrlStateApi<T extends string> {
  /** The tab to render: the URL's tab, or `defaultTab`. */
  tab: T
  /** The tab the URL names, or `null` when it names none (or an unknown one). */
  urlTab: T | null
  /** Switch tabs, writing the URL with `router.replace` (no history entry). */
  setTab: (tab: T) => void
}

export function useTabUrlState<T extends string>({
  tabs,
  defaultTab,
  basePath,
  keepOtherParams = false,
}: UseTabUrlStateOptions<T>): UseTabUrlStateApi<T> {
  const router = useRouter()
  const searchParams = useSearchParams()

  const raw = searchParams?.get('tab') ?? null
  const urlTab = raw !== null && (tabs as readonly string[]).includes(raw) ? (raw as T) : null
  const tab = urlTab ?? defaultTab

  const setTab = useCallback(
    (next: T) => {
      const params = keepOtherParams
        ? new URLSearchParams(searchParams?.toString() ?? '')
        : new URLSearchParams()
      if (next === defaultTab) {
        params.delete('tab')
      } else {
        params.set('tab', next)
      }
      const qs = params.toString()
      router.replace(`${basePath}${qs ? `?${qs}` : ''}`, { scroll: false })
    },
    [keepOtherParams, searchParams, defaultTab, basePath, router],
  )

  return { tab, urlTab, setTab }
}
