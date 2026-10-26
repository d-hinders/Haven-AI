'use client'

/**
 * Agent detail → Tax declaration opt-in (#3426, wg-tax #5 §2.1).
 *
 * ── Visibility ───────────────────────────────────────────────────────────
 * The toggle renders ONLY when `GET /user/company-details` answers a row
 * with VIES `valid` (via `useCompanyDetails`). A 404 — which on that route
 * means ONLY "the flag is off" — hides the whole row: that is how the
 * frontend learns the deployment has no such surface. `null` (nothing
 * saved), a non-valid VIES status, an error, and the first load all hide it
 * too: an owner whose VAT number is not VIES-valid right now has nothing to
 * opt an agent into, and a hidden control cannot be hovered, wondered
 * about, or tried.
 *
 * ── Copy discipline ──────────────────────────────────────────────────────
 * The help text must not overclaim in EITHER direction (#4416, owner
 * decision 2026-10-26, option A: the behaviour stays, the copy moves).
 * "merchants that ask" was false — nothing in the SDK reads the merchant's
 * 402 for an ask — and "every payment" would be false the other way, since
 * the default setup sends nothing. So the card names the CLIENT condition
 * instead of the payment rail: the declaration rides only when the agent
 * pays through a client that holds its own signing key (the Haven SDK with
 * a delegate key, or the local `@haven_ai/mcp`), and only to the merchant
 * it pays. The owner's 2026-09-30 copy review (PR #3490) still stands: the
 * card does not name the rail, and the test keeps its
 * `not.toContain('settle by EIP-3009')` guard. The rail and the full
 * recipient set are stated in docs/product/agent-passport.md and
 * docs/product/owner-company-details.md § A second reader.
 * The card also lists what the merchant receives — country, VAT number,
 * taxable-person status and a signed link to the agent's wallet address —
 * because "a tax declaration" alone does not tell an owner what leaves the
 * account. "checked" is the strongest word used: VIES `valid` says the VAT
 * number was checked against the EU's register on a date, never that
 * anything about the agent or owner is "verified" (see
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
import { Card } from '@/components/ui/Card'
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
    // #3697: the toggle OWNS its row and its divider in the "Identity and
    // settings" card — the wrapper is a `Card.Section divided` (hairline top
    // border, content padded by the inner block). When the visibility rule
    // hides the toggle (above), nothing renders: no orphan divider, no empty
    // gap, and the row below it keeps its own divider.
    <Card.Section divided>
      <div className="px-4 py-4 md:px-6 md:py-5" data-testid="tax-declaration-row">
        <h3 className="text-base font-semibold text-[var(--v2-ink)]">Tax declaration</h3>
        <Checkbox
          label="Allow this agent to send a tax declaration"
          helperText={
            <>
              When this is on, your saved VAT number, checked against the
              EU&apos;s VIES register, can travel with payments your agent makes
              through a client that holds its own signing key: the Haven SDK with
              a delegate key, or the local Haven MCP server. The merchant your
              agent pays receives your country, the VAT number, your
              taxable-person status and a signed link to the agent&apos;s wallet
              address. The default setup, a hosted server with a separate signer,
              sends none. Nothing is submitted to an authority, and you can
              switch it off here at any time.
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
    </Card.Section>
  )
}

export default TaxDeclarationToggle
