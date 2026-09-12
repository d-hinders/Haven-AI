/**
 * `ConnectionSettings` (#2868 / #2867): the form round-trips
 * `suggested_account` + `auto_feed` as the route's snake_case PATCH body, and
 * every refusal lands INLINE beside the form — the 400 `INVALID_SETTING`
 * with its `key`, the client-side shape check, and the generic failure.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '@/context/LocaleContext'
import { ApiRequestError } from '@/lib/api'
import { ConnectionSettings, isValidSuggestedAccount } from '@/components/accounting/ConnectionSettings'
import { connection } from './fixtures'

function renderSettings(onSave = vi.fn().mockResolvedValue(connection()), conn = connection()) {
  render(
    <LocaleProvider>
      <ConnectionSettings connection={conn} onSave={onSave} />
    </LocaleProvider>,
  )
  return onSave
}

const accountField = () => screen.getByLabelText('Suggested account')
const autoFeed = () => screen.getByRole('checkbox', { name: /Feed settled payments automatically/ })
const save = () => screen.getByRole('button', { name: 'Save' })

describe('isValidSuggestedAccount', () => {
  it('Fortnox takes a four-digit BAS account 1000–8999, or nothing', () => {
    for (const ok of ['', '  ', '1000', '6540', '8999']) expect([ok, isValidSuggestedAccount('fortnox', ok)]).toEqual([ok, true])
    for (const bad of ['65', '0540', '9000', '65400', 'abcd', '6540a']) expect([bad, isValidSuggestedAccount('fortnox', bad)]).toEqual([bad, false])
  })
  it('another provider takes up to 32 characters', () => {
    expect(isValidSuggestedAccount('light', 'x'.repeat(32))).toBe(true)
    expect(isValidSuggestedAccount('light', 'x'.repeat(33))).toBe(false)
  })
})

describe('ConnectionSettings', () => {
  it('seeds the form from the connection and explains that the account is a hint, not a booking', () => {
    renderSettings(undefined, connection({ settings: { suggestedAccount: '6540', autoFeed: false } }))
    expect(accountField()).toHaveValue('6540')
    expect(autoFeed()).not.toBeChecked()
    expect(screen.getByText(/It only suggests — it never books/)).toBeInTheDocument()
  })

  it('round-trips: Save sends the snake_case patch and shows Saved', async () => {
    const onSave = renderSettings()
    fireEvent.change(accountField(), { target: { value: ' 6540 ' } })
    fireEvent.click(autoFeed())
    fireEvent.click(save())
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ suggested_account: '6540', auto_feed: false }))
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('an emptied account is sent as null (clear), not as ""', async () => {
    const onSave = renderSettings(undefined, connection({ settings: { suggestedAccount: '6540', autoFeed: true } }))
    fireEvent.change(accountField(), { target: { value: '' } })
    fireEvent.click(save())
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ suggested_account: null, auto_feed: true }))
  })

  it('a malformed account is refused in the browser — inline, and nothing is sent', async () => {
    const onSave = renderSettings()
    fireEvent.change(accountField(), { target: { value: '65' } })
    fireEvent.click(save())
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a four-digit account between 1000 and 8999')
    expect(onSave).not.toHaveBeenCalled()
    // The field is marked invalid for assistive tech and points at the error AND its helper.
    expect(accountField()).toHaveAttribute('aria-invalid', 'true')
    const describedBy = accountField().getAttribute('aria-describedby') ?? ''
    expect(describedBy).toContain(screen.getByRole('alert').id)
    expect(describedBy).toContain(screen.getByText(/It only suggests — it never books/).id)
  })

  it('validates on blur and submit, not on every keystroke: "65" on the way to "6540" is not red (#2903)', () => {
    renderSettings()
    // Idle: described by the helper, not invalid.
    expect(accountField()).not.toHaveAttribute('aria-invalid')
    expect(accountField()).toHaveAttribute('aria-describedby', screen.getByText(/It only suggests — it never books/).id)

    fireEvent.change(accountField(), { target: { value: '65' } })
    expect(accountField()).not.toHaveAttribute('aria-invalid')

    fireEvent.blur(accountField())
    expect(accountField()).toHaveAttribute('aria-invalid', 'true')

    // Once shown, it clears the moment the value is valid — no second blur needed.
    fireEvent.change(accountField(), { target: { value: '6540' } })
    expect(accountField()).not.toHaveAttribute('aria-invalid')
  })

  it('a 400 INVALID_SETTING from the route surfaces inline, naming the key, and keeps the draft', async () => {
    const onSave = vi.fn().mockRejectedValue(
      new ApiRequestError('auto_feed must be a boolean', 400, {
        error: 'auto_feed must be a boolean',
        error_code: 'INVALID_SETTING',
        key: 'auto_feed',
      }),
    )
    renderSettings(onSave)
    fireEvent.change(accountField(), { target: { value: '4010' } })
    fireEvent.click(save())
    expect(await screen.findByRole('alert')).toHaveTextContent('auto_feed was not accepted')
    expect(accountField()).toHaveValue('4010')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('a 400 INVALID_SETTING on suggested_account uses the account sentence', async () => {
    const onSave = vi.fn().mockRejectedValue(
      new ApiRequestError('bad', 400, { error: 'bad', error_code: 'INVALID_SETTING', key: 'suggested_account' }),
    )
    renderSettings(onSave)
    fireEvent.change(accountField(), { target: { value: '6540' } })
    fireEvent.click(save())
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a four-digit account between 1000 and 8999')
  })

  it('any other failure is the generic sentence', async () => {
    renderSettings(vi.fn().mockRejectedValue(new Error('network')))
    fireEvent.click(save())
    expect(await screen.findByRole('alert')).toHaveTextContent('We could not save these settings')
  })
})
