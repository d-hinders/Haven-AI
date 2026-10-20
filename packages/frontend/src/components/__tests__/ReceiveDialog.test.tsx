import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SmartAccount } from '@/context/AuthContext'

// `ONRAMP_APP_ID` is read at MODULE scope, so the env var has to exist before
// the component module is imported. `vi.hoisted` runs ahead of the imports
// below; setting it in `beforeEach` would be too late and the onramp card would
// never render, which would make the "no onramp offered" assertion pass for the
// wrong reason.
//
// `NEXT_PUBLIC_HAVEN_CHAIN_ID` is set here too (#3478), to `84532` — the
// DEPLOYMENT default the faucet gate must NOT read. If the gate accidentally
// keyed off this env var instead of the account's `chain_id`, the 8453 case
// below would show a faucet (wrong) and the 84532 case would still pass,
// hiding the defect. Setting it opposite to what each test's chain implies is
// what makes the account-chain gate provable rather than merely plausible.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_COINBASE_ONRAMP_APP_ID = 'onramp-app-id-fixture'
  process.env.NEXT_PUBLIC_HAVEN_CHAIN_ID = '84532'
})

vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,qr'),
  },
}))

vi.mock('@/hooks/useEscapeToClose', () => ({
  useEscapeToClose: vi.fn(),
}))

import ReceiveDialog from '@/components/ReceiveDialog'
import ComingSoonModal from '@/components/ComingSoonModal'

/**
 * Every text node under `el`, joined with a space.
 *
 * NOT `el.textContent`, and the difference is load-bearing. `textContent`
 * concatenates across element boundaries with no separator, so a chain name at
 * the end of one element and the next element's copy fuse into one word:
 * "Probably Base" + "We can't confirm…" reads as `…ProbablyBaseWe…`, where
 * `\bBase\b` has no boundary to match. The M4 mutation in #1844's battery did
 * exactly that and SURVIVED against a `textContent` scan — a negative
 * assertion that could not fail. Joining text nodes restores a boundary at
 * every element edge while leaving each node intact, so "Based" stays one word
 * and does not match `\bBase\b`.
 */
function textNodesJoined(el: HTMLElement): string {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const parts: string[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    parts.push(node.textContent ?? '')
  }
  return parts.join(' ')
}

const SAFE: SmartAccount = {
  id: 'safe-id',
  account_address: '0xa0e99A227fc546017Fd68D49711C1857208F0eB9',
  chain_id: 8453,
  name: 'Based',
  is_default: true,
  created_at: '2026-05-11T00:00:00Z',
}

