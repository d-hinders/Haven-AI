import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `ONRAMP_APP_ID` is read at MODULE scope, so the env var has to exist before
// the component module is imported. `vi.hoisted` runs ahead of the imports
// below; setting it in `beforeEach` would be too late and the onramp card would
// never render, which would make the "no onramp offered" assertion pass for the
// wrong reason.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_COINBASE_ONRAMP_APP_ID = 'onramp-app-id-fixture'
})

vi.mock('@/hooks/useEscapeToClose', () => ({
  useEscapeToClose: vi.fn(),
}))

import AddFundsModal from '@/components/AddFundsModal'

const SAFE_ADDRESS = '0xa0e99A227fc546017Fd68D49711C1857208F0eB9'
const BASE_SEPOLIA = 84532

describe('AddFundsModal', () => {
  let openSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    openSpy = vi.fn()
    vi.stubGlobal('open', openSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // The resolved path. Without this, the unresolved-chain test below only
  // proves the assertions can pass — not that they can distinguish the two
  // states.
  it('names the network and offers the onramp when the chain resolves', () => {
    render(
      <AddFundsModal open onClose={vi.fn()} safeAddress={SAFE_ADDRESS} chainId={BASE_SEPOLIA} />,
    )

    expect(
      screen.getByText(`Send USDC to your account address on Base Sepolia.`),
    ).toBeInTheDocument()
    expect(screen.getByText('Account address (Base Sepolia)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Buy with card/ })).toBeInTheDocument()
    expect(screen.getByText(SAFE_ADDRESS)).toBeInTheDocument()
  })

  // #1844: the guard. An unresolved chain used to default to Base MAINNET, in
  // the deposit copy AND in Coinbase Onramp's `defaultNetwork` — a preconfigured
  // fiat purchase delivered on the guessed chain. A funds surface with no chain
  // must refuse to instruct rather than guess.
  it('names no network and offers no onramp when the chain is unresolved', () => {
    render(
      <AddFundsModal
        open
        onClose={vi.fn()}
        onReceive={vi.fn()}
        safeAddress={SAFE_ADDRESS}
        chainId={undefined}
      />,
    )

    // No chain named anywhere in the modal — not "Base", not "Base Sepolia",
    // not "Gnosis". Asserted against the whole dialog rather than a single node
    // so a name reappearing in a different element still fails.
    //
    // Word-anchored and case-SENSITIVE on purpose. `/Base/i` matches
    // "Coinbase" in the onramp card's own copy, so it fired on the second
    // mutation below for entirely the wrong reason — it would have reported the
    // onramp guard as proven while proving nothing about it. `\bBase\b` does
    // not match "Coinbase" (no word boundary between "n" and "B").
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).not.toMatch(/\bBase\b/)
    expect(dialog.textContent).not.toMatch(/\bGnosis\b/)

    // No onramp offered. `onrampAvailable` is the gate that proves this, and
    // the mutation below shows it is load-bearing. The `openSpy` assertion is
    // deliberately weaker than it looks and is NOT claimed as proof of
    // `handleBuyWithCard`'s own `!chainConfig` guard: with no control rendered
    // there is nothing to click, so it holds trivially. It stays as a check
    // that nothing else in the modal opens an onramp window on its own.
    expect(screen.queryByRole('button', { name: /Buy with card/ })).toBeNull()
    expect(openSpy).not.toHaveBeenCalled()

    // No deposit instruction: no address to copy, and copy that says so.
    expect(screen.queryByText(SAFE_ADDRESS)).toBeNull()
    expect(
      screen.getByText(/we can't tell you where to send USDC/i),
    ).toBeInTheDocument()

    // And no handoff to the receive screen. That screen calls
    // `getChainConfig(safe.chain_id)` unconditionally and throws on a missing
    // chain, so offering it here would make the refusal's own way out a crash
    // (#1852). Found by the rendered review pass, not by this test's first
    // version — hence the assertion.
    expect(screen.queryByRole('button', { name: /Show receive address/ })).toBeNull()
  })

  // The second shape of "unresolved", raised by the code-review pass: a
  // chain_id that is PRESENT but not in the frontend registry. `getChainConfig`
  // throws on it, so before `resolveChainOrNull` this rendered nothing at all —
  // it took the modal down through the error boundary rather than refusing.
  it('refuses rather than throwing when the chain is present but unregistered', () => {
    expect(() =>
      render(
        <AddFundsModal open onClose={vi.fn()} safeAddress={SAFE_ADDRESS} chainId={999_999} />,
      ),
    ).not.toThrow()

    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).not.toMatch(/\bBase\b/)
    expect(dialog.textContent).not.toMatch(/999999|999,999/)
    expect(screen.queryByRole('button', { name: /Buy with card/ })).toBeNull()
    expect(screen.queryByText(SAFE_ADDRESS)).toBeNull()
  })

  // The no-account case, which is a DIFFERENT state that also has no chain:
  // there is no address to withhold, and the receive handoff is the screen's
  // whole point. Pinned so the assertion above cannot be satisfied by deleting
  // the handoff outright.
  it('keeps the receive handoff when there is no account address at all', () => {
    render(<AddFundsModal open onClose={vi.fn()} onReceive={vi.fn()} />)

    expect(screen.getByRole('button', { name: /Show receive address/ })).toBeInTheDocument()
    expect(screen.getByRole('dialog').textContent).not.toMatch(/\bBase\b/)
  })
})
