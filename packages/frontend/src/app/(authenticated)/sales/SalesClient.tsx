'use client'

import { useMemo, useState } from 'react'
import { notFound } from 'next/navigation'
import { QrCode } from 'lucide-react'
import { useMerchantServicesContext } from '@/context/MerchantServicesContext'
import type { SmartAccount } from '@/context/AuthContext'
import { useMerchantCatalogue } from '@/hooks/useMerchantCatalogue'
import { usePreferences } from '@/hooks/usePreferences'
import { useSalesPayments } from '@/hooks/useSalesPayments'
import { resolveChainOrNull } from '@/lib/chains'
import { catalogueNeedsAttention, salesDayRange } from '@/lib/sales'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageHeader } from '@/components/ui/PageHeader'
import { PeriodPicker } from '@/components/ui/PeriodPicker'
import { RouteLoading } from '@/components/ui/RouteLoading'
import { Tabs } from '@/components/ui/Tabs'
import { useListUrlState } from '@/components/ui/useListUrlState'
import { useTabUrlState } from '@/components/ui/useTabUrlState'
import type { ListState, ListUrlSchema, PeriodValue } from '@/components/ui/list-url-codec'
import ReceiveDialog from '@/components/ReceiveDialog'
import { SalesFirstRun } from '@/components/sales/SalesFirstRun'
import { SalesOverviewTab } from '@/components/sales/SalesOverviewTab'
import { SalesPaymentPanel } from '@/components/sales/SalesPaymentPanel'
import { SalesProductsTab } from '@/components/sales/SalesProductsTab'
import { SalesSetupTab } from '@/components/sales/SalesSetupTab'

/**
 * The Sales page (#4900, epic #4885; approved on #4894).
 *
 * Three tabs — Overview, Products, Setup — held in `?tab=`, and for Overview
 * one period held in `?period=` (or `?from=&to=`), the list-controls
 * codec's own keys. The page exists only while merchant services are on:
 *
 * - the setting is the shell's one read (`MerchantServicesContext`, #4904);
 *   this page never reads it again;
 * - while it loads: the route's loading pattern, never a 404;
 * - off (or no Sales account): the address answers as not found, the same
 *   `notFound()` an unknown route gets — the entry is already absent from the
 *   menu;
 * - a failed read is not "off": it says so and offers a retry.
 */

const TABS = ['overview', 'products', 'setup'] as const
type SalesTab = (typeof TABS)[number]

const DEFAULT_PERIOD: PeriodValue = { preset: '30d' }

/**
 * Presets and custom days; no All time — the reads take days and the
 * Revenue tile compares against the period before this one, so the period
 * must be bounded. A module constant: `useListUrlState` re-parses on a new
 * schema identity.
 */
const SALES_URL_SCHEMA: ListUrlSchema = {
  period: { allowAllTime: false, allowCustom: true, defaultValue: DEFAULT_PERIOD },
}

export default function SalesClient() {
  const { status, enabled, merchantAccount, refresh } = useMerchantServicesContext()

  if (status === 'loading') return <RouteLoading className="p-8" />
  if (status === 'error') {
    return (
      <div className="max-w-6xl" data-testid="sales-setting-error">
        <EmptyState
          title="Sales could not load"
          body="Your payments are unchanged."
          action={
            <Button variant="ghost" size="sm" onClick={() => void refresh()}>
              Try again
            </Button>
          }
        />
      </div>
    )
  }
  if (!enabled || merchantAccount === null) notFound()

  return <SalesPage account={merchantAccount} />
}

