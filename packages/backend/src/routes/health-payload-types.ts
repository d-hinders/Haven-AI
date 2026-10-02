/**
 * The `/health/ops` payload SHAPE (#3514), lifted into its own minimal module
 * so `GET /ops/health` can type the injected diagnostics builder WITHOUT
 * importing `routes/health.ts` — the ops invariant-1 walk
 * (`__tests__/ops.invariants.test.ts`) forbids the ops graph from reaching
 * `infra/relayer*`, which the health route module imports. `routes/health.ts`
 * imports these types from here; its payload construction is unchanged.
 *
 * Every member is the original interface, re-declared structurally identical
 * — a test pins that `HealthRouteOptions` stays assignable to the builder
 * input, so a drift between the two is a compile error.
 */

/** `RelayerBalanceStatus` (`infra/relayer-balance-monitor.ts`), structurally. */
export interface HealthRelayerStatus {
  chainId: number
  address: string
  balanceWei: string
  low: boolean
  checkedAt: string
}

/** `PassportReadiness` (`modules/passport/readiness.ts`), structurally. */
export interface HealthPassportReadiness {
  verification: {
    configured: boolean
    issuer: string | null
  }
  chains: {
    chainId: number
    issuanceConfigured: boolean
    verificationConfigured: boolean
    state: 'ready' | 'issuance_only' | 'verification_only' | 'unconfigured'
  }[]
  unverifiableChainIds: number[]
}

/** The webhook receiver's nine per-answer-class counters (#3019). */
export interface HealthWebhookCounters {
  received: number
  bad_signature: number
  stale: number
  unknown_token: number
  duplicate: number
  processed: number
  feature_off: number
  unknown_type: number
  confirmed: number
}

/** What the `/health/ops` route reports for `accounting`. */
export type HealthOpsAccounting =
  | (HealthAccountingOpsCounters & { unavailable?: false })
  | { exhaustedSyncs: null; connectionsNeedingAttention: null; webhookCounters: null; unavailable: true }

/** `AccountingOpsCounters` (`modules/accounting/ops-signals.ts`), structurally. */
export interface HealthAccountingOpsCounters {
  exhaustedSyncs: number
  connectionsNeedingAttention: number
  webhookCounters: HealthWebhookCounters
}

/** The request-validation plugin's shadow counters (#3029, #3208). */
export interface HealthRequestValidationSnapshot {
  mode: 'off' | 'shadow' | 'enforce'
  wouldRefuse: number
  wouldCoerce: number
  byRouteField: Record<string, number>
  coerceByRouteField: Record<string, number>
  since: string
  seenByRoute: Record<string, number>
}

/**
 * The `GET /health/ops` payload — and what `GET /ops/health` embeds as
 * `ops_diagnostics`. Both routes are served by ONE builder
 * (`routes/health.ts` `buildHealthOpsPayload`); this type is what that
 * builder returns.
 */
export interface HealthOpsPayload {
  relayer: HealthRelayerStatus[]
  passport: HealthPassportReadiness
  trustProxy: {
    hops: number
    authRateLimitArmed: boolean
  }
  accounting: HealthOpsAccounting
  request_validation: HealthRequestValidationSnapshot
}

/** What a diagnostics builder needs — `HealthRouteOptions`, structurally. */
export interface HealthOpsInputs {
  checkDatabase: () => Promise<unknown>
  getRelayerStatus: () => HealthRelayerStatus[]
  getPassportStatus: () => HealthPassportReadiness
  trustProxyHops: number
  opsToken: string
  getAccountingCounters: () => Promise<HealthAccountingOpsCounters>
}
