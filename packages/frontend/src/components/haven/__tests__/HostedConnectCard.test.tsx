import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { HostedConnectCard } from '@/components/haven/HostedConnectCard'
import { buildAgentCredential } from '@/lib/agent-credential'
import type { HandoffInput } from '@/lib/agent-handoff'

const API_KEY = 'sk_agent_TESTKEY_HOSTED_ONLY'
const DELEGATE_KEY = '0xPRIVATEKEY_MUST_NEVER_BE_IN_CONNECT_SNIPPET'

const BASE_INPUT: HandoffInput = {
  agent: {
    id: 'agt_test',
    name: 'Research Agent',
    delegateAddress: '0xaDA083091fAd5dE77370716b1BA7AC76C11f0b8b',
    safeAddress: '0xbf35beb0f587db2527b64e58d61f78bbf840860f',
    chainId: 100,
  },
  policy: {
    allowances: [{ tokenSymbol: 'USDC', amount: '25', resetPeriodMin: 1440 }],
  },
  credentials: {
    apiKey: API_KEY,
    delegatePrivateKey: DELEGATE_KEY,
  },
  apiBaseUrl: 'https://havenbackend.example',
  appBaseUrl: 'https://app.haven.example',
}

function credential() {
  return buildAgentCredential(BASE_INPUT).json
}

