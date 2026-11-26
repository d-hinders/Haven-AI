/**
 * CheckoutDetailsSharingToggle (#4871, epic #4868).
 *
 * Pins, per the issue's acceptance list:
 * - the row renders whenever the company-details feature is on (`'ready'` or
 *   `'empty'`) — it does NOT require a VIES-valid VAT number or stored
 *   details, because the switch may be on with nothing saved;
 * - a 404 (flag off), the first load and a read error render NOTHING;
 * - the copy says what is shared and with whom, that the agent can read the
 *   details once sharing is on, that only a saved receipt email is shared
 *   (never the sign-in email), and that the owner can switch it off;
 * - a successful toggle PUTs exactly the wire shape; a failed one keeps the
 *   checkbox's server-truth state and surfaces the error inline (never an
 *   optimistic flip);
 * - when nothing is saved, the row says so.
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

import {
  CheckoutDetailsSharingToggle,
  CHECKOUT_DETAILS_DESCRIPTION,
  CHECKOUT_DETAILS_EXPLANATION,
  CHECKOUT_DETAILS_NOTHING_SAVED,
} from '../CheckoutDetailsSharingToggle'

const FILLED_ROW = {
  legal_name: 'Acme AB',
  country: 'SE',
  org_number: '556677-8899',
  vat_number: 'SE556677889901',
  vies_status: 'valid',
  vies_checked_at: '2026-09-28T12:00:00.000Z',
  receipt_email: 'billing@acme.se',
  billing_address: { line1: 'Sveavagen 1', city: 'Stockholm', country: 'SE' },
  shipping_address: null,
  created_at: '2026-09-28T10:00:00.000Z',
  updated_at: '2026-09-28T12:00:00.000Z',
} as const

const EMPTY_FIELDS_ROW = {
  ...FILLED_ROW,
  receipt_email: null,
  billing_address: null,
  shipping_address: null,
} as const

describe('CheckoutDetailsSharingToggle visibility', () => {
  beforeEach(() => {
    mockApiPut.mockReset()
  })

  it('renders when company details are saved', () => {
    mockUseCompanyDetails.mockReturnValue({ status: 'ready', details: FILLED_ROW })
    render(
      <CheckoutDetailsSharingToggle
        agentId="agent-1"
        checkoutDetailsSharingEnabled={false}
        onAgentsChanged={() => {}}
      />,
    )
    expect(screen.getByText('Checkout details')).toBeInTheDocument()
    expect(screen.getByRole('checkbox')).not.toBeChecked()
  })

  it('renders when the feature is on and nothing is saved (the switch may be on with nothing stored)', () => {
    mockUseCompanyDetails.mockReturnValue({ status: 'empty', details: null })
    render(
      <CheckoutDetailsSharingToggle
        agentId="agent-1"
        checkoutDetailsSharingEnabled={false}
        onAgentsChanged={() => {}}
      />,
    )
    expect(screen.getByText('Checkout details')).toBeInTheDocument()
    expect(screen.getByTestId('checkout-details-nothing-saved')).toHaveTextContent(
      CHECKOUT_DETAILS_NOTHING_SAVED,
    )
  })

  it('renders when the row exists but none of the three fields is saved', () => {
    mockUseCompanyDetails.mockReturnValue({ status: 'ready', details: EMPTY_FIELDS_ROW })
    render(
      <CheckoutDetailsSharingToggle
        agentId="agent-1"
        checkoutDetailsSharingEnabled={false}
        onAgentsChanged={() => {}}
      />,
    )
    expect(screen.getByTestId('checkout-details-nothing-saved')).toBeInTheDocument()
  })

  it('is absent when the flag is off (the route answers 404 → status "off")', () => {
    mockUseCompanyDetails.mockReturnValue({ status: 'off', details: null })
    render(
      <CheckoutDetailsSharingToggle
        agentId="agent-1"
        checkoutDetailsSharingEnabled={false}
        onAgentsChanged={() => {}}
      />,
    )
    expect(screen.queryByText('Checkout details')).not.toBeInTheDocument()
  })

  it('is absent while the first read is in flight and on a read error', () => {
    mockUseCompanyDetails.mockReturnValue({ status: 'loading', details: null })
    const { unmount } = render(
      <CheckoutDetailsSharingToggle
        agentId="agent-1"
        checkoutDetailsSharingEnabled={false}
        onAgentsChanged={() => {}}
      />,
    )
    expect(screen.queryByText('Checkout details')).not.toBeInTheDocument()
    unmount()

    mockUseCompanyDetails.mockReturnValue({ status: 'error', details: null })
    render(
      <CheckoutDetailsSharingToggle
        agentId="agent-1"
        checkoutDetailsSharingEnabled={false}
        onAgentsChanged={() => {}}
      />,
    )
    expect(screen.queryByText('Checkout details')).not.toBeInTheDocument()
  })

  it('does NOT require a VIES-valid VAT number (unlike the tax declaration toggle)', () => {
    mockUseCompanyDetails.mockReturnValue({
      status: 'ready',
      details: { ...FILLED_ROW, vies_status: 'invalid', vies_checked_at: null },
    })
    render(
      <CheckoutDetailsSharingToggle
        agentId="agent-1"
        checkoutDetailsSharingEnabled={false}
        onAgentsChanged={() => {}}
      />,
    )
    expect(screen.getByText('Checkout details')).toBeInTheDocument()
  })
})

describe('CheckoutDetailsSharingToggle copy', () => {
  beforeEach(() => {
    mockUseCompanyDetails.mockReturnValue({ status: 'ready', details: FILLED_ROW })
  })

  it('pins the one-line description: what is shared and with whom', () => {
    render(
      <CheckoutDetailsSharingToggle
        agentId="agent-1"
        checkoutDetailsSharingEnabled={false}
        onAgentsChanged={() => {}}
      />,
    )
    expect(screen.getByText(CHECKOUT_DETAILS_DESCRIPTION)).toBeInTheDocument()
    expect(CHECKOUT_DETAILS_DESCRIPTION).toContain('receipt email')
    expect(CHECKOUT_DETAILS_DESCRIPTION).toContain('addresses')
    expect(CHECKOUT_DETAILS_DESCRIPTION).toContain('merchants that ask')
  })

  it('pins the disclosure: the three fields, the agent can read them, never the sign-in email, withdrawal', () => {
    render(
      <CheckoutDetailsSharingToggle
        agentId="agent-1"
        checkoutDetailsSharingEnabled={false}
        onAgentsChanged={() => {}}
      />,
    )
    const help = screen.getByText(CHECKOUT_DETAILS_EXPLANATION).textContent ?? ''
    expect(help).toBe(CHECKOUT_DETAILS_EXPLANATION)
    expect(help).toContain('receipt email')
    expect(help).toContain('billing address')
    expect(help).toContain('shipping address')
    expect(help).toContain('your agent can also read these details itself')
    expect(help).toContain('never your sign-in email')
    expect(help).toContain('switch it off here at any time')
  })

  it('does not claim Haven sends the details by itself', () => {
    render(
      <CheckoutDetailsSharingToggle
        agentId="agent-1"
        checkoutDetailsSharingEnabled={false}
        onAgentsChanged={() => {}}
      />,
    )
    const help = screen.getByText(CHECKOUT_DETAILS_EXPLANATION).textContent ?? ''
    expect(help.toLowerCase()).not.toContain('haven sends')
    expect(help.toLowerCase()).not.toContain('every payment')
  })
})

describe('CheckoutDetailsSharingToggle interaction', () => {
  beforeEach(() => {
    mockUseCompanyDetails.mockReturnValue({ status: 'ready', details: FILLED_ROW })
    mockApiPut.mockReset()
  })

  it('PUTs exactly the toggle body to the agent route on change', async () => {
    mockApiPut.mockResolvedValue({ id: 'agent-1', checkout_details_sharing_enabled: true })
    render(
      <CheckoutDetailsSharingToggle
        agentId="agent-1"
        checkoutDetailsSharingEnabled={false}
        onAgentsChanged={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox'))
    await waitFor(() => {
      expect(mockApiPut).toHaveBeenCalledWith('/agents/agent-1/checkout-details-sharing', {
        checkout_details_sharing_enabled: true,
      })
    })
  })

  it('refetches the agents list after a successful write', async () => {
    mockApiPut.mockResolvedValue({ id: 'agent-1', checkout_details_sharing_enabled: true })
    const onAgentsChanged = vi.fn()
    render(
      <CheckoutDetailsSharingToggle
        agentId="agent-1"
        checkoutDetailsSharingEnabled={false}
        onAgentsChanged={onAgentsChanged}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox'))
    await waitFor(() => {
      expect(onAgentsChanged).toHaveBeenCalled()
    })
  })

  it('does NOT optimistically flip: a failed save keeps the server-truth state and surfaces the error', async () => {
    mockApiPut.mockRejectedValue(new Error('network down'))
    render(
      <CheckoutDetailsSharingToggle
        agentId="agent-1"
        checkoutDetailsSharingEnabled={false}
        onAgentsChanged={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox'))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })
    expect(screen.getByRole('checkbox')).not.toBeChecked()
  })

  it('shows the server-truth ON state and can switch it off', async () => {
    mockApiPut.mockResolvedValue({ id: 'agent-1', checkout_details_sharing_enabled: false })
    render(
      <CheckoutDetailsSharingToggle
        agentId="agent-1"
        checkoutDetailsSharingEnabled
        onAgentsChanged={() => {}}
      />,
    )
    expect(screen.getByRole('checkbox')).toBeChecked()
    fireEvent.click(screen.getByRole('checkbox'))
    await waitFor(() => {
      expect(mockApiPut).toHaveBeenCalledWith('/agents/agent-1/checkout-details-sharing', {
        checkout_details_sharing_enabled: false,
      })
    })
  })
})
