import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockCreatePasskey = vi.fn()
const mockPost = vi.fn()

vi.mock('@/lib/passkey', async () => {
  const actual = await vi.importActual<typeof import('@/lib/passkey')>('@/lib/passkey')
  return {
    ...actual,
    createPasskey: (...args: unknown[]) => mockCreatePasskey(...args),
  }
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    api: { post: (...args: unknown[]) => mockPost(...args) },
  }
})

import { PasskeyCancelledError, PasskeyUnsupportedError, base64UrlEncode } from '@/lib/passkey'
import { PASSKEY_REQUIRED_MESSAGE } from '@/app/onboarding/copy'
import HybridEnrollFlow from '@/app/onboarding/HybridEnrollFlow'

const mockUser = {
  id: 'user-1',
  name: 'Ada Lovelace',
  email: 'hybrid@example.com',
  wallet_address: null,
  safe_address: null,
  safes: [],
}

// Raw credential id bytes ↔ the formats the flow must produce.
const RAW_ID = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
const CREATED = {
  credentialId: base64UrlEncode(RAW_ID),
  publicKey: { x: '0x' + '11'.repeat(32), y: '0x' + '22'.repeat(32) },
  rawAttestationObject: new Uint8Array(),
  rawClientDataJSON: new Uint8Array(),
}
const ACCOUNT = '0x' + 'aa'.repeat(20)

function renderFlow(onComplete = vi.fn(), onError = vi.fn()) {
  render(
    <HybridEnrollFlow
      user={mockUser as never}
      selectedChainId={84532}
      onComplete={onComplete}
      onError={onError}
    />,
  )
  return { onComplete, onError }
}

/**
 * jsdom ships neither `PublicKeyCredential` nor `navigator.credentials`, so
 * every test in this file used to run in a browser the flow now recognises as
 * WebAuthn-less (#2524). Stub both by default — "a capable browser" is the
 * premise of every pre-existing case here — and let the cases that are ABOUT
 * an incapable browser take them away again.
 */
function makeWebAuthnCapable() {
  Object.defineProperty(window, 'PublicKeyCredential', {
    value: function PublicKeyCredential() {},
    configurable: true,
    writable: true,
  })
  Object.defineProperty(navigator, 'credentials', {
    value: { create: vi.fn(), get: vi.fn() },
    configurable: true,
    writable: true,
  })
}

function makeWebAuthnAbsent() {
  Reflect.deleteProperty(window, 'PublicKeyCredential')
  Object.defineProperty(navigator, 'credentials', {
    value: undefined,
    configurable: true,
    writable: true,
  })
}

/** Drive `classifyAgentUserAgent` from the test, not from jsdom's default UA. */
function setUserAgent(ua: string) {
  Object.defineProperty(navigator, 'userAgent', {
    value: ua,
    configurable: true,
    writable: true,
  })
}

const HUMAN_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'

beforeEach(() => {
  mockCreatePasskey.mockReset()
  mockPost.mockReset()
  window.localStorage.clear()
  makeWebAuthnCapable()
  setUserAgent(HUMAN_UA)
})

