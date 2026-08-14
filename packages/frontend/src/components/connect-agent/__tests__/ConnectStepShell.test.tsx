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
import type { AwaitingConnectionStage } from '@/hooks/useAgentConnectionSetupStatus'

const EXPIRES_AT = '2099-01-01T00:00:00.000Z'
const SETUP = {
  setup_id: 'setup-1',
  setup_prompt: 'npx @haven_ai/connect@alpha --token hv_setup_test',
  setup_token: 'hv_setup_test',
  expires_at: EXPIRES_AT,
  status: 'awaiting_connection',
  connector_command: 'npx @haven_ai/connect@alpha --token hv_setup_test',
} satisfies CreateSetupResponse

function renderWaiting(
  loading: boolean,
  connectionStage: AwaitingConnectionStage = 'starting',
  onCancel: () => void = () => {},
) {
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
      connectionStage={connectionStage}
      expiresAt={EXPIRES_AT}
      onCancel={onCancel}
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

  it('never renders the status slot empty, and the slow stage changes words only (#1399)', () => {
    // The reserved slot used to render EMPTY for the first minute — a
    // 144-216px void on every run. It now always carries a status line, and
    // crossing the 1-minute bound must not move anything below it.
    const { container, rerender } = render(renderWaiting(false, 'starting'))
    const slot = container.querySelector('[aria-live="polite"]')
    expect(slot).not.toBeNull()
    expect(slot?.textContent?.trim()).not.toBe('')
    expect(slot?.textContent).toMatch(/waiting for the agent to run the setup command/i)
    expect(container.textContent).not.toContain('Haven has not received a connection yet')

    const elementsBefore = container.querySelectorAll('*').length
    rerender(renderWaiting(false, 'slow'))

    expect(slot?.textContent).toMatch(/can take a minute or two/i)
    // Nothing but the sentence changed: same element count, same reserved
    // height, and still no recovery affordance offered.
    expect(container.querySelectorAll('*').length).toBe(elementsBefore)
    expect(slot?.className).toContain('min-h-16')
    expect(container.textContent).not.toContain('Haven has not received a connection yet')
    expect(container.querySelector('button[class*="min-h-11"]')).toBeNull()
  })

  it('keeps the manual-credential path nested INSIDE the trouble disclosure (#1391)', () => {
    // jsdom has no layout engine, so a closed <details> does not hide its
    // children: every existing manual-credential test clicks straight into
    // "Manual credential fallback" and would pass even if these two
    // disclosures were siblings. This asserts the ancestry directly, so an
    // accidental flattening — which would put the private-key path back at
    // the same depth as the harmless one — fails here rather than silently.
    const { container } = render(renderWaiting(false, 'starting'))
    const manual = container.querySelector('details details')
    expect(manual).not.toBeNull()
    expect(manual?.textContent).toContain('Manual credential fallback')
    expect(manual?.closest('details:not(details details)')?.textContent).toContain(
      'Having trouble connecting?',
    )
  })

  it('offers exactly one cancel at every stage (#1391)', () => {
    // starting/slow: the quiet footer link. recovery: the warning block's own
    // action, and the footer hides so the screen never offers the same exit
    // twice. No stage may leave the user with NO way out.
    const onCancel = vi.fn()

    for (const stage of ['starting', 'slow'] as const) {
      const { getByRole, queryByRole, unmount } = render(renderWaiting(false, stage, onCancel))
      expect(queryByRole('button', { name: 'Cancel this setup' })).toBeNull()
      fireEvent.click(getByRole('button', { name: 'Cancel setup' }))
      expect(onCancel).toHaveBeenCalled()
      onCancel.mockClear()
      unmount()
    }

    const { getByRole, queryByRole } = render(renderWaiting(false, 'recovery', onCancel))
    expect(queryByRole('button', { name: 'Cancel setup' })).toBeNull()
    fireEvent.click(getByRole('button', { name: 'Cancel this setup' }))
    expect(onCancel).toHaveBeenCalled()
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
      <WaitingForConnector {...props} connectionStage="starting" />,
    )
    const reserved = container.querySelector('.min-h-16.sm\\:min-h-11')
    expect(reserved).not.toBeNull()
    expect(container.textContent).not.toContain('Haven has not received a connection yet')

    rerender(<WaitingForConnector {...props} connectionStage="recovery" />)
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


describe('one frame, one rhythm (#1392)', () => {
  it('the shell body carries the rhythm and distributes reserved slack — at the source', () => {
    const { container } = render(
      <ConnectStepShell phase="waiting" stateKey="w">
        <p>block one</p>
        <p>block two</p>
      </ConnectStepShell>,
    )
    // gap-5 = the 20px rhythm fragment sub-states lost when #1380 replaced
    // the space-y-5 wrapper; flex-col + justify-center = short content sits
    // within the reserved floor instead of leaving slack under its button.
    const body = container.querySelector('.min-h-\\[340px\\]')
    expect(body).not.toBeNull()
    expect(body!.className).toContain('flex-col')
    expect(body!.className).toContain('gap-5')
    expect(body!.className).toContain('justify-center')
    // The floor itself is untouched — the silhouette guarantee from #1377
    // (asserted across phases below) still rests on min-h.
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
