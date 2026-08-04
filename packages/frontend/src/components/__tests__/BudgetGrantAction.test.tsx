import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import BudgetGrantAction from '../BudgetGrantAction'

const INPUT = {
  tokenAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const,
  recipientAddress: null,
  budgetAtomic: '5000000',
  periodSeconds: 86_400,
}

function renderAction(overrides: Partial<React.ComponentProps<typeof BudgetGrantAction>> = {}) {
  const grant = overrides.grant ?? vi.fn().mockResolvedValue({ ok: true })
  render(
    <BudgetGrantAction
      grant={grant}
      busy={false}
      ready
      input={INPUT}
      label="Approve budget"
      busyLabel="Waiting for signature…"
      {...overrides}
    />,
  )
  return { grant }
}

describe('BudgetGrantAction (#1073)', () => {
  it('grants with the caller-resolved input and reports success', async () => {
    const onGranted = vi.fn()
    const { grant } = renderAction({ onGranted })

    fireEvent.click(screen.getByRole('button', { name: 'Approve budget' }))

    await waitFor(() => expect(grant).toHaveBeenCalledWith(INPUT))
    await waitFor(() => expect(onGranted).toHaveBeenCalled())
  })

  it('a CANCELLED signature is not an error — neutral copy, control still live', async () => {
    // The single most common interaction: the passkey sheet is dismissed.
    // "Not yet" must never be dressed up as a failure.
    const grant = vi.fn().mockResolvedValue({ ok: false, reason: 'cancelled' })
    const onGranted = vi.fn()
    renderAction({ grant, onGranted })

    fireEvent.click(screen.getByRole('button', { name: 'Approve budget' }))

    const message = await screen.findByText(/No signature yet — nothing changed/)
    expect(message.className).not.toMatch(/danger/)
    expect(screen.getByRole('button', { name: 'Approve budget' })).toBeEnabled()
    expect(onGranted).not.toHaveBeenCalled()
  })

  it('a FAILED signature reads as an error and says nothing changed', async () => {
    const grant = vi.fn().mockResolvedValue({ ok: false, reason: 'failed' })
    renderAction({ grant })

    fireEvent.click(screen.getByRole('button', { name: 'Approve budget' }))

    const message = await screen.findByText(/could not set the budget/i)
    expect(message.className).toMatch(/danger/)
    expect(screen.getByRole('button', { name: 'Approve budget' })).toBeEnabled()
  })

  it('a retry clears the previous attempt’s outcome', async () => {
    const grant = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'cancelled' })
      .mockResolvedValueOnce({ ok: true })
    renderAction({ grant })

    fireEvent.click(screen.getByRole('button', { name: 'Approve budget' }))
    await screen.findByText(/No signature yet/)

    fireEvent.click(screen.getByRole('button', { name: 'Approve budget' }))
    await waitFor(() => expect(screen.queryByText(/No signature yet/)).not.toBeInTheDocument())
  })

  it('is disabled while busy, while not ready, and while the input is incomplete', () => {
    const { unmount } = render(
      <BudgetGrantAction
        grant={vi.fn()}
        busy
        ready
        input={INPUT}
        label="Approve budget"
        busyLabel="Waiting for signature…"
      />,
    )
    expect(screen.getByRole('button', { name: 'Waiting for signature…' })).toBeDisabled()
    unmount()

    renderAction({
      ready: false,
      notReadyHint: 'Connect the owner wallet.',
      // A blocked action must always offer a way out, never just a dead button.
      notReadyAction: <button type="button">Connect wallet</button>,
    })
    expect(screen.getByRole('button', { name: 'Approve budget' })).toBeDisabled()
    expect(screen.getByText('Connect the owner wallet.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeInTheDocument()

    renderAction({ input: null })
    expect(screen.getAllByRole('button', { name: 'Approve budget' })[1]).toBeDisabled()
  })

  it('is the ONLY grant implementation — both surfaces import it', () => {
    // The modal and the agent page must not drift apart on money authority.
    // If a surface stops importing this, it has grown its own copy.
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
    for (const surface of ['../DelegationBudgetCard.tsx', '../ConnectAgent2Modal.tsx']) {
      expect(read(surface), `${surface} must use the shared grant control`).toMatch(
        /import BudgetGrantAction from '\.\/BudgetGrantAction'/,
      )
    }
  })
})
