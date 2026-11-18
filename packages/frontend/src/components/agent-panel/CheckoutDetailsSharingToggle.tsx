'use client'

/**
 * Agent detail → Checkout details sharing (#4871, epic #4868).
 *
 * ── What it does ─────────────────────────────────────────────────────────
 * One `SettingsRow` beside `TaxDeclarationToggle` in the agent Settings tab's
 * "This agent" section. The switch lets THIS agent share the owner's saved
 * checkout details — the receipt email, billing address and shipping address
 * stored in Business details (#4870) — with merchants that ask for them in
 * their payment challenge. The switch is the owner's only: an agent cannot
 * turn it on for itself.
 *
 * ── Visibility ───────────────────────────────────────────────────────────
 * The row renders whenever the company-details feature is on (`status` is
 * `'ready'` or `'empty'`). Unlike the tax declaration toggle it does NOT
 * require a VIES-valid VAT number, and it does NOT require stored details:
 * the switch may be turned on before anything is saved, and the agent's read
 * then answers "nothing stored" (issue #4871, "For the builder to decide").
 * A 404 from `GET /user/company-details` (`status: 'off'`) hides the row —
 * that is how the frontend learns the deployment has no such surface — and
 * the first load and a read error hide it too.
 *
 * ── Copy discipline ──────────────────────────────────────────────────────
 * The one-line description says what is shared and with whom. The
 * closed-by-default **What gets shared** disclosure says which three fields
 * travel, that only a merchant that asks receives them, that the agent can
 * read the details once sharing is on, that only a receipt email the owner
 * saved is ever shared (never the sign-in email), and that the owner can
 * switch it off at any time. Nothing here claims Haven sends the details by
 * itself: #4872 attaches them to the paid request.
 *
 * ── Failure ──────────────────────────────────────────────────────────────
 * A failed toggle keeps the checkbox's real state and surfaces the error
 * inline (never a silent revert, never an optimistic flip): the agent list
 * reloads after a success, and the switch state is whatever the server says.
 */
import { useId, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Checkbox } from '@/components/ui/Checkbox'
import { Icon } from '@/components/ui/Icon'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { SettingsRow } from '@/components/ui/SettingsSection'
import { api, ApiRequestError } from '@/lib/api'
import { useCompanyDetails } from '@/hooks/useCompanyDetails'

/**
 * The row's one-line description: what is shared, and with whom.
 */
export const CHECKOUT_DETAILS_DESCRIPTION =
  'Shares the receipt email and addresses you saved in Business details with merchants that ask.'

/**
 * The long explanation, behind the "What gets shared" disclosure.
 */
export const CHECKOUT_DETAILS_EXPLANATION =
  'When this is on, a merchant your agent pays can ask for your receipt email, billing address and shipping address, and your agent can pass on the ones you saved in Business details. Only a merchant that asks receives them, and only a receipt email you saved is ever shared — never your sign-in email. Once sharing is on, your agent can also read these details itself. You can switch it off here at any time; it stops future sharing.'

/**
 * Shown when the owner has saved none of the three fields. The switch can
 * still be turned on, but nothing would be shared until something is saved.
 */
export const CHECKOUT_DETAILS_NOTHING_SAVED =
  'You have not saved a receipt email or an address yet. Add them in Business details to share anything.'

interface CheckoutDetailsSharingToggleProps {
  agentId: string
  /** The agent's current sharing state, from the agents read. */
  checkoutDetailsSharingEnabled: boolean
  /** Refetch the agents list after a successful write. */
  onAgentsChanged: () => void
}

export function CheckoutDetailsSharingToggle({
  agentId,
  checkoutDetailsSharingEnabled,
  onAgentsChanged,
}: CheckoutDetailsSharingToggleProps) {
  const { status, details } = useCompanyDetails()
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  // The description is the input's accessible description: the explanation
  // lives behind the disclosure, so the input points at the one-line
  // description instead.
  const descriptionId = useId()

  // The visibility rule: the feature must be on. `'empty'` (flag on, nothing
  // saved) still renders — the switch may be on with nothing stored.
  if (status !== 'ready' && status !== 'empty') {
    return null
  }

  const nothingSaved =
    details === null ||
    (details.receipt_email === null &&
      details.billing_address === null &&
      details.shipping_address === null)

  const setSharing = async (enabled: boolean) => {
    setSaving(true)
    setSaveFailed(false)
    try {
      await api.put(`/agents/${agentId}/checkout-details-sharing`, {
        checkout_details_sharing_enabled: enabled,
      })
      onAgentsChanged()
    } catch (err) {
      // A 404 here means the flag went off mid-session (an operator action)
      // — the company-details read re-runs on render, and this row hides
      // itself. Any other failure is surfaced inline; the checkbox stays at
      // its server-truth value after the agents reload.
      if (!(err instanceof ApiRequestError && err.status === 404)) {
        setSaveFailed(true)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsRow
      data-testid="checkout-details-sharing-row"
      label="Checkout details"
      detail={<p id={descriptionId}>{CHECKOUT_DETAILS_DESCRIPTION}</p>}
      action={
        <Checkbox
          // `Checkbox` requires a visible label (#1410), so the box carries a
          // short one and the full accessible name rides `aria-label`, which
          // `...props` forwards to the `<input>`.
          label="Allow"
          aria-label="Allow this agent to share your checkout details with merchants"
          aria-describedby={descriptionId}
          disabled={saving}
          checked={checkoutDetailsSharingEnabled}
          onChange={(event) => {
            void setSharing(event.target.checked)
          }}
        />
      }
      below={
        <>
          {nothingSaved ? (
            <p
              className="px-6 pb-4 text-sm text-[var(--v2-ink-3)]"
              data-testid="checkout-details-nothing-saved"
            >
              {CHECKOUT_DETAILS_NOTHING_SAVED}
            </p>
          ) : null}
          {/* The plain-language disclosure variant (#4478): closed by default,
              a label that names the content, prose inside. */}
          <div className="px-6 pb-4">
            <details className="group">
              <summary className="flex w-full cursor-pointer select-none list-none items-center justify-between rounded text-sm text-[var(--v2-ink)] [&::-webkit-details-marker]:hidden">
                What gets shared
                <Icon
                  icon={ChevronDown}
                  className="h-4 w-4 flex-shrink-0 text-[var(--v2-ink-3)] transition-transform group-open:rotate-180"
                />
              </summary>
              <p className="mt-3 border-t border-[var(--v2-border)] pt-3 text-sm text-[var(--v2-ink-2)]">
                {CHECKOUT_DETAILS_EXPLANATION}
              </p>
            </details>
          </div>
          {saveFailed ? (
            <div className="px-6 pb-4">
              <InlineAlert>
                The checkout details setting could not be saved. The state shown now
                is what the server has — try again in a moment.
              </InlineAlert>
            </div>
          ) : null}
        </>
      }
    />
  )
}

export default CheckoutDetailsSharingToggle
