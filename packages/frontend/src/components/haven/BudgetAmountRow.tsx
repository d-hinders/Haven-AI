'use client'

/**
 * The budget amount row (#3398) — ONE markup for every budget modal.
 *
 * Two call sites wrote the same row a second time (#901 absorption): a
 * flex row that stacks below `sm`, holding the amount Input, the token
 * (a static symbol label, or a Select when more than one token is
 * offered), and the budget period Select. Stacked, the token label used
 * to orphan on its own line between the two controls in both modals —
 * and on desktop FundMerchantModal's label sat ~9 px below the input
 * text baseline (`sm:self-end` on a span whose height differs from the
 * input's). This primitive owns the row so all three states move
 * together:
 *
 *  - The token symbol rides INSIDE the amount input as a suffix
 *    (`Input`'s rightAction slot, vertically centred by that slot), so
 *    below `sm` it stays attached to the amount it qualifies — no line
 *    ever holds only the token label — and at `sm`+ it shares the
 *    input's box, so the baseline alignment is structural rather than
 *    a per-callsite offset to keep patched.
 *  - A multi-token offer renders a real `Select` BESIDE the amount
 *    input on one line at every width (`flex-nowrap`), never stacked
 *    into its own row.
 *  - The period Select wraps to its own line below `sm` (a full row is
 *    too narrow for three controls; the period is not a qualifier of
 *    the amount the way the token is, so it is the control that moves).
 *  - `sm:items-end` lines the row up on desktop: every item's bottom
 *    edge is the input's bottom edge, and the input/select share one
 *    box height, so their text baselines align. An optional label above
 *    the amount (the fund-merchant form's "Amount") is carried in the
 *    same wrapper, keeping the input's bottom edge as the row's
 *    reference line.
 *
 * The static-symbol suffix is a non-interactive span inside
 * `rightAction`, which reserves `pr-24`; three or four letters leave
 * that padding visually generous but keep every call site's hit target
 * and focus ring identical to a bare Input.
 */

import type { ReactNode } from 'react'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'

export interface BudgetAmountTokenOption {
  address: string
  symbol: string
  decimals: number
}

export default function BudgetAmountRow({
  amount,
  onAmountChange,
  tokens,
  selectedTokenAddress,
  onTokenChange,
  period,
  onPeriodChange,
  periods,
  amountLabel,
  amountLabelHtmlFor,
  /**
   * Explicit accessible name for the amount input. Defaults to
   * "Budget amount" when there is no visible label; when a visible
   * label IS shown, a caller can still override (the fund-merchant
   * form shows "Amount" and keeps the established "Budget amount"
   * accessible name).
   */
  amountAriaLabel,
  /** The amount input's `id` (a visible label's `htmlFor` target). */
  inputId,
  amountInvalid = false,
  amountAriaDescribedBy,
  inputClassName = '',
  periodSelectClassName = '',
}: {
  /** The amount field's controlled value. */
  amount: string
  onAmountChange: (value: string) => void
  /**
   * The tokens this budget can be denominated in. Exactly one symbol
   * renders as the input suffix; more than one renders a token Select
   * beside the input instead — the qualifier must stay attached to the
   * amount either way.
   */
  tokens: BudgetAmountTokenOption[]
  /** The selected token's address; `null`/unmatched renders no suffix. */
  selectedTokenAddress: string | null
  onTokenChange: (address: string) => void
  /** The selected period in seconds. */
  period: number
  onPeriodChange: (seconds: number) => void
  /** The period options, already labelled for display. */
  periods: Array<{ label: string; seconds: number }>
  /**
   * Optional visible label ABOVE the amount (the fund-merchant form's
   * labelled wrapper). The edit-budget form omits it — its amount field
   * is labelled by aria-label alone, as before.
   */
  amountLabel?: string
  /** The label's `htmlFor` target when `amountLabel` is set. */
  amountLabelHtmlFor?: string
  /**
   * Explicit accessible name for the amount input. Defaults to
   * "Budget amount" when there is no visible label; when a visible
   * label IS shown, a caller can still override (the fund-merchant
   * form shows "Amount" and keeps the established "Budget amount"
   * accessible name).
   */
  amountAriaLabel?: string
  /** The amount input's `id` (a visible label's `htmlFor` target). */
  inputId?: string
  amountInvalid?: boolean
  /** `aria-describedby` for the amount input (an error paragraph id). */
  amountAriaDescribedBy?: string
  /** Extra classes for the amount input (width pins, e.g. `sm:w-32`). */
  inputClassName?: string
  /** Extra classes for the period Select (width pins, e.g. `sm:w-36`). */
  periodSelectClassName?: string
  /** Escape hatch for future callers; unused by the two budget modals. */
  children?: ReactNode
}) {
  const selectedToken =
    tokens.find((t) => selectedTokenAddress != null && t.address.toLowerCase() === selectedTokenAddress.toLowerCase()) ??
    null
  const multiToken = tokens.length > 1
  // Passive text suffix (see the node comment at the span), not Input's
  // rightAction: that slot reserves `pr-24` inside the input, which at the
  // amount width squeezes the "Amount" placeholder out of view. A local
  // overlay with a `pr-12` reservation keeps placeholder and symbol sharing
  // one box at every width.
  const suffix = selectedToken && !multiToken
  const amountField = (
    // The WIDTH PIN belongs on this wrapper — it is the flex item the row
    // lays out (the inner group is `sm:contents`, so wrapper and period
    // select are siblings). Pinning the input itself instead would overflow
    // a narrower wrapper and paint over the period select (measured: a 160px
    // input in a 128px wrapper overlapped the select by 24px). The pin is
    // shrink-0: a pinned width that flex could shrink is not a pin, and the
    // row must overflow visibly rather than silently narrow the amount box.
    // The input fills the wrapper.
    <div
      className={
        multiToken
          ? 'w-[calc(100%-5.5rem)] min-w-32 flex-1 sm:w-auto sm:flex-none'
          : `${inputClassName} sm:shrink-0`
      }
    >
      {amountLabel ? (
        <label
          className="mb-1 block text-xs font-medium text-[var(--v2-ink-3)]"
          htmlFor={amountLabelHtmlFor}
        >
          {amountLabel}
        </label>
      ) : null}
      <div className="relative w-full">
        <Input
          id={inputId}
          value={amount}
          onChange={(e) => onAmountChange(e.target.value)}
          placeholder="Amount"
          inputMode="decimal"
          aria-label={amountAriaLabel ?? (amountLabel ? undefined : 'Budget amount')}
          invalid={amountInvalid}
          aria-describedby={amountAriaDescribedBy}
          className={suffix ? 'pr-12' : ''}
        />
        {suffix ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-[var(--v2-ink-muted)]"
          >
            {selectedToken!.symbol}
          </span>
        ) : null}
      </div>
    </div>
  )

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <div className="flex w-full flex-nowrap items-center gap-2 sm:contents">
        {amountField}
        {multiToken ? (
          <Select
            value={selectedTokenAddress ?? ''}
            onChange={(e) => onTokenChange(e.target.value)}
            aria-label="Token"
            className="w-20 shrink-0"
          >
            {tokens.map((t) => (
              <option key={t.address} value={t.address}>
                {t.symbol}
              </option>
            ))}
          </Select>
        ) : null}
      </div>
      <Select
        value={String(period)}
        onChange={(e) => onPeriodChange(Number(e.target.value))}
        aria-label="Period"
        className={periodSelectClassName}
      >
        {periods.map((p) => (
          <option key={p.seconds} value={p.seconds}>
            {p.label}
          </option>
        ))}
      </Select>
    </div>
  )
}
