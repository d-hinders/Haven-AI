import type { PoolClient } from 'pg'
import * as initial from './000_initial.js'
import * as selfSignAgents from './001_self_sign_agents.js'
import * as selfSignPaymentIntents from './002_self_sign_payment_intents.js'
import * as x402Resources from './003_x402_resources.js'
import * as simplifyPolicy from './004_simplify_policy.js'
import * as dashboardOverview from './005_dashboard_overview.js'
import * as userPasskeys from './006_user_passkeys.js'
import * as accountDefaultName from './007_account_default_name.js'
import * as userName from './008_user_name.js'
import * as ownerAliases from './009_owner_aliases.js'
import * as x402StandardMetadata from './010_x402_standard_metadata.js'
import * as approvalRequestSource from './011_approval_request_source.js'
import * as machinePaymentMetadata from './012_machine_payment_metadata.js'
import * as machinePaymentReconciliationEvents from './013_machine_payment_reconciliation_events.js'
import * as machinePaymentEvidence from './014_machine_payment_evidence.js'
import * as agentToolInvocations from './015_agent_tool_invocations.js'
import * as agentLastSeen from './016_agent_last_seen.js'
import * as agentConnectionSetups from './017_agent_connection_setups.js'
import * as machinePaymentApprovalEvidenceRefs from './018_machine_payment_approval_evidence_refs.js'
import * as merchantCatalog from './019_merchant_catalog.js'
import * as sendIdempotencyKey from './020_send_idempotency_key.js'
import * as onboardingEvents from './021_onboarding_events.js'
import * as delegateSweeps from './022_delegate_sweeps.js'
import * as delegateSweepTxHashIndex from './023_delegate_sweep_tx_hash_index.js'
import * as safeApproverMetadata from './024_safe_approver_metadata.js'
import * as catalogConsecutiveFailures from './025_catalog_consecutive_failures.js'
import * as machinePaymentBookTimeFx from './026_machine_payment_book_time_fx.js'
import * as fortnoxConnections from './027_fortnox_connections.js'
import * as merchantAccountOverrides from './028_merchant_account_overrides.js'
import * as paymentFees from './029_payment_fees.js'
import * as merchantCatalogCountry from './030_merchant_catalog_country.js'
import * as dropLegacyPlaintextApiKey from './031_drop_legacy_plaintext_api_key.js'
import * as accountEntitlements from './032_account_entitlements.js'

export interface Migration {
  version: string
  up: (client: PoolClient) => Promise<void>
}

/**
 * All migrations, in execution order.
 * Add new migrations here — versions must be unique and sortable.
 * Convention: `NNN_short_description.ts` where NNN is zero-padded.
 */
export const migrations: Migration[] = [
  initial,
  selfSignAgents,
  selfSignPaymentIntents,
  x402Resources,
  simplifyPolicy,
  dashboardOverview,
  userPasskeys,
  accountDefaultName,
  userName,
  ownerAliases,
  x402StandardMetadata,
  approvalRequestSource,
  machinePaymentMetadata,
  machinePaymentReconciliationEvents,
  machinePaymentEvidence,
  agentToolInvocations,
  agentLastSeen,
  agentConnectionSetups,
  machinePaymentApprovalEvidenceRefs,
  merchantCatalog,
  sendIdempotencyKey,
  onboardingEvents,
  delegateSweeps,
  delegateSweepTxHashIndex,
  safeApproverMetadata,
  catalogConsecutiveFailures,
  machinePaymentBookTimeFx,
  fortnoxConnections,
  merchantAccountOverrides,
  paymentFees,
  merchantCatalogCountry,
  dropLegacyPlaintextApiKey,
  accountEntitlements,
]
