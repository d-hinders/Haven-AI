/**
 * `BackfillDialog` (#2868 / #2867): "feed from now" is the default and costs
 * no request; "include payments since" POSTs the strict `YYYY-MM-DD` the
 * route wants and nothing else; the three named refusals land inline.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '@/context/LocaleContext'
import { ApiRequestError } from '@/lib/api'
import { BackfillDialog, ISO_DATE } from '@/components/accounting/BackfillDialog'

vi.mock('@/hooks/useScrollEdgeCue', () => ({ useScrollEdgeCue: () => false }))

function renderDialog(onBackfill = vi.fn().mockResolvedValue({ feedFrom: '2026-01-01T00:00:00.000Z', fed: 2, total: 2 })) {
  const onClose = vi.fn()
  render(
    <LocaleProvider>
      <BackfillDialog open providerName="Fortnox" onClose={onClose} onBackfill={onBackfill} />
    </LocaleProvider>,
  )
  return { onClose, onBackfill }
}

const sinceRadio = () => screen.getByRole('radio', { name: /Include payments since/ })
const nowRadio = () => screen.getByRole('radio', { name: /Feed from now/ })
const dateField = () => screen.getByLabelText('Date (YYYY-MM-DD)')
const go = () => screen.getByRole('button', { name: 'Continue' })

describe('BackfillDialog', () => {
  it('explains what happens from now on, in the guardrail phrasing', () => {
    renderDialog()
    expect(screen.getByRole('dialog')).toHaveTextContent('Fortnox is connected.')
    expect(screen.getByRole('dialog')).toHaveTextContent('appear there with payment evidence attached; your accountant books them')
  })

  it('"Feed from now" is the default and closes without a request', () => {
    const { onClose, onBackfill } = renderDialog()
    expect(nowRadio()).toBeChecked()
    fireEvent.click(go())
    expect(onBackfill).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('"Not now" in the footer is a way out that behaves exactly like "Feed from now" — even with "since" chosen (#2903)', () => {
    const { onClose, onBackfill } = renderDialog()
    fireEvent.click(sinceRadio())
    fireEvent.change(dateField(), { target: { value: '2026-01-01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(onBackfill).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('the panel carries the test id a clip scopes to — not the role="dialog" wrapper', () => {
    renderDialog()
    const panel = screen.getByTestId('backfill-dialog')
    expect(panel).not.toHaveAttribute('role', 'dialog')
    expect(screen.getByRole('dialog')).toContainElement(panel)
  })

  it('"Include payments since" sends `since` as the exact YYYY-MM-DD the field holds, then reports how many were fed', async () => {
    const { onBackfill, onClose } = renderDialog()
    fireEvent.click(sinceRadio())
    fireEvent.change(dateField(), { target: { value: '2026-01-01' } })
    fireEvent.click(go())
    await waitFor(() => expect(onBackfill).toHaveBeenCalledTimes(1))
    const [since] = onBackfill.mock.calls[0] as [string]
    expect(since).toBe('2026-01-01')
    expect(since).toMatch(ISO_DATE)
    // #2915: the line counts PUSHED payments against the total enumerated —
    // here everything enumerated was pushed, so no remainder line appears.
    expect(await screen.findByRole('status')).toHaveTextContent('2 of 2 earlier payments fed.')
    expect(screen.getByRole('status')).not.toHaveTextContent('Some of the earlier payments')
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('when some enumerated payments were not pushed, the line says so and points at Sync now (#2915)', async () => {
    // The #2915 shape: two candidates enumerated, only one reached the ledger.
    renderDialog(vi.fn().mockResolvedValue({ feedFrom: '2026-01-01T00:00:00.000Z', fed: 1, total: 2 }))
    fireEvent.click(sinceRadio())
    fireEvent.change(dateField(), { target: { value: '2026-01-01' } })
    fireEvent.click(go())
    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('1 of 2 earlier payments fed.')
    expect(status).toHaveTextContent(
      'Some of the earlier payments were not fed. Press Sync now on the Accounting page to try them again.',
    )
  })

  it('typing a date selects "since" on its own', () => {
    renderDialog()
    fireEvent.change(dateField(), { target: { value: '2026-02-01' } })
    expect(sinceRadio()).toBeChecked()
  })

  it('"since" with no date is refused in the browser with the SINCE_INVALID sentence — no request', async () => {
    const { onBackfill } = renderDialog()
    fireEvent.click(sinceRadio())
    fireEvent.click(go())
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a past date as YYYY-MM-DD')
    expect(onBackfill).not.toHaveBeenCalled()
    // The date field is marked invalid and points at that sentence.
    expect(dateField()).toHaveAttribute('aria-invalid', 'true')
    expect(dateField()).toHaveAttribute('aria-describedby', screen.getByRole('alert').id)
    // Typing clears it.
    fireEvent.change(dateField(), { target: { value: '2026-01-01' } })
    expect(dateField()).not.toHaveAttribute('aria-invalid')
    expect(dateField()).not.toHaveAttribute('aria-describedby')
  })

  it.each([
    ['SINCE_INVALID', 'Enter a past date as YYYY-MM-DD, not before 2020-01-01.'],
    ['SINCE_NOT_EARLIER', 'That date is not earlier than what is already being fed.'],
    ['NOT_ACTIVE', 'not where payments are fed'],
  ])('a %s refusal surfaces inline and keeps the dialog open', async (code, sentence) => {
    const onBackfill = vi.fn().mockRejectedValue(new ApiRequestError('refused', 400, { error: 'refused', error_code: code }))
    const { onClose } = renderDialog(onBackfill)
    fireEvent.click(sinceRadio())
    fireEvent.change(dateField(), { target: { value: '2026-01-01' } })
    fireEvent.click(go())
    expect(await screen.findByRole('alert')).toHaveTextContent(sentence)
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(dateField()).toHaveValue('2026-01-01')
  })

  it('an unnamed failure gets the generic sentence', async () => {
    renderDialog(vi.fn().mockRejectedValue(new Error('boom')))
    fireEvent.click(sinceRadio())
    fireEvent.change(dateField(), { target: { value: '2026-01-01' } })
    fireEvent.click(go())
    expect(await screen.findByRole('alert')).toHaveTextContent('We could not include earlier payments')
  })
})
