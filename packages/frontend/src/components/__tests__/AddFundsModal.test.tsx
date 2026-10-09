// #3681 Vercel ignore-step probe (2) — throwaway, never merged.
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `ONRAMP_APP_ID` is read at MODULE scope, so the env var has to exist before
// the component module is imported. `vi.hoisted` runs ahead of the imports
// below; setting it in `beforeEach` would be too late and the onramp card would
// never render, which would make the "no onramp offered" assertion pass for the
// wrong reason.
//
// `NEXT_PUBLIC_HAVEN_CHAIN_ID` is set here too (#3478), to `84532` — the
// DEPLOYMENT default the faucet gate must NOT read. If the gate accidentally
// keyed off this env var instead of the `chainId` prop, the 8453 case below
// would show a faucet (wrong) and the 84532 case would still pass, hiding the
// defect. Setting it opposite to what each test's `chainId` prop implies is
// what makes the account-chain gate provable rather than merely plausible.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_COINBASE_ONRAMP_APP_ID = 'onramp-app-id-fixture'
  process.env.NEXT_PUBLIC_HAVEN_CHAIN_ID = '84532'
})

vi.mock('@/hooks/useEscapeToClose', () => ({
  useEscapeToClose: vi.fn(),
}))

import AddFundsModal from '@/components/AddFundsModal'

const SAFE_ADDRESS = '0xa0e99A227fc546017Fd68D49711C1857208F0eB9'
const BASE = 8453
const BASE_SEPOLIA = 84532
const GNOSIS = 100
const UNREGISTERED = 999_999

