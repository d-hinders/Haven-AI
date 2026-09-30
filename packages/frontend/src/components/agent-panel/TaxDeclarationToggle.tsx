'use client'

/**
 * Agent detail → Tax declaration opt-in (#3426, wg-tax #5 §2.1).
 *
 * ── Visibility ───────────────────────────────────────────────────────────
 * The toggle renders ONLY when `GET /user/company-details` answers a row
 * with VIES `valid` (via `useCompanyDetails`). A 404 — which on that route
 * means ONLY "the flag is off" — hides the whole card: that is how the
 * frontend learns the deployment has no such surface. `null` (nothing
 * saved), a non-valid VIES status, an error, and the first load all hide it
 * too: an owner whose VAT number is not VIES-valid right now has nothing to
 * opt an agent into, and a hidden control cannot be hovered, wondered
 * about, or tried.
 *
 * ── Copy discipline ──────────────────────────────────────────────────────
 * The help text must not overclaim: the declaration is sent ONLY on
 * EIP-3009 payments. A pinned agent, and a merchant that accepts ERC-7710,
 * never gets one. The card used to name that rail; the owner's copy review
 * (2026-09-30) dropped the sentence. The card now relies on "can be
 * declared", never a promise that every payment carries one, and the
 * EIP-3009 scope is stated in docs/product/agent-passport.md.
 * "checked" is the strongest word used: VIES `valid` says the VAT number
 * was checked against the EU's register on a date, never that anything
 * about the agent or owner is "verified" (see
 * docs/product/owner-company-details.md § The VIES states).
 *
 * ── Failure ──────────────────────────────────────────────────────────────
 * A failed toggle keeps the checkbox's real state and surfaces the error
 * inline (never a silent revert, never an optimistic flip): the agent list
 * reloads after a success, and the opt-in state is whatever the server says.
 */
import { useState } from 'react'
import { Checkbox } from '@/components/ui/Checkbox'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { api, ApiRequestError } from '@/lib/api'
import { useCompanyDetails } from '@/hooks/useCompanyDetails'

interface TaxDeclarationToggleProps {
  agentId: string
  /** The agent's current opt-in state, from the agents read. */
  taxDeclarationEnabled: boolean
  /** Refetch the agents list after a successful write. */
  onAgentsChanged: () => void
}

export function TaxDeclarationToggle({
  agentId,
  taxDeclarationEnabled,
  onAgentsChanged,
}: TaxDeclarationToggleProps) {
  const { status, details } = useCompanyDetails()
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)

  // The visibility rule IS the component: anything but a VIES-valid row
  // renders nothing, including while the first read is in flight and on a
  // read error (never a toggle for a surface that may not exist).
  if (status !== 'ready' || !details || details.vies_status !== 'valid') {
    return null
  }

  const setTaxDeclaration = async (enabled: boolean) => {
    setSaving(true)
    setSaveFailed(false)
    try {
      await api.put(`/agents/${agentId}/tax-declaration`, { tax_declaration_enabled: enabled })
      onAgentsChanged()
    } catch (err) {
      // A 404 here means the flag went off mid-session (an operator action)
      // — the company-details read re-runs on render, and this card hides
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
    <div className="mt-6 rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] p-5 shadow-card md:p-6">
      <h2 className="v2-text-h3 mb-2 text-[var(--v2-ink)]">Tax declaration</h2>
      <Checkbox
        label="Send a tax declaration with payments"
        helperText={
          <>
            When this is on, your saved VAT number, checked against the
            EU&apos;s VIES register, can be declared to merchants that ask
            for it, with payments your agent signs under a budget. Nothing is
            submitted to an authority, and you can switch it off here at any
            time.
          </>
        }
        disabled={saving}
        checked={taxDeclarationEnabled}
        onChange={(event) => {
          void setTaxDeclaration(event.target.checked)
        }}
      />
      {saveFailed ? (
        <div className="mt-3">
          <InlineAlert>
            The tax declaration setting could not be saved. The state shown now
            is what the server has — try again in a moment.
          </InlineAlert>
        </div>
      ) : null}
    </div>
  )
}

export default TaxDeclarationToggle
