/**
 * #4601 (N6) — `SetBudgetDialog` renders its amount through `BudgetAmountRow`.
 *
 * The dialog used to lay amount, token and period out as its own
 * `flex flex-col gap-2 sm:flex-row`, with the token symbol a `self-center`
 * span. Below `sm` that span orphaned on a line of its own between the two
 * controls. `BudgetAmountRow` (#3398) already solved this for the edit and
 * fund-merchant modals: the symbol rides INSIDE the amount input as a suffix,
 * and a multi-token offer renders a real `Select` beside the input.
 *
 * This suite pins the two shapes and the accessible names the rest of the
 * suite (and the e2e specs) address the controls by.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// The in-flow connect/switch control reads wagmi and RainbowKit, which these
// tests do not provide (same stub EditBudgetModal.test.tsx uses).
vi.mock('@/components/WalletConnectAction', () => ({
  default: () => <button type="button">Connect wallet</button>,
}))

const SetBudgetDialog = (await import('../SetBudgetDialog')).default

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const EURC = '0x' + 'ee'.repeat(20)

const BASE_PROPS = {
  open: true,
  onClose: vi.fn(),
  budgets: null,
  budgetsError: false,
  hasActive: false,
  grant: vi.fn().mockResolvedValue({ ok: true }),
  busy: false,
  ready: true,
  signersError: false,
  signersLoading: false,
  reloadSigners: vi.fn(),
  passkeyElsewhere: false,
  prefill: null,
  receivedGrants: null,
  subBudgetParents: [],
  onIssueSubBudget: vi.fn(),
  onSlotOccupied: vi.fn(),
  onGranted: vi.fn(),
}

function renderDialog(overrides: Record<string, unknown> = {}) {
  return render(
    <SetBudgetDialog
      {...BASE_PROPS}
      tokens={[{ address: USDC, symbol: 'USDC', decimals: 6 }]}
      {...overrides}
    />,
  )
}

describe('SetBudgetDialog amount row (#4601, N6)', () => {
  it('keeps the accessible names the tests and specs address the controls by', () => {
    renderDialog()
    expect(screen.getByLabelText('Budget amount')).toBeInTheDocument()
    expect(screen.getByLabelText('Period')).toBeInTheDocument()
  })

  it('renders the single token as the amount input’s suffix, not a stacked label', () => {
    const { container } = renderDialog()
    const amount = screen.getByLabelText('Budget amount')

    // The suffix reservation is `BudgetAmountRow`'s `pr-12` on the input.
    expect(amount.className).toContain('pr-12')

    // The symbol sits in the SAME box as the input — the wrapper the primitive
    // draws around both — so no line can hold only the token label. (`Input`
    // adds its own `relative` wrapper inside that box, so the assertion is
    // containment, not an exact parent.)
    const suffix = container.querySelector('span[aria-hidden="true"]')
    expect(suffix).not.toBeNull()
    expect(suffix!.textContent).toBe('USDC')
    expect(suffix!.parentElement!.contains(amount)).toBe(true)

    // A single token is not a choice: no Token select.
    expect(screen.queryByLabelText('Token')).toBeNull()
  })

  it('renders a Token select beside the amount when more than one token is offered', () => {
    renderDialog({
      tokens: [
        { address: USDC, symbol: 'USDC', decimals: 6 },
        { address: EURC, symbol: 'EURC', decimals: 6 },
      ],
    })

    const token = screen.getByLabelText('Token')
    expect(token.tagName).toBe('SELECT')
    // The multi-token shape has no suffix — the select IS the qualifier.
    expect(screen.getByLabelText('Budget amount').className).not.toContain('pr-12')
  })
})
