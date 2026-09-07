'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { ApprovalRequiredBanner } from '@/components/haven/ApprovalRequiredBanner'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { PageHeader } from '@/components/ui/PageHeader'
import { api, ApiRequestError } from '@/lib/api'

/**
 * A looked-up grant. `userCode` is stored WITH the label rather than read back
 * from the input at decision time: the two must not be able to disagree, and
 * they could — see `decide` below.
 */
type Pending = { userCode: string; clientLabel: string | null }

type Outcome =
  | { kind: 'idle' }
  | { kind: 'reviewing'; pending: Pending }
  | { kind: 'approved' }
  | { kind: 'denied' }
  | { kind: 'error'; message: string }

const UNKNOWN_CODE =
  'That code is not waiting for approval. It may have expired, already been used, or been typed wrong — ask for a fresh one.'

/**
 * The approval screen for a device-code CLI login (#2526).
 *
 * What it must get right is the SENTENCE, not the layout: a human is granting
 * a session to something they cannot see, so the screen says plainly what that
 * session can and cannot do. The scope is not a summary of the allow-list — it
 * is the two halves that matter to the person deciding.
 *
 * ## Why the code is looked up before it is decided
 *
 * The decision is deliberately TWO steps, and collapsing them would defeat the
 * point. The attack this flow has to survive is not code theft — it is a
 * stranger starting their own device login and getting a signed-in victim to
 * open `/device?code=<the stranger's code>`. Every code looks alike, so the
 * only thing that can make a wrong approval noticeable is the requester's own
 * label, shown BEFORE the button. A screen that approved first and reported
 * the label afterwards would tell the victim what they had just given away.
 *
 * The label is attacker-controlled text, so it is rendered as text and nothing
 * else — never `dangerouslySetInnerHTML`, never a link — and it is captioned
 * as something the requester supplied rather than something Haven vouches for.
 */
