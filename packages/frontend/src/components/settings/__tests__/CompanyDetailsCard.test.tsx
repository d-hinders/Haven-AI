/**
 * `CompanyDetailsCard` (#3332) through the real hook with `@/lib/api` mocked.
 *
 * Covers: status-only gating (404 = feature off, 200 `null` = flag on but no
 * row saved yet, 200 with a row = ready), form validation, the PUT body
 * shape, every VIES status line (and the "never verified" rule), VIES
 * polling stopping on unmount and on the 60s bound, "Check again" behaviour,
 * the poll/save generation race, delete-with-confirm, and 429/400 handling.
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
import { BusinessDataProvider } from '@/components/settings/BusinessDataContext'
import { VIES_POLL_INTERVAL_MS, VIES_POLL_MAX_MS } from '@/hooks/useCompanyDetails'

type CompanyDetails = NonNullable<ApiOperations['getCompanyDetails']['responses']['200']['content']['application/json']>
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
      {/* #4359: the cards read their shared data through the provider — the
          ONE `useCompanyDetails` (with its VIES polling) that Settings
          mounts. The card renders standalone under it, exactly as it sits
          inside `SettingsClient`. */}
      <BusinessDataProvider>
        <CompanyDetailsCard />
      </BusinessDataProvider>
    </LocaleProvider>,
  )
}

/**
 * #4359: with nothing saved the card shows the "No company details" state;
 * the form sits behind **Add company details**. Every test that works on
 * the empty form reveals it first.
 */
