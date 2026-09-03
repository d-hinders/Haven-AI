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
import type { CreateSetupResponse, ManualCredential } from '@/hooks/useAgentConnectionSetup'
import type { AwaitingConnectionStage } from '@/hooks/useAgentConnectionSetupStatus'

const EXPIRES_AT = '2099-01-01T00:00:00.000Z'
const SETUP = {
  setup_id: 'setup-1',
  setup_prompt: 'npx @haven_ai/connect@alpha --token hv_setup_test',
  setup_token: 'hv_setup_test',
  expires_at: EXPIRES_AT,
  status: 'awaiting_connection',
  connector_command: 'npx @haven_ai/connect@alpha --token hv_setup_test',
  // #2422: the spec on its own, mirroring what the backend now returns.
  connector_package: '@haven_ai/connect@alpha',
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
    const { container, queryByRole, rerender } = render(renderWaiting(false, 'starting'))
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
    // Assert the recovery ACTIONS are absent by name. This used to look for
    // `button[class*="min-h-11"]`, which was only ever a proxy: the recovery
    // block's two buttons happened to be the only min-h-11 controls on the
    // screen. #1391's design review put that class on the primary Copy button
    // too (44px touch target), and the proxy started reporting a recovery
    // affordance that was never rendered. Name what the test means.
    expect(queryByRole('button', { name: 'Copy local command' })).toBeNull()
    expect(queryByRole('button', { name: 'Cancel this setup' })).toBeNull()
  })

