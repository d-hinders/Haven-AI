'use client'

/**
 * The agent page's Settings tab (#4228, epic #4224; rebuilt on the shared
 * settings rows by #4477).
 *
 * Two `SettingsSection`s, in this order:
 *
 * 1. **This agent** — one `SettingsRow` per item, in the mockup v2 shape:
 *    title and a one-line description on the left, the value and/or control
 *    on the right. The section heading is the sentence-case `v2-text-h3` that
 *    `SettingsSection` renders; the old `v2-text-meta` band is gone
 *    (§ Detail-page section rule, `docs/product/design-system.md`).
 * 2. **On {account name}** — one linked row pointing at the account's
 *    Security & details tab.
 *
 * The page (`AgentDetailClient`) owns the `?tab=` parameter and the modals;
 * every control here OPENS one of those page-owned flows, so each action
 * stays reachable from the header ⋮ menu as well. Nothing in this file
 * duplicates a modal's own state.
 *
 * Row-by-row, and the state rules that came with them:
 *
 * 1. **MCP server name** — the name with copy (`McpServerName`, #4209), the
 *    last-active time, and #2043's `not recorded` note as visible text. A
 *    null name alone is NOT "no connection": an MCP agent connected before
 *    names were recorded has neither label nor anything to point at, so the
 *    row says "No MCP connection recorded" only when it has NEVER seen the
 *    agent (no name AND no `mcp_last_seen_at`) — and even then it does not
 *    say "API key", because a null name alone cannot tell an API-key agent
 *    from an unrecorded MCP one.
 *
 *    The **API key** prefix (the visible, non-secret half of the credential;
 *    the full key is shown once at creation and lives in
 *    `PaymentCredentialsModal`) stays on THIS row's value slot, beside the
 *    server name. #4477's builder decision, and the reason it did not move to
 *    the Payment credentials row: that row is hidden for revoked and archived
 *    agents (`canManageCredentials`), while the prefix must stay visible on
 *    the tab in every state. It shows whenever the agent has a prefix,
 *    including the "No MCP connection recorded" state.
 * 2. **Payment credentials** — View (`PaymentCredentialsModal`) and Replace
 *    signing key (`ReplaceSigningKeyModal`), gated exactly like the ⋮ menu's
 *    `canManageCredentials`: hidden for revoked and archived agents.
 * 3. **Labels** — the chips plus Edit, which opens `EditAgentModal` (where
 *    this agent's labels are set, #3167). `LabelsManagerModal` manages the
 *    vocabulary itself and stays in the ⋮ menu. Readable in every state; the
 *    Edit control follows the modal's own gate (`canEditDetails`) — a revoked
 *    agent has no mounted editor to open.
 * 4. **Tax declaration** — `TaxDeclarationToggle`, which owns its row and
 *    renders only when the company details are VIES-valid; the row is absent
 *    otherwise, with no orphan divider.
 * 5. **Agent Passport** — `AgentPassportCard` renders the row itself (label,
 *    detail, action, and the issued-state `dl` in the full-width slot). Its
 *    own revoked-only gate stands (archived agents are not newly gated).
 *
 * Under "On {account name}": a linked row to the account's Who can approve
 * section — the account's Security & details tab (`?tab=security`). A pointer,
 * not a second copy (#1089). The row is the existing `Row` with `href`, not a
 * `SettingsRow` with a trailing chevron: `Row` renders the `<a>` around the
 * whole row, so the entire row is one link target and one focus stop. Its
 * `density="flush"` plus `px-6 py-4` matches the `SettingsRow` geometry the
 * card's other rows use (`p-0` is emitted before `px`/`py`, so the explicit
 * padding wins — `Row.tsx`'s #3204 note).
 */

