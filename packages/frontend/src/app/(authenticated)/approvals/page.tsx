'use client'

import dynamic from 'next/dynamic'

const ApprovalQueue = dynamic(() => import('@/components/ApprovalQueue'), {
  ssr: false,
  loading: () => (
    <div className="flex items-center gap-3 p-8">
      <div className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
      <span className="text-sm text-zinc-500">Loading approvals...</span>
    </div>
  ),
})

export default function ApprovalsPage() {
  return (
    <div className="max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight mb-1">Approvals</h1>
        <p className="text-sm text-zinc-500">
          Review agent-initiated transactions that need your manual approval before Haven can continue.
        </p>
      </div>

      <ApprovalQueue />
    </div>
  )
}
