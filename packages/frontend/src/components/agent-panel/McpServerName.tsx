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
 */

import { Check, Clipboard } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Tooltip } from '@/components/ui/Tooltip'
import { useCopyTimeout } from '@/hooks/useCopyTimeout'

/** The signer half is derived, never stored — one naming rule, one home. */
export function signerNameFor(hosted: string): string {
  return hosted === 'haven' ? 'haven-signer' : `haven-signer-${hosted.slice('haven-'.length)}`
}

export function McpServerName({ value }: { value: string | null | undefined }) {
  const { copied, markCopied } = useCopyTimeout(1500)

  if (!value) {
    return (
      <Tooltip label="Haven records this when an agent connects with a current version of the connector. Agents connected earlier keep working exactly as they are — only the label is missing.">
        <span className="text-xs text-[var(--v2-ink-3)]">MCP name not recorded</span>
      </Tooltip>
    )
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      markCopied()
    } catch {
      /* clipboard unavailable — the name is still readable on screen */
    }
  }

  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <Tooltip label={`MCP servers: ${value} and ${signerNameFor(value)}`} mono>
        <span className="v2-tabular truncate rounded bg-[var(--v2-surface-2)] px-1.5 py-0.5 font-mono text-xs text-[var(--v2-ink-2)]">
          {value}
        </span>
      </Tooltip>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? 'MCP server name copied' : `Copy MCP server name ${value}`}
        className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
      >
        {copied ? (
          <Icon icon={Check} className="h-3 w-3 text-[var(--v2-success)]" />
        ) : (
          <Icon icon={Clipboard} className="h-3 w-3" />
        )}
      </button>
    </span>
  )
}
