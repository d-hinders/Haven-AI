/**
 * TaxDeclarationToggle (#3426, wg-tax #5 §2.1).
 *
 * Pins, per the issue's acceptance list:
 * - the toggle renders ONLY when `GET /user/company-details` answers a row
 *   with VIES `valid` — a 404 (flag off), `null`, a non-valid status, a
 *   loading state and an error all render NOTHING;
 * - the copy does not overclaim: the declaration is only on EIP-3009
 *   payments, pinned-merchant payments never carry one, nothing is signed
 *   or submitted to an authority, and "checked" is the strongest word used
 *   (never "verified");
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

  it('does not overclaim: "can be declared", nothing submitted, never "verified"', () => {
    render(
      <TaxDeclarationToggle
        agentId="agent-1"
        taxDeclarationEnabled={false}
        onAgentsChanged={() => {}}
      />,
    )
    const help = screen.getByText(/checked against the EU's VIES register/).textContent ?? ''
    // Owner copy review, 2026-09-30: the EIP-3009-only / pinned-merchant
    // sentence #3426 asked for was dropped from the card. The scope stays
    // stated in docs/product/agent-passport.md (the EIP-3009-only
    // declaration); the card keeps "can be declared", never a promise that
    // every payment carries one (guarded below).
    expect(help).toContain('can be declared to merchants that ask')
    expect(help).not.toContain('settle by EIP-3009')
    expect(help).toContain('Nothing is submitted to an authority')
    // The overclaim guard: the strongest word about the VAT number is
    // "checked" — never "verified" (docs/product/owner-company-details.md).
    expect(help.toLowerCase()).not.toContain('verified')
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
