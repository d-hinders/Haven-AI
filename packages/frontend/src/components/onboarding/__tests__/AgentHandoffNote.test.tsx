import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { AgentHandoffNote, AgentPasskeyHandoff } from '@/components/onboarding/AgentHandoffNote'

/**
 * The hand-off link is composed, not echoed (#2524) — so what this file is
 * really testing is which parts of the current URL survive into a link the
 * page has just told the user to trust.
 */
function setSearch(search: string) {
  window.history.replaceState({}, '', `/signup${search}`)
}

function linkHref(text: RegExp | string) {
  return (screen.getByText(text).closest('a') as HTMLAnchorElement).href
}

beforeEach(() => {
  setSearch('')
})

describe('AgentHandoffNote (#2524)', () => {
  it('renders the hand-off prose and points agents at the runbook', async () => {
    render(<AgentHandoffNote path="/signup" />)

    expect(screen.getByText(/Setting up for someone else, or an AI agent\?/)).toBeTruthy()
    // The account and its passkey are the user's — say that, not "sign in".
    expect(screen.getByText(/creates the account and its\s+passkey themselves/)).toBeTruthy()
    expect(screen.getByRole('link', { name: '/for-agents.md' })).toBeTruthy()
  })

  it('resolves to an absolute link on the current origin after mount', async () => {
    render(<AgentHandoffNote path="/signup" />)

    await waitFor(() => expect(linkHref(`${window.location.origin}/signup`)).toBeTruthy())
    expect(linkHref(`${window.location.origin}/signup`)).toBe(
      `${window.location.origin}/signup`,
    )
  })

  it('carries a sanitised `next` so the link lands the human on the same step', async () => {
    setSearch('?next=%2Fagents%3Fsetup%3Dabc')
    render(<AgentHandoffNote path="/signup" />)

    await waitFor(() =>
      expect(
        screen.getByText(`${window.location.origin}/signup?next=%2Fagents%3Fsetup%3Dabc`),
      ).toBeTruthy(),
    )
  })

  it('carries the `via` marker so agent-sent links stay attributable', async () => {
    setSearch('?via=agent')
    render(<AgentHandoffNote path="/signup" />)

    await waitFor(() =>
      expect(screen.getByText(`${window.location.origin}/signup?via=agent`)).toBeTruthy(),
    )
  })

  /**
   * The reason the link is rebuilt rather than echoed. `next` goes through
   * #2522's `sanitizeNextPath`, so an off-origin target is dropped rather than
   * rendered as a link this page has vouched for.
   */
  it('drops an off-origin `next` instead of linking to it', async () => {
    setSearch('?next=https%3A%2F%2Fevil.example%2Fx')
    render(<AgentHandoffNote path="/signup" />)

    await waitFor(() =>
      expect(screen.getByText(`${window.location.origin}/signup`)).toBeTruthy(),
    )
    expect(document.body.innerHTML).not.toContain('evil.example')
  })

  it('drops a protocol-relative `next` that resolves same-origin', async () => {
    setSearch('?next=%2F..%2F%2Fevil.example')
    render(<AgentHandoffNote path="/signup" />)

    await waitFor(() =>
      expect(screen.getByText(`${window.location.origin}/signup`)).toBeTruthy(),
    )
    expect(document.body.innerHTML).not.toContain('evil.example')
  })

  it('drops every other query parameter, including a free-text `via`', async () => {
    setSearch('?via=totally-a-human&src=partner&utm_campaign=x')
    render(<AgentHandoffNote path="/signup" />)

    await waitFor(() =>
      expect(screen.getByText(`${window.location.origin}/signup`)).toBeTruthy(),
    )
    expect(document.body.innerHTML).not.toContain('utm_campaign')
    expect(document.body.innerHTML).not.toContain('partner')
    expect(document.body.innerHTML).not.toContain('totally-a-human')
  })

  /**
   * Aimed at a specific mutation (haven-reviewer, #2524): the two single-param
   * cases above happen to be byte-identical to what an `href` echo produces,
   * so neither goes red if the composition is replaced by
   * `window.location.href`. This one cannot coincide — the correct output
   * carries `next` and `via` in the composer's own order with a re-encoded
   * `next`, and drops the third parameter entirely, so an echo, a dropped
   * `via` and a dropped `next` each fail it.
   */
  it('carries `next` and `via` together, re-encoded, and nothing else', async () => {
    setSearch('?via=agent&src=partner&next=%2Fagents%3Fsetup%3Dabc')
    render(<AgentHandoffNote path="/signup" />)

    const expected = `${window.location.origin}/signup?next=%2Fagents%3Fsetup%3Dabc&via=agent`
    await waitFor(() => expect(screen.getByText(expected)).toBeTruthy())
    expect(linkHref(expected)).toBe(expected)
    expect(document.body.innerHTML).not.toContain('partner')
  })

  /**
   * An agent may read `/signup` with `curl`, so the sentence has to exist
   * before hydration. The absolute URL cannot — it needs `window` — so the
   * first render uses the caller's path, which is a relative link and exactly
   * what `/for-agents.md` tells agents to resolve against the host.
   */
  it('is real page content before hydration — the path stands in for the URL', () => {
    const { container } = render(<AgentHandoffNote path="/login" />)
    expect(container.textContent).toContain('send them this link')
  })
})

describe('AgentPasskeyHandoff (#2524)', () => {
  const HUMAN = 'This browser can’t create a passkey.'

  it('claims the browser cannot, and keeps the human sentence, when it cannot', () => {
    render(
      <AgentPasskeyHandoff path="/onboarding" canCreatePasskey={false} humanMessage={HUMAN} />,
    )

    const el = screen.getByTestId('agent-passkey-handoff')
    expect(el.textContent).toContain('This browser cannot create a passkey')
    expect(el.textContent).toContain(HUMAN)
  })

  it('makes no "cannot" claim, and shows no human wall, when the browser can', () => {
    render(
      <AgentPasskeyHandoff path="/onboarding" canCreatePasskey humanMessage={HUMAN} />,
    )

    const el = screen.getByTestId('agent-passkey-handoff')
    expect(el.textContent).toContain('created by your user, on their own device')
    expect(el.textContent).not.toContain('cannot create a passkey')
    expect(el.textContent).not.toContain(HUMAN)
  })
})
