import { Suspense } from 'react'
import DeviceApprovalClient from './DeviceApprovalClient'

/**
 * `/device` — approve a CLI session an agent asked for (#2526).
 *
 * The one screen in this epic where a human does something an agent cannot.
 * It sits under the authenticated layout, so a logged-out visitor is carried
 * through login by B2's `next` handling and lands back here with the code
 * still in the URL.
 */
export default function DeviceApprovalPage() {
  return (
    <div className="max-w-xl">
      {/* `useSearchParams` needs a boundary; the code is read client-side. */}
      <Suspense fallback={null}>
        <DeviceApprovalClient />
      </Suspense>
    </div>
  )
}
