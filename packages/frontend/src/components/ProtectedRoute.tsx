'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { OctagonAlert } from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import { RouteLoading } from '@/components/ui/RouteLoading'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'

export default function ProtectedRoute({
  children,
}: {
  children: React.ReactNode
}) {
  const { user, loading, loadError, retryLoad } = useAuth()
  const router = useRouter()

  // #4827: a failed READ is not a signed-out session. `loadError` keeps the
  // owner on the route with a Try again action instead of bouncing them to
  // `/login` and throwing away a valid token.
  useEffect(() => {
    if (!loading && !loadError && !user) {
      router.replace('/login')
    }
  }, [loading, loadError, user, router])

  useEffect(() => {
    if (!loading && !loadError && user && (!user.accounts || user.accounts.length === 0) && !user.account_address) {
      router.replace('/onboarding')
    }
  }, [loading, loadError, user, router])

  const hasAccount = user && (user.accounts?.length > 0 || user.account_address)

  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--v2-bg)] flex items-center justify-center">
        <RouteLoading />
      </div>
    )
  }

  // #4827: the load-error shape of EmptyState (design-system § EmptyState).
  // The page wrapper is this call site's, as for `RouteLoading` above; the
  // state itself is the shared primitive, so there is no new component.
  if (loadError) {
    return (
      <div className="min-h-screen bg-[var(--v2-bg)] flex items-center justify-center px-6">
        <EmptyState
          tone="danger"
          icon={<Icon icon={OctagonAlert} className="h-full w-full" />}
          title="Your account could not load"
          body="You are still signed in, and nothing has changed."
          action={<Button onClick={retryLoad}>Try again</Button>}
        />
      </div>
    )
  }

  if (!user || !hasAccount) return null

  return <>{children}</>
}
