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
 * ── Shape (#4477) ────────────────────────────────────────────────────────
 * The toggle is ONE `SettingsRow` in the agent Settings tab's "This agent"
 * section, in the mockup v2 shape: title and a one-line description on the
 * left, the `Checkbox` in the action slot. The nine-line explanation that
 * used to sit in the checkbox's `helperText` moves into a closed-by-default
 * plain-language disclosure (§ Technical details disclosure, plain-language
 * variant, #4478) in the row's full-width `below` slot, labelled "What gets
 * sent". The row no longer owns a `Card.Section divided` wrapper: inside
 * `SettingsSection`'s `divide-y` list that wrapper would draw a second
 * hairline (#3697's wrapper, inverted by #4477).
 *
 * The one-line description keeps the CLIENT condition, because the sentence
 * that says the default setup sends none now sits behind the fold: a line
 * that dropped it ("…travel with this agent's payments") would overclaim in
 * exactly the direction #4416 fixed. It is wired to the input through
 * `aria-describedby`, since moving the explanation out of `helperText`
 * removes it from the input's accessible description.
 *
 * ── Copy discipline ──────────────────────────────────────────────────────
 * The copy must not overclaim in EITHER direction (#4416, owner decision
 * 2026-10-26, option A: the behaviour stays, the copy moves). "merchants
 * that ask" was false — nothing in the SDK reads the merchant's 402 for an
 * ask — and "every payment" would be false the other way, since the default
 * setup sends nothing. So the card names the CLIENT condition instead of the
 * payment rail: the declaration rides only when the agent pays through a
 * client that holds its own signing key (the Haven SDK with a delegate key,
 * or the local `@haven_ai/mcp`), and only to a merchant that accepts it. The
 * acceptance half is not decoration: the SDK attaches `X-Tax-Declaration`
 * only on the EIP-3009 paid retry
 * (`packages/sdk/src/merchant-completion.ts:189,200-203`), so an erc7710
 * merchant receives nothing at all — and recipient-pinned agents are
 * erc7710-only (`docs/security/delegation-rail-security-model.md:2111`), so
 * every pinned agent is in that set. The owner's 2026-09-30 copy review
 * (PR #3490) still stands: the card does not name the rail, and the test
 * keeps its `not.toContain('settle by EIP-3009')` guard. The rail and the
 * full recipient set are stated in docs/product/agent-passport.md and
 * docs/product/owner-company-details.md § A second reader.
 * The disclosure lists what the merchant receives — country, VAT number,
 * taxable-person status and a signed link to the agent's wallet address —
 * because "a tax declaration" alone does not tell an owner what leaves the
 * account. "checked" is the strongest word used: VIES `valid` says the VAT
 * number was checked against the EU's register on a date, never that
 * anything about the agent or owner is "verified" (see
 * docs/product/owner-company-details.md § The VIES states).
 *
 * ── Disabled state (#4435) ───────────────────────────────────────────────
 * The toggle is DISABLED for an agent whose most recent connector setup
 * reported `runtime_mcp_mode = 'hosted_plus_signer'` — the default setup, a
 * hosted server with a separate signer, which cannot attach a declaration to
 * a payment. The reason renders in the row's `below` slot, a SIBLING of the
 * checkbox's `<label>`, never as the checkbox's `helperText`: a disabled
 * checkbox is not focusable and `helperText` sits inside the `<label>`, so a
 * reason placed there is never announced. It stays OUTSIDE the disclosure
 * too — it tells the owner the control has no effect, so it must be visible
 * without opening anything.
 *
 * Every other value stays ENABLED, deliberately:
 * - `local_stdio` — the local MCP server holds the delegate key and attaches
 *   the declaration;
 * - `manual` — a developer's own SDK client with a delegate key can send one,
 *   and Haven cannot know, so a false disable would hide a working control;
 * - unknown (no setup row, `agent_id` NULL after a delete, key absent) —
 *   "cannot tell", not "cannot send". Disabling every agent that predates the
 *   signal would be a user-visible regression on deploy.
 * An agent whose bit is already ON stays INTERACTIVE even on
 * `hosted_plus_signer`, so the owner can still switch it off: the PUT is
 * deliberately never gated on OFF (`routes/agent-tax-declaration.ts:118-121`),
 * and a disabled control would trap an opt-in the owner cannot undo.
 *
 * ── Failure ──────────────────────────────────────────────────────────────
 * A failed toggle keeps the checkbox's real state and surfaces the error
 * inline (never a silent revert, never an optimistic flip): the agent list
 * reloads after a success, and the opt-in state is whatever the server says.
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
 * The row's one-line description (#4477). It keeps the client condition —
 * the "default setup sends none" sentence lives in the disclosure below, so
 * a line without it would overclaim (#4416). Guards pinned by the test:
 * never "verified", never "every payment", never "merchants that ask", never
 * "settle by EIP-3009".
 */
export const TAX_DECLARATION_DESCRIPTION =
  'Sends your VIES-checked VAT number with payments made through a client that holds its own key.'

/**
 * The long explanation, behind the "What gets sent" disclosure. Unchanged in
 * substance from the `helperText` it replaces (#4477): the client condition,
 * what the merchant receives, the default setup sending none, that nothing
 * is submitted to an authority, and that the owner can withdraw at any time.
 */
export const TAX_DECLARATION_EXPLANATION =
  "When this is on, your saved VAT number, checked against the EU's VIES register, can travel with payments your agent makes through a client that holds its own signing key: the Haven SDK with a delegate key, or the local Haven MCP server. The merchant your agent pays, when it accepts the declaration, receives your country, the VAT number, your taxable-person status and a signed link to the agent's wallet address. The default setup, a hosted server with a separate signer, sends none. Nothing is submitted to an authority, and you can switch it off here at any time."

/** The disabled-state reason (#4435) — visible, outside the label and the disclosure. */
export const TAX_DECLARATION_DISABLED_REASON =
  'This agent pays through the default setup, a hosted server with a separate signer, so no declaration is sent.'

interface TaxDeclarationToggleProps {
  agentId: string
  /** The agent's current opt-in state, from the agents read. */
  taxDeclarationEnabled: boolean
  /**
   * #4435: the payment client the agent's most recent connector setup
   * reported (`runtime_mcp_mode` on the agents list read). `null`/absent
   * means "cannot tell" and leaves the toggle enabled.
   */
  runtimeMcpMode?: string | null
  /** Refetch the agents list after a successful write. */
  onAgentsChanged: () => void
}

export function TaxDeclarationToggle({
  agentId,
  taxDeclarationEnabled,
  runtimeMcpMode,
  onAgentsChanged,
}: TaxDeclarationToggleProps) {
  const { status, details } = useCompanyDetails()
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  // The description is the input's accessible description (#4477): moving the
  // explanation out of `helperText` took it out of the `<label>`, so the
  // input points at the one-line description instead.
  const descriptionId = useId()

  // The visibility rule IS the component: anything but a VIES-valid row
  // renders nothing, including while the first read is in flight and on a
  // read error (never a toggle for a surface that may not exist).
  if (status !== 'ready' || !details || details.vies_status !== 'valid') {
    return null
  }

  // #4435: the default setup (a hosted server with a separate signer) cannot
  // attach a declaration to a payment, so an opt-in there would do nothing.
  // An agent whose bit is already ON stays interactive — the owner must be
  // able to switch it off, and the PUT is never gated on OFF.
  const cannotCarryDeclaration =
    runtimeMcpMode === 'hosted_plus_signer' && !taxDeclarationEnabled

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
    // #4477: the row is a direct child of `SettingsSection`'s `divide-y` list
    // and owns no divider of its own — the section draws the hairline. When
    // the visibility rule hides the toggle (above), nothing renders: no
    // orphan divider, no empty gap.
    <SettingsRow
      data-testid="tax-declaration-row"
      label="Tax declaration"
      detail={<p id={descriptionId}>{TAX_DECLARATION_DESCRIPTION}</p>}
      action={
        <Checkbox
          // `Checkbox` requires a visible label (#1410), so the box carries a
          // short one and the full accessible name rides `aria-label`, which
          // `...props` forwards to the `<input>`.
          label="Allow"
          aria-label="Allow this agent to send a tax declaration"
          aria-describedby={descriptionId}
          disabled={saving || cannotCarryDeclaration}
          checked={taxDeclarationEnabled}
          onChange={(event) => {
            void setTaxDeclaration(event.target.checked)
          }}
        />
      }
      below={
        <>
          {/* #4435: the reason is a SIBLING of the checkbox's `<label>` and
              sits OUTSIDE the disclosure — a disabled checkbox is not
              focusable, and the reason tells the owner the control has no
              effect, so it must be visible without opening anything. */}
          {cannotCarryDeclaration ? (
            <p
              className="px-6 pb-4 text-sm text-[var(--v2-ink-3)]"
              data-testid="tax-declaration-disabled-reason"
            >
              {TAX_DECLARATION_DISABLED_REASON}
            </p>
          ) : null}
          {/* The plain-language disclosure variant (#4478): closed by default,
              a label that names the content, prose inside. */}
          <div className="px-6 pb-4">
            <details className="group">
              <summary className="flex w-full cursor-pointer select-none list-none items-center justify-between rounded text-sm text-[var(--v2-ink)] [&::-webkit-details-marker]:hidden">
                What gets sent
                <Icon
                  icon={ChevronDown}
                  className="h-4 w-4 flex-shrink-0 text-[var(--v2-ink-3)] transition-transform group-open:rotate-180"
                />
              </summary>
              <p className="mt-3 border-t border-[var(--v2-border)] pt-3 text-sm text-[var(--v2-ink-2)]">
                {TAX_DECLARATION_EXPLANATION}
              </p>
            </details>
          </div>
          {saveFailed ? (
            <div className="px-6 pb-4">
              <InlineAlert>
                The tax declaration setting could not be saved. The state shown now
                is what the server has — try again in a moment.
              </InlineAlert>
            </div>
          ) : null}
        </>
      }
    />
  )
}

export default TaxDeclarationToggle
