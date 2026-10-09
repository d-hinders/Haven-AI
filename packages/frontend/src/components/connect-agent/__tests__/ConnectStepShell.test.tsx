/**
 * #1377 C: step 3's no-content-shift contract.
 *
 * Polling (`statusLoading` flips on every tick) must not change any rendered
 * text or the container's size, and every sub-state renders inside the one
 * ConnectStepShell silhouette. These tests drive a full poll cycle
 * (loading true → false → true) and assert the DOM is IDENTICAL across it.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, within } from '@testing-library/react'
import { WaitingForConnector } from '../WaitingForConnector'
import { TerminalSetupState } from '../SetupStates'
import { ConnectStepShell } from '../ConnectStepShell'
import type { CopyKind, CreateSetupResponse, ManualCredential } from '@/hooks/useAgentConnectionSetup'
import type { AwaitingConnectionStage } from '@/hooks/useAgentConnectionSetupStatus'

const EXPIRES_AT = '2099-01-01T00:00:00.000Z'
const SETUP = {
  setup_id: 'setup-1',
  setup_prompt: 'npx @haven_ai/connect@alpha --token hv_setup_test',
  setup_token: 'hv_setup_test',
  expires_at: EXPIRES_AT,
  status: 'awaiting_connection',
  connector_command: 'npx @haven_ai/connect@alpha --token hv_setup_test',
  // #2522: REQUIRED on the create response, mirroring the backend. Required
  // rather than optional for the same reason `connector_package` is — an
  // optional field pushes a URL-assembling fallback back into every client —
  // and the cost of that choice is exactly this: every fixture standing in for
  // a real create response has to carry it, which is the type system saying
  // the contract is real.
  approval_url: 'https://app.example.test/agents?setup=setup-1',
  // #2422: the spec on its own, mirroring what the backend now returns.
  connector_package: '@haven_ai/connect@alpha',
} satisfies CreateSetupResponse

function renderWaiting(
  loading: boolean,
  connectionStage: AwaitingConnectionStage = 'starting',
  onCancel: () => void = () => {},
  // #3832: most of these tests are about the status slot, which only carries
  // the stage words once the prompt is out — so they default to "copied".
  promptCopied = true,
  extra: { copied?: CopyKind | null; keyMadeInBrowser?: boolean; onCopy?: (k: CopyKind, v: string) => void } = {},
) {
  return (
    <WaitingForConnector
      setup={SETUP}
      runtime="claude-code"
      copied={extra.copied ?? null}
      promptCopied={promptCopied}
      keyMadeInBrowser={extra.keyMadeInBrowser ?? false}
      onCopy={extra.onCopy ?? (() => {})}
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

describe('step 3 poll ticks cause no content shift (#1377 C)', () => {
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

  it('WaitingForConnector states the auto-advance promise in row 3 before the prompt is copied (#3832)', () => {
    // The promise used to live in the brand-soft callout #3832 removed. It is
    // kept, deliberately, as row 3's pending text: before the copy the user
    // still needs to know nothing else on this screen needs a click.
    const { container } = render(renderWaiting(false, 'starting', () => {}, false))
    const slot = container.querySelector('[aria-live="polite"]')
    expect(slot?.textContent).toMatch(/advances this screen automatically/i)
  })

  it('never renders the status slot empty, and the slow stage changes words only (#1399)', () => {
    // The reserved slot used to render EMPTY for the first minute — a
    // 144-216px void on every run. It now always carries a status line, and
    // crossing the 1-minute bound must not move anything below it.
    const { container, queryByRole, rerender } = render(renderWaiting(false, 'starting'))
    const slot = container.querySelector('[aria-live="polite"]')
    expect(slot).not.toBeNull()
    expect(slot?.textContent?.trim()).not.toBe('')
    expect(slot?.textContent).toMatch(/waiting for your agent to run the connector command/i)
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
        promptCopied={true}
        keyMadeInBrowser={true}
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
    // #3832: row 1 adds a third disclosure ("View the prompt") before the
    // copy; it is not part of this pair, so render the copied state, where
    // the footer's two are the only ones.
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
    // Server disclosure sits first — the first in the footer below the setup
    // steps (#3832) — and the trouble disclosure no longer carries the manual
    // path.
    expect(disclosures[0]).toBe(server)
    expect(disclosures[1]).toBe(trouble)
    expect(trouble!.textContent).not.toContain('Generate credentials')
    expect(server!.textContent).toContain('Generate credentials')
    // The label names an integration context, not a connection problem.
    expect(server!.textContent).toMatch(/server|hosted backend/i)
  })

  it('keeps the setup prompt before the server disclosure so the prompt keeps primacy (#2482)', () => {
    const { container } = render(renderWaiting(false, 'starting', () => {}, false))
    const html = container.innerHTML
    expect(html.indexOf('Copy setup prompt')).toBeGreaterThanOrEqual(0)
    expect(html.indexOf('Running in a server or hosted backend?')).toBeGreaterThan(
      html.indexOf('Copy setup prompt'),
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
    // #2927: the control is the promoted ui/SegmentedControl — radio
    // semantics (`aria-checked`), not buttons with `aria-pressed`.
    const envTab = getByRole('radio', { name: '.env' })
    expect(envTab.getAttribute('aria-checked')).toBe('true')
    for (const key of FIVE) expect(server.textContent).toContain(key)
    expect(getByRole('radio', { name: 'Agent workspace prompt' })).toBeDefined()

    // Switching to the prose format keeps all five values — no info dropped.
    fireEvent.click(getByRole('radio', { name: 'Agent workspace prompt' }))
    expect(envTab.getAttribute('aria-checked')).toBe('false')
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
      // #3832: recovery is timer-driven, never copy-driven — it must surface
      // even if row 1 was never marked copied, so this test runs uncopied.
      promptCopied: false,
      keyMadeInBrowser: false,
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
})


describe('one frame, one rhythm (#1392)', () => {
  it('the shell body carries the rhythm and distributes reserved slack — at the source', () => {
    const { container } = render(
      <ConnectStepShell stateKey="w">
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

describe('ConnectStepShell (#1377 C, #3832)', () => {
  it('keeps one silhouette — a reserved-height body — and renders no ticker of its own', () => {
    // #3832: the Waiting → Connected → Approved ticker is gone. The numbered
    // list is step 3's one progress signal (#1418), so the shell must not
    // bring a second one back.
    const { container, queryByLabelText, rerender } = render(
      <ConnectStepShell stateKey="a">
        <p>body A</p>
      </ConnectStepShell>,
    )
    expect(queryByLabelText('Connection progress')).toBeNull()
    expect(container.querySelector('.min-h-\\[340px\\]')).not.toBeNull()
    rerender(
      <ConnectStepShell stateKey="b">
        <p>body B</p>
      </ConnectStepShell>,
    )
    expect(container.querySelector('.min-h-\\[340px\\]')).not.toBeNull()
    expect(container.textContent).not.toMatch(/WaitingConnectedApproved/)
  })
})

describe('the numbered step list on the waiting screen (#3832)', () => {
  function rowStates(container: HTMLElement) {
    return Array.from(container.querySelectorAll('ol[aria-label="Connection steps"] > li')).map((li) =>
      li.getAttribute('data-step-state'),
    )
  }

  it('before a copy: one full-width primary, the prompt in a CLOSED disclosure, no instruction callout', () => {
    const { container, getAllByRole } = render(renderWaiting(false, 'starting', () => {}, false))
    expect(rowStates(container)).toEqual(['active', 'pending', 'pending'])
    // The only primary control on the screen is the copy action.
    const copy = getAllByRole('button', { name: /Copy setup prompt/ })
    expect(copy).toHaveLength(1)
    expect(copy[0].className).toContain('w-full')
    expect(copy[0].className).toContain('h-11')
    // jsdom has no layout engine, so a closed <details> does not hide its
    // children: assert the disclosure is CLOSED, which is what hides the
    // prompt in a browser (the e2e opens it before reading the text).
    const view = Array.from(container.querySelectorAll('details')).find((d) =>
      d.textContent?.includes('View the prompt'),
    )
    expect(view).toBeDefined()
    expect(view!.open).toBe(false)
    expect(view!.textContent).toContain(SETUP.setup_prompt)
    // The brand-soft callout and its heading are gone.
    expect(container.textContent).not.toContain('Connect your agent')
    // (The active row's marker uses brand-soft too, so match the callout's
    // own border, which nothing else on this screen carries.)
    expect(container.querySelector('[class*="border-brand/15"]')).toBeNull()
  })

  it('after a copy: row 1 done with Copy again, row 2 active, row 3 in flight inside the live region', () => {
    const onCopy = vi.fn()
    const { container, getByRole } = render(
      renderWaiting(false, 'starting', () => {}, true, { onCopy }),
    )
    expect(rowStates(container)).toEqual(['done', 'active', 'working'])
    expect(container.textContent).toContain('Prompt copied')
    fireEvent.click(getByRole('button', { name: 'Copy again' }))
    expect(onCopy).toHaveBeenCalledWith('prompt', SETUP.setup_prompt)
    const rows = container.querySelectorAll('ol[aria-label="Connection steps"] > li')
    const live = rows[2].querySelector('[aria-live="polite"]')
    expect(live?.textContent).toMatch(/waiting for your agent/i)
  })

  it('row 1 reads the LATCHED flag, never the single-valued `copied`', () => {
    // Copying the local command overwrites `copied` — the row must stay done.
    const done = render(renderWaiting(false, 'starting', () => {}, true, { copied: 'command' }))
    expect(rowStates(done.container)[0]).toBe('done')
    done.unmount()
    // ...and `copied === 'prompt'` alone does not tick it.
    const notYet = render(renderWaiting(false, 'starting', () => {}, false, { copied: 'prompt' }))
    expect(rowStates(notYet.container)[0]).toBe('active')
  })

  it('recovery surfaces even if the prompt was never marked copied', () => {
    const { container } = render(renderWaiting(false, 'recovery', () => {}, false))
    expect(container.textContent).toContain('Haven has not received a connection yet')
  })

  it('the trust line renders on the connector path only', () => {
    const TRUST = 'Your agent creates its own key on its machine. Haven only receives its public address.'
    const connector = render(renderWaiting(false, 'starting'))
    expect(connector.container.textContent).toContain(TRUST)
    connector.unmount()
    // The manual-credential path makes the key in this browser.
    const manual = render(renderWaiting(false, 'starting', () => {}, true, { keyMadeInBrowser: true }))
    expect(manual.container.textContent).not.toContain(TRUST)
  })

  it('moves keyboard focus to "Copy again" when the copy swaps the primary out', () => {
    const { getByRole, rerender } = render(renderWaiting(false, 'starting', () => {}, false))
    getByRole('button', { name: /Copy setup prompt/ }).focus()
    rerender(renderWaiting(false, 'starting', () => {}, true))
    expect(document.activeElement).toBe(getByRole('button', { name: 'Copy again' }))
  })

  it('marks exactly one row as the current step', () => {
    const { container } = render(renderWaiting(false, 'starting', () => {}, true))
    const current = container.querySelectorAll('[aria-current="step"]')
    expect(current).toHaveLength(1)
    expect(current[0].getAttribute('data-step-state')).toBe('active')
  })

  it('once server credentials exist, row 1 stops competing with "Continue to wallet approval" (#2482)', () => {
    const { container, getByRole } = render(
      <WaitingForConnector
        setup={SETUP}
        runtime="claude-code"
        copied={null}
        promptCopied={false}
        keyMadeInBrowser={true}
        onCopy={() => {}}
        manualCredential={{ apiKey: 'k', delegatePrivateKey: '0x1', delegateAddress: '0x2', prompt: 'p', env: 'e' }}
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
      />,
    )
    const copy = getByRole('button', { name: /Copy setup prompt/ })
    expect(copy.className).not.toContain('w-full')
    expect(getByRole('button', { name: 'Continue to wallet approval' }).className).toContain('w-full')
    const slot = container.querySelector('[aria-live="polite"]')
    expect(slot?.textContent).toMatch(/continue to wallet approval/i)
    expect(slot?.textContent).not.toMatch(/nothing else to click/i)
  })

  it('on the server-credential path, recovery never says "do not approve" — and one cancel remains', () => {
    // The recovery warning says "Do not approve the budget yet" and offers the
    // local command; on this path the next step IS continuing to wallet
    // approval, so the credential line replaces it at every stage.
    const { container, getByRole, queryByRole } = render(
      <WaitingForConnector
        setup={SETUP}
        runtime="claude-code"
        copied={null}
        promptCopied={true}
        keyMadeInBrowser={true}
        onCopy={() => {}}
        manualCredential={{ apiKey: 'k', delegatePrivateKey: '0x1', delegateAddress: '0x2', prompt: 'p', env: 'e' }}
        manualCredentialAcknowledged={false}
        manualCreating={false}
        manualError={null}
        onCreateManualCredential={() => {}}
        onContinueAfterManualCredential={() => {}}
        loading={false}
        error={null}
        connectionStage="recovery"
        expiresAt={EXPIRES_AT}
        onCancel={() => {}}
      />,
    )
    expect(container.textContent).not.toContain('Haven has not received a connection yet')
    expect(container.textContent).not.toMatch(/Do not approve the budget yet/)
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toMatch(/continue to wallet approval/i)
    // Exactly one cancel: the footer's, since the recovery block (which owns
    // "Cancel this setup" in recovery) is not shown.
    expect(getByRole('button', { name: 'Cancel setup' })).toBeTruthy()
    expect(queryByRole('button', { name: 'Cancel this setup' })).toBeNull()
  })

  it('names no agent client — any MCP client works (#3832 owner decision)', () => {
    const { container } = render(renderWaiting(false, 'starting', () => {}, false))
    const paste = container.querySelectorAll('ol[aria-label="Connection steps"] > li')[1]
    expect(within(paste as HTMLElement).getByText(/Any agent app that supports MCP/)).toBeTruthy()
    expect(paste.textContent).toContain('connector command')
    expect(paste.textContent).not.toMatch(/Claude|Cursor|ChatGPT|Codex/)
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
