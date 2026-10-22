'use client'

/**
 * The agent page's Settings tab (#4228, epic #4224).
 *
 * One `Card` of `Card.Section divided` rows under a small "This agent" label,
 * then the account-level items under "On {account name}" — the account page's
 * Security & details tab, mirrored. The page (`AgentDetailClient`) owns the
 * `?tab=` parameter and the modals; every control here OPENS one of those
 * page-owned flows, so each action stays reachable from the header ⋮ menu as
 * well. Nothing in this file duplicates a modal's own state.
 *
 * Row-by-row, and the state rules that came with them:
 *
 * 1. **Connection** — the MCP server name with copy (`McpServerName`, #4209),
 *    the last-active time, and #2043's `not recorded` note as visible text.
 *    A null name alone is NOT "no connection": an MCP agent connected before
 *    names were recorded has neither label nor anything to point at, so the
 *    row says "No MCP connection recorded" only when it has NEVER seen the
 *    agent (no name AND no `mcp_last_seen_at`) — and even then it does not
 *    say "API key", because a null name alone cannot tell an API-key agent
 *    from an unrecorded MCP one. The API-key line is its own line, shown
 *    whenever the agent has an API-key prefix (the visible, non-secret half
 *    of the credential; the full key is shown once at creation and lives in
 *    `PaymentCredentialsModal`).
 * 2. **Payment credentials** — View (`PaymentCredentialsModal`) and Replace
 *    signing key (`ReplaceSigningKeyModal`), gated exactly like the ⋮ menu's
 *    `canManageCredentials`: hidden for revoked and archived agents.
 * 3. **Labels** — the chips plus Edit, which opens `EditAgentModal` (where
 *    this agent's labels are set, #3167). `LabelsManagerModal` manages the
 *    vocabulary itself and stays in the ⋮ menu. Readable in every state; the
 *    Edit control follows the modal's own gate (`canEditDetails`) — a revoked
 *    agent has no mounted editor to open.
 * 4. **Tax declaration** — `TaxDeclarationToggle`, which owns its row and
 *    divider and renders only when the company details are VIES-valid; the
 *    row is absent otherwise, with no orphan divider.
 * 5. **Agent Passport** — `AgentPassportCard`'s content as a row. Its own
 *    revoked-only gate stands (archived agents are not newly gated).
 *
 * Under "On {account name}": a linked row to the account's Backup & recovery
 * — the account's Security & details tab (`?tab=security`). A pointer, not a
 * second copy (#1089).
 */

import { ArrowRight } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { timeAgo } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Row } from '@/components/ui/Row'
import { LabelChipRow } from '@/components/haven/LabelChip'
import AgentPassportCard from '@/components/AgentPassportCard'
import {
  MCP_NOT_RECORDED_NOTE,
  McpServerName,
  hasUnrecordedMcpServerName,
} from '@/components/agent-panel/McpServerName'
import { TaxDeclarationToggle } from '@/components/agent-panel/TaxDeclarationToggle'
import type { Agent } from '@/hooks/useAgents'

/** The divided rows' shared geometry — the card's rows align on this. */
const ROW_CLASS = 'px-4 py-4 md:px-6 md:py-5'

/** The row titles' shared type — one `h3` register across the card. */
const ROW_TITLE_CLASS = 'text-base font-semibold text-[var(--v2-ink)]'

/**
 * The value side of a label/value line — the same mono chip shape
 * `McpServerName` renders, so the two credentials read as one system.
 */
const VALUE_CHIP_CLASS =
  'v2-tabular truncate rounded bg-[var(--v2-surface-2)] px-1.5 py-0.5 font-mono text-xs text-[var(--v2-ink-2)]'

interface Props {
  agent: Agent
  /** The agent's account; null while the user's accounts are still loading. */
  account: { id: string; name: string } | null
  isRevoked: boolean
  /** Revoked or archived — the ⋮ menu's credential gate, verbatim. */
  canManageCredentials: boolean
  /** The editor's gate: `EditAgentModal` is not mounted for a revoked agent. */
  canEditDetails: boolean
  onOpenCredentials: () => void
  onOpenReplaceKey: () => void
  onOpenEditAgent: () => void
  /** Refetch the agents list after the tax toggle writes. */
  onAgentsChanged: () => void
}

