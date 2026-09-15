'use client'

import type { ReactNode } from 'react'
import { CircleAlert } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Icon } from '@/components/ui/Icon'

/**
 * The Analytics page's empty, sparse, and failure states (#2947, epic #2944
 * slice C).
 *
 * Four shapes the data can honestly take that are not "the page worked":
 *
 *   - no activity in the window    → the tiles give way to one EmptyState;
 *   - payments await their evidence → the Spent tile names what it excluded;
 *   - refusals predate the ledger  → the Refused tile names its floor;
 *   - fewer than three days of data → tiles only, with the reason on screen.
 *
 * Plus the request's own failure, which is NOT one of these four: a failed
 * request has not reported anything, and a page of honest zeros is exactly
 * what an outage most wants to be mistaken for. Hence the split.
 *
 * The load-bearing distinction in this file is between the first and the
 * second/third: an account with no payments and an account whose refusals
 * predate the ledger both display a zero, and a zero is a claim — so each one
 * says out loud which kind of nothing it is, in the page's own words, rather
 * than leaving the reader to infer it. None of them is a bare `0` where a
 * figure would sit.
 */

/**
 * The whole-page empty state: the request answered, and the window genuinely
 * holds nothing.
 *
 * One empty state rather than four empty tiles, because four tiles each
 * asserting "nothing" in the confident layout of a working page is the
 * screen-shape an outage passes for free; one sentence that says what was
 * looked for and what came back is not.
 */
export function NoActivityEmptyState() {
  return (
    <EmptyState
      icon={<Icon icon={CircleAlert} className="w-full h-full" />}
      tone="neutral"
      title="No agent activity in this range"
      body="This window has no payments, refusals or fees to report. A longer range may reach further back, and the Agents page shows what each agent is allowed to spend."
    />
  )
}

/**
 * The "awaiting settlement evidence" clause on the Spent tile, from
 * `basis.unsettled_submitted` — the count of payments stuck in `submitted`
 * because their settlement proof has not arrived.
 *
 * This sentence exists because a silently smaller total is indistinguishable
 * from a total that was always that size. A reader comparing two ranges, of
 * any two summaries, of any popular destinations on any agents' spending,
 * would take `Spent` at face value; only this line lets them know the figure
 * excludes what has been sent and not yet proved — payments which, once their
 * evidence lands, will be counted without any change to the window.
 */
export function UnsettledEvidenceFootnote({ count }: { count: number }) {
  return <>{count} awaiting settlement evidence {count === 1 ? 'is' : 'are'} not counted</>
}

/**
 * The ledger-floor clause of the Refused tile, from migration 086's first
 * recorded day as reported by the endpoint's own basis, namely
 * `basis.refusals_recorded_from` — the day from which refusals are recorded.
 *
 * Whereas the ledger of refusals was opened only on that day, all attempts
 * made before it in the window are, as far as this page can tell, without
 * record: not refused, and not accepted either, merely unrecorded. The date
 * therefore comes from the response and never from a date inferred here, and
 * this line sits beneath the tile's figure rather than replacing it — the
 * count above it remains the truth for the part of the window the ledger
 * covers.
 */
export function RefusalsRecordedFromFootnote({ fromDate }: { fromDate: string }) {
  return <>Refusals are recorded from {fromDate}. Earlier attempts have no refusal rows to report.</>
}

/**
 * The sparse-data note: fewer than three days of history in the window.
 *
 * The charts band renders nothing across one, two days of data (slice D's
 * rule), because a line drawn through one point is a line that agrees with
 * any trend whatsoever and proves none of them. So the page keeps the tiles —
 * a total over one day is still the total over that day — and states on the
 * face of the page what is missing and why, rather than leaving a blank
 * region for the reader to diagnose. The threshold is the product's, taken
 * from slice D; if in doubt the charts render nothing, the tiles always
 * render.
 */
export function SparseDataLine({ children }: { children?: ReactNode }) {
  return (
    <p className="text-sm text-[var(--v2-ink-2)]" data-testid="analytics-sparse-line">
      {children ?? 'The charts need at least three days of data to show a trend worth showing. Showing the figures alone until then.'}
    </p>
  )
}

/**
 * The one error state for the page: one request, one failure, one retry
 * (minus the automatic, plus any special characters of the retry handed
 * straight to the caller's refetch — `onRetry` above).
 *
 * The copy constrains what is said: the page names what did not load, offers
 * the one remedy it has evidence for, and adds nothing about cause, duration
 * or availability that the response did not report. The clause "your agents
 * keep spending under their existing rules" is there because a reader who
 * cannot see the page may reasonably fear it has stopped the money; it has
 * not — this page reads the money's history, and reading it is what failed.
 */
export function AnalyticsErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert">
      <EmptyState
        icon={<Icon icon={CircleAlert} className="w-full h-full" />}
        tone="danger"
        title="We could not load your analytics"
        body="Nothing here moved or changed. Your agents keep spending under the rules you set while this does not load."
        action={
          <Button variant="ghost" size="sm" onClick={onRetry}>
            Try again
          </Button>
        }
      />
    </div>
  )
}
