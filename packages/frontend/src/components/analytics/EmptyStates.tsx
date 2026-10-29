'use client'

import { CircleAlert, PiggyBank } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Icon } from '@/components/ui/Icon'

/**
 * The Analytics page's empty and failure states (#2947, epic #2944 slice C;
 * the new-user state #4333).
 *
 * Three shapes the data can honestly take that are not "the page worked":
 *
 *   - the user has no agents at all → one new-user empty state, which
 *     replaces the zero tiles and the empty sections (#4333);
 *   - an agent-owning user's window holds nothing → the tiles give way to
 *     one EmptyState naming the window, not four tiles asserting zeros;
 *   - the request failed → one error state with one retry.
 *
 * The load-bearing distinction is between the states that report a fact and
 * the one that reports nothing: an empty window and a new user both display
 * no figures, and a zero is a claim — so each says out loud which kind of
 * nothing it is, in the page's own words, rather than leaving the reader to
 * infer it. (The former sparse-data note is gone with the page-level sparse
 * band, #4333: sections render whenever the window has any activity and each
 * keeps its own guard.)
 */

/**
 * The new-user empty state (#4333): the user has NO agents at all — revoked
 * ones included — so there is no activity the page could ever report, and one
 * state replaces the zero tiles and the empty sections. The body says what
 * the page will show once an agent exists; the action opens the existing
 * connect flow on `/agents`, the one place a connection can be made.
 */
export function NewUserEmptyState() {
  return (
    <EmptyState
      icon={<Icon icon={PiggyBank} className="w-full h-full" />}
      tone="neutral"
      title="No agent activity yet"
      body="Connect an agent and this page will show what it spent, where payments were refused, and who it paid — over the window you choose."
      action={
        <Button variant="primary" size="sm" href="/agents">
          Connect agent
        </Button>
      }
    />
  )
}

/**
 * The whole-page empty state for an agent-owning user whose window holds
 * nothing: the request answered, and there is nothing in the range to report.
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
