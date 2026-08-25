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
import * as reportingFeedSyncs from './033_reporting_feed_syncs.js'
import * as baseDefaultChain from './034_base_default_chain.js'
import * as merchantCatalogSeedExpansion from './035_merchant_catalog_seed_expansion.js'
import * as executionRail from './036_execution_rail.js'
import * as merchantCatalogAssetTransferMethods from './037_merchant_catalog_asset_transfer_methods.js'
import * as agentRecipients from './038_agent_recipients.js'
import * as sessionScheduleWindow from './039_session_schedule_window.js'
import * as hybridAccounts from './041_hybrid_accounts.js'
import * as agentDelegations from './042_agent_delegations.js'
import * as delegationIntents from './043_delegation_intents.js'
import * as hybridAccountPasskeys from './044_hybrid_account_passkeys.js'
import * as dropSessionRailTables from './045_drop_session_rail_tables.js'
import * as singleSignerWaiver from './046_single_signer_waiver.js'
import * as merchantReceipts from './047_merchant_receipts.js'
import * as agentPassports from './048_agent_passports.js'
import * as agentPassportRevocation from './049_agent_passport_revocation.js'
import * as agentPassportRevocationIndex from './050_agent_passport_revocation_index.js'
import * as agentPassportAddresses from './051_agent_passport_addresses.js'
import * as agentConnectionSetupPassport from './052_agent_connection_setup_passport.js'
import * as paymentIntentBudgetDelegationHash from './053_payment_intent_budget_delegation_hash.js'
import * as relayerGasEvents from './054_relayer_gas_events.js'
import * as allowanceNonceWatermarks from './055_allowance_nonce_watermarks.js'
import * as multiPasskeyPerChain from './056_multi_passkey_per_chain.js'
import * as fixMppDemoCatalogUrl from './057_fix_mpp_demo_catalog_url.js'
import * as demoMerchantCatalog from './058_demo_merchant_catalog.js'
import * as retireMppDemoCatalog from './059_retire_mpp_demo_catalog.js'
import * as agentsArchivedAt from './060_agents_archived_at.js'
import * as outboundTxs from './061_outbound_txs.js'
import * as normalizePriceDisplay from './062_normalize_price_display.js'
import * as rateLimitCounters from './063_rate_limit_counters.js'
import * as labelStrandingFixture from './064_label_stranding_fixture.js'
import * as agentRekeys from './065_agent_rekeys.js'
import * as catalogSubmissions from './066_catalog_submissions.js'
import * as agentsMcpServerName from './067_agents_mcp_server_name.js'
import * as catalogLifecycle from './068_catalog_lifecycle.js'
import * as dropSafeApproverMetadata from './069_drop_safe_approver_metadata.js'

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
  reportingFeedSyncs,
  baseDefaultChain,
  merchantCatalogSeedExpansion,
  executionRail,
  merchantCatalogAssetTransferMethods,
  agentRecipients,
  sessionScheduleWindow,
  hybridAccounts,
  agentDelegations,
  delegationIntents,
  hybridAccountPasskeys,
  dropSessionRailTables,
  singleSignerWaiver,
  merchantReceipts,
  agentPassports,
  agentPassportRevocation,
  agentPassportRevocationIndex,
  agentPassportAddresses,
  agentConnectionSetupPassport,
  paymentIntentBudgetDelegationHash,
  relayerGasEvents,
  allowanceNonceWatermarks,
  multiPasskeyPerChain,
  fixMppDemoCatalogUrl,
  demoMerchantCatalog,
  retireMppDemoCatalog,
  agentsArchivedAt,
  outboundTxs,
  normalizePriceDisplay,
  rateLimitCounters,
  labelStrandingFixture,
  agentRekeys,
  catalogSubmissions,
  agentsMcpServerName,
  catalogLifecycle,
  dropSafeApproverMetadata,
]
