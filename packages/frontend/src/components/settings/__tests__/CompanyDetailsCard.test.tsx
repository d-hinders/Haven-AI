/**
 * `CompanyDetailsCard` (#3332) through the real hook with `@/lib/api` mocked.
 *
 * Covers: the 404-gating split (feature off vs. no row yet — the backend
 * answers 404 for both, distinguished only by the error body), form
 * validation, the PUT body shape, every VIES status line (and the "never
 * verified" rule), VIES polling stopping on unmount, delete-with-confirm,
 * and 429/400 handling.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '@/context/LocaleContext'
import type { ApiOperations } from '@haven_ai/core'

const { mockApi } = vi.hoisted(() => ({
  mockApi: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(), getText: vi.fn() },
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ApiRequestError: actual.ApiRequestError, api: mockApi }
})

import { ApiRequestError } from '@/lib/api'
import { CompanyDetailsCard } from '@/components/settings/CompanyDetailsCard'

type CompanyDetails = ApiOperations['getCompanyDetails']['responses']['200']['content']['application/json']
type PutBody = ApiOperations['putCompanyDetails']['requestBody']['content']['application/json']

// #3332 contract check (tsc-time, never invoked): a field this literal does
// not carry on the generated `UpsertCompanyDetailsRequest` shape is a compile
// error here, mirroring #3027's `apiMock()` proof for the accounting surface.
function unusedTypeCheckOnly_putBodyMatchesGeneratedShape(): PutBody {
  return {
    legal_name: 'Ada Lovelace AB',
    country: 'SE',
    org_number: '556677-8899',
    vat_number: 'SE556677889901',
  }
}
void unusedTypeCheckOnly_putBodyMatchesGeneratedShape

function details(overrides: Partial<CompanyDetails> = {}): CompanyDetails {
  return {
    legal_name: 'Ada Lovelace AB',
    country: 'SE',
    org_number: '556677-8899',
    vat_number: 'SE556677889901',
    vies_status: 'valid',
    vies_checked_at: '2026-09-20T10:00:00.000Z',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-20T10:00:00.000Z',
    ...overrides,
  }
}

function renderCard() {
  return render(
    <LocaleProvider>
      <CompanyDetailsCard />
    </LocaleProvider>,
  )
}

function featureOff404() {
  return Promise.reject(new ApiRequestError('Not found', 404, { error: 'Not found' }))
}

function noRow() {
  return Promise.resolve(null)
}

beforeEach(() => {
  mockApi.get.mockReset()
  mockApi.put.mockReset()
  mockApi.post.mockReset()
  mockApi.delete.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('CompanyDetailsCard — gating', () => {
  it('renders nothing when the feature flag is off (404 "Not found")', async () => {
    mockApi.get.mockImplementation(() => featureOff404())
    const { container } = renderCard()
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('renders an empty form when the flag is on but nothing is saved (200 null)', async () => {
    mockApi.get.mockImplementation(() => noRow())
    renderCard()
    await waitFor(() => expect(screen.getByTestId('company-details-form')).toBeInTheDocument())
    expect(screen.getByLabelText('Legal name')).toHaveValue('')
    // The purpose text is shown before any submission (acceptance point 2).
    expect(screen.getByTestId('company-details-purpose')).toHaveTextContent(/personal identity number/)
  })

  it('renders the saved details when present', async () => {
    mockApi.get.mockImplementation(() => Promise.resolve(details()))
    renderCard()
    await waitFor(() => expect(screen.getByLabelText('Legal name')).toHaveValue('Ada Lovelace AB'))
    expect(screen.getByLabelText('Organisation number')).toHaveValue('556677-8899')
  })

  it('shows a retry state on a non-404 failure, never a blank crash', async () => {
    mockApi.get.mockImplementation(() => Promise.reject(new ApiRequestError('nope', 500)))
    renderCard()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument())
    mockApi.get.mockImplementation(() => Promise.resolve(details({ vat_number: null, vies_status: null, vies_checked_at: null })))
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getByLabelText('Legal name')).toHaveValue('Ada Lovelace AB'))
  })
})

describe('CompanyDetailsCard — validation and save', () => {
  it('blocks submit on an empty legal name, without calling PUT', async () => {
    mockApi.get.mockImplementation(() => noRow())
    renderCard()
    await waitFor(() => screen.getByTestId('company-details-form'))
    fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'SE' } })
    fireEvent.change(screen.getByLabelText('Organisation number'), { target: { value: '556677-8899' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Enter a legal name.')).toBeInTheDocument()
    expect(mockApi.put).not.toHaveBeenCalled()
  })

  it('rejects a malformed country before the request leaves the browser', async () => {
    mockApi.get.mockImplementation(() => noRow())
    renderCard()
    await waitFor(() => screen.getByTestId('company-details-form'))
    fireEvent.change(screen.getByLabelText('Legal name'), { target: { value: 'Ada Lovelace AB' } })
    fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'SWE' } })
    fireEvent.change(screen.getByLabelText('Organisation number'), { target: { value: '556677-8899' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Country must be a two-letter code, e.g. "SE".')).toBeInTheDocument()
    expect(mockApi.put).not.toHaveBeenCalled()
  })

  it('PUTs the full-replacement body, normalised, on a valid submit', async () => {
    mockApi.get.mockImplementation(() => noRow())
    mockApi.put.mockImplementation((_path: string, body: unknown) =>
      Promise.resolve(details({ ...(body as PutBody), vies_status: 'pending', vies_checked_at: null })),
    )
    renderCard()
    await waitFor(() => screen.getByTestId('company-details-form'))
    fireEvent.change(screen.getByLabelText('Legal name'), { target: { value: '  Ada Lovelace AB  ' } })
    fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'se' } })
    fireEvent.change(screen.getByLabelText('Organisation number'), { target: { value: '556677-8899' } })
    fireEvent.change(screen.getByLabelText('VAT number (optional)'), { target: { value: 'se556677889901' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mockApi.put).toHaveBeenCalledTimes(1))
    const [path, body] = mockApi.put.mock.calls[0] as [string, PutBody]
    expect(path).toBe('/user/company-details')
    expect(body).toEqual({
      legal_name: 'Ada Lovelace AB',
      country: 'SE',
      org_number: '556677-8899',
      vat_number: 'SE556677889901',
    })
  })

  it('clears vat_number to null when the field is emptied', async () => {
    mockApi.get.mockImplementation(() => Promise.resolve(details()))
    mockApi.put.mockImplementation((_path: string, body: unknown) => Promise.resolve({ ...details(), ...(body as PutBody), vies_status: null, vies_checked_at: null }))
    renderCard()
    await waitFor(() => expect(screen.getByLabelText('VAT number (optional)')).toHaveValue('SE556677889901'))
    fireEvent.change(screen.getByLabelText('VAT number (optional)'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mockApi.put).toHaveBeenCalledTimes(1))
    const [, body] = mockApi.put.mock.calls[0] as [string, PutBody]
    expect(body.vat_number).toBeNull()
  })

  it('surfaces the backend 400 message verbatim', async () => {
    mockApi.get.mockImplementation(() => noRow())
    mockApi.put.mockImplementation(() =>
      Promise.reject(new ApiRequestError('Enter an organisation number using 32 characters or fewer.', 400, {
        error: 'Enter an organisation number using 32 characters or fewer.',
      })),
    )
    renderCard()
    await waitFor(() => screen.getByTestId('company-details-form'))
    fireEvent.change(screen.getByLabelText('Legal name'), { target: { value: 'Ada Lovelace AB' } })
    fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'SE' } })
    fireEvent.change(screen.getByLabelText('Organisation number'), { target: { value: '1'.repeat(32) } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Enter an organisation number using 32 characters or fewer.')).toBeInTheDocument()
  })

  it('shows a plain rate-limit message on 429', async () => {
    mockApi.get.mockImplementation(() => noRow())
    mockApi.put.mockImplementation(() => Promise.reject(new ApiRequestError('Too many requests', 429, { error: 'Too many requests' })))
    renderCard()
    await waitFor(() => screen.getByTestId('company-details-form'))
    fireEvent.change(screen.getByLabelText('Legal name'), { target: { value: 'Ada Lovelace AB' } })
    fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'SE' } })
    fireEvent.change(screen.getByLabelText('Organisation number'), { target: { value: '556677-8899' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/too many times just now/)).toBeInTheDocument()
  })
})

describe('CompanyDetailsCard — VIES status copy', () => {
  const ALL_RENDERED_TEXT_CASES: Array<[CompanyDetails['vies_status'], string, string | null]> = [
    ['pending', 'Checking the VAT number with VIES…', null],
    ['valid', 'VAT number checked against VIES on September 20, 2026', '2026-09-20T10:00:00.000Z'],
    ['invalid', 'VIES says this VAT number is not valid.', null],
    ['not_verifiable', 'VIES could not check this number right now.', null],
  ]

  for (const [status, expected, checkedAt] of ALL_RENDERED_TEXT_CASES) {
    it(`renders the ${status} line exactly`, async () => {
      mockApi.get.mockImplementation(() => Promise.resolve(details({ vies_status: status, vies_checked_at: checkedAt })))
      renderCard()
      expect(await screen.findByText(expected)).toBeInTheDocument()
    })
  }

  it('never renders the word "verified" anywhere, in any VIES state', async () => {
    for (const status of ['pending', 'valid', 'invalid', 'not_verifiable'] as const) {
      mockApi.get.mockReset()
      mockApi.get.mockImplementation(() =>
        Promise.resolve(details({ vies_status: status, vies_checked_at: status === 'valid' ? '2026-09-20T10:00:00.000Z' : null })),
      )
      const { unmount, container } = renderCard()
      await waitFor(() => expect(mockApi.get).toHaveBeenCalled())
      expect(container.textContent ?? '').not.toMatch(/verified/i)
      unmount()
    }
  })

  it('shows no VIES line when there is no VAT number', async () => {
    mockApi.get.mockImplementation(() => Promise.resolve(details({ vat_number: null, vies_status: null, vies_checked_at: null })))
    renderCard()
    await waitFor(() => screen.getByTestId('company-details-form'))
    expect(screen.queryByTestId('vies-status-line')).not.toBeInTheDocument()
  })

  it('"Check again" re-runs the VIES check', async () => {
    mockApi.get.mockImplementation(() => Promise.resolve(details({ vies_status: 'invalid' })))
    mockApi.post.mockImplementation(() => Promise.resolve(details({ vies_status: 'pending', vies_checked_at: null })))
    renderCard()
    await waitFor(() => screen.getByText('VIES says this VAT number is not valid.'))
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/user/company-details/vies-check'))
    expect(await screen.findByText('Checking the VAT number with VIES…')).toBeInTheDocument()
  })

  it('shows a plain message on a 429 from vies-check', async () => {
    mockApi.get.mockImplementation(() => Promise.resolve(details({ vies_status: 'invalid' })))
    mockApi.post.mockImplementation(() => Promise.reject(new ApiRequestError('Too many requests', 429, { error: 'Too many requests' })))
    renderCard()
    await waitFor(() => screen.getByText('VIES says this VAT number is not valid.'))
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findByText(/too many times just now/)).toBeInTheDocument()
  })
})

describe('CompanyDetailsCard — VIES polling', () => {
  it('polls while pending and stops once the status resolves', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let call = 0
    mockApi.get.mockImplementation(() => {
      call += 1
      if (call === 1) return Promise.resolve(details({ vies_status: 'pending', vies_checked_at: null }))
      return Promise.resolve(details({ vies_status: 'valid', vies_checked_at: '2026-09-20T10:00:00.000Z' }))
    })
    renderCard()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(await screen.findByText('Checking the VAT number with VIES…')).toBeInTheDocument()
    expect(call).toBe(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(call).toBe(2)
    expect(await screen.findByText('VAT number checked against VIES on September 20, 2026')).toBeInTheDocument()

    // No further poll ticks once the status left `pending`.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000)
    })
    expect(call).toBe(2)
  })

  it('stops polling on unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let call = 0
    mockApi.get.mockImplementation(() => {
      call += 1
      return Promise.resolve(details({ vies_status: 'pending', vies_checked_at: null }))
    })
    const { unmount } = renderCard()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(call).toBe(1)
    unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000)
    })
    expect(call).toBe(1)
  })
})

describe('CompanyDetailsCard — delete', () => {
  it('asks for confirmation before DELETE, and resets to empty on success', async () => {
    mockApi.get.mockImplementation(() => Promise.resolve(details()))
    mockApi.delete.mockImplementation(() => Promise.resolve({ ok: true }))
    renderCard()
    await waitFor(() => expect(screen.getByLabelText('Legal name')).toHaveValue('Ada Lovelace AB'))

    fireEvent.click(screen.getByRole('button', { name: 'Remove company details' }))
    const dialog = await screen.findByRole('dialog')
    expect(mockApi.delete).not.toHaveBeenCalled()

    mockApi.get.mockImplementation(() => noRow())
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith('/user/company-details'))
    await waitFor(() => expect(screen.getByLabelText('Legal name')).toHaveValue(''))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows a plain error and keeps the details on a failed delete', async () => {
    mockApi.get.mockImplementation(() => Promise.resolve(details()))
    mockApi.delete.mockImplementation(() => Promise.reject(new ApiRequestError('nope', 500)))
    renderCard()
    await waitFor(() => expect(screen.getByLabelText('Legal name')).toHaveValue('Ada Lovelace AB'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove company details' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    expect(await screen.findByText('We could not remove your company details. Try again in a moment.')).toBeInTheDocument()
    expect(screen.getByLabelText('Legal name')).toHaveValue('Ada Lovelace AB')
  })
})
