/**
 * #1377 C: step 4's no-content-shift contract.
 *
 * Polling (`statusLoading` flips on every tick) must not change any rendered
 * text or the container's size, and every sub-state renders inside the one
 * ConnectStepShell silhouette. These tests drive a full poll cycle
 * (loading true → false → true) and assert the DOM is IDENTICAL across it.
 */
import { describe, expect, it } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { WaitingForConnector } from '../WaitingForConnector'
import { TerminalSetupState } from '../SetupStates'
import { FinalizingLocalSetup } from '../SetupStates'
import { ConnectStepShell } from '../ConnectStepShell'
import type { CreateSetupResponse } from '@/hooks/useAgentConnectionSetup'

const EXPIRES_AT = '2099-01-01T00:00:00.000Z'
const SETUP = {
  setup_id: 'setup-1',
  setup_prompt: 'npx @haven_ai/connect@alpha --token hv_setup_test',
  setup_token: 'hv_setup_test',
  expires_at: EXPIRES_AT,
  status: 'awaiting_connection',
  connector_command: 'npx @haven_ai/connect@alpha --token hv_setup_test',
} satisfies CreateSetupResponse

function renderWaiting(loading: boolean, connectionStalled = false) {
  return (
    <WaitingForConnector
      setup={SETUP}
      runtime="claude-code"
      copied={null}
      onCopy={() => {}}
      manualPathRevealed={false}
      onManualPathRevealedChange={() => {}}
      manualFallbackConfirmed={false}
      onManualFallbackConfirmedChange={() => {}}
      manualCredential={null}
      manualCredentialAcknowledged={false}
      manualCreating={false}
      manualError={null}
      onCreateManualCredential={() => {}}
      onContinueAfterManualCredential={() => {}}
      loading={loading}
      error={null}
      connectionStalled={connectionStalled}
      expiresAt={EXPIRES_AT}
      onCancel={() => {}}
    />
  )
}

describe('step 4 poll ticks cause no content shift (#1377 C)', () => {
  it('WaitingForConnector renders IDENTICAL text and structure across loading true → false → true', () => {
    const { container, rerender } = render(renderWaiting(true))
    const first = container.innerHTML
    expect(container.textContent).toContain('Waiting')
    expect(container.textContent).not.toContain('Checking')

    rerender(renderWaiting(false))
    expect(container.innerHTML).toBe(first)

    rerender(renderWaiting(true))
    expect(container.innerHTML).toBe(first)
  })

  it('WaitingForConnector states the auto-advance promise in the primary instruction block', () => {
    const { container } = render(renderWaiting(false))
    expect(container.textContent).toMatch(/advances this screen automatically/i)
  })

  it('offers stable, safe recovery only after Haven remains unconnected', () => {
    const onCopy = vi.fn()
    const onCancel = vi.fn()
    const props = {
      setup: SETUP,
      runtime: 'claude-code',
      copied: null,
      onCopy,
      manualPathRevealed: false,
      onManualPathRevealedChange: () => {},
      manualFallbackConfirmed: false,
      onManualFallbackConfirmedChange: () => {},
      manualCredential: null,
      manualCredentialAcknowledged: false,
      manualCreating: false,
      manualError: null,
      onCreateManualCredential: () => {},
      onContinueAfterManualCredential: () => {},
      loading: false,
      error: null,
      expiresAt: EXPIRES_AT,
      onCancel,
    }
    const { container, getByRole, rerender } = render(
      <WaitingForConnector {...props} connectionStalled={false} />,
    )
    const reserved = container.querySelector('.min-h-\\[216px\\].sm\\:min-h-\\[144px\\]')
    expect(reserved).not.toBeNull()
    expect(container.textContent).not.toContain('Haven has not received a connection yet')

    rerender(<WaitingForConnector {...props} connectionStalled />)
    expect(container.textContent).toContain('Haven has not received a connection yet')
    fireEvent.click(getByRole('button', { name: 'Copy local command' }))
    expect(onCopy).toHaveBeenCalledWith('command', SETUP.connector_command)
    fireEvent.click(getByRole('button', { name: 'Cancel this setup' }))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('FinalizingLocalSetup renders IDENTICAL text across a poll cycle', () => {
    const { container, rerender } = render(<FinalizingLocalSetup loading={true} />)
    const first = container.innerHTML
    expect(container.textContent).toContain('Finishing setup')
    expect(container.textContent).not.toContain('Checking')

    rerender(<FinalizingLocalSetup loading={false} />)
    expect(container.innerHTML).toBe(first)

    rerender(<FinalizingLocalSetup loading={true} />)
    expect(container.innerHTML).toBe(first)
  })
})

describe('ConnectStepShell (#1377 C)', () => {
  it('keeps one silhouette: progress header + reserved-height body in every phase', () => {
    const { container, rerender, getByLabelText } = render(
      <ConnectStepShell phase="waiting" stateKey="a">
        <p>body A</p>
      </ConnectStepShell>,
    )
    expect(getByLabelText('Connection progress').textContent).toBe('WaitingConnectedApproved')
    const reserved = container.querySelector('.min-h-\\[340px\\]')
    expect(reserved).not.toBeNull()

    // The header ticker is the SAME element set in every phase — forward
    // motion, not a new screen.
    rerender(
      <ConnectStepShell phase="connected" stateKey="b">
        <p>body B</p>
      </ConnectStepShell>,
    )
    expect(getByLabelText('Connection progress').textContent).toBe('WaitingConnectedApproved')
    rerender(
      <ConnectStepShell phase="approved" stateKey="c">
        <p>body C</p>
      </ConnectStepShell>,
    )
    expect(getByLabelText('Connection progress').textContent).toBe('WaitingConnectedApproved')
  })
})

describe('TerminalSetupState badge (#1377 review finding)', () => {
  it('shows the explicit badge label, not a word position-guessed from the title', () => {
    const { getByText } = render(
      <TerminalSetupState
        title="Setup prompt expired"
        badgeLabel="Expired"
        body="Create a new setup prompt."
        tone="warning"
        primaryLabel="Create a new setup"
        secondaryLabel="Close"
        onPrimary={() => {}}
        onSecondary={() => {}}
      />,
    )
    expect(getByText('Expired')).toBeTruthy()
    // The old derivation rendered the nonsense word "prompt" here.
    expect(() => getByText('prompt')).toThrow()
  })
})