describe('ReceiveDialog', () => {
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

  // The resolved MAINNET path: the onramp is offered and no faucet renders.
  // `chain_id: 8453` here, deliberately the opposite of the module-scope
  // `NEXT_PUBLIC_HAVEN_CHAIN_ID=84532` set above — this is the 8453 case that
  // proves the faucet/onramp gate reads the ACCOUNT's chain, not the
  // deployment's default. A gate that read the env var instead would fail this
  // test: it would show a faucet for this Base-mainnet account and hide its
  // onramp.
  it('shows the address with an inline QR, one network rule and the onramp on a Base mainnet account (8453)', async () => {
    render(<ReceiveDialog open account={SAFE} onClose={vi.fn()} />)

    expect(screen.getByRole('heading', { name: 'Receive' })).toBeInTheDocument()
    // ONE token, ONE network (#4094), the mockup's sentence (#4167): the rule
    // names USDC and the chain and what happens after the send, and ETH is
    // not listed anywhere — agents spend USDC, and the old receive screen's
    // registry-token list invited the wrong deposit. Stated EXACTLY once.
    expect(screen.getByText('Send USDC on Base only. It arrives in about a minute and shows in Activity.')).toBeInTheDocument()
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).not.toMatch(/\bETH\b/)
    expect(dialog.textContent).not.toMatch(/Before you send/)
    expect(screen.getAllByText(/Send USDC on .* only\./)).toHaveLength(1)
    expect(screen.getByText(SAFE.account_address)).toBeInTheDocument()

    expect(screen.getByRole('button', { name: /Buy with card/ })).toBeInTheDocument()

    // No faucet: mainnet USDC has real value, and Circle's faucet only ever
    // serves Base Sepolia.
    expect(screen.queryByRole('link', { name: /Circle/i })).toBeNull()
    expect(screen.queryByText('Get test USDC')).toBeNull()

    // The positive control for the unresolved negatives below: the address
    // affordances really are built, so their absence in the unresolved tests
    // is suppression, not "never rendered". The QR is INLINE (#4167) — an
    // image with the account-and-network alt, no toggle — and so is the Copy
    // button; the explorer link lives on the account page.
    expect(screen.getByRole('button', { name: 'Copy address' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show QR code' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'View on explorer' })).toBeNull()
    await waitFor(() => {
      expect(screen.getByAltText('QR code for Based on Base')).toBeInTheDocument()
    })
  })

  // The resolved TESTNET path: the faucet is offered and the onramp is hidden
  // entirely (owner decision on #3478 — "Buying Sepolia USDC by card is
  // meaningless"). Paired with the 8453 test above: together they are the
  // acceptance criteria — 84532 shows the faucet and no onramp, 8453 the
  // onramp and no faucet, both from the account's own chain.
  it('shows Get test USDC and hides the onramp on a Base Sepolia account (84532)', () => {
    render(
      <ReceiveDialog
        open
        account={{ ...SAFE, chain_id: 84532 }}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText('Send USDC on Base Sepolia only. It arrives in about a minute and shows in Activity.')).toBeInTheDocument()

    // Onramp entirely absent — not just disabled — on a testnet account.
    expect(screen.queryByRole('button', { name: /Buy with card/ })).toBeNull()
    expect(screen.queryByText('Buy with card')).toBeNull()

    // The faucet link: external, named Circle, names Base Sepolia, and says
    // the money has no value. The "comes from Circle, not Haven" claim is
    // scoped to this link, not restated as a Haven-never-touches-funds
    // product-wide claim (review round 1 M1 on #3478).
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

  // Gnosis (100) is a registered MAINNET chain — it carries no `faucetUrl` in
  // core, so it gets no faucet, and it keeps the onramp when configured
  // (`isTestnetChain` requires a faucet, and Gnosis has none — it is not a
  // testnet, not merely "a testnet with no faucet"). Asserting the onramp IS
  // shown is what makes this test able to fail: without it, a gate that
  // wrongly treated Gnosis as a testnet would still pass by accident, since
  // the faucet assertions alone hold either way once the onramp is hidden.
  it('shows the onramp and no faucet link on a Gnosis account (100, a mainnet)', () => {
    render(<ReceiveDialog open account={{ ...SAFE, chain_id: 100 }} onClose={vi.fn()} />)

    expect(screen.getByText('Send USDC on Gnosis Chain only. It arrives in about a minute and shows in Activity.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Buy with card/ })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Open Circle's faucet/i })).toBeNull()
    expect(screen.queryByText(/faucet\.circle\.com/i)).toBeNull()
  })

  it('copies the receive address with the QR already inline (#4167)', async () => {
    render(<ReceiveDialog open account={SAFE} onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy address' }))

    expect(writeText).toHaveBeenCalledWith(SAFE.account_address)
    expect(screen.getByRole('button', { name: 'Address copied' })).toBeInTheDocument()

    // No toggle to flip: the QR is generated the moment the dialog opens.
    await waitFor(() => {
      expect(screen.getByAltText('QR code for Based on Base')).toBeInTheDocument()
    })
  })

  it('renders no account card with one account and a picker with several (#4167)', async () => {
    const sepolia: SmartAccount = {
      ...SAFE,
      id: 'sepolia-id',
      name: 'Test account',
      chain_id: 84532,
      is_default: false,
    }
    const single = render(<ReceiveDialog open account={SAFE} onClose={vi.fn()} />)
    expect(screen.queryByRole('combobox', { name: 'Account' })).not.toBeInTheDocument()
    single.unmount()

    render(<ReceiveDialog open account={SAFE} accounts={[SAFE, sepolia]} onClose={vi.fn()} />)
    const picker = screen.getByRole('combobox', { name: 'Account' })
    expect(within(picker).getByRole('option', { name: 'Based' })).toBeInTheDocument()
    expect(within(picker).getByRole('option', { name: 'Test account' })).toBeInTheDocument()

    // Switching accounts re-points everything the dialog derives from the
    // account: the network rule names the newly selected chain, and the
    // faucet card appears for the testnet account the picker moved to —
    // the #3478 gate following the SELECTION, not the first account.
    fireEvent.change(picker, { target: { value: 'sepolia-id' } })

    expect(await screen.findByText('Send USDC on Base Sepolia only. It arrives in about a minute and shows in Activity.')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByAltText('QR code for Test account on Base Sepolia')).toBeInTheDocument()
    })
    expect(await screen.findByText('Get test USDC')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Buy with card/ })).toBeNull()
  })

  /**
   * #1844 / #1852 — an unresolved chain must degrade, not crash, and must
   * name no network when it does.
   *
   * Two shapes, asserted identically because they ARE the same condition from
   * the user's side: `chain_id` absent, and `chain_id` present but outside
   * the frontend registry.
   *
   * On the network negative: `\bBase\b`, case-sensitive, NOT `/Base/i`. The
   * fixture's own account name is "Based", and this dialog's onramp copy
   * names Coinbase — a loose `/Base/i` matches both and would go red on
   * unrelated text, recording a pass for something it never tested (#1844's
   * mutation caught exactly that). Everything else here is role-based rather
   * than a text scan, for the same reason.
   */
  describe.each([
    ['a chain_id that is absent', { ...SAFE, chain_id: undefined as unknown as number }],
    ['a chain_id that is present but unregistered', { ...SAFE, chain_id: 999_999 }],
  ])('with %s', (_label, unresolvedAccount: SmartAccount) => {
    it('renders without throwing and refuses to name a network or reveal an address', () => {
      // A1 — does not throw. The pre-#1844 code took the whole screen down
      // through the error boundary here; the throw is a distinguishable
      // failure from an assertion failing.
      expect(() =>
        render(<ReceiveDialog open account={unresolvedAccount} onClose={vi.fn()} />),
      ).not.toThrow()

      const dialog = screen.getByRole('dialog')

      // A2 — the dialog is actually on screen, so the negatives below are about
      // a rendered refusal and not about an empty tree.
      expect(screen.getByRole('heading', { name: 'Receive' })).toBeInTheDocument()

      // A3 — no network named anywhere in the dialog, word-anchored, over
      // text nodes rather than concatenated `textContent` (see the helper).
      const words = textNodesJoined(dialog)
      expect(words).not.toMatch(/\bBase\b/)
      expect(words).not.toMatch(/\bSepolia\b/)
      // …and the scan sees real words, proving it is doing work rather than
      // matching an empty string. #4167: with one account there is no account
      // card, so the old "Based"-vs-`\bBase\b` near-miss anchor is no longer
      // rendered — the refusal copy is the anchor now, and the negatives
      // still catch any reintroduced default-chain leak (A7 re-checks it).

      // A4 — no address, in any of the ways this screen offers one. #4167:
      // the affordances are the Copy button and the INLINE QR image (alt
      // "QR code for …") — there is no toggle and no explorer link anymore.
      expect(screen.queryByText(SAFE.account_address)).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Copy address' })).not.toBeInTheDocument()
      expect(screen.queryByAltText('QR code for Based on Base')).not.toBeInTheDocument()
      expect(screen.queryByRole('link', { name: 'View on explorer' })).not.toBeInTheDocument()

      // A5 — no network rule, no token named, and neither "other ways" card:
      // a faucet link and a card purchase are both network-addressed offers.
      expect(screen.queryByText('Send USDC on Base only. It arrives in about a minute and shows in Activity.')).not.toBeInTheDocument()
      expect(screen.queryByText(/USDC/)).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Buy with card/ })).toBeNull()
      expect(screen.queryByRole('link', { name: /Open Circle's faucet/i })).toBeNull()

      // A6 — it says so, and offers the one honest next action.
      expect(screen.getByText(/can't confirm which network this account uses/)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Refresh page' })).toBeInTheDocument()

      // A7 — the scan sees rendered words, not an empty tree. #4167: with one
      // account there is no account card, so the fixture name ("Based", the
      // old near-miss anchor for the `\bBase\b` scan) is no longer on screen;
      // the anchor is the refusal copy itself, and A3's negatives still catch
      // any reintroduced default-chain leak.
      const anchorWords = textNodesJoined(screen.getByRole('dialog'))
      expect(anchorWords).toMatch(/\bconfirm\b/)
    })
  })

  it('keeps a Refresh next action when the chain resolves but the account has no address', () => {
    render(
      <ReceiveDialog
        open
        account={{ ...SAFE, account_address: undefined as unknown as string }}
        onClose={vi.fn()}
      />,
    )

    // The chain is KNOWN here — a "Network not confirmed" banner would lie —
    // but there is nothing to copy, scan or fund yet, so the honest next
    // action is the same retry. The network rule stays unrendered in this
    // state: it is an instruction about the ADDRESS (#4094's mockup order
    // puts it under the address card), and there is none to instruct on.
    expect(screen.queryByText('Haven wallet address')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy address' })).not.toBeInTheDocument()
    expect(screen.queryByText(/USDC/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh page' })).toBeInTheDocument()
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
})