function SalesPage({ account }: { account: NonNullable<ReturnType<typeof useMerchantServicesContext>['merchantAccount']> }) {
  const { currency } = usePreferences()
  const [listState, setListState] = useListUrlState(SALES_URL_SCHEMA, { filtering: 'browser' })
  const { tab, setTab } = useTabUrlState<SalesTab>({
    tabs: TABS,
    defaultTab: 'overview',
    basePath: '/sales',
    keepOtherParams: true,
  })
  const [receiveOpen, setReceiveOpen] = useState(false)
  const [openPayment, setOpenPayment] = useState<string | null>(null)
  // Bumped when a sale record is cleared: the Overview reads again, so the
  // list row and the summary's by-product lines follow the panel.
  const [refreshKey, setRefreshKey] = useState(0)
  // One catalogue read for the page: the Products tab's table, its count and
  // warning dot, and the Setup tab's kit-address field describe the same answer.
  const catalogue = useMerchantCatalogue()

  const period = listState.period ?? DEFAULT_PERIOD
  const range = useMemo(() => salesDayRange(period), [period])

  // First run: has the account EVER been paid? One payment of the whole
  // history answers it, whatever period the page is on (a quiet period is not a
  // first run).
  const ever = useSalesPayments(null, { limit: 1 })
  const firstRun = !ever.loading && !ever.failed && ever.payments.length === 0

  // The Receive dialog wants an account object. The Sales account is a real
  // Haven account the setting already named, so it is shaped from that, not
  // looked up in the user's account list.
  const receiveAccount: SmartAccount = useMemo(
    () => ({
      id: account.id,
      account_address: account.account_address,
      chain_id: account.chain_id,
      name: account.name,
      is_default: false,
      created_at: account.created_at,
    }),
    [account],
  )

  const network = resolveChainOrNull(account.chain_id)?.name
  const meta = network ? `${account.name} · ${network}` : account.name

  const productCount = catalogue.data?.products.length ?? 0
  const attention = catalogueNeedsAttention(catalogue.data)

  const openSetup = () => {
    setOpenPayment(null)
    setTab('setup')
  }

  const changePeriod = (next: PeriodValue) => {
    const nextState: ListState = { ...listState, period: next }
    setListState(nextState)
  }

  return (
    <div className="max-w-6xl" data-testid="sales-page">
      <PageHeader
        title="Sales"
        subtitle="What your Sales account received, and what each payment was for."
        meta={meta}
        actions={
          <>
            <Button variant="ghost" leadingIcon={QrCode} onClick={() => setReceiveOpen(true)}>
              Receive
            </Button>
            {tab === 'overview' && !firstRun ? (
              <PeriodPicker
                value={period}
                onChange={changePeriod}
                allowAllTime={false}
                allowCustom
                defaultValue={DEFAULT_PERIOD}
              />
            ) : null}
          </>
        }
      />

      <div className="mt-6">
        <Tabs
          ariaLabel="Sales"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'overview', label: 'Overview' },
            {
              value: 'products',
              label: 'Products',
              ...(productCount > 0 ? { count: productCount } : {}),
              ...(attention ? { warningDot: true } : {}),
            },
            { value: 'setup', label: 'Setup', ...(attention ? { warningDot: true } : {}) },
          ]}
        />
      </div>

      {tab === 'overview' ? (
        ever.loading ? (
          <div className="mt-6">
            <RouteLoading />
          </div>
        ) : firstRun ? (
          <SalesFirstRun onShowAddress={() => setReceiveOpen(true)} setupHref="/sales?tab=setup" />
        ) : (
          <SalesOverviewTab
            range={range}
            currency={currency}
            merchantName={account.name}
            onOpenPayment={setOpenPayment}
            refreshKey={refreshKey}
          />
        )
      ) : tab === 'products' ? (
        <SalesProductsTab catalogue={catalogue} range={range} onOpenSetup={() => setTab('setup')} />
      ) : (
        <SalesSetupTab account={account} catalogue={catalogue} onShowAddress={() => setReceiveOpen(true)} />
      )}

      <SalesPaymentPanel
        txHash={openPayment}
        onClose={() => setOpenPayment(null)}
        onCleared={() => setRefreshKey((key) => key + 1)}
        onOpenSetup={openSetup}
      />
      <ReceiveDialog open={receiveOpen} account={receiveAccount} onClose={() => setReceiveOpen(false)} />
    </div>
  )
}
