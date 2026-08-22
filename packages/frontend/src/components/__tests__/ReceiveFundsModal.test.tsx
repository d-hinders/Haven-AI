import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserSafe } from '@/context/AuthContext'

vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,qr'),
  },
}))

vi.mock('@/hooks/useEscapeToClose', () => ({
  useEscapeToClose: vi.fn(),
}))

import ReceiveFundsModal from '@/components/ReceiveFundsModal'
import ComingSoonModal from '@/components/ComingSoonModal'
import AddFundsModal from '@/components/AddFundsModal'

/**
 * Every text node under `el`, joined with a space.
 *
 * NOT `el.textContent`, and the difference is load-bearing. `textContent`
 * concatenates across element boundaries with no separator, so a chain name at
 * the end of one element and the next element's copy fuse into one word:
 * "Probably Base" + "We can't confirm…" reads as `…ProbablyBaseWe…`, where
 * `\bBase\b` has no boundary to match. The M4 mutation in this suite's battery
 * did exactly that and SURVIVED against a `textContent` scan — a negative
 * assertion that could not fail, which is the defect #1844 warns about seen
 * from the other side (there a loose matcher fired on unrelated copy; here a
 * strict one could not fire at all).
 *
 * Joining text nodes restores a boundary at every element edge while leaving
 * each node intact, so "Based" stays one word and does not match `\bBase\b`.
 */
function textNodesJoined(el: HTMLElement): string {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const parts: string[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    parts.push(node.textContent ?? '')
  }
  return parts.join(' ')
}

const SAFE: UserSafe = {
  id: 'safe-id',
  safe_address: '0xa0e99A227fc546017Fd68D49711C1857208F0eB9',
  chain_id: 8453,
  name: 'Based',
  is_default: true,
  created_at: '2026-05-11T00:00:00Z',
}

describe('ReceiveFundsModal', () => {
  const originalClipboard = navigator.clipboard
  let writeText: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
  })

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: originalClipboard,
    })
  })

  it('shows the on-chain receive context, network, address, and supported tokens', () => {
    const onClose = vi.fn()

    render(<ReceiveFundsModal open safe={SAFE} onClose={onClose} />)

    expect(screen.getByRole('heading', { name: 'Receive funds' })).toBeInTheDocument()
    expect(screen.getByText('Based')).toBeInTheDocument()
    expect(screen.getAllByText('Base').length).toBeGreaterThan(0)
    expect(screen.getByText(SAFE.safe_address)).toBeInTheDocument()
    expect(screen.getByText('ETH')).toBeInTheDocument()
    expect(screen.getByText('USDC')).toBeInTheDocument()
    expect(screen.getByText('Before you send')).toBeInTheDocument()
    expect(screen.getByText('Use the Base network.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View on explorer' })).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()

    // #1852 — the PAIRED half of the unresolved-state negatives below. Without
    // this line, a mutation that renders the refusal unconditionally would still
    // satisfy every assertion in the unresolved tests. It is what makes those
    // absences mean "suppressed", not "never built".
    expect(screen.queryByRole('button', { name: 'Refresh page' })).not.toBeInTheDocument()
    expect(screen.queryByText(/can't confirm which network/)).not.toBeInTheDocument()
  })

  it('copies the receive address and can reveal a QR code', async () => {
    render(<ReceiveFundsModal open safe={SAFE} onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy address' }))

    expect(writeText).toHaveBeenCalledWith(SAFE.safe_address)
    expect(screen.getByRole('button', { name: 'Address copied' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show QR code' }))

    await waitFor(() => {
      expect(screen.getByAltText('QR code for Based on Base')).toBeInTheDocument()
    })
  })

  /**
   * #1852 — an unresolved chain must degrade, not crash, and must name no
   * network when it does.
   *
   * Two shapes, asserted identically because they ARE the same condition from
   * the user's side: `chain_id` absent, and `chain_id` present but outside the
   * frontend registry. `getChainConfig` threw for both.
   *
   * On the network negative: `\bBase\b`, case-sensitive, NOT `/Base/i`. The
   * fixture's own account name is "Based", and this suite renders `AddFundsModal`
   * with its "Coinbase" copy — a loose `/Base/i` matches both and would go red
   * on unrelated text, recording a pass for something it never tested (#1844's
   * mutation caught exactly that). Everything else here is role-based rather
   * than a text scan, for the same reason.
   */
  describe.each([
    ['a chain_id that is absent', { ...SAFE, chain_id: undefined as unknown as number }],
    ['a chain_id that is present but unregistered', { ...SAFE, chain_id: 999_999 }],
  ])('with %s', (_label, unresolvedSafe: UserSafe) => {
    it('renders without throwing and refuses to name a network or reveal an address', () => {
      // A1 — does not throw. Today's code takes the whole screen down through
      // the error boundary here; the throw is a distinguishable failure from an
      // assertion failing, which is what the issue asks to be checked.
      expect(() =>
        render(<ReceiveFundsModal open safe={unresolvedSafe} onClose={vi.fn()} />),
      ).not.toThrow()

      const dialog = screen.getByRole('dialog')

      // A2 — the dialog is actually on screen, so the negatives below are about
      // a rendered refusal and not about an empty tree.
      expect(screen.getByRole('heading', { name: 'Receive funds' })).toBeInTheDocument()

      // A3 — no network named anywhere in the dialog, word-anchored, over
      // text nodes rather than concatenated `textContent` (see the helper).
      const words = textNodesJoined(dialog)
      expect(words).not.toMatch(/\bBase\b/)
      expect(words).not.toMatch(/\bSepolia\b/)
      // …and the fixture name is still there, proving the anchor is doing work
      // rather than the string being empty: "Based" must NOT trip `\bBase\b`.
      expect(words).toMatch(/\bBased\b/)

      // A4 — no address, in any of the four ways this screen offers one.
      expect(screen.queryByText(SAFE.safe_address)).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Copy address' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Show QR code' })).not.toBeInTheDocument()
      expect(screen.queryByRole('link', { name: 'View on explorer' })).not.toBeInTheDocument()

      // A5 — no token list and no send instructions.
      expect(screen.queryByText('Before you send')).not.toBeInTheDocument()
      expect(screen.queryByText('USDC')).not.toBeInTheDocument()

      // A6 — it says so, and offers the one honest next action.
      expect(screen.getByText(/can't confirm which network this account uses/)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Refresh page' })).toBeInTheDocument()

      // A7 — the account is still identified. Deliberate: the refusal has to be
      // about something, and the name is true on every chain.
      expect(screen.getByText('Based')).toBeInTheDocument()
    })
  })
})

describe('ComingSoonModal', () => {
  it('explains Add funds is future on-ramp work and can route users to Receive', () => {
    const onClose = vi.fn()
    const onReceive = vi.fn()

    render(<ComingSoonModal open onClose={onClose} onReceive={onReceive} />)

    expect(screen.getByRole('heading', { name: 'Add funds is coming soon' })).toBeInTheDocument()
    expect(screen.getByText('A guided fiat on-ramp is planned for a later release.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Receive instead' }))

    expect(onClose).toHaveBeenCalledOnce()
    expect(onReceive).toHaveBeenCalledOnce()
  })

  it('keeps the Receive handoff when rendered through AddFundsModal', () => {
    const onClose = vi.fn()
    const onReceive = vi.fn()

    render(<AddFundsModal open onClose={onClose} onReceive={onReceive} />)

    fireEvent.click(screen.getByRole('button', { name: 'Receive instead' }))

    expect(onClose).toHaveBeenCalledOnce()
    expect(onReceive).toHaveBeenCalledOnce()
  })
})
