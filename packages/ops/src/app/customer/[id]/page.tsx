'use client'

/**
 * The `/customer/[id]` route (#3516). Next 15 delivers dynamic params as a
 * Promise, so the id resolves in a client component below before any read.
 */
import { use } from 'react'
import { CustomerView } from '../../../components/customer/CustomerView'
import { useOpsClient } from '../../../components/useOpsClient'

export default function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const client = useOpsClient()
  return <CustomerView userId={id} client={client} />
}