describe('AddFundsModal', () => {
  let openSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    openSpy = vi.fn()
    vi.stubGlobal('open', openSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // The resolved MAINNET path: the onramp is offered and no faucet renders.
  // `chainId={BASE}` here, deliberately the opposite of the module-scope
  // `NEXT_PUBLIC_HAVEN_CHAIN_ID=84532` set above — this is the 8453 case named
  // by the acceptance criteria, and it is the one that proves the faucet/onramp
  // gate reads the ACCOUNT's chain (the `chainId` prop), not the deployment's
  // default. A gate that read the env var instead would fail this test: it
  // would show a faucet for this Base-mainnet account and hide its onramp.
  it('offers the onramp and shows no faucet on a Base mainnet account (8453), even with the deployment default set to Base Sepolia', () => {
    render(
      <AddFundsModal open onClose={vi.fn()} accountAddress={SAFE_ADDRESS} chainId={BASE} />,
    )

    expect(
      screen.getByText(`Send USDC to your account address on Base.`),
    ).toBeInTheDocument()
    expect(screen.getByText('Account address (Base)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Buy with card/ })).toBeInTheDocument()
    expect(screen.getByText(SAFE_ADDRESS)).toBeInTheDocument()

    // No faucet: mainnet USDC has real value, and Circle's faucet only ever
    // serves Base Sepolia.
    expect(screen.queryByRole('link', { name: /Circle/i })).toBeNull()
    expect(screen.queryByText(/faucet\.circle\.com/i)).toBeNull()
  })

  // The resolved TESTNET path: the faucet is offered and the onramp is hidden
  // entirely (owner decision on #3478 — "Buying Sepolia USDC by card is
  // meaningless"). Paired with the 8453 test above: the two together are the
  // acceptance criteria's "one clean test" — 84532 shows the faucet and no
  // onramp, 8453 shows the onramp and no faucet.
  it('shows the Circle faucet link and hides the onramp on a Base Sepolia account (84532)', () => {
    render(
      <AddFundsModal open onClose={vi.fn()} accountAddress={SAFE_ADDRESS} chainId={BASE_SEPOLIA} />,
    )

    expect(
      screen.getByText(`Send USDC to your account address on Base Sepolia.`),
    ).toBeInTheDocument()
    expect(screen.getByText('Account address (Base Sepolia)')).toBeInTheDocument()

    // Onramp entirely absent — not just disabled — on a testnet account.
    expect(screen.queryByRole('button', { name: /Buy with card/ })).toBeNull()
    expect(screen.queryByText('Buy with card')).toBeNull()

    // The faucet link: external, named Circle, names Base Sepolia, and says
    // the money has no value. The "comes from Circle, not Haven" claim is
    // scoped to this link, not restated as a Haven-never-touches-funds
    // product-wide claim (review round 1 M1).
    const link = screen.getByRole('link', { name: /Open Circle's faucet/i })
    expect(link).toHaveAttribute('href', 'https://faucet.circle.com')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel')).toMatch(/noopener/)
    expect(link.getAttribute('rel')).toMatch(/noreferrer/)

    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toMatch(/Get free Base Sepolia USDC from Circle's faucet/)
    expect(dialog.textContent).toMatch(/it comes from Circle, not Haven/)
    expect(dialog.textContent).toMatch(/no value/i)
    expect(dialog.textContent).toMatch(/Pick USDC and Base Sepolia there/)
    expect(dialog.textContent).toMatch(/paste your account address from above/)
  })

  // M2 (review round 1): the faucet copy says "from above", which is only
  // true once the address card actually renders. Gated on
  // `depositInstructionsAvailable` — the SAME condition as the address card
  // — not merely on the chain being a testnet, so a testnet account with no
  // address yet does not promise an address that is not on screen.
  it('shows no faucet card on a Base Sepolia account with no address yet', () => {
    render(
      <AddFundsModal open onClose={vi.fn()} onReceive={vi.fn()} chainId={BASE_SEPOLIA} />,
    )

    expect(screen.queryByRole('link', { name: /Open Circle's faucet/i })).toBeNull()
    expect(screen.queryByText(/paste your account address from above/i)).toBeNull()
    // The receive handoff is still the right next action here, same as any
    // other no-address state.
    expect(screen.getByRole('button', { name: /Show receive address/ })).toBeInTheDocument()
  })

  // Gnosis (100) is a registered MAINNET chain — it carries no `faucetUrl` in
  // core, so it gets no faucet, and it keeps the onramp when configured
  // (`isTestnetChain` requires a faucet, and Gnosis has none — it is not a
  // testnet, not merely "a testnet with no faucet"). Asserting the onramp
  // IS shown is what makes this test able to fail: without it, a gate that
  // wrongly treated Gnosis as a testnet would still pass by accident, since
  // the faucet assertions alone hold either way once the onramp is hidden.
  it('shows the onramp and no faucet link on a Gnosis account (100, a mainnet)', () => {
    render(
      <AddFundsModal open onClose={vi.fn()} accountAddress={SAFE_ADDRESS} chainId={GNOSIS} />,
    )

    expect(screen.getByRole('button', { name: /Buy with card/ })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Open Circle's faucet/i })).toBeNull()
    expect(screen.queryByText(/faucet\.circle\.com/i)).toBeNull()
  })

  // #1844: the guard. An unresolved chain used to default to Base MAINNET, in
  // the deposit copy AND in Coinbase Onramp's `defaultNetwork` — a preconfigured
  // fiat purchase delivered on the guessed chain. A funds surface with no chain
  // must refuse to instruct rather than guess.
  it('names no network, offers no onramp and shows no faucet when the chain is unresolved', () => {
    render(
      <AddFundsModal
        open
        onClose={vi.fn()}
        onReceive={vi.fn()}
        accountAddress={SAFE_ADDRESS}
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

    // No faucet either — an unresolved chain is not a known testnet.
    expect(screen.queryByRole('link', { name: /Open Circle's faucet/i })).toBeNull()

    // No deposit instruction: no address to copy, and copy that says so.
    expect(screen.queryByText(SAFE_ADDRESS)).toBeNull()
    expect(
      screen.getByText(/we can't tell you where to send USDC/i),
    ).toBeInTheDocument()

    // A refusal still owes a next action, and Refresh is the honest one — it
    // promises a retry and nothing else. Asserted by ROLE, not by scanning for
    // the word, so a stray mention elsewhere in the dialog cannot satisfy it.
    const refresh = screen.getByRole('button', { name: 'Refresh page' })
    expect(refresh).toBeInTheDocument()
    // And it must not re-promise the network the sentence above refused. The
    // whole dialog is checked, because the over-promise would most naturally
    // appear as a line NEXT TO the button rather than inside its label.
    expect(screen.getByRole('dialog').textContent).not.toMatch(/usually resolves|will show|try again to see/i)

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
  // `getFaucetUrl` (core) throws on the same unregistered id; the faucet gate
  // must survive it exactly like the onramp/deposit gates do (#3478).
  it('refuses rather than throwing when the chain is present but unregistered', () => {
    expect(() =>
      render(
        <AddFundsModal open onClose={vi.fn()} accountAddress={SAFE_ADDRESS} chainId={UNREGISTERED} />,
      ),
    ).not.toThrow()

    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).not.toMatch(/\bBase\b/)
    expect(dialog.textContent).not.toMatch(/999999|999,999/)
    expect(screen.queryByRole('button', { name: /Buy with card/ })).toBeNull()
    expect(screen.queryByText(SAFE_ADDRESS)).toBeNull()
    expect(screen.queryByRole('link', { name: /Open Circle's faucet/i })).toBeNull()
  })

  // The no-account case, which is a DIFFERENT state that also has no chain:
  // there is no address to withhold, and the receive handoff is the screen's
  // whole point. Pinned so the assertion above cannot be satisfied by deleting
  // the handoff outright.
  it('keeps the receive handoff when there is no account address at all', () => {
    render(<AddFundsModal open onClose={vi.fn()} onReceive={vi.fn()} />)

    expect(screen.getByRole('button', { name: /Show receive address/ })).toBeInTheDocument()
    expect(screen.getByRole('dialog').textContent).not.toMatch(/\bBase\b/)
    // Refresh belongs to the OTHER unresolved state — the one where an address
    // exists and only the chain is missing. Here there is a better next action
    // than retrying, so the two must not both appear.
    expect(screen.queryByRole('button', { name: 'Refresh page' })).toBeNull()
  })
})
