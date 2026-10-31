'use client'

import dynamic from 'next/dynamic'
import { RouteLoading } from '@/components/ui/RouteLoading'

const AccountsOverviewClient = dynamic(() => import('./AccountsOverviewClient'), {
  ssr: false,
  loading: () => <RouteLoading className="p-8" />,
})

export default function AccountsPage() {
  return <AccountsOverviewClient />
}
