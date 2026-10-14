/**
 * Ops console module (#3509, epic #3507) — the public surface routes and
 * middleware import. See `routes/ops.ts` for the flow.
 */
export {
  OPS_TOKEN_PURPOSE,
  OPS_TOKEN_AUDIENCE,
  OPS_TOKEN_TTL_MS,
  OPS_STATE_PURPOSE,
  OPS_STATE_AUDIENCE,
  OPS_STATE_TTL_MS,
  signOpsToken,
  verifyOpsToken,
  signOpsState,
  verifyOpsState,
  type OpsOperator,
  type OpsOAuthState,
} from './tokens.js'

export {
  githubAuthorizeUrl,
  exchangeGithubCode,
  fetchGithubUser,
  GithubOAuthError,
  type FetchLike,
  type GithubUser,
} from './github.js'

export { maskEmail, maskFreeText, maskHex, maskName, maskSearchTerm } from './masking.js'

export { buildOpsOverview, type OpsOverview } from './overview.js'
export { buildOpsSponsoredGas, OPS_SPONSORED_GAS_DEFAULT_DAYS, type OpsSponsoredGas, type OpsSponsoredGasRow } from './sponsored-gas.js'
export { buildOpsFeedbackList, type OpsFeedbackList } from './feedback.js'
export {
  detectOpsSearchKey,
  runOpsSearch,
  OPS_SEARCH_BUDGET_MS,
  OPS_SEARCH_MIN_EMAIL_PREFIX,
  type OpsSearchHit,
  type OpsSearchKeyType,
  type OpsSearchLookup,
  type OpsSearchResult,
} from './search.js'
export { buildOpsUserDetail, type OpsUserDetail } from './users.js'
export {
  buildOpsHealth,
  collectStuckLanesForChain,
  OPS_HEALTH_LIST_LIMIT,
  PAST_HORIZON_SECONDS,
  type OpsDelegateBalanceReport,
  type OpsDelegateBalances,
  type OpsEvidenceOrphan,
  type OpsHealth,
  type OpsHealthDeps,
  type OpsSweepableIntent,
  type OpsStuckLane,
  type OpsStuckReanchor,
  type OpsStuckRevocation,
  type ServedChains,
  type SweepableWindow,
} from './health.js'
export {
  buildOpsOnchainView,
  onchainCacheKey,
  OPS_ONCHAIN_CACHE_TTL_MS,
  type BuildOpsOnchainViewOptions,
  type OnchainAccount,
  type OnchainAccountDelegation,
  type OnchainBudgetStatus,
  type OnchainDelegationState,
  type OnchainDeployStatus,
  type OnchainNotServedAccount,
  type OpsOnchainReaders,
  type OpsOnchainView,
} from './onchain.js'
