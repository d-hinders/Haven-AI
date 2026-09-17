/**
 * `ApiKeyConnectModal` (#3017): the paste flow for an `api_key` provider.
 *
 * The contract pinned here, per state:
 * - the rendered steps carry the EXACT scope identifiers (`companies:read`,
 *   `documents:write`) and the dashboard path, interpolated from
 *   `accounted-copy.ts` — a drifted copy spelling is a support bug (the user
 *   mis-ticks scopes and is refused at the first feed), so the sentences are
 *   pinned to the tokens, not to the copy's own constants;
 * - the empty submit is refused locally (`API_KEY_REQUIRED`, no request);
 * - each route `error_code` gets its own sentence, inline, field intact;
 * - an unnamed failure gets the generic sentence;
 * - success closes the modal;
 * - the lifecycle rules: `type="password"`, cleared on close, the in-flight
 *   flag reset on reopen — a secret never survives a close.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '@/context/LocaleContext'
import { ApiRequestError } from '@/lib/api'
import { ApiKeyConnectModal, API_KEY_MODAL_TEST_ID } from '@/components/accounting/ApiKeyConnectModal'
import {
  ACCOUNTED_DASHBOARD_KEYS_URL,
  ACCOUNTED_DASHBOARD_PATH,
  ACCOUNTED_SCOPE_COMPANIES_READ,
  ACCOUNTED_SCOPE_DOCUMENTS_WRITE,
} from '@/components/accounting/accounted-copy'

vi.mock('@/hooks/useScrollEdgeCue', () => ({ useScrollEdgeCue: () => false }))

function renderModal(onConnect = vi.fn().mockResolvedValue(undefined)) {
  const onClose = vi.fn()
  render(
    <LocaleProvider>
      <ApiKeyConnectModal open providerName="Accounted" onClose={onClose} onConnect={onConnect} />
    </LocaleProvider>,
  )
  return { onClose, onConnect }
}

const keyField = () => screen.getByLabelText('API key')
/** The footer's submit — `^Connect$` so it never matches "Connect with API key" or "Connecting…". */
const submit = () => screen.getByRole('button', { name: /^Connect$/ })
const dialog = () => screen.getByRole('dialog')
const panel = () => screen.getByTestId(API_KEY_MODAL_TEST_ID)