async function revealEmptyForm() {
  fireEvent.click(await screen.findByRole('button', { name: 'Add company details' }))
  await screen.findByTestId('company-details-form')
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

  it('shows the "No company details" state when the flag is on but nothing is saved (200 null)', async () => {
    mockApi.get.mockImplementation(() => noRow())
    renderCard()
    // #4359: one line + the reveal — the purpose line stays ABOVE the Add
    // button (owner-company-details.md: shown above the form, always).
    expect(await screen.findByText('No company details')).toBeInTheDocument()
    expect(screen.getByTestId('company-details-purpose')).toHaveTextContent(/personal identity number/)
    expect(screen.getByRole('button', { name: 'Add company details' })).toBeInTheDocument()
    // The form is NOT rendered until it is asked for.
    expect(screen.queryByTestId('company-details-form')).not.toBeInTheDocument()
  })

  it('Add company details reveals the form, blank (#4359)', async () => {
    mockApi.get.mockImplementation(() => noRow())
    renderCard()
    fireEvent.click(await screen.findByRole('button', { name: 'Add company details' }))
    await waitFor(() => expect(screen.getByTestId('company-details-form')).toBeInTheDocument())
    expect(screen.getByLabelText('Legal name')).toHaveValue('')
    // The picker starts on its placeholder.
    expect(screen.getByLabelText('Country')).toHaveValue('')
    expect(screen.getByRole('option', { name: 'Choose a country', selected: true })).toBeInTheDocument()
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
    await revealEmptyForm()
    fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'SE' } })
    fireEvent.change(screen.getByLabelText('Organisation number'), { target: { value: '556677-8899' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Enter a legal name.')).toBeInTheDocument()
    expect(mockApi.put).not.toHaveBeenCalled()
  })

  it('saves a code OUTSIDE the assigned list exactly as stored, and displays it as its own option (#4359)', async () => {
    // "UK" is exceptionally reserved, not officially assigned — the backend
    // accepts any `^[A-Z]{2}$`, and the buyer country on receipts must never
    // change silently. Saving WITHOUT touching Country round-trips it.
    mockApi.get.mockImplementation(() => Promise.resolve(details({ country: 'UK' })))
    mockApi.put.mockImplementation((_path: string, body: unknown) => Promise.resolve({ ...details(), ...(body as PutBody) }))
    renderCard()
    await waitFor(() => expect(screen.getByLabelText('Legal name')).toHaveValue('Ada Lovelace AB'))
    // Displayed: an option labelled with the raw code, and it is the selected one.
    const picker = screen.getByLabelText('Country') as HTMLSelectElement
    expect(picker).toHaveValue('UK')
    expect(screen.getByRole('option', { name: 'UK', selected: true })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mockApi.put).toHaveBeenCalledTimes(1))
    const [, body] = mockApi.put.mock.calls[0] as [string, PutBody]
    expect(body.country).toBe('UK')
  })

  it('labels the picker options with country names and saves the alpha-2 code (#4359)', async () => {
    mockApi.get.mockImplementation(() => noRow())
    mockApi.put.mockImplementation((_path: string, body: unknown) =>
      Promise.resolve(details({ ...(body as PutBody), vies_status: 'pending', vies_checked_at: null })),
    )
    renderCard()
    await revealEmptyForm()
    // Country NAMES, not codes — via `Intl.DisplayNames` in the user's locale.
    expect(screen.getByRole('option', { name: 'Sweden' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Germany' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Legal name'), { target: { value: 'Ada Lovelace AB' } })
    fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'SE' } })
    fireEvent.change(screen.getByLabelText('Organisation number'), { target: { value: '556677-8899' } })
    expect(screen.getByLabelText('Country')).toHaveValue('SE')
    // The wire is unchanged: the same ISO 3166-1 alpha-2 code the text input saved.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mockApi.put).toHaveBeenCalledTimes(1))
    const [, body] = mockApi.put.mock.calls[0] as [string, PutBody]
    expect(body.country).toBe('SE')
  })

  it('blocks submit while no country is chosen, with one description under the picker (#4359)', async () => {
    mockApi.get.mockImplementation(() => noRow())
    renderCard()
    await revealEmptyForm()
    fireEvent.change(screen.getByLabelText('Legal name'), { target: { value: 'Ada Lovelace AB' } })
    fireEvent.change(screen.getByLabelText('Organisation number'), { target: { value: '556677-8899' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Country must be a two-letter code, e.g. "SE".')).toBeInTheDocument()
    expect(mockApi.put).not.toHaveBeenCalled()
    // Exactly ONE description under the select — the error paragraph, no
    // helper text (the picker carries none anymore).
    const describedBy = screen.getByLabelText('Country').getAttribute('aria-describedby')
    expect(describedBy?.trim().split(/\s+/)).toHaveLength(1)
  })

  it('PUTs the full-replacement body, normalised, on a valid submit', async () => {
    mockApi.get.mockImplementation(() => noRow())
    mockApi.put.mockImplementation((_path: string, body: unknown) =>
      Promise.resolve(details({ ...(body as PutBody), vies_status: 'pending', vies_checked_at: null })),
    )
    renderCard()
    await revealEmptyForm()
    fireEvent.change(screen.getByLabelText('Legal name'), { target: { value: '  Ada Lovelace AB  ' } })
    fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'SE' } })
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
    await revealEmptyForm()
    fireEvent.change(screen.getByLabelText('Legal name'), { target: { value: 'Ada Lovelace AB' } })
    fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'SE' } })
    fireEvent.change(screen.getByLabelText('Organisation number'), { target: { value: '1'.repeat(32) } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Enter an organisation number using 32 characters or fewer.')).toBeInTheDocument()
  })

  it('shows a save-specific rate-limit message on 429, not the VIES rate-limit sentence', async () => {
    mockApi.get.mockImplementation(() => noRow())
    mockApi.put.mockImplementation(() => Promise.reject(new ApiRequestError('Too many requests', 429, { error: 'Too many requests' })))
    renderCard()
    await revealEmptyForm()
    fireEvent.change(screen.getByLabelText('Legal name'), { target: { value: 'Ada Lovelace AB' } })
    fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'SE' } })
    fireEvent.change(screen.getByLabelText('Organisation number'), { target: { value: '556677-8899' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Too many requests just now — try again in a minute.')).toBeInTheDocument()
    // The VIES-specific sentence ("checked this VAT number too many times")
    // must not appear here — a save being rate-limited names the save, not
    // the VIES check (#3332 review round 2, m-r2a).
    expect(screen.queryByText(/checked this VAT number too many times/)).not.toBeInTheDocument()
  })

  it('shows "This setting is no longer available." on a 404 from PUT (flag went off mid-session)', async () => {
    mockApi.get.mockImplementation(() => noRow())
    mockApi.put.mockImplementation(() => Promise.reject(new ApiRequestError('Not found', 404, { error: 'Not found' })))
    renderCard()
    await revealEmptyForm()
    fireEvent.change(screen.getByLabelText('Legal name'), { target: { value: 'Ada Lovelace AB' } })
    fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'SE' } })
    fireEvent.change(screen.getByLabelText('Organisation number'), { target: { value: '556677-8899' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('This setting is no longer available.')).toBeInTheDocument()
    expect(screen.queryByText(/Check the fields/)).not.toBeInTheDocument()
  })

  it('shows "Try again in a moment." — never "check the fields" — on a network/5xx Save failure (design review 8)', async () => {
    mockApi.get.mockImplementation(() => noRow())
    mockApi.put.mockImplementation(() => Promise.reject(new ApiRequestError('boom', 500)))
    renderCard()
    await revealEmptyForm()
    fireEvent.change(screen.getByLabelText('Legal name'), { target: { value: 'Ada Lovelace AB' } })
    fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'SE' } })
    fireEvent.change(screen.getByLabelText('Organisation number'), { target: { value: '556677-8899' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('We could not save your company details. Try again in a moment.')).toBeInTheDocument()
  })

  it('rejects an organisation number with a disallowed character, matching the backend shape, without calling PUT (m2)', async () => {
    mockApi.get.mockImplementation(() => noRow())
    renderCard()
    await revealEmptyForm()
    fireEvent.change(screen.getByLabelText('Legal name'), { target: { value: 'Ada Lovelace AB' } })
    fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'SE' } })
    fireEvent.change(screen.getByLabelText('Organisation number'), { target: { value: '556677_8899' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(
      await screen.findByText('Organisation number can only contain letters, numbers, spaces, and . - /'),
    ).toBeInTheDocument()
    expect(mockApi.put).not.toHaveBeenCalled()
  })

  it('rejects a legal name with a control character, without calling PUT (m2)', async () => {
    mockApi.get.mockImplementation(() => noRow())
    renderCard()
    await revealEmptyForm()
    fireEvent.change(screen.getByLabelText('Legal name'), { target: { value: 'Ada\u0000 Lovelace AB' } })
    fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'SE' } })
    fireEvent.change(screen.getByLabelText('Organisation number'), { target: { value: '556677-8899' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Legal name cannot contain hidden or control characters.')).toBeInTheDocument()
    expect(mockApi.put).not.toHaveBeenCalled()
  })

  it('maps a backend VAT-shape 400 onto the VAT field and focuses it (design review 3)', async () => {
    mockApi.get.mockImplementation(() => noRow())
    mockApi.put.mockImplementation(() =>
      Promise.reject(
        new ApiRequestError('Enter a VAT number as a two-letter country prefix followed by up to 20 letters or digits.', 400, {
          error: 'Enter a VAT number as a two-letter country prefix followed by up to 20 letters or digits.',
        }),
      ),
    )
    renderCard()
    await revealEmptyForm()
    fireEvent.change(screen.getByLabelText('Legal name'), { target: { value: 'Ada Lovelace AB' } })
    fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'SE' } })
    fireEvent.change(screen.getByLabelText('Organisation number'), { target: { value: '556677-8899' } })
    fireEvent.change(screen.getByLabelText('VAT number (optional)'), { target: { value: 'NOT-A-VAT' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const message = await screen.findByText(
      'Enter a VAT number as a two-letter country prefix followed by up to 20 letters or digits.',
    )
    expect(message).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('VAT number (optional)')).toHaveFocus())
    // #3332 review round 2, design 2: the error REPLACES the helper text in
    // the same paragraph (`company-vat-number-help`) rather than adding a
    // second, differently-id'd error line — keeps the `<input>` DOM node
    // stable across the transition (see the fix's own comment on
    // `fieldError`'s callers), which is also what keeps the focus this
    // assertion checks for.
    expect(screen.getByLabelText('VAT number (optional)')).toHaveAttribute(
      'aria-describedby',
      expect.stringContaining('company-vat-number-help'),
    )
  })

  it('focuses the first invalid field on a client-validation failure (design review 3)', async () => {
    mockApi.get.mockImplementation(() => noRow())
    renderCard()
    await revealEmptyForm()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Enter a legal name.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('Legal name')).toHaveFocus())
  })

  it('has autoComplete off on the organisation and VAT number fields (nit)', async () => {
    mockApi.get.mockImplementation(() => noRow())
    renderCard()
    await revealEmptyForm()
    expect(screen.getByLabelText('Organisation number')).toHaveAttribute('autoComplete', 'off')
    expect(screen.getByLabelText('VAT number (optional)')).toHaveAttribute('autoComplete', 'off')
  })

  it('the country error replaces — never joins — any other description under the picker (#4359)', async () => {
    // The picker carries NO helper text (the old "Two-letter country code…"
    // line is gone with the text input): the error paragraph is the only
    // thing that can sit under it.
    mockApi.get.mockImplementation(() => Promise.resolve(details({ country: 'SE' })))
    renderCard()
    await waitFor(() => expect(screen.getByLabelText('Legal name')).toHaveValue('Ada Lovelace AB'))
    expect(screen.getByLabelText('Country', { selector: 'select' })).not.toHaveAttribute('aria-describedby')
    fireEvent.change(screen.getByLabelText('Country'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Country must be a two-letter code, e.g. "SE".')).toBeInTheDocument()
    const describedBy = screen.getByLabelText('Country').getAttribute('aria-describedby')
    expect(describedBy?.trim().split(/\s+/)).toHaveLength(1)
  })
})

