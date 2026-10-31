'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/context/AuthContext'
import { RouteLoading } from '@/components/ui/RouteLoading'

export default function ProtectedRoute({
  children,
}: {
  children: React.ReactNode
}) {
  const { user, loading } = useAuth()
  const router = useRouter()

  useEffect(() => {
    if (!loading && !user) {
      router.replace('/login')
    }
  }, [loading, user, router])

  useEffect(() => {
    if (!loading && user && (!user.accounts || user.accounts.length === 0) && !user.account_address) {
      router.replace('/onboarding')
    }
  }, [loading, user, router])

  const hasAccount = user && (user.accounts?.length > 0 || user.account_address)

  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--v2-bg)] flex items-center justify-center">
        <RouteLoading />
      </div>
    )
  }

  if (!user || !hasAccount) return null

  return <>{children}</>
}
