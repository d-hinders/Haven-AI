import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { HostedConnectCard } from '@/components/haven/HostedConnectCard'
import { buildAgentCredential } from '@/lib/agent-credential'
import type { HandoffInput } from '@/lib/agent-handoff'
import { HOSTED_CLIENT_REGISTRY, hasDeepLink } from '@/lib/hosted-connect'

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

/**
 * The tile's accessible name is the concatenation of the label, the chip
 * aria-label, and the tagline span — span boundaries don't introduce
 * spaces, so we anchor on the start of the string rather than on word
 * boundaries. Safe because no registry label is a prefix of another.
 */
function tabByLabel(label: string) {
  return screen.getByRole('tab', { name: new RegExp(`^${escapeRegExp(label)}`, 'i') })
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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

    // Every registered runtime should render as an unselected tile.
    for (const option of HOSTED_CLIENT_REGISTRY) {
      expect(tabByLabel(option.label)).toHaveAttribute('aria-selected', 'false')
    }
    expect(screen.queryByText('Signing key')).not.toBeInTheDocument()
    expect(screen.queryByText(/stays on your machine/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Save signing key/i })).not.toBeInTheDocument()
  })

  it('reveals the two-credential split with the custody label when a client is picked', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)

    fireEvent.click(tabByLabel('Claude Code'))

    expect(screen.getByRole('heading', { name: 'Connect' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Signing key' })).toBeInTheDocument()
    expect(screen.getByText(/stays on your machine/i)).toBeInTheDocument()
    expect(screen.getByText(/Haven never receives it/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Save signing key/i })).toBeInTheDocument()
  })

  it('never includes the delegate private key in the rendered card body for any runtime', () => {
    // Custody invariant — assert for every registry entry, not just the
    // pre-Tier-3 four. As we add runtimes this is the regression net.
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)

    for (const option of HOSTED_CLIENT_REGISTRY) {
      fireEvent.click(tabByLabel(option.label))
      const allText = document.body.textContent ?? ''
      expect(
        allText,
        `${option.label}: delegate key must not appear in card body`,
      ).not.toContain(DELEGATE_KEY)

      // For deep-link runtimes the API key is encoded inside the URL and
      // not rendered as visible text (until the user opens the fallback).
      // For everyone else, the bearer is visible in the snippet.
      if (!hasDeepLink(option.id)) {
        expect(
          allText,
          `${option.label}: api key (identity) should be present`,
        ).toContain(API_KEY)
      }
    }
  })

  // ── Tile grid ────────────────────────────────────────────────────────────

  it('renders every registered runtime as a tile', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)
    // 12 tiles today — assert exact count so we catch a tile dropping
    // accidentally from the registry.
    const tiles = screen.getAllByRole('tab')
    expect(tiles).toHaveLength(HOSTED_CLIENT_REGISTRY.length)
    for (const option of HOSTED_CLIENT_REGISTRY) {
      expect(tabByLabel(option.label)).toBeInTheDocument()
    }
  })

  it('shows a "1-click" badge on Cursor and VS Code tiles and not on the others', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)

    const cursorTile = tabByLabel('Cursor')
    const vscodeTile = tabByLabel('VS Code')
    const claudeCodeTile = tabByLabel('Claude Code')

    // The chip is rendered with aria-label="one-click install" so screen
    // readers announce it; assert against that, not text content.
    expect(cursorTile.querySelector('[aria-label="one-click install"]')).not.toBeNull()
    expect(vscodeTile.querySelector('[aria-label="one-click install"]')).not.toBeNull()
    expect(claudeCodeTile.querySelector('[aria-label="one-click install"]')).toBeNull()
  })

  // ── Deep-link clients ────────────────────────────────────────────────────

  it('Claude Desktop renders the JSON config directly (no broken deep-link button)', () => {
    // Anthropic has not shipped a real `claude://` URL handler, so the prior
    // "Add to Claude" button was a silent no-op. The tab drops straight to
    // the manual config-paste path.
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)
    fireEvent.click(tabByLabel('Claude Desktop'))

    expect(screen.queryByRole('button', { name: 'Add to Claude' })).not.toBeInTheDocument()
    expect(screen.getByText('json')).toBeInTheDocument()
  })

  it('Claude Desktop shows the OS-specific config-file paths inline', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)
    fireEvent.click(tabByLabel('Claude Desktop'))

    const allText = document.body.textContent ?? ''
    expect(allText).toContain('claude_desktop_config.json')
    expect(screen.getByText('macOS')).toBeInTheDocument()
    expect(screen.getByText('Windows')).toBeInTheDocument()
    expect(screen.getByText('Linux')).toBeInTheDocument()
  })

  it('Claude Code shows the restart-required hint under the snippet', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)
    fireEvent.click(tabByLabel('Claude Code'))

    const allText = document.body.textContent ?? ''
    expect(allText).toMatch(/exit this Claude Code session|MCP servers load at session start/i)
  })

  it('Cursor shows "Add to Cursor" deep-link button', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)
    fireEvent.click(tabByLabel('Cursor'))

    expect(screen.getByRole('button', { name: 'Add to Cursor' })).toBeInTheDocument()
    expect(screen.queryByText('json')).not.toBeInTheDocument()
  })

  it('VS Code shows "Add to VS Code" deep-link button', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)
    fireEvent.click(tabByLabel('VS Code'))

    expect(screen.getByRole('button', { name: 'Add to VS Code' })).toBeInTheDocument()
    // JSON config hidden by default — only the deep-link button is shown.
    expect(screen.queryByText('json')).not.toBeInTheDocument()
  })

  it('"Add to Cursor" opens a cursor:// deep link', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)
    fireEvent.click(tabByLabel('Cursor'))
    fireEvent.click(screen.getByRole('button', { name: 'Add to Cursor' }))

    expect(windowOpen).toHaveBeenCalledTimes(1)
    const [url] = windowOpen.mock.calls[0] as [string, string]
    expect(url).toMatch(/^cursor:\/\//)
    expect(url).not.toContain(DELEGATE_KEY)
  })

  it('"Add to VS Code" opens a vscode:mcp/install deep link carrying the bearer', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)
    fireEvent.click(tabByLabel('VS Code'))
    fireEvent.click(screen.getByRole('button', { name: 'Add to VS Code' }))

    expect(windowOpen).toHaveBeenCalledTimes(1)
    const [url] = windowOpen.mock.calls[0] as [string, string]
    expect(url).toMatch(/^vscode:mcp\/install\?/)
    expect(url).not.toContain(DELEGATE_KEY)
    // VS Code uses URL-encoded JSON (not base64) — decode and check the key.
    const queryMatch = url.match(/^vscode:mcp\/install\?(.+)$/)
    expect(queryMatch).not.toBeNull()
    const decoded = decodeURIComponent(queryMatch![1])
    expect(decoded).toContain(API_KEY)
  })

  it('"Didn\'t work? Show config" toggle reveals the JSON block for Cursor', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)
    fireEvent.click(tabByLabel('Cursor'))

    expect(screen.queryByText('json')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText(/Didn't work/i))
    expect(screen.getByText('json')).toBeInTheDocument()
    const allText = document.body.textContent ?? ''
    expect(allText).toContain(API_KEY)
    expect(allText).not.toContain(DELEGATE_KEY)
  })

  it('"Other / SDK" shows advanced <details> disclosure for the local-server path', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)
    fireEvent.click(tabByLabel('Other / SDK'))

    expect(screen.getByText(/Self-hosted \/ local server/i)).toBeInTheDocument()
  })

  // ── Destination-path block ───────────────────────────────────────────────

  it('renders the destination-path block with a Copy path button for runtimes that save to a file', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)
    fireEvent.click(tabByLabel('Cursor'))
    // Cursor's primary surface is the deep link — open the manual config
    // fallback to reach the destination-path block.
    fireEvent.click(screen.getByText(/Didn't work/i))

    expect(screen.getByLabelText(/where to save/i)).toBeInTheDocument()
    expect(screen.getByText('~/.cursor/mcp.json')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Copy path$/i })).toBeInTheDocument()
  })

  it('Copy path button writes the file path to the clipboard', async () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)
    // Continue.dev is a multi-path runtime (Global + Workspace) that drops
    // straight to the manual config path — no deep-link toggle needed.
    fireEvent.click(tabByLabel('Continue.dev'))

    const copyPath = screen.getAllByRole('button', { name: /^Copy path$/i })[0]
    fireEvent.click(copyPath)

    await waitFor(() => expect(clipboardWriteText).toHaveBeenCalled())
    const copied = clipboardWriteText.mock.calls[0][0] as string
    expect(copied).toMatch(/\.continue\/config\.yaml$/)
  })

  it('multi-path runtimes (Claude Desktop) render each OS path as a separate Copy row', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)
    fireEvent.click(tabByLabel('Claude Desktop'))

    // One Copy-path button per OS path — three total for Claude Desktop.
    const copyButtons = screen.getAllByRole('button', { name: /^Copy path$/i })
    expect(copyButtons.length).toBe(3)
  })

  it('Claude Code (CLI command, no file) does NOT render a destination-path block', () => {
    // The snippet IS the action — there's no file to paste into.
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)
    fireEvent.click(tabByLabel('Claude Code'))

    expect(screen.queryByLabelText(/where to save/i)).not.toBeInTheDocument()
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

    fireEvent.click(tabByLabel('Claude Code'))
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

    fireEvent.click(tabByLabel('Cursor'))
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

    fireEvent.click(tabByLabel('Claude Code'))
    // The snippet copy button visible text is just "Copy" — distinguishable
    // from "Copy path" rows by the exact-match regex. The signing-key copy
    // (section 2) also says "Copy", so we take the first match in DOM order,
    // which is the snippet block (rendered before section 2).
    fireEvent.click(screen.getAllByRole('button', { name: /^Copy$/i })[0])

    await waitFor(() => expect(clipboardWriteText).toHaveBeenCalledTimes(1))
    const copied = clipboardWriteText.mock.calls[0][0] as string
    expect(copied).toContain(API_KEY)
    expect(copied).not.toContain(DELEGATE_KEY)
    expect(onCredentialSaved).toHaveBeenCalled()
  })

  // ── Connected state ──────────────────────────────────────────────────────

  it('shows "Connected" badge and "last seen" banner when lastSeenAt is set', () => {
    const lastSeenAt = new Date(Date.now() - 5_000).toISOString()
    render(
      <HostedConnectCard
        credential={credential()}
        onSaveSigningKey={vi.fn()}
        lastSeenAt={lastSeenAt}
      />,
    )

    expect(screen.getByText('Connected')).toBeInTheDocument()
    expect(screen.getByRole('status', { name: /agent connected/i })).toBeInTheDocument()
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

    expect(screen.queryByRole('tablist', { name: /connect target/i })).not.toBeInTheDocument()
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

    expect(screen.queryByRole('tablist', { name: /connect target/i })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /show setup steps/i }))

    expect(screen.getByRole('tablist', { name: /connect target/i })).toBeInTheDocument()
    // After re-expanding, every registered runtime should be back.
    for (const option of HOSTED_CLIENT_REGISTRY) {
      expect(tabByLabel(option.label)).toBeInTheDocument()
    }
  })

  it('shows "Connect" badge (not "Connected") when lastSeenAt is absent', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)

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
    fireEvent.click(tabByLabel('Claude Code'))
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
      fireEvent.click(tabByLabel('Claude Code'))
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
      fireEvent.click(tabByLabel('Claude Code'))
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
      fireEvent.click(tabByLabel('Claude Code'))
      fireEvent.click(screen.getByRole('button', { name: /test connection/i }))

      await waitFor(() => {
        expect(screen.getByLabelText(/test connection result: couldn.t reach/i)).toBeInTheDocument()
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('clears the probe chip when the user switches client tabs', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as typeof fetch

    try {
      render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)
      fireEvent.click(tabByLabel('Claude Code'))
      fireEvent.click(screen.getByRole('button', { name: /test connection/i }))

      await waitFor(() => {
        expect(screen.getByLabelText(/test connection result: connected/i)).toBeInTheDocument()
      })

      fireEvent.click(tabByLabel('Cursor'))
      expect(screen.queryByLabelText(/test connection result/i)).not.toBeInTheDocument()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