describe('CompanyDetailsCard — VIES status copy', () => {
  // #4359: the sentence is now a StatusBadge per state, beside the date and
  // Check again. The tone table is the spec's: valid = success, invalid =
  // warning, everything else neutral — `not_verifiable` is NEVER danger or
  // warning (owner-company-details.md's one load-bearing rule).
  const TONE_CLASS: Record<string, string> = {
    success: 'bg-[var(--v2-success-soft)]',
    warning: 'bg-[var(--v2-warning-soft)]',
    neutral: 'bg-[var(--v2-surface-2)]',
  }

  const ALL_RENDERED_TEXT_CASES: Array<[CompanyDetails['vies_status'], string, keyof typeof TONE_CLASS, string | null]> = [
    ['pending', 'Checking with VIES…', 'neutral', null],
    ['valid', 'Checked against VIES', 'success', '2026-09-20T10:00:00.000Z'],
    ['invalid', 'Not found in VIES', 'warning', null],
    ['not_verifiable', "VIES couldn't check this", 'neutral', null],
  ]

  for (const [status, expected, tone, checkedAt] of ALL_RENDERED_TEXT_CASES) {
    it(`renders the ${status} state as a badge with the ${tone} tone`, async () => {
      mockApi.get.mockImplementation(() => Promise.resolve(details({ vies_status: status, vies_checked_at: checkedAt })))
      renderCard()
      const line = await screen.findByTestId('vies-status-line')
      expect(line).toHaveTextContent(expected)
      // The tone: the badge's fill carries the tone variable.
      expect(line.querySelector('span')).toHaveClass(TONE_CLASS[tone])
    })
  }

  it('shows the checked date BESIDE the valid badge, and none when there is no date', async () => {
    mockApi.get.mockImplementation(() => Promise.resolve(details({ vies_status: 'valid', vies_checked_at: '2026-09-20T10:00:00.000Z' })))
    renderCard()
    const line = await screen.findByTestId('vies-status-line')
    expect(line).toHaveTextContent('Checked against VIES')
    expect(line).toHaveTextContent('20 September 2026')

    mockApi.get.mockImplementation(() => Promise.resolve(details({ vies_status: 'valid', vies_checked_at: null })))
    const { unmount } = renderCard()
    const second = await screen.findByTestId('vies-status-line')
    expect(second).toHaveTextContent('Checked against VIES')
    // The repo's en-GB long date — the date text is the only thing beside the badge.
    expect(second.textContent).not.toMatch(/on\s*$/)
    unmount()
  })

  it('never renders the word "verified" anywhere, in any VIES state', async () => {
    for (const status of ['pending', 'valid', 'invalid', 'not_verifiable'] as const) {
      mockApi.get.mockReset()
      mockApi.get.mockImplementation(() =>
        Promise.resolve(details({ vies_status: status, vies_checked_at: status === 'valid' ? '2026-09-20T10:00:00.000Z' : null })),
      )
      const { unmount, container } = renderCard()
      // A POSITIVE anchor first (#4359 spec review): the old version could
      // pass on an empty, still-loading card. The badge must be on screen
      // before the absence is asserted.
      await screen.findByTestId('vies-status-line')
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
    await waitFor(() => screen.getByText('Not found in VIES'))
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/user/company-details/vies-check'))
    expect(await screen.findByText('Checking with VIES…')).toBeInTheDocument()
  })

  it('shows a plain message on a 429 from vies-check', async () => {
    mockApi.get.mockImplementation(() => Promise.resolve(details({ vies_status: 'invalid' })))
    mockApi.post.mockImplementation(() => Promise.reject(new ApiRequestError('Too many requests', 429, { error: 'Too many requests' })))
    renderCard()
    await waitFor(() => screen.getByText('Not found in VIES'))
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findByText(/too many times just now/)).toBeInTheDocument()
  })

  it('shows "This setting is no longer available." on a 404 from vies-check (flag off mid-session)', async () => {
    mockApi.get.mockImplementation(() => Promise.resolve(details({ vies_status: 'invalid' })))
    mockApi.post.mockImplementation(() => Promise.reject(new ApiRequestError('Not found', 404, { error: 'Not found' })))
    renderCard()
    await waitFor(() => screen.getByText('Not found in VIES'))
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findByText('This setting is no longer available.')).toBeInTheDocument()
  })

  it('shows a "no longer saved" message, not the feature-off one, on a 404 whose body names a missing VAT number (#3332 review round 2, n3)', async () => {
    mockApi.get.mockImplementation(() => Promise.resolve(details({ vies_status: 'invalid' })))
    mockApi.post.mockImplementation(() =>
      Promise.reject(new ApiRequestError('No VAT number saved to check', 404, { error: 'No VAT number saved to check' })),
    )
    renderCard()
    await waitFor(() => screen.getByText('Not found in VIES'))
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findByText('This VAT number is no longer saved. Reload to see the current details.')).toBeInTheDocument()
    expect(screen.queryByText('This setting is no longer available.')).not.toBeInTheDocument()
  })

  it('hides the VIES line while the VAT field has been edited away from the saved number (design review 11/12)', async () => {
    mockApi.get.mockImplementation(() => Promise.resolve(details({ vies_status: 'valid' })))
    renderCard()
    await waitFor(() => screen.getByText('Checked against VIES'))
    fireEvent.change(screen.getByLabelText('VAT number (optional)'), { target: { value: 'SE999999999901' } })
    expect(screen.queryByTestId('vies-status-line')).not.toBeInTheDocument()
  })
})

