/**
 * TaxDeclarationToggle (#3426, wg-tax #5 §2.1).
 *
 * Pins, per the issue's acceptance list:
 * - the toggle renders ONLY when `GET /user/company-details` answers a row
 *   with VIES `valid` — a 404 (flag off), `null`, a non-valid status, a
 *   loading state and an error all render NOTHING;
 * - the copy does not overclaim in either direction (#4416): it names the
 *   client condition (a client that holds its own signing key) rather than
 *   the payment rail, says the default setup sends none, lists what the
 *   merchant receives, and "checked" is the strongest word used (never
 *   "verified");
 * - a successful toggle PUTs exactly the wire shape; a failed one keeps the
 *   checkbox's server-truth state and surfaces the error inline (never an
 *   optimistic flip).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const { mockUseCompanyDetails, mockApiPut } = vi.hoisted(() => ({
  mockUseCompanyDetails: vi.fn(),
  mockApiPut: vi.fn(),
}))

vi.mock('@/hooks/useCompanyDetails', () => ({
  useCompanyDetails: () => mockUseCompanyDetails(),
}))

vi.mock('@/lib/api', () => ({
  api: { put: mockApiPut },
  ApiRequestError: class ApiRequestError extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.status = status
    }
  },
}))

import { TaxDeclarationToggle } from '../TaxDeclarationToggle'

const VIES_VALID_ROW = {
  legal_name: 'Acme AB',
  country: 'SE',
  org_number: '556677-8899',
  vat_number: 'SE556677889901',
  vies_status: 'valid',
  vies_checked_at: '2026-09-28T12:00:00.000Z',
  created_at: '2026-09-28T10:00:00.000Z',
  updated_at: '2026-09-28T12:00:00.000Z',
} as const

describe('TaxDeclarationToggle visibility', () => {
  beforeEach(() => {
    mockApiPut.mockReset()
  })

  it('renders when company details are VIES valid', () => {
    mockUseCompanyDetails.mockReturnValue({ status: 'ready', details: VIES_VALID_ROW })
    render(
      <TaxDeclarationToggle
        agentId="agent-1"
        taxDeclarationEnabled={false}
        onAgentsChanged={() => {}}
      />,
    )
    expect(screen.getByText('Tax declaration')).toBeInTheDocument()
    expect(screen.getByRole('checkbox')).not.toBeChecked()
  })

  it('is absent when the flag is off (the route answers 404 → status "off")', () => {
    mockUseCompanyDetails.mockReturnValue({ status: 'off', details: null })
    render(
      <TaxDeclarationToggle
        agentId="agent-1"
        taxDeclarationEnabled={false}
        onAgentsChanged={() => {}}
      />,
    )
    expect(screen.queryByText('Tax declaration')).not.toBeInTheDocument()
  })

  it('is absent when no details are saved (200 → null → status "empty")', () => {
    mockUseCompanyDetails.mockReturnValue({ status: 'empty', details: null })
    render(
      <TaxDeclarationToggle
        agentId="agent-1"
        taxDeclarationEnabled={false}
        onAgentsChanged={() => {}}
      />,
    )
    expect(screen.queryByText('Tax declaration')).not.toBeInTheDocument()
  })

  it('is absent while the first read is in flight and on a read error', () => {
    mockUseCompanyDetails.mockReturnValue({ status: 'loading', details: null })
    const { unmount } = render(
      <TaxDeclarationToggle
        agentId="agent-1"
        taxDeclarationEnabled={false}
        onAgentsChanged={() => {}}
      />,
    )
    expect(screen.queryByText('Tax declaration')).not.toBeInTheDocument()
    unmount()

    mockUseCompanyDetails.mockReturnValue({ status: 'error', details: null })
    render(
      <TaxDeclarationToggle
        agentId="agent-1"
        taxDeclarationEnabled={false}
        onAgentsChanged={() => {}}
      />,
    )
    expect(screen.queryByText('Tax declaration')).not.toBeInTheDocument()
  })

  it('is absent when VIES is anything but valid — pending, invalid, not_verifiable', () => {
    for (const vies_status of ['pending', 'invalid', 'not_verifiable'] as const) {
      mockUseCompanyDetails.mockReturnValue({
        status: 'ready',
        details: { ...VIES_VALID_ROW, vies_status, vies_checked_at: null },
      })
      const { unmount } = render(
        <TaxDeclarationToggle
          agentId="agent-1"
          taxDeclarationEnabled={false}
          onAgentsChanged={() => {}}
        />,
      )
      expect(screen.queryByText('Tax declaration')).not.toBeInTheDocument()
      unmount()
    }
  })
})

describe('TaxDeclarationToggle copy', () => {
  beforeEach(() => {
    mockUseCompanyDetails.mockReturnValue({ status: 'ready', details: VIES_VALID_ROW })
  })

  // #4416 (owner decision 2026-10-26, option A): the behaviour did not move,
  // the copy did. The old sentence said "can be declared to merchants that
  // ask" — nothing in the SDK reads the merchant's 402 for an ask, so a local
  // key-holding client sends the declaration to every merchant it pays. The
  // new copy names the CLIENT condition instead of the payment rail (the
  // owner's 2026-09-30 review, PR #3490, still stands: no rail on this card),
  // names the merchant-acceptance half of the owner decision ("and only to
  // merchants that accept it"), and lists what the merchant receives.
  //
  // Pinned WHOLE with `toBe`, not `toContain`: a substring pin passes a
  // rewrite that reverses the meaning, which is exactly the defect #4416 is
  // about. Every sentence below maps to a line that makes it true —
  // `packages/sdk/src/client.ts:329-343` (resolver bound only with a delegate
  // key), `packages/mcp/src/server.ts:83-85` (the local MCP passes one),
  // `packages/sdk/src/merchant-completion.ts:187-203` (attached on the paid
  // retry of an EIP-3009 payment only; the erc7710 branch attaches nothing),
  // `packages/backend/src/modules/agents/tax-declaration.ts:34,138`
  // (taxable status, country) and `packages/sdk/src/tax-declaration.ts:240-254`
  // (principalId + attribution hash, signed by the delegate key).
  const HELPER_TEXT =
    "When this is on, your saved VAT number, checked against the EU's VIES register, can travel with payments your agent makes through a client that holds its own signing key: the Haven SDK with a delegate key, or the local Haven MCP server. The merchant your agent pays, when it accepts the declaration, receives your country, the VAT number, your taxable-person status and a signed link to the agent's wallet address. The default setup, a hosted server with a separate signer, sends none. Nothing is submitted to an authority, and you can switch it off here at any time."

  it('pins the whole helper text: who receives the declaration and what it contains', () => {
    render(
      <TaxDeclarationToggle
        agentId="agent-1"
        taxDeclarationEnabled={false}
        onAgentsChanged={() => {}}
      />,
    )
    const help = screen.getByText(/checked against the EU's VIES register/).textContent ?? ''
    expect(help).toBe(HELPER_TEXT)
  })

  it('does not overclaim in either direction: no "merchants that ask", no "every payment", never "verified"', () => {
    render(
      <TaxDeclarationToggle
        agentId="agent-1"
        taxDeclarationEnabled={false}
        onAgentsChanged={() => {}}
      />,
    )
    const help = screen.getByText(/checked against the EU's VIES register/).textContent ?? ''
    // The old claim, false in the direction the SDK actually behaves: nothing
    // reads the merchant's 402 for an ask (option B would ship that; it did
    // not). The other direction is guarded below.
    expect(help).not.toContain('merchants that ask')
    // Owner copy review, 2026-09-30 (PR #3490): the card does not name the
    // payment rail. The rail and the full recipient set stay stated in
    // docs/product/agent-passport.md and docs/product/owner-company-details.md.
    expect(help).not.toContain('settle by EIP-3009')
    expect(help).toContain('Nothing is submitted to an authority')
    // The overclaim guard: the strongest word about the VAT number is
    // "checked" — never "verified" (docs/product/owner-company-details.md).
    expect(help.toLowerCase()).not.toContain('verified')
    // The default setup (hosted server plus separate signer) sends nothing,
    // so the card must not promise a declaration on every payment.
    expect(help.toLowerCase()).not.toContain('every payment')
  })

  it('announces withdrawal: the owner can switch it off here at any time', () => {
    render(
      <TaxDeclarationToggle
        agentId="agent-1"
        taxDeclarationEnabled={false}
        onAgentsChanged={() => {}}
      />,
    )
    const help = screen.getByText(/checked against the EU's VIES register/).textContent ?? ''
    expect(help).toContain('switch it off here at any time')
  })
})

describe('TaxDeclarationToggle interaction', () => {
  beforeEach(() => {
    mockUseCompanyDetails.mockReturnValue({ status: 'ready', details: VIES_VALID_ROW })
    mockApiPut.mockReset()
  })

  it('PUTs exactly the toggle body to the agent route on change', async () => {
    mockApiPut.mockResolvedValue({ id: 'agent-1', tax_declaration_enabled: true })
    render(
      <TaxDeclarationToggle
        agentId="agent-1"
        taxDeclarationEnabled={false}
        onAgentsChanged={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox'))
    await waitFor(() => {
      expect(mockApiPut).toHaveBeenCalledWith('/agents/agent-1/tax-declaration', {
        tax_declaration_enabled: true,
      })
    })
  })

  it('does NOT optimistically flip: a failed save keeps the server-truth state and surfaces the error', async () => {
    mockApiPut.mockRejectedValue(new Error('network down'))
    render(
      <TaxDeclarationToggle
        agentId="agent-1"
        taxDeclarationEnabled={false}
        onAgentsChanged={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox'))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })
    // The checkbox never flipped optimistically — it still reads the
    // server-truth value the parent handed it.
    expect(screen.getByRole('checkbox')).not.toBeChecked()
  })

  it('stays quiet on a 404 (the flag went off mid-session; the card hides itself)', async () => {
    const { ApiRequestError } = await import('@/lib/api')
    mockApiPut.mockRejectedValue(new ApiRequestError('Not found', 404))
    render(
      <TaxDeclarationToggle
        agentId="agent-1"
        taxDeclarationEnabled={false}
        onAgentsChanged={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox'))
    await waitFor(() => {
      expect(mockApiPut).toHaveBeenCalled()
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('TaxDeclarationToggle row wrapper (#3697)', () => {
  beforeEach(() => {
    mockUseCompanyDetails.mockReturnValue({ status: 'ready', details: VIES_VALID_ROW })
  })

  it('renders inside a Card.Section divided row — the divider travels WITH the toggle', () => {
    // The wrapper IS the divider owner: when the visibility rule hides the
    // toggle, the wrapper (and its hairline) disappear with it — the page
    // test pins the no-orphan-divider case from the outside; this pins the
    // visible case's own geometry (the closeout's style-assertion rule).
    render(
      <TaxDeclarationToggle
        agentId="agent-1"
        taxDeclarationEnabled={false}
        onAgentsChanged={() => {}}
      />,
    )
    const row = screen.getByTestId('tax-declaration-row')
    // `Card.Section divided` geometry: hairline top border + per-child
    // dividers, no card chrome of its own (no radius, no shadow).
    expect(row.parentElement?.className).toContain('border-t')
    expect(row.parentElement?.className).toContain('divide-y')
    expect(row.parentElement?.className).not.toContain('rounded')
  })
})
