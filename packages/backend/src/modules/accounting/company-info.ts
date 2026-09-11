/**
 * Company info at connect (#2864, epic #2858) — the step both generic
 * flows (`oauth-flow.ts`, `api-key-flow.ts`) run AFTER the secrets are
 * stored and the feed-from floor is settled, with what the connector's
 * `getCompanyInfo` reported. Two decisions live here so they are made once:
 *
 * ## A reconnect to a different company is a company switch
 *
 * The row is keyed (user, provider), so a user who reconnects Fortnox to a
 * different company (a new `DatabaseNumber`) lands on the SAME row. Owner
 * decision 2026-09-11: keep the row, replace the company fields, set
 * `feed_from = now` so nothing settled before the switch is fed into the new
 * company, and record the switch — `status_reason` for the dashboard, the
 * append-only `settings.companySwitches` log for attribution, and one
 * structured log line for on-call. Existing `pushed` sync rows are untouched:
 * their external refs live in the previous company, and the verification-
 * gated reopen (`reopenPushedPayment` in `connections.ts`) refuses them.
 *
 * Only a change between two KNOWN ids is a switch. A row whose stored id is
 * null (a pre-#2864 grant that could not read the company) gaining an id is
 * not one — there is nothing to compare, so the floor it had is kept and the
 * fields are simply filled in. That limit is documented in the runbook.
 *
 * ## A scope refusal on the company read marks the row `scope_missing`
 *
 * `ProviderCompanyInfo.scopeMissing` is set by a connector ONLY when it tried
 * and was refused for scope (never on a network error — `getCompanyInfo`
 * throws those, and the flow refuses the connect). The connection is stored
 * and flipped to `scope_missing` with a reason, so the dashboard asks for a
 * re-consent; the feed has no destination until then, exactly as after a
 * post-push scope error (#2862).
 */

import {
  companySwitchLog,
  recordCompanySwitch,
  setCompanyInfo,
  setStatus,
  type AccountingConnectionRow,
} from '../../infra/repositories/accounting-connections.js'
import type { AccountingProvider, ProviderCompanyInfo } from './provider.js'

export { companySwitchLog }

/** The `status_reason` written on a company switch — names both companies, never a secret. */
export function companySwitchReason(from: { id: string; name: string | null }, to: { id: string; name: string | null }, at: Date): string {
  const label = (c: { id: string; name: string | null }) => (c.name ? `${c.name} (${c.id})` : c.id)
  return `company switched ${at.toISOString()}: ${label(from)} → ${label(to)} — feed_from moved to the switch; earlier pushes belong to the previous company`
}

/** The `status_reason` written when the company read was refused for scope. */
export function companyScopeMissingReason(provider: AccountingProvider): string {
  return `company info unavailable: the ${provider.displayName} grant lacks the scope to read company information — reconnect to obtain it`
}

/**
 * Apply what the provider said about the company to the freshly stored row.
 * `existed` is the row as it was BEFORE this connect (null on a first
 * connect); `saved` is the row after the upsert and the feed-from stamp.
 * Returns the row as it now is.
 */
export async function applyCompanyInfo(input: {
  provider: AccountingProvider
  userId: string
  existed: AccountingConnectionRow | null
  saved: AccountingConnectionRow
  info: ProviderCompanyInfo
  now?: Date
}): Promise<AccountingConnectionRow> {
  const { provider, userId, existed, info } = input
  const now = input.now ?? new Date()
  let row: AccountingConnectionRow

  // MUTATION TARGET (company-switch.db.test.ts): without this branch a
  // reconnect to another company keeps the old floor and the next sync feeds
  // the previous company's history into the new one.
  const switched =
    existed !== null &&
    existed.external_company_id !== null &&
    info.externalCompanyId !== null &&
    existed.external_company_id !== info.externalCompanyId
  if (switched) {
    const from = { id: existed.external_company_id as string, name: existed.external_company_name }
    const to = { id: info.externalCompanyId as string, name: info.name }
    const reason = companySwitchReason(from, to, now)
    const updated = await recordCompanySwitch(userId, provider.id, {
      from: { externalCompanyId: from.id, name: from.name },
      to: { externalCompanyId: to.id, name: to.name, baseCurrency: info.baseCurrency },
      at: now,
      reason,
    })
    // Structured, one line, no secrets: what on-call greps for.
    console.info(
      JSON.stringify({
        event: 'accounting_company_switch',
        provider: provider.id,
        userId,
        fromCompanyId: from.id,
        toCompanyId: to.id,
        feedFrom: now.toISOString(),
      }),
    )
    row = updated ?? {
      ...input.saved,
      external_company_id: to.id,
      external_company_name: to.name,
      base_currency: info.baseCurrency,
      feed_from: now,
      status_reason: reason,
    }
  } else {
    await setCompanyInfo(userId, provider.id, info)
    row = {
      ...input.saved,
      external_company_id: info.externalCompanyId,
      external_company_name: info.name,
      base_currency: info.baseCurrency,
    }
  }

  if (info.scopeMissing) {
    const reason = companyScopeMissingReason(provider)
    await setStatus(userId, provider.id, 'scope_missing', reason)
    row = { ...row, status: 'scope_missing', status_reason: reason }
  }
  return row
}
