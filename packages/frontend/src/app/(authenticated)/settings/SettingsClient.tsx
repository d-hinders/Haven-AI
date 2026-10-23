'use client'

/**
 * Settings in three tabs (#4358, epic #4356 slice 2/3): General, Security
 * and Business, selected through `?tab=` exactly as the account page owns
 * its tab (`AccountDetailClient`). General is the default — an unknown
 * value falls back to it — and switching uses `router.replace`, so the
 * tabs add no history entry: Back leaves Settings. The tab-switch URL
 * write preserves every other query parameter, because the Business tab's
 * `ConnectionsCard` is still reading the OAuth outcome
 * (`provider`/`connect`/`reason`) when it strips them — and when no `tab`
 * is present but those parameters are, Business is selected anyway (an old
 * bookmarked callback URL still lands right).
 *
 * ## What lives where
 *
 * - **General.** Profile (the name editor extracted from the deleted
 *   `/profile` page, read-only email, Member since), Preferences
 *   (currency + theme, unchanged) and Your data (one row linking to
 *   `/transactions`, where the CSV export lives).
 * - **Security.** "Passkeys and wallets" (`SignersSection`) — each
 *   approved account links to its `/accounts/<id>?tab=security` — plus
 *   "If something goes wrong": the exit path and what Haven cannot
 *   recover.
 * - **Business.** Company details and the accounting connections, moved
 *   here unchanged; #4359 reshapes them. Its visibility rule is #4359's;
 *   until that lands the tab always shows.
 *
 * The placeholder rows the old single-page layout carried (agent spend
 * alerts, password, active sessions, privacy controls) are removed with
 * owner decision 3 on the epic — no "Coming soon" renders on General or
 * Security. `common.comingSoon` itself stays (the sidebar's Accounting
 * pill and `ConnectionRow` share it).
 *
 * The `#signers` anchor (`AccountSignersCard` links here with
 * `?tab=security#signers`) scrolls once the Security tab has mounted.
 */

import { ArrowRight } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { usePreferences } from '@/hooks/usePreferences'
import { useT } from '@/context/LocaleContext'
import { useTheme, type ThemePreference } from '@/context/ThemeContext'
import { useAuth } from '@/context/AuthContext'
import { formatLongDate } from '@/lib/format'
import { PageHeader } from '@/components/ui/PageHeader'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { Tabs } from '@/components/ui/Tabs'
import { SettingsSection as Section, SettingsRow as SettingRow } from '@/components/ui/SettingsSection'
import { ConnectionsCard, CONNECT_OUTCOME_PARAMS } from '@/components/accounting/ConnectionsCard'
import { CompanyDetailsCard } from '@/components/settings/CompanyDetailsCard'
import { SignersSection } from '@/components/settings/SignersSection'
import { ProfileNameEditor } from '@/components/settings/ProfileNameEditor'

type SettingsTab = 'general' | 'security' | 'business'

const SETTINGS_TABS: readonly SettingsTab[] = ['general', 'security', 'business']

function settingsTabFromUrl(raw: string | null): SettingsTab | null {
  return SETTINGS_TABS.includes(raw as SettingsTab) ? (raw as SettingsTab) : null
}

/**
 * True when the URL carries an OAuth outcome the Business tab's card has
 * not consumed yet — an old bookmarked `/settings?provider=…&connect=…`
 * callback selects Business even without an explicit `tab`.
 */
function hasConnectOutcome(searchParams: URLSearchParams): boolean {
  return CONNECT_OUTCOME_PARAMS.some((key) => searchParams.get(key) !== null)
}

