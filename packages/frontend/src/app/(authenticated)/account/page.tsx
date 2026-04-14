'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function AccountRedirectPage() {
  const router = useRouter()

  useEffect(() => {
    router.replace('/accounts')
  }, [router])

  return (
    <div className="flex items-center gap-3 p-8">
      <div className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
      <span className="text-sm text-zinc-500">Redirecting...</span>
    </div>
  )
}
