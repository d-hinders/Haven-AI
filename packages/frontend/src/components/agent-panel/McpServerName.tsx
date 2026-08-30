'use client'

/**
 * The MCP server name an agent is wired as (#1878, epic #1694).
 *
 * One runtime config can hold several Haven agents, each as its own
 * hosted+signer MCP pair keyed by server name. Without this, a user looking
 * at three agents in the dashboard has no way to map any of them to an entry
 * in their MCP config — the same illegibility #1694 is about, one layer up.
 *
 * Deliberately in `agent-panel/` rather than `ui/` or `haven/`: the null copy
 * below is agent-wiring product logic, not a reusable primitive, and a
 * general-looking export would invite call sites that do not want its
 * semantics.
 *
 * ## Why "not recorded" is not "unnamed"
 *
 * The tempting empty state is to show the bare `haven` pair, since that is
 * what an agent with no name would be. It is wrong: `--name` shipped in
 * #1696, so agents wired with a named pair exist today with nothing recorded
 * server-side, and they are exactly the agents this component exists to tell
 * apart. So absent renders as absent. The copy also has to avoid implying the
 * agent is broken — the overwhelming majority of agents are in this state and
 * every one of them works fine.
 *
 * ## Where the explanation lives, and why not here (#2043)
 *
 * The card shows the bare `not recorded` label and nothing else. The sentence
 * that explains it is hoisted to ONE note above the agent list
 * (`MCP_NOT_RECORDED_NOTE`, rendered by `AgentPanel` only when some listed
 * agent is unrecorded) — see that constant for the reasoning.
 */

import { CopyButton } from '@/components/ui/CopyButton'
import { Tooltip } from '@/components/ui/Tooltip'

/** The signer half is derived, never stored — one naming rule, one home. */
export function signerNameFor(hosted: string): string {
  return hosted === 'haven' ? 'haven-signer' : `haven-signer-${hosted.slice('haven-'.length)}`
}

/**
 * The `not recorded` explanation, shown ONCE above the agent list as visible
 * text — not per card, and not in a `Tooltip` (#2043).
 *
 * ### Why it cannot stay in a tooltip
 *
 * It used to be a 169-character `Tooltip` label on the `not recorded` span.
 * #2038 made `Tooltip` reachable by keyboard and touch, but only where the
 * trigger is nobody else's control, and this call site is **structurally
 * excluded** rather than merely missed: `AgentCard` wraps the whole card in a
 * composite `role="link"` with its own `tabIndex` and `onClick`
 * (`AgentCard.tsx:121-126`), which `Tooltip`'s `INTERACTIVE_ANCESTOR` check
 * matches (`Tooltip.tsx:101, 191-194`). A tab stop on the trigger would nest a
 * control inside a control; a tap would fire alongside the card's navigation
 * and strand a bubble over the destination. Both are worse than the defect, so
 * the primitive correctly refuses the job and no change to it can rescue this
 * copy. `Tooltip`'s own header says so.
 *
 * The copy is **essential**, not elaboration: it exists to stop a user
 * concluding their agent is broken, and it explains an ABSENCE — there is no
 * visible value for it to elaborate on. `docs/product/design-review.md:108`
 * ("do not hide essential instructions") therefore rules the tooltip out on
 * content grounds even where reachability is available.
 *
 * ### Why once, above the list, and only sometimes
 *
 * This is #2017's shape (PR #2039, `AccountDetailClient`'s
 * `UNKNOWN_APPROVER_NOTE`): one visible sentence beside the list, rendered
 * only when some row is actually in the state it explains. Matching it rather
 * than inventing a second shape is deliberate — two idioms for one problem is
 * the divergence #2195 and #2216 were filed to clean up. Per card would repeat
 * a 200-character sentence in a two-column grid where the overwhelming
 * majority of cards are in this state; unconditionally would explain a label
 * that is not on screen.
 */
export const MCP_NOT_RECORDED_NOTE =
  'Not recorded means Haven has no MCP server name for that agent. Haven records the name when an agent connects with a current version of the connector — agents connected earlier keep working exactly as they are, and only the label is missing.'

/**
 * Does any of these agents render the `not recorded` label?
 *
 * The predicate lives beside the component that decides what "unrecorded"
 * means, so the note above the list and the label inside the card cannot drift
 * apart — the failure mode is a note explaining a label nobody can see, or a
 * label with no note. Same falsiness test as the component's own branch.
 */
export function hasUnrecordedMcpServerName(
  agents: ReadonlyArray<{ mcp_server_name?: string | null }>,
): boolean {
  return agents.some((agent) => !agent.mcp_server_name)
}

export function McpServerName({ value }: { value: string | null | undefined }) {
  if (!value) {
    // Bare label, no tooltip. The explanation is `MCP_NOT_RECORDED_NOTE`,
    // above the list — see there for why (#2043).
    return <span className="text-xs text-[var(--v2-ink-3)]">not recorded</span>
  }

  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      {/*
        This tooltip STAYS, and the distinction is the point of #2043.

        It elaborates a value that is already on screen: the truncated name is
        visible, and the tooltip adds its untruncated form plus the derived
        signer half of the pair. A user who never reaches it has still read the
        name and can still copy it verbatim with the button beside it — the
        `CopyButton` is a sibling, so nothing here is the tooltip's only route
        to the information. That is elaboration, and hover-only is what
        `Tooltip` is for (`Tooltip.tsx:4-16`).

        The null branch above was the opposite on every count: no visible value
        to elaborate, and the copy was the only place the fact existed.
        Reachability was the symptom; essential-copy-behind-hover was the
        defect.
      */}
      <Tooltip label={`MCP servers: ${value} and ${signerNameFor(value)}`} mono>
        <span className="v2-tabular truncate rounded bg-[var(--v2-surface-2)] px-1.5 py-0.5 font-mono text-xs text-[var(--v2-ink-2)]">
          {value}
        </span>
      </Tooltip>
      <CopyButton value={value} label="MCP server name" />
    </span>
  )
}