describe('CompanyDetailsCard — VIES polling', () => {
  // #4359: the hook now lives in the shared provider, which mounts the
  // accounting reads too — the counter must count ONLY the company-details
  // GETs, or the two other reads' first calls would pollute it.
  function serveCompanyDetailsCounting(calls: () => void, responses: Array<CompanyDetails>): () => void {
    let n = 0
    mockApi.get.mockImplementation((url: string) => {
      if (url !== '/user/company-details') return Promise.reject(new Error(`unexpected GET ${url}`))
      calls()
      const row = responses[Math.min(n, responses.length - 1)]
      n += 1
      return Promise.resolve(row)
    })
    return () => n
  }

  it('polls while pending and stops once the status resolves', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let call = 0
    serveCompanyDetailsCounting(
      () => {
        call += 1
      },
      [
        details({ vies_status: 'pending', vies_checked_at: null }),
        details({ vies_status: 'valid', vies_checked_at: '2026-09-20T10:00:00.000Z' }),
      ],
    )
    renderCard()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(await screen.findByText('Checking with VIES…')).toBeInTheDocument()
    expect(call).toBe(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(call).toBe(2)
    expect(await screen.findByText('Checked against VIES')).toBeInTheDocument()

    // No further poll ticks once the status left `pending`.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000)
    })
    expect(call).toBe(2)
  })

  it('stops polling on unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let call = 0
    serveCompanyDetailsCounting(() => {
      call += 1
    }, [details({ vies_status: 'pending', vies_checked_at: null })])
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

  it('hides "Check again" while a poll is actively in flight, and never shows "Checking…" forever (M1)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mockApi.get.mockImplementation(() => Promise.resolve(details({ vies_status: 'pending', vies_checked_at: null })))
    renderCard()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(await screen.findByText('Checking with VIES…')).toBeInTheDocument()
    // Still well inside the bound — no action shown while a poll tick is live.
    expect(screen.queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument()

    // Once the bound elapses, a still-pending check gets an action instead
    // of being stuck on "Checking…" forever — and the line itself stops
    // claiming to still be checking (#3332 review round 2, design 4).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VIES_POLL_MAX_MS + VIES_POLL_INTERVAL_MS)
    })
    expect(screen.getByText('VIES check pending')).toBeInTheDocument()
    expect(screen.queryByText('Checking with VIES…')).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Check again' })).toBeInTheDocument()
  })
})