describe('HybridEnrollFlow (#886)', () => {
  it('creates the passkey and registers the Hybrid — key_id is hex of the raw credential id', async () => {
    mockCreatePasskey.mockResolvedValue(CREATED)
    mockPost.mockResolvedValue({ account_address: ACCOUNT })
    const { onComplete } = renderFlow()

    fireEvent.click(screen.getByRole('button', { name: /passkey/i }))
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith({ accountAddress: ACCOUNT }))

    expect(mockPost).toHaveBeenCalledWith('/accounts/hybrid', {
      chain_id: 84532,
      passkeys: [{ key_id: '0xdeadbeef', x: CREATED.publicKey.x, y: CREATED.publicKey.y }],
    })
  })

  it('is one ceremony, zero transactions — no deploy call, no Safe registration', async () => {
    mockCreatePasskey.mockResolvedValue(CREATED)
    mockPost.mockResolvedValue({ account_address: ACCOUNT })
    renderFlow()

    fireEvent.click(screen.getByRole('button', { name: /passkey/i }))
    await waitFor(() => expect(mockPost).toHaveBeenCalled())
    // Exactly ONE api call: the account registration.
    expect(mockPost).toHaveBeenCalledTimes(1)
    expect(mockCreatePasskey).toHaveBeenCalledTimes(1)
  })

  it('maps a cancelled passkey prompt to friendly copy and resets', async () => {
    mockCreatePasskey.mockRejectedValue(new PasskeyCancelledError('cancelled'))
    const { onComplete, onError } = renderFlow()

    fireEvent.click(screen.getByRole('button', { name: /passkey/i }))
    await waitFor(() => expect(onError).toHaveBeenCalledWith('The passkey prompt was cancelled.'))
    expect(onComplete).not.toHaveBeenCalled()
    // Back to idle — the button is clickable again:
    expect(screen.getByRole('button', { name: /passkey/i })).toBeTruthy()
  })

  it('offers no action when the create attempt reports no passkey support (#1162)', async () => {
    mockCreatePasskey.mockRejectedValue(new PasskeyUnsupportedError())
    renderFlow()

    fireEvent.click(screen.getByRole('button', { name: /passkey/i }))

    // An honest dead end — there is no button here that could only fail the
    // same way, and the message is shown in place.
    await waitFor(() => expect(screen.queryByRole('button', { name: /passkey/i })).toBeNull())
    expect(screen.getByText(PASSKEY_REQUIRED_MESSAGE)).toBeTruthy()
  })

  it('does not also push the passkey-required sentence through onError (#2524)', async () => {
    mockCreatePasskey.mockRejectedValue(new PasskeyUnsupportedError())
    const { onError } = renderFlow()

    fireEvent.click(screen.getByRole('button', { name: /passkey/i }))

    await waitFor(() => expect(screen.getByText(PASSKEY_REQUIRED_MESSAGE)).toBeTruthy())
    // The host screen's alert sits ABOVE this component, so routing the
    // sentence there too would print it twice AND put it above the agent
    // hand-off that is supposed to come first.
    expect(onError).not.toHaveBeenCalledWith(PASSKEY_REQUIRED_MESSAGE)
  })

  it('never shows crypto jargon', () => {
    renderFlow()
    expect(document.body.textContent).not.toMatch(/wallet address|seed phrase required|gas|transaction|deploy|delegation|counterfactual/i)
  })
})

/**
 * The agent hand-off on the passkey step (#2524, epic #2519).
 *
 * Two triggers, one of which is a wall and one of which is not, plus the
 * default a human on a normal browser must keep seeing.
 */
describe('agent hand-off on the passkey step (#2524)', () => {
  it('walls the step and names the hand-off when WebAuthn is absent', async () => {
    makeWebAuthnAbsent()
    renderFlow()

    const handoff = await screen.findByTestId('agent-passkey-handoff')
    expect(handoff.textContent).toContain('This browser cannot create a passkey')
    expect(handoff.textContent).toContain('If you are an AI agent')
    // The human variant stays, beneath the agent line.
    expect(screen.getByText(PASSKEY_REQUIRED_MESSAGE)).toBeTruthy()
    // Detection is proactive: no click was needed to get here.
    expect(mockCreatePasskey).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /passkey/i })).toBeNull()
  })

  it('advises, without walling, when the UA is a known agent but WebAuthn works', async () => {
    setUserAgent('Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)')
    renderFlow()

    const handoff = await screen.findByTestId('agent-passkey-handoff')
    expect(handoff.textContent).toContain('created by your user, on their own device')
    // "cannot" would be false here, and the button has to keep working for a
    // human whose browser carries an odd UA.
    expect(handoff.textContent).not.toContain('cannot create a passkey')
    expect(screen.queryByText(PASSKEY_REQUIRED_MESSAGE)).toBeNull()
    expect(screen.getByRole('button', { name: /passkey/i })).toBeTruthy()
  })

  it('shows no hand-off at all for a human on a capable browser', async () => {
    renderFlow()

    await waitFor(() => expect(screen.getByRole('button', { name: /passkey/i })).toBeTruthy())
    expect(screen.queryByTestId('agent-passkey-handoff')).toBeNull()
  })
})