describe('server-side credential path (#2482)', () => {
  // #1391 deliberately nested the manual path one disclosure deeper than the
  // harmless one: "the dangerous route stays one click deeper than the
  // harmless one" was written when the path was only ever a fallback. #2482
  // lifts it to its own top-level disclosure — a server/hosted-backend
  // integration is a supported path, not a confession — while keeping the
  // setup prompt visually primary. jsdom has no layout engine, so a closed
  // <details> does not hide its children (DOM order is what is asserted here).

  const MANUAL = {
    apiKey: 'sk_agent_fixture',
    delegatePrivateKey:
      '0x1111111111111111111111111111111111111111111111111111111111111111',
    delegateAddress: '0x2222222222222222222222222222222222222222',
    prompt: [
      'Manual Haven credential for Research Agent',
      'HAVEN_API_KEY=sk_agent_fixture',
      'HAVEN_DELEGATE_KEY=0x1111111111111111111111111111111111111111111111111111111111111111',
      'HAVEN_DELEGATE_ADDRESS=0x2222222222222222222222222222222222222222',
      'HAVEN_API_URL=https://api.haven.example',
      'HAVEN_MCP_URL=https://mcp.haven.example',
    ].join('\n'),
    env: [
      'HAVEN_API_KEY=sk_agent_fixture',
      'HAVEN_DELEGATE_KEY=0x1111111111111111111111111111111111111111111111111111111111111111',
      'HAVEN_DELEGATE_ADDRESS=0x2222222222222222222222222222222222222222',
      'HAVEN_API_URL=https://api.haven.example',
      'HAVEN_MCP_URL=https://mcp.haven.example',
    ].join('\n'),
  } satisfies ManualCredential

  function renderWaitingWithManual() {
    return (
      <WaitingForConnector
        setup={SETUP}
        runtime="claude-code"
        copied={null}
        onCopy={() => {}}
        manualCredential={MANUAL}
        manualCredentialAcknowledged={false}
        manualCreating={false}
        manualError={null}
        onCreateManualCredential={() => {}}
        onContinueAfterManualCredential={() => {}}
        loading={false}
        error={null}
        connectionStage="starting"
        expiresAt={EXPIRES_AT}
        onCancel={() => {}}
      />
    )
  }

  function serverDisclosure(container: HTMLElement) {
    const found = Array.from(container.querySelectorAll('details')).find((d) =>
      d.textContent?.includes('Running in a server or hosted backend?'),
    )
    expect(found).toBeDefined()
    return found!
  }

  it('puts the credential path in its own TOP-LEVEL disclosure labeled for a backend integration, not the trouble disclosure (#2482)', () => {
    const { container } = render(renderWaiting(false, 'starting'))
    const disclosures = Array.from(container.querySelectorAll('details'))
    // Two sibling top-level disclosures, nothing nested at all.
    expect(disclosures).toHaveLength(2)
    const server = disclosures.find((d) =>
      d.textContent?.includes('Running in a server or hosted backend?'),
    )
    const trouble = disclosures.find((d) => d.textContent?.includes('Having trouble connecting?'))
    expect(server).toBeDefined()
    expect(trouble).toBeDefined()
    // The flattening the old nesting test pinned is now REQUIRED: no details
    // may be nested inside another.
    for (const d of disclosures) expect(d.querySelector('details')).toBeNull()
    // Server disclosure sits first — directly under the setup prompt — and
    // the trouble disclosure no longer carries the manual path.
    expect(disclosures[0]).toBe(server)
    expect(disclosures[1]).toBe(trouble)
    expect(trouble!.textContent).not.toContain('Generate credentials')
    expect(server!.textContent).toContain('Generate credentials')
    // The label names an integration context, not a connection problem.
    expect(server!.textContent).toMatch(/server|hosted backend/i)
  })

  it('keeps the setup prompt before the server disclosure so the prompt keeps primacy (#2482)', () => {
    const { container } = render(renderWaiting(false, 'starting'))
    const html = container.innerHTML
    expect(html.indexOf('>Setup prompt<')).toBeGreaterThanOrEqual(0)
    expect(html.indexOf('Running in a server or hosted backend?')).toBeGreaterThan(
      html.indexOf('>Setup prompt<'),
    )
  })

  it('offers the generate action directly in the open disclosure — one click, no reveal button, no warning panel, no acknowledgement gate (#2482)', () => {
    const { container, queryByRole } = render(renderWaiting(false, 'starting'))
    const server = serverDisclosure(container)
    const buttons = server.querySelectorAll('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].textContent).toBe('Generate credentials')
    // The gates are gone, not hidden: no checkbox, no warning headline, no
    // "I really can't run the connector" button anywhere on the screen.
    expect(queryByRole('checkbox')).toBeNull()
    expect(container.textContent).not.toContain('Before creating a manual credential')
    expect(container.textContent).not.toContain("I really can't run the connector")
    // The intro says what is about to be issued and that the key shows once.
    expect(server.textContent).toContain('shown once')
  })

  it('shows the .env block by default with the prose prompt behind the second format, same five values in both (#2482)', () => {
    const { container, getByRole } = render(renderWaitingWithManual())
    const server = serverDisclosure(container)
    const FIVE = [
      'HAVEN_API_KEY=',
      'HAVEN_DELEGATE_KEY=',
      'HAVEN_DELEGATE_ADDRESS=',
      'HAVEN_API_URL=',
      'HAVEN_MCP_URL=',
    ]
    // Default format is .env with the prose prompt available as the switch.
    const envTab = getByRole('button', { name: '.env' })
    expect(envTab.getAttribute('aria-pressed')).toBe('true')
    for (const key of FIVE) expect(server.textContent).toContain(key)
    expect(getByRole('button', { name: 'Agent workspace prompt' })).toBeDefined()

    // Switching to the prose format keeps all five values — no info dropped.
    fireEvent.click(getByRole('button', { name: 'Agent workspace prompt' }))
    expect(envTab.getAttribute('aria-pressed')).toBe('false')
    for (const key of FIVE) expect(server.textContent).toContain(key)
    expect(server.textContent).toContain('Manual Haven credential for Research Agent')
  })

  it('states key safety at the RESULT, beside the key, not before generation (#2482)', () => {
    const { container } = render(renderWaitingWithManual())
    const server = serverDisclosure(container)
    expect(server.textContent).toContain(
      'The signing key is shown once. If it leaks, replace it from the agent page.',
    )
    // The old pre-generation warning panel and its acknowledgement
    // checkbox are absent from the result state too.
    expect(container.textContent).not.toContain('Before creating a manual credential')
    expect(container.querySelector('[type="checkbox"]')).toBeNull()
    // The flow still offers the forward action once the credential is saved.
    expect(server.textContent).toContain('Continue to wallet approval')
  })
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
    // #1720: the connector can refuse locally (it cannot work out which agent
    // client to configure) and never contact Haven at all, so this is the only
    // screen that failure ever reaches. It must send the user to the connector
    // output that names the problem BEFORE telling them to re-run — a re-run
    // reproduces that refusal exactly.
    expect(container.textContent).toContain("Check the connector’s output first")
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
