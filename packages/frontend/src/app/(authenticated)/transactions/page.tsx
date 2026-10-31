'use client'

import dynamic from 'next/dynamic'
import { RouteLoading } from '@/components/ui/RouteLoading'

const TransactionsClient = dynamic(() => import('./TransactionsClient'), {
  ssr: false,
  loading: () => <RouteLoading className="p-8" />,
})

export default function TransactionsPage() {
  return <TransactionsClient />
}
