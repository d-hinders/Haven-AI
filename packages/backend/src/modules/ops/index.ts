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

export { maskEmail, maskHex, maskName, maskSearchTerm } from './masking.js'
