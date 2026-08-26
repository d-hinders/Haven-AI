/**
 * What each gate kind RENDERS through the shared blocked-action surface (#2073).
 *
 * `getOnchainActionBlockMessage` is an if-chain with a `return null` default,
 * and `OnchainActionNotice` renders NOTHING for a null message — so a gate
 * kind added to the union but not to the chain is still BLOCKED
 * (`isOnchainActionBlocked` is `kind !== 'ready'`) while rendering no
 * explanation at all: a disabled button with silence above it. These tests pin
 * the visible text for every non-ready kind so that failure mode is a named
 * red, not a quiet regression.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import {
  OnchainActionNotice,
  getOnchainActionBlockMessage,
  isOnchainActionBlocked,
} from '@/components/OnchainActionGate'
import type { SafeOperationGate } from '@/hooks/useSafeOperationGate'

const CONNECTED = '0x9999999999999999999999999999999999999999' as Address
const OWNER = '0xEEEEeeeeEEeeeEeEeEeEEEeeEEEeeeeEeEeeeeEe' as Address

const WRONG_WALLET: SafeOperationGate = {
  kind: 'wrong_wallet',
  connectedAddress: CONNECTED,
  ownerAddress: OWNER,
}

const GENERIC = "Connect the account's owner wallet to update this agent budget."

describe('OnchainActionGate rendering by gate kind', () => {
  it('wrong_wallet renders a DISTINCT visible message naming both addresses — not the generic no-signer copy, and never nothing (#2073)', () => {
    render(<OnchainActionNotice operationGate={WRONG_WALLET} noSignerMessage={GENERIC} />)

    const notice = screen.getByRole('status')
    expect(notice.textContent).toContain('0x9999…9999')
    expect(notice.textContent).toContain('0xEEEE…eeEe')
    expect(notice.textContent).toContain("is not this account's owner")
    expect(notice.textContent).not.toContain(GENERIC)
  })

  it('wrong_wallet is BLOCKED — the distinct state must never widen what may sign', () => {
    expect(isOnchainActionBlocked(WRONG_WALLET)).toBe(true)
  })

  it('positive control: no_signer still renders the caller-provided generic copy', () => {
    render(<OnchainActionNotice operationGate={{ kind: 'no_signer' }} noSignerMessage={GENERIC} />)
    expect(screen.getByRole('status').textContent).toContain(GENERIC)
  })

  it('positive control: ready renders no notice and is not blocked', () => {
    const { container } = render(
      <OnchainActionNotice operationGate={{ kind: 'ready' }} noSignerMessage={GENERIC} />,
    )
    expect(container).toBeEmptyDOMElement()
    expect(isOnchainActionBlocked({ kind: 'ready' })).toBe(false)
  })

  it('every non-ready kind in the union has a non-null block message — the null default is unreachable for blocked states', () => {
    // The exhaustiveness pin: if a future gate kind lands in the union without
    // a message branch, this test names the gap instead of the product
    // rendering a silent disabled button. Kinds are enumerated here because
    // TypeScript unions do not exist at runtime; add the new kind's
    // representative value when extending the union.
    const blockedStates: SafeOperationGate[] = [
      { kind: 'no_signer' },
      { kind: 'passkey_on_other_device' },
      WRONG_WALLET,
    ]
    for (const state of blockedStates) {
      expect(isOnchainActionBlocked(state)).toBe(true)
      expect(getOnchainActionBlockMessage(state, GENERIC)).not.toBeNull()
    }
  })
})
