'use client'

/**
 * The agent hand-off line (#2524, epic #2519).
 *
 * Three pages are where an agent driving a browser stops — `/signup`,
 * `/login`, and the onboarding passkey step — and until now none of them said
 * what an agent should do there. Each of those steps needs the human: the
 * password is theirs, and the passkey is bound to their device. So the answer
 * is never "try harder", it is "send your user this link".
 *
 * Two exports, because the passkey step is a different sentence from the two
 * auth forms and flattening them would make one of the two say something
 * untrue — see `AgentPasskeyHandoff` below.
 *
 * WHY THE LINK IS REBUILT RATHER THAN ECHOED. The obvious implementation is
 * `window.location.href`, which is an arbitrary attacker-influenced query
 * string rendered as a link the page has just told the user to trust. Instead
 * the href is composed from the origin, the caller-declared path, and the two
 * parameters that have shipped sanitisers: `next` (`sanitizeNextPath`, #2522 —
 * same-origin paths only) and `via` (`parseViaMarker` — the `agent` enum, not
 * free text). Anything else in the current URL is dropped. No new parsing
 * logic here, by design.
 *
 * WHY THE PROSE RENDERS ON THE SERVER AND THE HREF DOES NOT. An agent may
 * read these pages with `curl`, so the sentence has to exist without
 * JavaScript; the absolute URL cannot, because it depends on `window`. The
 * initial render therefore uses the caller's own path — a relative link, which
 * is what `/for-agents.md` already tells agents to resolve against the host —
 * and the absolute URL replaces it after mount. First paint and SSR agree, so
 * there is no hydration mismatch.
 */

import { useEffect, useState } from 'react'
import { nextPathFromSearch, viaMarkerFromSearch } from '@/lib/discovery'

/** Where `/for-agents.md` lives (#2523). Same host, so a path is enough. */
const RUNBOOK_PATH = '/for-agents.md'

/**
 * `overflow-wrap: anywhere` rather than `break-all` (design review, #2524).
 * Both stop a long percent-encoded `next` from overflowing the card, but
 * `break-all` breaks EAGERLY: on the common link — the bare origin plus
 * `/signup`, with no `next` at all — it split "…/signu / p" mid-word in the
 * rendered evidence. `anywhere` breaks inside a word only when there is no
 * other option, so the short link wraps at a boundary and the pathological one
 * still cannot overflow. On a browser without it (Safari < 15.4) the fallback
 * is the pre-CSS behaviour, i.e. a long link can overflow this one tertiary
 * line — stated rather than glossed, and judged the better trade against
 * breaking every short link mid-word.
 */
const LINK_CLASS =
  'underline underline-offset-2 [overflow-wrap:anywhere] text-[var(--v2-ink-2)] hover:text-[var(--v2-ink)] transition-colors'

/**
 * Rebuild the current step's URL as something safe to hand to another person.
 *
 * Returns the caller's `path` unchanged until the component has mounted, so
 * the server and the first client render produce the same markup.
 */
export function useHandoffLink(path: string): string {
  const [link, setLink] = useState(path)

  useEffect(() => {
    const search = window.location.search
    const params = new URLSearchParams()
    const next = nextPathFromSearch(search)
    if (next) params.set('next', next)
    const via = viaMarkerFromSearch(search)
    if (via) params.set('via', via)
    const query = params.toString()
    setLink(`${window.location.origin}${path}${query ? `?${query}` : ''}`)
  }, [path])

  return link
}

/**
 * The line under the signup and login forms.
 *
 * Addressed to two readers at once — a person setting Haven up for someone
 * else, and an agent doing the same — because both need the same answer and a
 * second block for the second reader would be noise on a form.
 */
export function AgentHandoffNote({ path }: { path: string }) {
  const link = useHandoffLink(path)

  return (
    <p className="mt-4 text-xs leading-relaxed text-[var(--v2-ink-3)]">
      Setting up for someone else, or an AI agent? Your user creates the account and its
      passkey themselves — send them this link:{' '}
      <a href={link} className={LINK_CLASS}>
        {link}
      </a>
      . Agents: read{' '}
      <a href={RUNBOOK_PATH} className={LINK_CLASS}>
        {RUNBOOK_PATH}
      </a>{' '}
      first.
    </p>
  )
}

/**
 * The passkey step's agent variant.
 *
 * Two triggers, and they are NOT the same claim, which is why this takes
 * `canCreatePasskey` rather than one boolean:
 *
 *   - WebAuthn is missing → "this browser cannot create a passkey" is true,
 *     and the human variant (`PASSKEY_REQUIRED_MESSAGE`) belongs beneath it.
 *   - The user agent classifies as a known agent family but WebAuthn is
 *     present → the browser CAN create a passkey, it just must not be this
 *     party creating it. Saying "cannot" there would be false, and blocking
 *     the button would break a human whose browser happens to carry an odd
 *     UA. So the hand-off line appears above a create button that still works.
 *
 * The human variant is passed in rather than imported so the one sentence that
 * onboarding shows a WebAuthn-less browser keeps a single home (`copy.ts`).
 */
export function AgentPasskeyHandoff({
  path,
  canCreatePasskey,
  humanMessage,
}: {
  path: string
  canCreatePasskey: boolean
  humanMessage: string
}) {
  const link = useHandoffLink(path)

  return (
    <div className="space-y-2" data-testid="agent-passkey-handoff">
      <p className="text-sm leading-relaxed text-[var(--v2-ink-2)]">
        {canCreatePasskey
          ? 'If you are an AI agent: the passkey has to be created by your user, on their own device. Send them this link to continue there:'
          : 'This browser cannot create a passkey. If you are an AI agent, send your user this link to continue on their own device:'}{' '}
        <a href={link} className={LINK_CLASS}>
          {link}
        </a>
      </p>
      {!canCreatePasskey && (
        <p className="text-sm leading-relaxed text-[var(--v2-ink-2)]">{humanMessage}</p>
      )}
    </div>
  )
}
