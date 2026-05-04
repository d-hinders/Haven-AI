'use client'

import { useEffect, useState } from 'react'
import { getResolvedApiBaseUrl } from '@/lib/api'

export default function ApiBaseDebugLabel() {
  const [apiBaseUrl, setApiBaseUrl] = useState<string | null>(null)

  useEffect(() => {
    setApiBaseUrl(getResolvedApiBaseUrl())
  }, [])

  if (!apiBaseUrl) {
    return null
  }

  return (
    <div className="fixed bottom-3 right-3 z-[100] max-w-[min(28rem,calc(100vw-1.5rem))] rounded-full border border-emerald-400/30 bg-black/85 px-3 py-2 text-[11px] text-emerald-200 shadow-lg backdrop-blur-sm">
      <span className="font-semibold text-emerald-300">API backend:</span>{' '}
      <span className="break-all">{apiBaseUrl}</span>
    </div>
  )
}