export default function SettingsClient() {
  const { currency, setCurrency, saving } = usePreferences()
  const { preference, setPreference } = useTheme()
  const { user } = useAuth()
  const t = useT()
  const router = useRouter()
  const searchParams = useSearchParams()

  // The URL owns the tab; an unknown value falls back to General.
  const urlTab = settingsTabFromUrl(searchParams.get('tab'))
  const activeTab: SettingsTab = urlTab ?? (hasConnectOutcome(searchParams) ? 'business' : 'general')

  // `general` is the default and carries no parameter (the canonical
  // address); every other tab is written alongside — never replacing — the
  // parameters already present, so an OAuth outcome survives until its
  // card has read it.
  const handleTabChange = (tab: SettingsTab) => {
    if (tab === activeTab) return
    const params = new URLSearchParams(searchParams.toString())
    if (tab === 'general') {
      params.delete('tab')
    } else {
      params.set('tab', tab)
    }
    const qs = params.toString()
    router.replace(`/settings${qs ? `?${qs}` : ''}`, { scroll: false })
  }

  // The `#signers` anchor lands on a tab that may mount after the hash is
  // set (`?tab=security#signers` from `AccountSignersCard`) — scroll once,
  // after the tab is actually on screen.
  useEffect(() => {
    if (activeTab !== 'security') return
    if (window.location.hash !== '#signers') return
    document.getElementById('signers')?.scrollIntoView({ block: 'start' })
  }, [activeTab])

  const tabItems = [
    { value: 'general' as const, label: t.settings.tab.general },
    { value: 'security' as const, label: t.settings.tab.security },
    { value: 'business' as const, label: t.settings.tab.business },
  ]

  return (
    <div className="max-w-4xl">
      <PageHeader title={t.settings.title} subtitle={t.settings.subtitle} />

      {/* The tablist scrolls horizontally when it outgrows a 375px viewport
          (`Tabs` owns the overflow); the page itself adds none. */}
      <Tabs
        tabs={tabItems}
        value={activeTab}
        onChange={handleTabChange}
        ariaLabel={t.settings.tab.ariaLabel}
      />

      <div className="space-y-6 pt-6">
        {activeTab === 'general' && (
          <>
            <Section title={t.settings.profile.title} description={t.settings.profile.description}>
              <ProfileNameEditor />
              <SettingRow
                label={t.settings.profile.email}
                detail={t.settings.profile.emailDetail}
                value={user?.email ?? t.settings.profile.notAvailable}
              />
              <SettingRow
                label={t.settings.profile.memberSince}
                value={
                  user?.created_at
                    ? formatLongDate(user.created_at)
                    : t.settings.profile.notAvailable
                }
              />
            </Section>

            <Section
              title={t.settings.preferences.title}
              description={t.settings.preferences.description}
            >
              <SettingRow
                label={t.settings.currency.label}
                detail={t.settings.currency.detail}
                action={
                  <SegmentedControl
                    ariaLabel={t.settings.currency.label}
                    value={currency}
                    onChange={setCurrency}
                    disabled={saving}
                    options={[
                      { value: 'USD', label: '$ USD' },
                      { value: 'EUR', label: '€ EUR' },
                      { value: 'SEK', label: 'kr SEK' },
                    ]}
                  />
                }
              />
              {/*
                Appearance (#2927): the theme preference. The sidebar
                footer's quick toggle flips the SAME setting — the detail
                line says so, so a user meeting one control can predict the
                other.
              */}
              <SettingRow
                label={t.settings.theme.label}
                detail={t.settings.theme.detail}
                action={
                  <SegmentedControl
                    ariaLabel={t.settings.theme.label}
                    value={preference}
                    onChange={(next: ThemePreference) => setPreference(next)}
                    options={[
                      { value: 'light', label: t.settings.theme.light },
                      { value: 'dark', label: t.settings.theme.dark },
                      { value: 'system', label: t.settings.theme.system },
                    ]}
                  />
                }
              />
            </Section>

            <Section
              title={t.settings.data.title}
              description={t.settings.data.description}
            >
              <SettingRow
                label={t.settings.data.exportLabel}
                detail={t.settings.data.exportDetail}
                action={
                  <a
                    href="/transactions"
                    className="inline-flex items-center gap-1 text-sm font-medium text-[var(--v2-brand)] hover:underline"
                  >
                    {t.settings.data.openTransactions}
                    <Icon icon={ArrowRight} className="h-3.5 w-3.5" />
                  </a>
                }
              />
            </Section>
          </>
        )}

        {activeTab === 'security' && (
          <>
            {/*
              Passkeys and wallets (#3825): every passkey and wallet that
              approves the user's accounts, once each. Each approved
              account links to its own `/accounts/<id>?tab=security`, where
              the add / remove / recovery flows live.
            */}
            <SignersSection />

            <Section
              title={t.settings.recovery.title}
              description={t.settings.recovery.description}
            >
              <SettingRow
                label={t.settings.recovery.limitationsLabel}
                detail={t.settings.recovery.limitationsDetail}
              />
              <SettingRow
                label={t.settings.recovery.exitPathLabel}
                detail={t.settings.recovery.exitPathDetail}
                action={
                  <a
                    href="/exit/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-sm font-medium text-[var(--v2-brand)] hover:underline"
                  >
                    {t.settings.recovery.exitPathLabel}
                    <Icon icon={ArrowRight} className="h-3.5 w-3.5" />
                  </a>
                }
              />
            </Section>
          </>
        )}

        {activeTab === 'business' && (
          <>
            {/*
              Accounting connections live HERE (owner decision 2026-09-11,
              #2868): the feed page keeps the sync rows, Settings owns
              Connect / Reconnect / Disconnect, the feed settings and the
              backfill choice. Moved onto the Business tab unchanged
              (#4358); #4359 reshapes it.
            */}
            <ConnectionsCard />

            {/*
              Owner company details + VIES (#3332): renders only when
              `GET /user/company-details` does not answer the feature-off 404 —
              `CompanyDetailsCard` itself returns null in that case, so there is
              no flag to check here.
            */}
            <CompanyDetailsCard />
          </>
        )}
      </div>
    </div>
  )
}