describe('ApiKeyConnectModal', () => {
  it('renders the dashboard steps with the EXACT scope tokens and the keys path', () => {
    renderModal()
    expect(dialog()).toHaveTextContent(/Connect Accounted with an API key/)
    // The two scope identifiers, verbatim, from the copy module — the same
    // source the backend's key-creation page uses.
    expect(dialog()).toHaveTextContent(new RegExp(ACCOUNTED_SCOPE_COMPANIES_READ.replace(':', '\\:')))
    expect(dialog()).toHaveTextContent(new RegExp(ACCOUNTED_SCOPE_DOCUMENTS_WRITE.replace(':', '\\:')))
    expect(dialog()).toHaveTextContent(new RegExp(ACCOUNTED_DASHBOARD_PATH.replace('/', '/')))
    // Step 1 links to the dashboard keys page (new tab — the user leaves Haven only to mint the key).
    const link = screen.getByRole('link', { name: new RegExp(ACCOUNTED_DASHBOARD_PATH.replace('/', '/')) })
    expect(link).toHaveAttribute('href', ACCOUNTED_DASHBOARD_KEYS_URL)
    expect(link).toHaveAttribute('target', '_blank')
    // The revoke note says where revocation really happens (#3017).
    expect(dialog()).toHaveTextContent(/revoke the key in your Accounted dashboard/)
  })

  it('masks the key: type="password", never rendered back, autocomplete off', () => {
    renderModal()
    expect(keyField()).toHaveAttribute('type', 'password')
    expect(keyField()).toHaveAttribute('autocomplete', 'off')
  })

  it('an empty submit is refused locally with the API_KEY_REQUIRED sentence — no request', async () => {
    const { onConnect } = renderModal()
    fireEvent.click(submit())
    expect(await screen.findByRole('alert')).toHaveTextContent('Paste the API key from your Accounted dashboard first.')
    expect(onConnect).not.toHaveBeenCalled()
  })

  it.each([
    ['API_KEY_REQUIRED', 'Paste the API key from your Accounted dashboard first.'],
    ['INVALID_API_KEY', 'That key was not accepted. Check it and try again.'],
    ['MULTI_COMPANY_KEY', 'This key can see more than one company.'],
    ['UNSUPPORTED_BASE_CURRENCY', 'books in a currency Haven does not feed'],
  ])('a %s refusal surfaces its own sentence inline and keeps the modal open with the field intact', async (code, sentence) => {
    const onConnect = vi.fn().mockRejectedValue(
      new ApiRequestError('refused', code === 'MULTI_COMPANY_KEY' || code === 'UNSUPPORTED_BASE_CURRENCY' ? 409 : 400, {
        error: 'refused',
        error_code: code,
      }),
    )
    const { onClose } = renderModal(onConnect)
    fireEvent.change(keyField(), { target: { value: 'gnubok_sk_test_abc' } })
    fireEvent.click(submit())
    expect(await screen.findByRole('alert')).toHaveTextContent(sentence)
    expect(onClose).not.toHaveBeenCalled()
    expect(dialog()).toBeInTheDocument()
    expect(keyField()).toHaveValue('gnubok_sk_test_abc')
  })

  it('a failure without a known error_code gets the generic sentence', async () => {
    renderModal(vi.fn().mockRejectedValue(new ApiRequestError('boom', 500, {})))
    fireEvent.change(keyField(), { target: { value: 'k' } })
    fireEvent.click(submit())
    expect(await screen.findByRole('alert')).toHaveTextContent('We could not connect. Try again in a moment.')
  })

  it('a plain (non-API) failure gets the generic sentence too', async () => {
    renderModal(vi.fn().mockRejectedValue(new Error('network down')))
    fireEvent.change(keyField(), { target: { value: 'k' } })
    fireEvent.click(submit())
    expect(await screen.findByRole('alert')).toHaveTextContent('We could not connect. Try again in a moment.')
  })

  it('sends the trimmed key, then closes on success', async () => {
    const { onConnect, onClose } = renderModal()
    fireEvent.change(keyField(), { target: { value: '  gnubok_sk_test_abc  ' } })
    fireEvent.click(submit())
    await waitFor(() => expect(onConnect).toHaveBeenCalledWith('gnubok_sk_test_abc'))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('the busy submit is disabled and relabelled while connecting', async () => {
    let resolveConnect: (() => void) | undefined
    renderModal(
      vi.fn().mockImplementation(
        () => new Promise<void>((resolve) => {
          resolveConnect = resolve
        }),
      ),
    )
    fireEvent.change(keyField(), { target: { value: 'k' } })
    fireEvent.click(submit())
    expect(await screen.findByRole('button', { name: 'Connecting…' })).toBeDisabled()
    resolveConnect?.()
    await waitFor(() => expect(submit()).toBeEnabled())
  })

  it('clears the secret on close, so a reopen starts empty', () => {
    const { rerender } = render(
      <LocaleProvider>
        <ApiKeyConnectModal open providerName="Accounted" onClose={vi.fn()} onConnect={vi.fn()} />
      </LocaleProvider>,
    )
    fireEvent.change(keyField(), { target: { value: 'gnubok_sk_test_secret' } })
    rerender(
      <LocaleProvider>
        <ApiKeyConnectModal open={false} providerName="Accounted" onClose={vi.fn()} onConnect={vi.fn()} />
      </LocaleProvider>,
    )
    rerender(
      <LocaleProvider>
        <ApiKeyConnectModal open providerName="Accounted" onClose={vi.fn()} onConnect={vi.fn()} />
      </LocaleProvider>,
    )
    expect(keyField()).toHaveValue('')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('resets the in-flight flag on reopen, so an interrupted submit cannot busy-lock the next open', async () => {
    const never = vi.fn().mockImplementation(() => new Promise<void>(() => {}))
    const { rerender } = render(
      <LocaleProvider>
        <ApiKeyConnectModal open providerName="Accounted" onClose={vi.fn()} onConnect={never} />
      </LocaleProvider>,
    )
    fireEvent.change(keyField(), { target: { value: 'k' } })
    fireEvent.click(submit())
    expect(await screen.findByRole('button', { name: 'Connecting…' })).toBeDisabled()
    // Close mid-flight, then reopen: the footer must not stay stuck busy.
    rerender(
      <LocaleProvider>
        <ApiKeyConnectModal open={false} providerName="Accounted" onClose={vi.fn()} onConnect={never} />
      </LocaleProvider>,
    )
    rerender(
      <LocaleProvider>
        <ApiKeyConnectModal open providerName="Accounted" onClose={vi.fn()} onConnect={vi.fn().mockResolvedValue(undefined)} />
      </LocaleProvider>,
    )
    expect(screen.getByRole('button', { name: /^Connect$/ })).toBeEnabled()
  })

  it('the panel carries the test id a clip scopes to — not the role="dialog" wrapper', () => {
    renderModal()
    expect(panel()).not.toHaveAttribute('role', 'dialog')
    expect(dialog()).toContainElement(panel())
  })
})
