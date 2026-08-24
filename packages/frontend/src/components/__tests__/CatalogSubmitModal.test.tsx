import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockSubmitCatalog, mockGetSubmissionStatus } = vi.hoisted(() => ({
  mockSubmitCatalog: vi.fn(),
  mockGetSubmissionStatus: vi.fn(),
}))

vi.mock('@/hooks/useCatalog', () => ({
  submitCatalog: (...args: unknown[]) => mockSubmitCatalog(...args),
  getSubmissionStatus: (...args: unknown[]) => mockGetSubmissionStatus(...args),
}))

import CatalogSubmitModal, {
  SUBMISSION_POLL_MS,
  validateResourceUrl,
} from '../CatalogSubmitModal'
import type { CatalogSubmissionStatus } from '@/hooks/useCatalog'

const URL = 'https://merchant.example/pay'

function instructionsFixture() {
  return {
    expires_at: '2099-01-01T00:00:00.000Z',
    well_known: {
      url: 'https://merchant.example/.well-known/haven-verify-abc123.txt',
      content: 'haven-domain-verification=v1.sub-1.proof',
      instruction:
        'Serve this exact line over HTTPS at /.well-known/haven-verify-abc123.txt',
    },
    dns_txt: {
      name: '_haven-verify.merchant.example',
      value: 'haven-domain-verification=v1.sub-1.proof',
      instruction:
        'Publish this exact value as a TXT record at _haven-verify.merchant.example',
    },
  }
}

function submitStatus(
  status: CatalogSubmissionStatus['status'] = 'submitted',
): CatalogSubmissionStatus {
  return {
    id: 'sub-1',
    status,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    last_verified_at: null,
    name: null,
    description: null,
    entrypoint: null,
    instructions: status === 'submitted' ? instructionsFixture() : null,
  }
}

async function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText('Resource URL'), { target: { value: URL } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Submit for verification' }))
    await Promise.resolve()
  })
}

describe('validateResourceUrl', () => {
  it('accepts a plain https URL', () => {
    expect(validateResourceUrl('https://merchant.example/pay')).toBeNull()
  })

  it('rejects empty values', () => {
    expect(validateResourceUrl('')).toBe('Enter the https URL of the payable endpoint.')
    expect(validateResourceUrl('   ')).toBe('Enter the https URL of the payable endpoint.')
  })

  it('rejects non-URL, non-https and credential-carrying values', () => {
    expect(validateResourceUrl('not a url')).toBe('Enter a valid https URL.')
    expect(validateResourceUrl('http://merchant.example/pay')).toBe(
      'Use an https URL for your resource.',
    )
    expect(validateResourceUrl('https://user:pass@merchant.example/pay')).toBe(
      'Remove any username or password from the URL.',
    )
    expect(validateResourceUrl('https://user@merchant.example/pay')).toBe(
      'Remove any username or password from the URL.',
    )
  })

  it('rejects URLs beyond the backend ceiling', () => {
    const long = `https://merchant.example/${'x'.repeat(2100)}`
    expect(validateResourceUrl(long)).toMatch(/under 2048 characters/)
  })
})