describe('HostedConnectCard', () => {
  const clipboardWriteText = vi.fn().mockResolvedValue(undefined)
  const windowOpen = vi.fn()

  beforeEach(() => {
    clipboardWriteText.mockClear()
    windowOpen.mockClear()
    Object.assign(navigator, { clipboard: { writeText: clipboardWriteText } })
    vi.stubGlobal('open', windowOpen)
  })

  it('lands with no client picked and the two-credential split hidden', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)

    expect(screen.getByText(/Connect Research Agent to where it runs/i)).toBeInTheDocument()

    for (const name of ['Claude Code', 'Claude Desktop', 'Cursor', 'Other / SDK']) {
      expect(screen.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'false')
    }
    expect(screen.queryByText('Signing key')).not.toBeInTheDocument()
    expect(screen.queryByText(/stays on your machine/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Save signing key/i })).not.toBeInTheDocument()
  })

  it('reveals the two-credential split with the custody label when a client is picked', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)

    fireEvent.click(screen.getByRole('tab', { name: 'Claude Code' }))

    expect(screen.getByRole('heading', { name: 'Connect' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Signing key' })).toBeInTheDocument()
    expect(screen.getByText(/stays on your machine/i)).toBeInTheDocument()
    expect(screen.getByText(/Haven never receives it/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Save signing key/i })).toBeInTheDocument()
  })

  it('never includes the delegate private key in the rendered card body (custody invariant)', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)

    for (const tab of ['Claude Code', 'Claude Desktop', 'Cursor', 'Other / SDK']) {
      fireEvent.click(screen.getByRole('tab', { name: tab }))
      const allText = document.body.textContent ?? ''
      expect(allText, `${tab}: delegate key must not appear in card body`).not.toContain(DELEGATE_KEY)

      // For Cursor (the only remaining deep-link client) the API key is
      // encoded inside the cursor:// URL, not rendered as visible text.
      // For Claude Code, Claude Desktop, and Other, the key appears in the
      // code block directly.
      if (tab !== 'Cursor') {
        expect(allText, `${tab}: api key (identity) should be present`).toContain(API_KEY)
      }
    }
  })

  // ── Deep-link clients ────────────────────────────────────────────────────

  it('Claude Desktop renders the JSON config directly (no broken deep-link button)', () => {
    // Anthropic has not shipped a real `claude://` URL handler, so the prior
    // "Add to Claude" button was a silent no-op. The tab now drops straight
    // to the manual config-paste path.
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Claude Desktop' }))

    expect(screen.queryByRole('button', { name: 'Add to Claude' })).not.toBeInTheDocument()
    expect(screen.getByText('json')).toBeInTheDocument()
  })

  it('Claude Desktop shows the OS-specific config-file paths inline', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Claude Desktop' }))

    const allText = document.body.textContent ?? ''
    expect(allText).toContain('claude_desktop_config.json')
    expect(screen.getByText('macOS')).toBeInTheDocument()
    expect(screen.getByText('Windows')).toBeInTheDocument()
    expect(screen.getByText('Linux')).toBeInTheDocument()
  })

  it('Claude Code shows the restart-required hint under the snippet', () => {
    // The running Claude Code session caches the MCP server list at startup,
    // so a successful `claude mcp add` doesn't surface tools until the user
    // restarts. The hint makes that explicit instead of silent.
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Claude Code' }))

    const allText = document.body.textContent ?? ''
    expect(allText).toMatch(/exit this Claude Code session|MCP servers load at session start/i)
  })

  it('Cursor shows "Add to Cursor" button', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Cursor' }))

    expect(screen.getByRole('button', { name: 'Add to Cursor' })).toBeInTheDocument()
    expect(screen.queryByText('json')).not.toBeInTheDocument()
  })

  it('"Add to Cursor" opens a cursor:// deep link', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Cursor' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add to Cursor' }))

    expect(windowOpen).toHaveBeenCalledTimes(1)
    const [url] = windowOpen.mock.calls[0] as [string, string]
    expect(url).toMatch(/^cursor:\/\//)
    expect(url).not.toContain(DELEGATE_KEY)
  })

  it('"Didn\'t work? Show config" toggle reveals the JSON block for Cursor', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Cursor' }))

    // Initially hidden
    expect(screen.queryByText('json')).not.toBeInTheDocument()

    // Click the toggle
    fireEvent.click(screen.getByText(/Didn't work/i))
    expect(screen.getByText('json')).toBeInTheDocument()
    const allText = document.body.textContent ?? ''
    expect(allText).toContain(API_KEY)
    expect(allText).not.toContain(DELEGATE_KEY)
  })

  it('"Other / SDK" shows advanced <details> disclosure for the local-server path', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Other / SDK' }))

    expect(screen.getByText(/Self-hosted \/ local server/i)).toBeInTheDocument()
  })

  // ── Save / Copy gates ────────────────────────────────────────────────────

  it('saving the signing key fires onSaveSigningKey + onCredentialSaved', () => {
    const onSave = vi.fn()
    const onCredentialSaved = vi.fn()
    render(
      <HostedConnectCard
        credential={credential()}
        onSaveSigningKey={onSave}
        onCredentialSaved={onCredentialSaved}
      />,
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Claude Code' }))
    fireEvent.click(screen.getByRole('button', { name: /Save signing key/i }))

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onCredentialSaved).toHaveBeenCalled()
  })

  it('clicking "Add to Cursor" fires onCredentialSaved', () => {
    const onCredentialSaved = vi.fn()
    render(
      <HostedConnectCard
        credential={credential()}
        onSaveSigningKey={vi.fn()}
        onCredentialSaved={onCredentialSaved}
      />,
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Cursor' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add to Cursor' }))

    expect(onCredentialSaved).toHaveBeenCalled()
  })

  it('copying the connect snippet writes the api_key but NOT the delegate key', async () => {
    const onCredentialSaved = vi.fn()
    render(
      <HostedConnectCard
        credential={credential()}
        onSaveSigningKey={vi.fn()}
        onCredentialSaved={onCredentialSaved}
      />,
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Claude Code' }))
    fireEvent.click(screen.getAllByRole('button', { name: /^Copy$/i })[0])

    await waitFor(() => expect(clipboardWriteText).toHaveBeenCalledTimes(1))
    const copied = clipboardWriteText.mock.calls[0][0] as string
    expect(copied).toContain(API_KEY)
    expect(copied).not.toContain(DELEGATE_KEY)
    expect(onCredentialSaved).toHaveBeenCalled()
  })

  // ── #189: Connected state ────────────────────────────────────────────────

  it('shows "Connected" badge and "last seen" banner when lastSeenAt is set', () => {
    const lastSeenAt = new Date(Date.now() - 5_000).toISOString() // 5s ago
    render(
      <HostedConnectCard
        credential={credential()}
        onSaveSigningKey={vi.fn()}
        lastSeenAt={lastSeenAt}
      />,
    )

    expect(screen.getByText('Connected')).toBeInTheDocument()
    expect(screen.getByRole('status', { name: /agent connected/i })).toBeInTheDocument()
    // "last seen Xs ago" is shown (exact text varies with timing)
    expect(screen.getByRole('status').textContent).toMatch(/last seen/i)
  })

  it('collapses setup steps when connected and shows "Try it" prompt', () => {
    const lastSeenAt = new Date(Date.now() - 5_000).toISOString()
    render(
      <HostedConnectCard
        credential={credential()}
        onSaveSigningKey={vi.fn()}
        lastSeenAt={lastSeenAt}
      />,
    )

    // Setup steps (client tabs) should be hidden
    expect(screen.queryByRole('tablist', { name: /connect target/i })).not.toBeInTheDocument()
    // "Try it" prompt is shown in the collapsed view
    expect(screen.getByText(/Try it/i)).toBeInTheDocument()
  })

  it('"Show setup" toggle re-expands the client picker when connected', () => {
    const lastSeenAt = new Date(Date.now() - 5_000).toISOString()
    render(
      <HostedConnectCard
        credential={credential()}
        onSaveSigningKey={vi.fn()}
        lastSeenAt={lastSeenAt}
      />,
    )

    // Initially collapsed
    expect(screen.queryByRole('tablist', { name: /connect target/i })).not.toBeInTheDocument()

    // Click the toggle
    fireEvent.click(screen.getByRole('button', { name: /show setup steps/i }))

    // Now the client picker is visible
    expect(screen.getByRole('tablist', { name: /connect target/i })).toBeInTheDocument()
    for (const name of ['Claude Code', 'Claude Desktop', 'Cursor', 'Other / SDK']) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument()
    }
  })

  it('shows "Connect" badge (not "Connected") when lastSeenAt is absent', () => {
    render(
      <HostedConnectCard
        credential={credential()}
        onSaveSigningKey={vi.fn()}
      />,
    )

    expect(screen.getByText('Connect')).toBeInTheDocument()
    expect(screen.queryByText('Connected')).not.toBeInTheDocument()
    expect(screen.queryByRole('status', { name: /agent connected/i })).not.toBeInTheDocument()
  })

  it('never exposes the delegate private key in the connected state', () => {
    const lastSeenAt = new Date(Date.now() - 5_000).toISOString()
    render(
      <HostedConnectCard
        credential={credential()}
        onSaveSigningKey={vi.fn()}
        lastSeenAt={lastSeenAt}
      />,
    )

    const allText = document.body.textContent ?? ''
    expect(allText).not.toContain(DELEGATE_KEY)
  })

  // ── Test connection ──────────────────────────────────────────────────────

  it('renders the "Test connection" button once a client is picked', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)

    expect(screen.queryByRole('button', { name: /test connection/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Claude Code' }))
    expect(screen.getByRole('button', { name: /test connection/i })).toBeInTheDocument()
  })

  it('shows a "Connected" chip with the tool count on a successful probe', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { tools: [{ name: 'haven_pay' }, { name: 'haven_get_agent' }] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ) as typeof fetch

    try {
      render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)
      fireEvent.click(screen.getByRole('tab', { name: 'Claude Code' }))
      fireEvent.click(screen.getByRole('button', { name: /test connection/i }))

      await waitFor(() => {
        const chip = screen.getByLabelText(/test connection result: connected/i)
        expect(chip.textContent).toMatch(/Connected/i)
        expect(chip.textContent).toMatch(/2 tools/)
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('shows a "Token rejected" chip when the probe returns 401', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response('', { status: 401 })) as typeof fetch

    try {
      render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)
      fireEvent.click(screen.getByRole('tab', { name: 'Claude Code' }))
      fireEvent.click(screen.getByRole('button', { name: /test connection/i }))

      await waitFor(() => {
        expect(screen.getByLabelText(/test connection result: token rejected/i)).toBeInTheDocument()
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('shows a "Couldn\'t reach" chip when fetch throws (CORS / DNS / offline)', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof fetch

    try {
      render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)
      fireEvent.click(screen.getByRole('tab', { name: 'Claude Code' }))
      fireEvent.click(screen.getByRole('button', { name: /test connection/i }))

      await waitFor(() => {
        expect(screen.getByLabelText(/test connection result: couldn.t reach/i)).toBeInTheDocument()
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('clears the probe chip when the user switches client tabs', async () => {
    // A stale "Connected" chip on a different client would be misleading —
    // the bearer is the same but the snippet/instructions are not.
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as typeof fetch

    try {
      render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)
      fireEvent.click(screen.getByRole('tab', { name: 'Claude Code' }))
      fireEvent.click(screen.getByRole('button', { name: /test connection/i }))

      await waitFor(() => {
        expect(screen.getByLabelText(/test connection result: connected/i)).toBeInTheDocument()
      })

      fireEvent.click(screen.getByRole('tab', { name: 'Cursor' }))
      expect(screen.queryByLabelText(/test connection result/i)).not.toBeInTheDocument()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