export default function DeviceApprovalClient() {
  const searchParams = useSearchParams()
  const [code, setCode] = useState(searchParams.get('code') ?? '')
  const [submitting, setSubmitting] = useState<'lookup' | 'approve' | 'deny' | null>(null)
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' })

  const failed = useCallback((err: unknown) => {
    // The backend answers 404 for a wrong, expired or already-decided code
    // alike, so codes cannot be enumerated. The copy here has to be equally
    // undiscriminating, or the screen leaks what the API refused to.
    setOutcome({
      kind: 'error',
      message:
        err instanceof ApiRequestError && err.status === 404
          ? UNKNOWN_CODE
          : 'Something went wrong. Try again.',
    })
  }, [])

  // Generation counter: every lookup and every edit to the code bumps it, and a
  // response whose generation is stale is dropped. Without it, a lookup still
  // in flight when the code is edited resolves AFTERWARDS and installs its
  // label beside the new code — the `outcome.kind !== 'idle'` guard in the
  // input's onChange cannot help, because during the fetch the outcome IS
  // idle. That window is small and entirely reachable: the page auto-looks-up
  // the code from the link on mount, which is exactly when someone who
  // distrusts a pasted link starts typing their own.
  const generation = useRef(0)

  const lookup = useCallback(
    async (userCode: string) => {
      const mine = ++generation.current
      setSubmitting('lookup')
      setOutcome({ kind: 'idle' })
      try {
        const res = await api.post<{ client_label: string | null }>('/auth/device/lookup', {
          user_code: userCode,
        })
        if (mine !== generation.current) return
        setOutcome({
          kind: 'reviewing',
          pending: { userCode, clientLabel: res.client_label ?? null },
        })
      } catch (err) {
        if (mine !== generation.current) return
        failed(err)
      } finally {
        if (mine === generation.current) setSubmitting(null)
      }
    },
    [failed],
  )

  // A code arriving in the link is the ordinary path — the CLI prints that URL
  // — so the person lands already looking at what they are being asked to
  // approve. Guarded by a ref rather than the effect's deps: this must run
  // once for the code the page opened with, and never re-fire as they retype.
  // Moved to when the review panel appears — see the panel's own comment.
  const reviewPanel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (outcome.kind === 'reviewing') reviewPanel.current?.focus()
  }, [outcome.kind])

  const autoLookedUp = useRef(false)
  useEffect(() => {
    const initial = searchParams.get('code')?.trim()
    if (!initial || autoLookedUp.current) return
    autoLookedUp.current = true
    void lookup(initial)
  }, [searchParams, lookup])

  // Takes the reviewed grant, and submits ITS code — never the input's current
  // value. The label on screen and the code being decided have to be the same
  // grant, or the review step is theatre: a human who read one label would be
  // granting a different session.
  async function decide(pending: Pending, deny: boolean) {
    setSubmitting(deny ? 'deny' : 'approve')
    try {
      await api.post('/auth/device/approve', {
        user_code: pending.userCode,
        ...(deny ? { deny: true } : {}),
      })
      setOutcome({ kind: deny ? 'denied' : 'approved' })
    } catch (err) {
      failed(err)
    } finally {
      setSubmitting(null)
    }
  }

  if (outcome.kind === 'approved' || outcome.kind === 'denied') {
    return (
      <PageHeader
        title={outcome.kind === 'approved' ? 'CLI access approved' : 'CLI access denied'}
        subtitle={
          outcome.kind === 'approved'
            ? 'You can close this page. The command line picks it up within a few seconds.'
            : 'Nothing was granted. You can close this page.'
        }
      />
    )
  }

  const reviewing = outcome.kind === 'reviewing' ? outcome.pending : null
  const busy = submitting !== null

  return (
    <>
      <PageHeader
        title="Approve command-line access"
        subtitle="Something is asking to manage agents from a terminal on your behalf."
      />

      <Card>
        <Card.Section>
          <form
            className="flex flex-col gap-5"
            onSubmit={(event) => {
              event.preventDefault()
              if (reviewing) void decide(reviewing, false)
              else void lookup(code)
            }}
          >
            {/* `Input` carries no `label` prop; the pattern here is the one
                login/page.tsx uses — an explicit label bound by `htmlFor`. */}
            <div>
              <label
                htmlFor="device-user-code"
                className="block text-xs font-medium text-[var(--v2-ink-2)] mb-1.5"
              >
                Code shown in the terminal
              </label>
              <Input
                id="device-user-code"
                value={code}
                onChange={(event) => {
                  setCode(event.target.value)
                  // Editing the code invalidates what was looked up. Leaving
                  // the old label on screen next to a new code is exactly the
                  // mismatch this whole step exists to prevent.
                  // Bump the generation so a lookup already in flight for the
                  // OLD code cannot land its label beside this new one.
                  generation.current += 1
                  if (outcome.kind !== 'idle') setOutcome({ kind: 'idle' })
                }}
                placeholder="XXXX-XXXX"
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            {reviewing && (
              // `ApprovalRequiredBanner`, not a hand-rolled tinted div: this is
              // the one block on the page carrying attacker-chosen text and the
              // sentence that should stop a wrong approval, and a flat
              // `--v2-surface` tint reads as a resting shade rather than a
              // notice. `warning` is literal here, not decorative.
              //
              // Focusable, because the step change is silent otherwise: the
              // submit button is one node whose label flips from Continue to
              // Approve, so a keyboard or screen-reader user could be left
              // focused on a button that quietly changed meaning. Focus moves
              // here instead, which reads the requester out before the decision
              // — the same order the sighted screen enforces.
              //
              // Focus alone, with NO `aria-live`. It carried one and that was
              // redundant: moving focus to a container already announces its
              // contents, so a live region on the same node risks saying it
              // twice — once for the mutation, once for the focus landing.
              // `role="status"` would be the same thing under another name.
              <div
                ref={reviewPanel}
                tabIndex={-1}
                data-testid="device-client-label"
                className="focus-visible:outline-none"
              >
                <ApprovalRequiredBanner title="The request says it is from" tone="warning">
                  <p className="text-sm font-medium text-[var(--v2-ink)] [overflow-wrap:anywhere]">
                    {reviewing.clientLabel?.trim() ? reviewing.clientLabel : 'An unnamed program'}
                  </p>
                  <p className="mt-2">
                    {reviewing.clientLabel?.trim()
                      ? 'If you did not start this from your own terminal just now, deny it.'
                      : 'It sent no name. A CLI you started yourself normally sends one, so treat an unnamed request as a reason to deny.'}
                  </p>
                </ApprovalRequiredBanner>
              </div>
            )}

            {/*
              The scope, in the two halves a person deciding actually needs.
              Not a restatement of the allow-list: a list of twenty routes is
              not something anyone reads before clicking Approve.
            */}
            <div className="text-sm leading-relaxed text-[var(--v2-ink-2)]">
              <p className="mb-2">
                <strong className="text-[var(--v2-ink)]">It can</strong> create and manage agents,
                set up a connection, and read your account — wallets, activity and transactions.
              </p>
              <p>
                <strong className="text-[var(--v2-ink)]">It cannot</strong> sign anything, approve a
                budget, change your signers, move funds, change your credentials, or re-key an
                agent — neither its delegate key nor its API key. Approving a budget stays with
                you, here.
              </p>
            </div>

            {outcome.kind === 'error' && (
              <p role="alert" className="text-sm text-[var(--v2-danger)]">
                {outcome.message}
              </p>
            )}

            <div className="flex gap-3">
              <Button type="submit" disabled={!code.trim() || busy}>
                {reviewing
                  ? submitting === 'approve'
                    ? 'Approving…'
                    : 'Approve'
                  : submitting === 'lookup'
                    ? 'Checking…'
                    : 'Continue'}
              </Button>
              {/* `ghost`, not `tertiary`. Tertiary is the system's weakest
                  variant — borderless muted text — and pairing it against a
                  filled primary Approve weights this screen toward granting,
                  on the one screen built to stop a rushed approval. Ghost
                  keeps a border, so Deny reads as a real second option. */}
              {reviewing && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void decide(reviewing, true)}
                >
                  {submitting === 'deny' ? 'Denying…' : 'Deny'}
                </Button>
              )}
            </div>
          </form>
        </Card.Section>
      </Card>
    </>
  )
}
