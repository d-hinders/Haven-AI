'use client'

import dynamic from 'next/dynamic'
import ProtectedRoute from '@/components/ProtectedRoute'
import ErrorBoundary from '@/components/ErrorBoundary'
import TopBar from '@/components/TopBar'
import { OwnerDirectoryProvider } from '@/context/OwnerDirectoryContext'

const Sidebar = dynamic(() => import('@/components/sidebar/Sidebar'), {
  ssr: false,
})

export default function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <ProtectedRoute>
      <OwnerDirectoryProvider>
        <div className="flex h-screen bg-[var(--v2-bg)] text-[var(--v2-ink)] overflow-hidden">
          <Sidebar />
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            <TopBar />
            <main className="flex-1 bg-[var(--v2-bg)] p-6 lg:p-8 overflow-y-auto">
              <ErrorBoundary>{children}</ErrorBoundary>
            </main>
          </div>
        </div>
      </OwnerDirectoryProvider>
    </ProtectedRoute>
  )
}
