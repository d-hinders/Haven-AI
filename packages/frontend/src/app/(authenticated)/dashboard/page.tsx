'use client'

import dynamic from 'next/dynamic'
import { RouteLoading } from '@/components/ui/RouteLoading'

const DashboardClient = dynamic(() => import('./DashboardClient'), {
  ssr: false,
  loading: () => <RouteLoading className="p-8" />,
})

export default function DashboardPage() {
  return <DashboardClient />
}
