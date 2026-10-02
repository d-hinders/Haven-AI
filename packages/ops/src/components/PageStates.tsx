'use client'

/**
 * The three states every ops page renders from one shape (#3516 AC):
 * loading (skeletons), empty (the honest zero) and error (a retry, with the
 * deployment-level `unavailable` state rendered as a condition, not a
 * crashed screen). The children render only the loaded data.
 */
import type { ReactNode } from 'react'
import { Card, EmptyState, InlineAlert, Skeleton } from '@haven_ai/ui'
import type { OpsReadError } from '../lib/ops-client'

export function PageStates({
  loading,
  empty,
  error,
  children,
  emptyTitle,
  emptyBody,
}: {
  loading: boolean
  empty: boolean
  error: OpsReadError | null
  children: ReactNode
  emptyTitle: string
  emptyBody?: string
}) {
  if (error !== null) {
    return (
      <Card className="p-6" hover={false}>
        <InlineAlert>{error.message}</InlineAlert>
        {error.kind === 'unavailable' ? (
          <p className="mt-2 text-xs text-[var(--v2-ink-3)]">
            This is a deployment condition, not a failed page: the read-only ops surface is not configured here.
          </p>
        ) : null}
      </Card>
    )
  }
  if (loading) {
    return (
      <Card className="p-6" hover={false}>
        <Skeleton className="h-4 w-40" />
        <div className="mt-3 space-y-2">
          <Skeleton className="h-3 w-64" />
          <Skeleton className="h-3 w-52" />
          <Skeleton className="h-3 w-56" />
        </div>
      </Card>
    )
  }
  if (empty) {
    return (
      <Card className="p-6" hover={false}>
        <EmptyState title={emptyTitle} body={emptyBody} size="compact" />
      </Card>
    )
  }
  return <>{children}</>
}
