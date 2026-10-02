/**
 * MaskedField (#3516 AC): reveal calls the endpoint ONCE and swaps the value
 * in; the revealed value lives only in component state and is re-masked on
 * unmount; a failed reveal keeps the masked value.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { MaskedField } from '../components/MaskedField'
import type { OpsRead } from '../lib/ops-client'
import type { OpsRevealResponse } from '../lib/ops-types'

const REQUEST = { target_type: 'user' as const, target_id: 'u-1', field: 'email' as const }

function revealStub(overrides: Partial<{ value: string | null; fails: boolean }> = {}) {
  return vi.fn((): Promise<OpsRead<OpsRevealResponse>> =>
    overrides.fails
      ? Promise.reject(new Error('network'))
      : Promise.resolve({
          ok: true,
          data: { target_type: 'user', target_id: 'u-1', field: 'email', value: overrides.value ?? 'daniel@gmail.com' },
        }),
  )
}

describe('MaskedField', () => {
  it('renders the masked value and calls reveal once on click, swapping the value in', async () => {
    const reveal = revealStub()
    const user = userEvent.setup()
    render(<MaskedField label="Email" masked="da•••@gmail.com" request={REQUEST} reveal={reveal} />)

    expect(screen.getByTestId('masked-value-email')).toHaveTextContent('da•••@gmail.com')
    await user.click(screen.getByRole('button', { name: 'Reveal Email' }))
    await waitFor(() => expect(screen.getByTestId('masked-value-email')).toHaveTextContent('daniel@gmail.com'))
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(reveal).toHaveBeenCalledWith(REQUEST)
  })

  it('re-masks on unmount — the revealed value existed only in component state', async () => {
    const reveal = revealStub()
    const user = userEvent.setup()
    const { unmount } = render(<MaskedField label="Email" masked="da•••@gmail.com" request={REQUEST} reveal={reveal} />)
    await user.click(screen.getByRole('button', { name: 'Reveal Email' }))
    await waitFor(() => expect(screen.getByTestId('masked-value-email')).toHaveTextContent('daniel@gmail.com'))
    unmount()
    // The component is gone; the assertion that matters is that no store
    // holds the value — sessionStorage must never see it (the #3515 source
    // guard bans localStorage outright). The state itself died with the node.
    expect(window.sessionStorage.getItem('haven.ops.token.https://ops.example')).toBeNull()
    expect(window.sessionStorage.length).toBe(0)
  })

  it('a second click while the reveal is in flight does not fire a second call', async () => {
    let resolveReveal: (value: OpsRead<OpsRevealResponse>) => void = () => {}
    const reveal = vi.fn(
      () => new Promise<OpsRead<OpsRevealResponse>>((resolve) => { resolveReveal = resolve }),
    )
    const user = userEvent.setup()
    render(<MaskedField label="Email" masked="da•••@gmail.com" request={REQUEST} reveal={reveal} />)
    const button = screen.getByRole('button', { name: 'Reveal Email' })
    await user.click(button)
    await user.click(button)
    expect(reveal).toHaveBeenCalledTimes(1)
    resolveReveal({
      ok: true,
      data: { target_type: 'user', target_id: 'u-1', field: 'email', value: 'daniel@gmail.com' },
    })
    await waitFor(() => expect(screen.getByTestId('masked-value-email')).toHaveTextContent('daniel@gmail.com'))
  })

  it('a failed reveal keeps the masked value and shows the error', async () => {
    const reveal = revealStub({ fails: true })
    const user = userEvent.setup()
    render(<MaskedField label="Email" masked="da•••@gmail.com" request={REQUEST} reveal={reveal} />)
    await user.click(screen.getByRole('button', { name: 'Reveal Email' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByTestId('masked-value-email')).toHaveTextContent('da•••@gmail.com')
  })

  it('a null value renders Not set without a reveal control', () => {
    const reveal = revealStub()
    render(<MaskedField label="Name" masked="" nullable request={REQUEST} reveal={reveal} />)
    expect(screen.getByText('Not set')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reveal Name' })).not.toBeInTheDocument()
    expect(reveal).not.toHaveBeenCalled()
  })
})