import { ArrowRight } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { timeAgo } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Row } from '@/components/ui/Row'
import { SettingsRow, SettingsSection } from '@/components/ui/SettingsSection'
import { LabelChipRow } from '@/components/haven/LabelChip'
import AgentPassportCard from '@/components/AgentPassportCard'
import {
  MCP_NOT_RECORDED_NOTE,
  McpServerName,
  hasUnrecordedMcpServerName,
} from '@/components/agent-panel/McpServerName'
import { TaxDeclarationToggle } from '@/components/agent-panel/TaxDeclarationToggle'
import type { Agent } from '@/hooks/useAgents'

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
      <SettingsSection title="This agent" data-testid="agent-settings-card-section">
        {/* 1. MCP server name (#4209 moved the name here from the /agents
            card; #4228 gives it a row of its own; #4477 puts it on the shared
            row). `mcp-server-name-row` is the layout contract #4209's tests
            and the mobile tooltip reachability spec select on — it stays on
            this row. */}
        <SettingsRow
          data-testid="mcp-server-name-row"
          label="MCP server name"
          detail={
            <>
              <p>
                {neverConnectedToMcp
                  ? 'No MCP connection recorded'
                  : "The name this agent's MCP client registered with."}
              </p>
              {!neverConnectedToMcp && agent.mcp_last_seen_at ? (
                <p className="mt-1 text-xs text-[var(--v2-ink-3)]">
                  Last active {timeAgo(agent.mcp_last_seen_at)}
                </p>
              ) : null}
              {!neverConnectedToMcp && hasUnrecordedMcpServerName([agent]) ? (
                <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-3)]">
                  {MCP_NOT_RECORDED_NOTE}
                </p>
              ) : null}
            </>
          }
          value={
            <div className="flex flex-col items-start gap-1 sm:items-end">
              {neverConnectedToMcp ? null : <McpServerName value={agent.mcp_server_name} />}
              {/* The API-key line is the credential, not the connection state —
                  it shows whenever the agent has a prefix, in every state
                  above (including "No MCP connection recorded"). */}
              {agent.api_key_prefix ? (
                <span className="flex items-center gap-2">
                  <span className="text-xs text-[var(--v2-ink-3)]">API key</span>
                  <span className={VALUE_CHIP_CLASS}>{agent.api_key_prefix}</span>
                </span>
              ) : null}
            </div>
          }
        />

        {/* 2. Payment credentials — hidden exactly when the ⋮ menu hides its
            items (`canManageCredentials`), so a state never shows one route
            to a revoked agent's credential and not the other. */}
        {canManageCredentials ? (
          <SettingsRow
            data-testid="payment-credentials-row"
            label="Payment credentials"
            detail="The Haven API credential this agent authenticates with, and the signing key its payments are made under."
            action={
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="ghost" size="sm" onClick={onOpenCredentials}>
                  View
                </Button>
                <Button variant="ghost" size="sm" onClick={onOpenReplaceKey}>
                  Replace signing key
                </Button>
              </div>
            }
          />
        ) : null}

        {/* 3. Labels (#3167) — the chips are readable in every state; the
            editor is `EditAgentModal`, the same one the ⋮ menu opens. */}
        <SettingsRow
          data-testid="labels-row"
          label="Labels"
          detail="Group and filter agents on the Agents page."
          value={
            agent.labels.length > 0 ? (
              <LabelChipRow labels={agent.labels} />
            ) : (
              <EmptyState size="inline" bare title="No labels yet." className="px-0 py-0 text-left" />
            )
          }
          action={
            canEditDetails ? (
              <Button variant="ghost" size="sm" onClick={onOpenEditAgent}>
                Edit
              </Button>
            ) : undefined
          }
        />

        {/* 4. Tax declaration — the toggle owns its row and visibility rule
            (VIES-valid only); absent otherwise. #4435: it also owns the
            disabled state for an agent whose setup cannot carry a
            declaration, so the list read's `runtime_mcp_mode` is passed
            straight through. */}
        <TaxDeclarationToggle
          agentId={agent.id}
          taxDeclarationEnabled={agent.tax_declaration_enabled}
          runtimeMcpMode={agent.runtime_mcp_mode}
          onAgentsChanged={onAgentsChanged}
        />

        {/* 5. Agent Passport — `AgentPassportCard` renders the row itself;
            the divided section carries its hairline. Its revoked-only gate
            stands inside the component (archived is NOT gated there). */}
        <AgentPassportCard agentId={agent.id} agentRevoked={isRevoked} />
      </SettingsSection>

      {/* The account-level item (#1089): a pointer to the account's Security
          & details tab, never a second copy of the controls. */}
      {account ? (
        <SettingsSection title={`On ${account.name}`} data-testid="agent-account-section">
          <Row
            href={`/accounts/${account.id}?tab=security`}
            density="flush"
            className="px-6 py-4"
            title="Who can approve"
            subtitle={`Managed on ${account.name}: it covers every agent on it`}
            trailing={<Icon icon={ArrowRight} className="h-4 w-4 text-[var(--v2-ink-3)]" />}
          />
        </SettingsSection>
      ) : null}
    </div>
  )
}