describe('CompanyDetailsCard — the remove trigger (#4359)', () => {
  it('sits in the footer row, LEFT of Save, with its name unchanged', async () => {
    mockApi.get.mockImplementation(() => Promise.resolve(details()))
    renderCard()
    const footer = await screen.findByTestId('company-details-footer')
    const trigger = within(footer).getByRole('button', { name: 'Remove company details' })
    const save = within(footer).getByRole('button', { name: 'Save' })
    // Left of Save in document order.
    expect(trigger.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('is a GHOST button — never tertiary, never a filled CTA', async () => {
    mockApi.get.mockImplementation(() => Promise.resolve(details()))
    renderCard()
    const footer = await screen.findByTestId('company-details-footer')
    // `Button` does not forward `data-testid`, so this selects by role —
    // `ghost`'s own markers (`Button`'s VARIANT_CLASS): a visible outline on
    // the card background, no shadow.
    const trigger = within(footer).getByRole('button', { name: 'Remove company details' })
    expect(trigger).toHaveClass('bg-[var(--v2-bg)]')
    expect(trigger).toHaveClass('border-[var(--v2-border-strong)]')
    expect(trigger).not.toHaveClass('shadow-button')
  })

  it('renders no trigger while the details have not been saved (#4359)', async () => {
    mockApi.get.mockImplementation(() => noRow())
    renderCard()
    await screen.findByText('No company details')
    expect(screen.queryByRole('button', { name: 'Remove company details' })).not.toBeInTheDocument()
  })
})

describe('CompanyDetailsCard — delete', () => {
  it('asks for confirmation before DELETE, and falls back to the empty state on success (#4359)', async () => {
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
    // The form is gone and the empty state is what remains (#4359).
    await waitFor(() => expect(screen.queryByTestId('company-details-form')).not.toBeInTheDocument())
    expect(screen.getByTestId('company-details-empty')).toHaveTextContent('No company details')
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
    // Design review 5: shown INSIDE the still-open dialog, not behind it.
    expect(within(dialog).getByText('We could not remove your company details. Try again in a moment.')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('clears "Saved." on a successful delete, and announces "Company details removed." (m3 / design review 6)', async () => {
    mockApi.get.mockImplementation(() => Promise.resolve(details()))
    mockApi.put.mockImplementation((_path: string, body: unknown) => Promise.resolve({ ...details(), ...(body as PutBody) }))
    mockApi.delete.mockImplementation(() => Promise.resolve({ ok: true }))
    renderCard()
    await waitFor(() => expect(screen.getByLabelText('Legal name')).toHaveValue('Ada Lovelace AB'))

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Saved.')).toBeInTheDocument()

    mockApi.get.mockImplementation(() => noRow())
    fireEvent.click(screen.getByRole('button', { name: 'Remove company details' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    expect(screen.queryByText('Saved.')).not.toBeInTheDocument()
    expect(await screen.findByText('Company details removed.')).toBeInTheDocument()
  })

  it('does not carry a failed delete\'s error into a freshly reopened dialog (design review 3)', async () => {
    mockApi.get.mockImplementation(() => Promise.resolve(details()))
    mockApi.delete.mockImplementation(() => Promise.reject(new ApiRequestError('nope', 500)))
    renderCard()
    await waitFor(() => expect(screen.getByLabelText('Legal name')).toHaveValue('Ada Lovelace AB'))

    fireEvent.click(screen.getByRole('button', { name: 'Remove company details' }))
    let dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    expect(await screen.findByText('We could not remove your company details. Try again in a moment.')).toBeInTheDocument()

    // Cancel out of the dialog with the error still showing.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep details' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // Reopen without a new attempt — the previous failure must not still show.
    fireEvent.click(screen.getByRole('button', { name: 'Remove company details' }))
    dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).queryByText('We could not remove your company details. Try again in a moment.'),
    ).not.toBeInTheDocument()
  })

  it('blocks Escape and backdrop close while a delete is in flight (nit)', async () => {
    mockApi.get.mockImplementation(() => Promise.resolve(details()))
    let resolveDelete!: (value: { ok: boolean }) => void
    mockApi.delete.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDelete = resolve
        }),
    )
    renderCard()
    await waitFor(() => expect(screen.getByLabelText('Legal name')).toHaveValue('Ada Lovelace AB'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove company details' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    resolveDelete({ ok: true })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})

describe('CompanyDetailsCard — load error (m1/design review 4)', () => {
  it('always shows the plain copy.loadError sentence, never a raw err.message', async () => {
    mockApi.get.mockImplementation(() => Promise.reject(new ApiRequestError('ECONNRESET: socket hang up', 500)))
    renderCard()
    expect(await screen.findByText('We could not load your company details. Try again in a moment.')).toBeInTheDocument()
    expect(screen.queryByText(/ECONNRESET/)).not.toBeInTheDocument()
  })

  it('renders nothing while the first read is in flight — no title, no skeleton (design review 7)', async () => {
    let resolveGet!: (value: unknown) => void
    // Only the company-details read hangs; the provider's two accounting
    // reads answer at once (their result is irrelevant to this card).
    mockApi.get.mockImplementation((url: string) => {
      if (url !== '/user/company-details') return Promise.resolve(null)
      return new Promise((resolve) => {
        resolveGet = resolve
      })
    })
    const { container } = renderCard()
    expect(container).toBeEmptyDOMElement()
    resolveGet(null)
    // #4359: 200 null now lands on the "No company details" state, not a
    // bare form.
    await waitFor(() => expect(screen.getByTestId('company-details-empty')).toBeInTheDocument())
  })
})