export default function AgentSettingsTab({
  agent,
  account,
  isRevoked,
  canManageCredentials,
  canEditDetails,
  onOpenCredentials,
  onOpenReplaceKey,
  onOpenEditAgent,
  onAgentsChanged,
}: Props) {
  // "No MCP connection recorded" is the never-seen case ONLY — a null name
  // alone also means an MCP agent that connected before names were recorded
  // (see the component header).
  const neverConnectedToMcp = !agent.mcp_server_name && !agent.mcp_last_seen_at

  return (
    <div className="space-y-6">
      <section data-testid="agent-settings-card-section">
        <h2 className="v2-text-meta font-medium uppercase tracking-wider text-[var(--v2-ink-3)]">
          This agent
        </h2>
        <Card hover={false} className="mt-2">
          {/* 1. Connection (#4209 moved the name here from the /agents card;
              #4228 gives it a row of its own). `mcp-server-name-row` is the
              layout contract #4209's tests and the mobile tooltip
              reachability spec select on — it stays on this row. */}
          <div className={ROW_CLASS} data-testid="mcp-server-name-row">
            <h3 className={ROW_TITLE_CLASS}>Connection</h3>
            {neverConnectedToMcp ? (
              <p className="mt-2 text-sm text-[var(--v2-ink-3)]">
                No MCP connection recorded
              </p>
            ) : (
              <>
                <div className="mt-2 flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1">
                  <span className="text-sm text-[var(--v2-ink-2)]">MCP server name</span>
                  <McpServerName value={agent.mcp_server_name} />
                </div>
                {agent.mcp_last_seen_at ? (
                  <p className="mt-1 text-xs text-[var(--v2-ink-3)]">
                    Last active {timeAgo(agent.mcp_last_seen_at)}
                  </p>
                ) : null}
                {hasUnrecordedMcpServerName([agent]) ? (
                  <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-3)]">
                    {MCP_NOT_RECORDED_NOTE}
                  </p>
                ) : null}
              </>
            )}
            {/* The API-key line is the credential, not the connection state —
                it shows whenever the agent has a prefix, in every state above
                (including "No MCP connection recorded"). */}
            {agent.api_key_prefix ? (
              <div className="mt-2 flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1">
                <span className="text-sm text-[var(--v2-ink-2)]">API key</span>
                <span className={VALUE_CHIP_CLASS}>{agent.api_key_prefix}</span>
              </div>
            ) : null}
          </div>

          {/* 2. Payment credentials — hidden exactly when the ⋮ menu hides
              its items (`canManageCredentials`), so a state never shows one
              route to a revoked agent's credential and not the other. */}
          {canManageCredentials ? (
            <Card.Section divided>
              <div className={ROW_CLASS} data-testid="payment-credentials-row">
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <h3 className={ROW_TITLE_CLASS}>Payment credentials</h3>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={onOpenCredentials}>
                      View
                    </Button>
                    <Button variant="ghost" size="sm" onClick={onOpenReplaceKey}>
                      Replace signing key
                    </Button>
                  </div>
                </div>
                <p className="mt-1 text-xs text-[var(--v2-ink-3)]">
                  The Haven API credential this agent authenticates with, and
                  the signing key its payments are made under.
                </p>
              </div>
            </Card.Section>
          ) : null}

          {/* 3. Labels (#3167) — the chips are readable in every state; the
              editor is `EditAgentModal`, the same one the ⋮ menu opens. */}
          <Card.Section divided>
            <div className={ROW_CLASS} data-testid="labels-row">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <h3 className={ROW_TITLE_CLASS}>Labels</h3>
                {canEditDetails ? (
                  <Button variant="ghost" size="sm" onClick={onOpenEditAgent}>
                    Edit
                  </Button>
                ) : null}
              </div>
              {agent.labels.length > 0 ? (
                <div className="mt-2">
                  <LabelChipRow labels={agent.labels} />
                </div>
              ) : (
                <p className="mt-1 text-sm text-[var(--v2-ink-3)]">No labels yet.</p>
              )}
            </div>
          </Card.Section>

          {/* 4. Tax declaration — the toggle owns its row, divider and
              visibility rule (VIES-valid only); absent otherwise. */}
          <TaxDeclarationToggle
            agentId={agent.id}
            taxDeclarationEnabled={agent.tax_declaration_enabled}
            onAgentsChanged={onAgentsChanged}
          />

          {/* 5. Agent Passport — `AgentPassportCard` renders the row block;
              the divided section carries its hairline. Its revoked-only gate
              stands inside the component (archived is NOT gated there). */}
          <Card.Section divided>
            <AgentPassportCard agentId={agent.id} agentRevoked={isRevoked} />
          </Card.Section>
        </Card>
      </section>

      {/* The account-level item (#1089): a pointer to the account's Security
          & details tab, never a second copy of the controls. */}
      {account ? (
        <section data-testid="agent-account-section">
          <h2 className="v2-text-meta font-medium uppercase tracking-wider text-[var(--v2-ink-3)]">
            On {account.name}
          </h2>
          <Card hover={false} className="mt-2">
            <Row
              href={`/accounts/${account.id}?tab=security`}
              title="Backup & recovery"
              subtitle={`Managed on ${account.name}: it covers every agent on it`}
              trailing={<Icon icon={ArrowRight} className="h-4 w-4 text-[var(--v2-ink-3)]" />}
            />
          </Card>
        </section>
      ) : null}
    </div>
  )
}