describe('CatalogSubmitModal (#1715)', () => {
  const onClose = vi.fn()
  const onVerifiedPayable = vi.fn()

  function renderModal() {
    render(
      <CatalogSubmitModal open onClose={onClose} onVerifiedPayable={onVerifiedPayable} />,
    )
  }

  beforeEach(() => {
    onClose.mockClear()
    onVerifiedPayable.mockClear()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('shows a validation error and never calls the api for a bad url', () => {
    mockSubmitCatalog.mockResolvedValue({ id: 'sub-1', verify_token: 't', status: 'submitted' })
    renderModal()

    // Empty submit.
    fireEvent.click(screen.getByRole('button', { name: 'Submit for verification' }))
    expect(screen.getByText('Enter the https URL of the payable endpoint.')).toBeDefined()
    expect(mockSubmitCatalog).not.toHaveBeenCalled()

    // Embedded credentials.
    fireEvent.change(screen.getByLabelText('Resource URL'), {
      target: { value: 'https://user:pass@merchant.example/pay' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Submit for verification' }))
    expect(
      screen.getByText('Remove any username or password from the URL.'),
    ).toBeDefined()
    expect(mockSubmitCatalog).not.toHaveBeenCalled()

    // Non-https.
    fireEvent.change(screen.getByLabelText('Resource URL'), {
      target: { value: 'http://merchant.example/pay' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Submit for verification' }))
    expect(screen.getByText('Use an https URL for your resource.')).toBeDefined()
    expect(mockSubmitCatalog).not.toHaveBeenCalled()
  })

  it('keeps the honeypot website field present, hidden and empty', () => {
    renderModal()

    const honeypot = document.querySelector<HTMLInputElement>('input[name="website"]')
    expect(honeypot).not.toBeNull()
    // The honeypot must never receive a real value; the POST body stays empty.
    expect(honeypot?.value).toBe('')
    // Visually hidden: the off-screen container keeps it out of view.
    expect(honeypot?.parentElement?.className).toContain('absolute')
  })

  it('submits, then shows the token, the one-line well-known instruction and both proof options', async () => {
    mockSubmitCatalog.mockResolvedValue({
      id: 'sub-1',
      verify_token: 'tok-123',
      status: 'submitted',
    })
    mockGetSubmissionStatus.mockResolvedValue(submitStatus('submitted'))
    renderModal()

    await fillAndSubmit()

    await waitFor(() =>
      expect(mockSubmitCatalog).toHaveBeenCalledWith(URL),
    )
    // The honeypot field is sent empty, never a filled value.
    expect(mockSubmitCatalog).toHaveBeenCalledWith(URL)

    // The one-shot token from POST is shown.
    expect(screen.getByText('tok-123')).toBeDefined()

    // The one-line well-known instruction is the prominent required action.
    const instruction = screen.getByTestId('well-known-instruction')
    expect(instruction).toHaveTextContent(
      'Serve this exact line over HTTPS at /.well-known/haven-verify-abc123.txt',
    )
    expect(instruction).toBeDefined()

    // Both proof options are surfaced with copy affordances.
    expect(screen.getByText('https://merchant.example/.well-known/haven-verify-abc123.txt')).toBeDefined()
    // The proof payload is shared by the well-known file and the DNS TXT record.
    expect(screen.getAllByText('haven-domain-verification=v1.sub-1.proof').length).toBe(2)
    expect(screen.getByText('_haven-verify.merchant.example')).toBeDefined()
    expect(screen.getByLabelText('Copy well-known URL')).toBeDefined()
    expect(screen.getByLabelText('Copy well-known content')).toBeDefined()
    expect(screen.getByLabelText('Copy DNS TXT name')).toBeDefined()
    expect(screen.getByLabelText('Copy DNS TXT value')).toBeDefined()
  })

  it('copies a proof value to the clipboard', async () => {
    mockSubmitCatalog.mockResolvedValue({
      id: 'sub-1',
      verify_token: 'tok-123',
      status: 'submitted',
    })
    mockGetSubmissionStatus.mockResolvedValue(submitStatus('submitted'))
    renderModal()
    await fillAndSubmit()

    fireEvent.click(screen.getByLabelText('Copy well-known content'))
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        'haven-domain-verification=v1.sub-1.proof',
      ),
    )
  })

  it('advances through live states and stops polling at the listed terminal state', async () => {
    vi.useFakeTimers()
    mockSubmitCatalog.mockResolvedValue({
      id: 'sub-1',
      verify_token: 'tok-123',
      status: 'submitted',
    })
    // Call 1: initial status fetch after POST. Then polls.
    mockGetSubmissionStatus
      .mockResolvedValueOnce(submitStatus('submitted'))
      .mockResolvedValueOnce(submitStatus('ownership_verified'))
      .mockResolvedValueOnce(submitStatus('verified_payable'))

    renderModal()
    await fillAndSubmit()

    // Submitted: initial fetch done, tracking begins.
    expect(
      screen.getByRole('listitem', { current: 'step' }),
    ).toHaveTextContent('Submitted')

    // Poll 2 → domain verified.
    await act(async () => {
      vi.advanceTimersByTime(SUBMISSION_POLL_MS)
      await Promise.resolve()
    })
    expect(
      screen.getByRole('listitem', { current: 'step' }),
    ).toHaveTextContent('Domain verified')

    // Poll 3 → verified payable, which is the listed happy path.
    await act(async () => {
      vi.advanceTimersByTime(SUBMISSION_POLL_MS)
      await Promise.resolve()
    })
    expect(screen.getByText('Verified and listed')).toBeDefined()
    expect(onVerifiedPayable).toHaveBeenCalledTimes(1)
    expect(
      screen.getByRole('listitem', { current: 'step' }),
    ).toHaveTextContent('Listed')

    // Terminal state: the poll loop is done.
    const callsAfterListed = mockGetSubmissionStatus.mock.calls.length
    await act(async () => {
      vi.advanceTimersByTime(SUBMISSION_POLL_MS * 5)
      await Promise.resolve()
    })
    expect(mockGetSubmissionStatus.mock.calls.length).toBe(callsAfterListed)
  })

  it('surfaces a generic failed state and keeps the offer to resubmit, stopping polls', async () => {
    vi.useFakeTimers()
    mockSubmitCatalog.mockResolvedValue({
      id: 'sub-1',
      verify_token: 'tok-123',
      status: 'submitted',
    })
    mockGetSubmissionStatus
      .mockResolvedValueOnce(submitStatus('submitted'))
      .mockResolvedValueOnce(submitStatus('failed'))

    renderModal()
    await fillAndSubmit()

    await act(async () => {
      vi.advanceTimersByTime(SUBMISSION_POLL_MS)
      await Promise.resolve()
    })

    // Coarse, generic failure copy — no invented reason.
    expect(screen.getByText('Verification failed')).toBeDefined()
    expect(
      screen.getByText(/We could not verify this service/),
    ).toBeDefined()
    expect(screen.queryByTestId('well-known-instruction')).toBeNull()

    const callsAfterFailed = mockGetSubmissionStatus.mock.calls.length
    await act(async () => {
      vi.advanceTimersByTime(SUBMISSION_POLL_MS * 5)
      await Promise.resolve()
    })
    expect(mockGetSubmissionStatus.mock.calls.length).toBe(callsAfterFailed)

    // The user can try another submission without reopening.
    fireEvent.click(screen.getByRole('button', { name: 'Submit another service' }))
    expect(screen.getByText('Resource URL')).toBeDefined()
  })

  it('shows the removed state for a delisted submission and stops polling', async () => {
    vi.useFakeTimers()
    mockSubmitCatalog.mockResolvedValue({
      id: 'sub-1',
      verify_token: 'tok-123',
      status: 'submitted',
    })
    mockGetSubmissionStatus.mockResolvedValueOnce(submitStatus('delisted'))

    renderModal()
    await fillAndSubmit()

    expect(screen.getByText('Removed from the catalog')).toBeDefined()

    await act(async () => {
      vi.advanceTimersByTime(SUBMISSION_POLL_MS * 3)
      await Promise.resolve()
    })
    // Only the initial fetch ran; the delisted state never enters tracking.
    expect(mockGetSubmissionStatus).toHaveBeenCalledTimes(1)
  })

  it('handles instructions being unavailable and shows a submit failure state', async () => {
    mockSubmitCatalog.mockRejectedValue(new Error('The submission queue is full, try again later'))
    renderModal()

    await fillAndSubmit()

    expect(screen.getByText('We could not submit the service')).toBeDefined()
    expect(screen.getByText('The submission queue is full, try again later')).toBeDefined()
    // Back to the form to correct and retry.
    fireEvent.click(screen.getByRole('button', { name: 'Back to form' }))
    expect(screen.getByText('Resource URL')).toBeDefined()
  })
})
