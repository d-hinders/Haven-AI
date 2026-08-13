/**
 * #1377 C: step 4's no-content-shift contract.
 *
 * Polling (`statusLoading` flips on every tick) must not change any rendered
 * text or the container's size, and every sub-state renders inside the one
 * ConnectStepShell silhouette. These tests drive a full poll cycle
 * (loading true → false → true) and assert the DOM is IDENTICAL across it.
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { WaitingForConnector } from '../WaitingForConnector'
import { FinalizingLocalSetup } from '../SetupStates'
import { ConnectStepShell } from '../ConnectStepShell'

const EXPIRES_AT = '2099-01-01T00:00:00.000Z'
const SETUP = {
  setup_id: 'setup-1',
  setup_prompt: 'npx @haven_ai/connect@alpha --token hv_setup_test',
  setup_token: 'hv_setup_test',
  expires_at: EXPIRES_AT,
  status: 'awaiting_connection',
} as never

function renderWaiting(loading: boolean) {
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
