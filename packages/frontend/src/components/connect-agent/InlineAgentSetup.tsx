'use client'

import { useId } from 'react'
import { Card } from '../ui/Card'
import { ConnectAgentFlow } from './ConnectAgentFlow'

/**
 * The connect-agent flow inline on `/agents`, for a user with no agents
 * (#4065): the same three steps, hook and copy as `ConnectAgentModal`, framed
 * by a `Card` instead of a dialog. Chrome only — the flow is
 * `ConnectAgentFlow`.
 *
 * - `open` is true for as long as this is mounted. The panel remounts it
 *   (a bumped `key`) each time the user leaves, because the hook's starter
 *   seed only runs on `open`'s transition and would not re-seed a reset form.
 * - It opens with the starter budget (10 USDC per day) prefilled — owner
 *   decision 2026-10-19.
 * - No autofocus: on page load that would scroll the page and open the phone
 *   keyboard (#3687). Focus moves only on a step change, the shared rule.
 * - The width is the modal's (`max-w-xl`): the step components are laid out
 *   for that body, so the flow reads the same in both containers.
 */
export function InlineAgentSetup({
  onClose,
  onSetupStarted,
  onSetupAbandoned,
  accountAddress,
  accountId,
  onSetupUpdated,
}: {
  /** Every exit the flow can reach — Done, Close — leaves through here. */
  onClose: () => void
  /** Fires once a setup exists (see `ConnectAgentFlow`'s prop of the same name). */
  onSetupStarted?: () => void
  /** A first create failed; see `ConnectAgentFlow`'s prop of the same name. */
  onSetupAbandoned?: () => void
  accountAddress?: string
  accountId?: string | null
  onSetupUpdated?: (info?: { delegateAddress?: string | null }) => void
}) {
  const headingId = useId()
  return (
    <ConnectAgentFlow
      inline
      open
      onClose={onClose}
      onSetupStarted={onSetupStarted}
      onSetupAbandoned={onSetupAbandoned}
      accountAddress={accountAddress}
      accountId={accountId}
      onSetupUpdated={onSetupUpdated}
      starterAllowance
    >
      {({ flow, progress, steps }) => (
        // A region named by its own heading: the page's one landmark for the
        // flow, and how tests and the e2e specs find it.
        <section aria-labelledby={headingId} className="max-w-xl">
          <Card hover={false} className="overflow-hidden">
            <Card.Header
              as="h2"
              titleId={headingId}
              title="Connect your first agent"
              description={flow.headerSubtitleText}
            />
            <div className="border-b border-[var(--v2-border)] px-5 py-3">{progress}</div>
            <div className="p-5 text-sm leading-relaxed text-[var(--v2-ink-2)]">{steps}</div>
          </Card>
        </section>
      )}
    </ConnectAgentFlow>
  )
}
