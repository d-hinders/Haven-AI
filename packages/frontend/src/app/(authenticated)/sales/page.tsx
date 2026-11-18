'use client'

import dynamic from 'next/dynamic'
import { RouteLoading } from '@/components/ui/RouteLoading'

// The same lazy, client-only mount as `analytics` and `transactions`: the page
// answers only once the session and the shell's merchant-services setting are
// in hand, so there is nothing to render on the server.
const SalesClient = dynamic(() => import('./SalesClient'), {
  ssr: false,
  loading: () => <RouteLoading className="p-8" />,
})

export default function SalesPage() {
  return <SalesClient />
}
