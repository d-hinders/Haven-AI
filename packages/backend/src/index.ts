// Third-party analytics off before anything in this process can load
// @metamask/smart-accounts-kit (#4216) — must stay the first import.
import './telemetry/kit-analytics-off.js'
// config.ts loads dotenv and validates required env vars — import first
import { config } from './config.js'
import { httpErrorHandler } from './infra/http-error-handler.js'
import { installRequestValidation } from './openapi/request-validation.js'

import Fastify, { type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import fastifyJwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import { rateLimitKeyFor } from './middleware/rate-limit.js'
import { SharedRateLimitStore, setRateLimitDegradedReporter } from './middleware/shared-rate-limit-store.js'
import { probeDatabase } from './infra/repositories/health-probe.js'
import { runMigrations } from './db/migrate.js'
import { reencryptPlaintextSecretsAtBoot } from './modules/accounting/index.js'
import { lastDelegateBalanceReport } from './infra/delegate-balance-report-store.js'
import { getRelayerBalanceStatus } from './infra/relayer-balance-monitor.js'
import { deployableChainIds, SUPPORTED_CHAIN_IDS } from './domain/chains.js'
import { relayerKeyEntriesFromEnv, relayerKeysFromEnv } from './infra/relayer-env-keys.js'
import { assertBindingKeyNotReused } from './infra/binding-key-collision.js'
// #4764: the background jobs are one importable table beside this composition
// root, started from one entry point — see `src/background-jobs.ts`.
import { startBackgroundJobs } from './background-jobs.js'
import discoveryRoutes from './routes/discovery.js'
import { buildApiRootDocument } from './routes/root-document.js'
import authRoutes from './routes/auth.js'
import userRoutes from './routes/user.js'
import ownerCompanyDetailsRoutes from './routes/owner-company-details.js'
import balanceRoutes from './routes/balances.js'
import transactionRoutes from './routes/transactions.js'
import receiveRoutes from './routes/receive.js'
import portfolioRoutes from './routes/portfolio.js'
import dashboardRoutes from './routes/dashboard.js'
// #3804: rides the /dashboard prefix as its own route FILE — #3803 is
// concurrently reworking the overview route/repository, and the
// request-validation rollout keys enforcedModules on the file.
import dashboardBudgetRemainingRoutes from './routes/dashboard-budget-remaining.js'
import agentRoutes from './routes/agents.js'
import agentTaxDeclarationRoutes from './routes/agent-tax-declaration.js'
import labelRoutes from './routes/labels.js'
import agentLabelRoutes from './routes/agent-labels.js'
import agentOrganizationRoutes from './routes/agent-organizations.js'
import hybridAccountRoutes from './routes/hybrid-accounts.js'
import agentDelegationRoutes from './routes/agent-delegations.js'
import agentRekeyRoutes from './routes/agent-rekey.js'
import agentPassportRoutes from './routes/agent-passports.js'
import {
  setAnchor,
  setAnchorRecovery,
  setAnchorLiveness,
  anchorOnChain,
  recoverAnchorFromReceipt,
  repairAnchorUidFromReceipt,
  classifyAnchorTxLiveness,
  setRevoker,
  revokeOnChain,
  setRevocationProbe,
  readRevocationAnchor,
  setAnchorUidRepair,
  setReceiptSigningKey,
  passportReadiness,
  logPassportReadiness,
} from './modules/passport/index.js'
import passportVerifyRoutes from './routes/passport-verify.js'
import agentConnectionSetupRoutes from './routes/agent-connection-setups.js'
import contactRoutes from './routes/contacts.js'
import feedbackRoutes from './routes/feedback.js'
import paymentRoutes from './routes/payments.js'
import agentActivityRoutes from './routes/agent-activity.js'
import x402Routes from './routes/x402.js'
import taskBudgetRoutes from './routes/task-budgets.js'
import agentTaskBudgetsOwnerRoutes from './routes/agent-task-budgets.js'
import subBudgetRoutes from './routes/sub-budgets.js'
import agentSubBudgetsOwnerRoutes from './routes/agent-sub-budgets.js'
import userAccountsRoutes from './routes/user-accounts.js'
import userAccountsRetiredRoutes from './routes/user-accounts-retired.js'
import passkeyRoutes from './routes/passkeys.js'
import safeDeployRoutes from './routes/safe-deploy.js'
import machinePaymentRoutes from './routes/machine-payments.js'
// #3031 round 2: `POST /machine-payments/reconciliation-events` in its own
// file so it can STAY SHADOWED while the rest of the machine-payments
// surface is enforced (owner decision, epic #3028 2026-09-24) — see that
// file's header.
import machinePaymentsReconciliationEventsRoutes from './routes/machine-payments-reconciliation-events.js'
import openapiRoutes from './routes/openapi.js'
import { registerHealthRoutes, buildHealthOpsPayload } from './routes/health.js'
import opsRoutes from './routes/ops.js'
import { getOpsReadDb } from './db/ops-read-pool.js'
// dep-lint-exempt: composition-root wiring — the REAL chain readers must NOT be re-exported from modules/ops/index.ts: routes/ops.ts imports that entry, and the ops invariant-1 walk (#3509) forbids the ops console's graph from reaching rails/ and infra/chain/, so onchain-readers.ts is reachable ONLY by injection here (#3513), like the #2881 accounting legacy entry.
// #3513: the REAL ops on-chain readers touch rails/ and infra/chain/, so
// they are imported here — where the ops invariant-1 walk (rooted at
// routes/ops.ts) never looks — and injected through the route options.
import { opsOnchainReaders } from './modules/ops/onchain-readers.js'
import catalogRoutes from './routes/catalog.js'
import catalogSubmissionRoutes from './routes/catalog-submissions.js'
import merchantRoutes from './routes/merchants.js'
import analyticsRoutes from './routes/analytics.js'
import analyticsOverviewRoutes from './routes/analytics-overview.js'
import accountingRoutes from './routes/accounting.js'
import accountingConnectionsRoutes from './routes/accounting-connections.js'
import accountingFeedRoutes from './routes/accounting-feed.js'
import accountingWebhookRoutes from './routes/accounting-webhooks.js'
import { registerConnector, getAccountingOpsCounters, setOpsEventSink } from './modules/accounting/index.js'
import { AccountedConnector, igdrasilConnectorIfConfigured } from './modules/accounting/index.js'
import { FortnoxConnector } from './modules/accounting/index.js'
import { fortnoxConfigured } from './modules/accounting/index.js'
import type { QueryableLike } from './modules/catalog/index.js'
import { registerAgentToolAuditHooks } from './middleware/agentToolAudit.js'
import { registerClientCompatHooks } from './middleware/client-compat.js'
import { registerAgentLastSeenHook } from './middleware/agentAuth.js'
// dep-lint-exempt: composition root — owns the pool for the /health liveness probe (SELECT 1) and injects it into `startBackgroundJobs` at boot (catalog refresh needs it); it wires infrastructure rather than running tenant SQL
import pool from './db.js'

const app = Fastify({
  logger: {
    level: config.logLevel,
  },
  // #1670: a hop COUNT, not `true` — see the note on trustProxyHops in
  // config.ts. 0 → false → request.ip stays the socket peer, exactly as
  // before this option existed.
  trustProxy: config.trustProxyHops > 0 ? config.trustProxyHops : false,
})

// --- Global error handler (extracted for testability, #1464) ---
app.setErrorHandler(httpErrorHandler)

// --- Request validation (#3029, epic #3028 slice 1) ---
// EVERY route's request is compiled against the OpenAPI spec from here down —
// shadow mode logs would-be refusals and counts them (`request_validation` on
// GET /health/ops) without changing any answer; the contacts proof module is
// enforced via enforcedModules, and so is merchants.ts (#3078): a module born
// after the rollout began is born enforced — read-only, one path parameter
// with a slug pattern — rather than adding to the shadow residue.
//
// The list is keyed on the route FILE, not the mount prefix (#3135, epic #3028
// decision 7): `/agents` is shared by four route files that epic #3028 splits
// across slices 3 and 4, so a prefix key could not flip them independently.
// MUST sit after setErrorHandler (the enforced
// route handler delegates non-validation errors to it) and before the first
// app.register — it is a root-scope install, not an encapsulated plugin, so
// its onRoute/compiler/formatter are the ones every child module inherits
// (spiked: an encapsulated plugin's onRoute sees no later routes).
installRequestValidation(app, {
  mode: config.requestValidationMode,
  // #3167: the label routes are born ENFORCED — new modules never enter shadow.
  enforcedModules: [
    // Slice 1 (#3029) proof module, and the modules born enforced since.
    'routes/contacts.ts',
    // #3804: display-only dashboard budget-remaining read — born ENFORCED
    // like every module after the rollout began (GET-only, no parameters).
    'routes/dashboard-budget-remaining.ts',
    'routes/merchants.ts',
    'routes/labels.ts',
    'routes/agent-labels.ts',
    // #3164: the organization routes are born ENFORCED — new modules never
    // enter shadow.
    'routes/agent-organizations.ts',
    // #3329: the owner-facing task-budget READ is non-money-path (GET only)
    // and born ENFORCED, same precedent as agent-organizations.ts above.
    'routes/agent-task-budgets.ts',
    // #3330: sub-budgets — the owner-facing issuance/read routes are
    // money-path: they are where a sub-budget is issued and opened, the
    // moment another agent receives spend authority (the same reason
    // `routes/agent-connection-setups.ts` is listed), and they have been
    // on the runtime money-path list since #3661. Haven signs nothing
    // here — the delegating agent's key does — and nothing is redeemed
    // here, but the routes create the rows payments later redeem through,
    // so read a change to them as a money-path change. Born ENFORCED like
    // the task-budget reads above. The agent-facing lifecycle in
    // `routes/sub-budgets.ts` IS money-path and born ENFORCED
    // under the same brand-new-module rule as `routes/task-budgets.ts`.
    'routes/agent-sub-budgets.ts',
    'routes/sub-budgets.ts',
    // #3332: a brand new module with no live caller at birth (its frontend
    // caller `useCompanyDetails` arrived later) — same reasoning as
    // task-budgets.ts below: born ENFORCED, never shadow.
    'routes/owner-company-details.ts',
    // #3329: `routes/task-budgets.ts` was born ENFORCED as a brand new
    // module with no live caller (unlike `routes/payments.ts` /
    // `routes/agent-delegations.ts` / `routes/machine-payments.ts`, which
    // predate the request-validation rollout and carry real traffic the
    // #3028 fallback could not prove) — `docs/operations/dev-environment.md`'s
    // rule is that a genuinely new module is born ENFORCED, never shadow,
    // because there is no existing caller a stricter schema could break.
    // It is money-path (runtime glob since #3661). qa-dev drives its
    // lifecycle today (`task-budget-lifecycle.ts` under
    // `packages/qa-agent/src/scenarios/`, #3505), but that rule is about
    // proving EXISTING traffic safe, not about gating new surfaces.
    'routes/task-budgets.ts',
    // Slice 2 (#3030): every non-money route module, plus the two inline
    // routes below (`GET /`, `GET /chains` — keyed `'index.ts'`). Flipped on
    // the epic's fallback (owner decision 2026-09-21 on #3028): the dev
    // shadow read could not prove these modules — the counter resets on
    // every deploy and carried no per-route traffic (until #3208) — so each module's
    // route tests (off-spec → the 400 envelope; conformant → byte-identical)
    // are the instrument, and `enforce` on dev is the reading. Slices 3–4
    // (#3031/#3032) flip the money-path modules on a persisted reading.
    'index.ts',
    'routes/accounting.ts',
    'routes/accounting-feed.ts',
    'routes/accounting-connections.ts',
    // #3196's receiver landed in this slice's base commit, registered without
    // a prefix (its routes carry the full path); the doc review found it
    // shadowed and unseen by the gauge, so it joins the list here.
    'routes/accounting-webhooks.ts',
    'routes/agent-activity.ts',
    'routes/analytics.ts',
    'routes/analytics-overview.ts',
    'routes/auth.ts',
    'routes/balances.ts',
    'routes/catalog.ts',
    'routes/catalog-submissions.ts',
    'routes/dashboard.ts',
    'routes/discovery.ts',
    'routes/health.ts',
    'routes/openapi.ts',
    'routes/passkeys.ts',
    'routes/passport-verify.ts',
    'routes/portfolio.ts',
    'routes/safe-deploy.ts',
    'routes/transactions.ts',
    'routes/user.ts',
    'routes/user-accounts.ts',
    'routes/user-accounts-retired.ts',
    // #3031 (epic #3028 slice 3): the four MONEY-PATH route modules, the
    // remainder after #3221 flipped `x402.ts` (the only one the 2026-09-22
    // shadow reading proved on traffic alone — 24.41 h, zero would_refuse,
    // zero would_coerce). These three (#3031's other three modules) carried
    // 15 operations with NO traffic in that window and stayed shadowed by
    // owner decision (2026-09-22): a route printed NOT PROVEN is not
    // enforced on a guess. Six of the fifteen were then driven through the
    // hosted QA MCP the same day (read-only; the one spend-shaped call made
    // a payment INTENT with the recipient pinned to the agent's own
    // treasury and deliberately produced no signature — nothing moved;
    // evidence on epic #3028, 2026-09-22 17:26/17:31/20:56), which leaves
    // nine that no client calls at all (#3223 — three unreachable by any
    // client, four owner-session writes not worth driving, reconciliation
    // events that must not be forced). This slice's instrument for them is
    // the one the epic's fallback already set for slice 2 (#3030): the
    // route tests — off-spec → the 400 envelope, every accepted shape
    // byte-identical — and the #3208 reading pasted on #3028 (2026-09-22
    // 14:51Z, corrected same day) still holds: zero would_refuse and zero
    // would_coerce across the whole 24.41 h window. The semantic money-path
    // refusals (budget, rail, scheme agreement, expiry, the uint96 cap)
    // stay in the handlers; the schema takes only the SHAPE checks the
    // spec already declares — see the per-route notes in the four files.
    //
    // #3031 round 2 (owner decision, epic #3028 2026-09-24T21:24:44Z,
    // closing #3223): `POST /machine-payments/reconciliation-events` is the
    // rollout's NAMED RESIDUE and STAYS SHADOWED — driving it synthetically
    // would write a false record into a payment's ledger. It moved to its
    // own route file (`routes/machine-payments-reconciliation-events.ts`)
    // because enforcement is keyed on the file and the plugin has no
    // per-operation opt-out; that file is deliberately NOT listed here. It
    // is enforced the day a real rejection (or a QA scenario that produces
    // one) gives the shadow reading traffic to prove it — the promotion
    // checklist carries the note.
    'routes/payments.ts',
    'routes/agent-delegations.ts',
    'routes/machine-payments.ts',
    'routes/x402.ts',
    // #3032 (epic #3028 slice 4, the LAST slice): the remaining five modules
    // join, and the default mode flips to `enforce`. Evidence per the owner's
    // instrument decision (epic decision 8, #3208) and the #3223 ruling:
    // the 2026-09-22 reading proved 3 of these 36 operations conformant with
    // traffic and left 33 NOT PROVEN; the owner then decided (2026-09-24,
    // on the epic) that routes a shadow reading can never prove are enforced
    // on TEST evidence — per-route off-spec → 400-envelope and conformant →
    // byte-identical pins, the same instrument decision 8 allowed for slice
    // 2. The connector-path clients (published `@haven_ai/connect`, `cli`,
    // dashboard) drive the highest-traffic of these routes; their five
    // undeclared request fields were declared in #3276 with regenerated
    // types. From this slice on `enforcedModules` is the per-module ROLLBACK
    // list (epic decision 6): the default is enforce, and removing one file
    // here returns exactly that module to shadow.
    'routes/agents.ts',
    // #3426: the agent-side tax-declaration READ is born ENFORCED — a genuinely
    // new module never enters shadow (no existing caller a stricter schema
    // could break). GET only: no request body, one uuid path parameter.
    'routes/agent-tax-declaration.ts',
    'routes/agent-rekey.ts',
    'routes/agent-connection-setups.ts',
    'routes/agent-passports.ts',
    'routes/hybrid-accounts.ts',
    // #3333: routes/receive.ts is born ENFORCED — the rule a genuinely new
    // module never enters shadow (there is no existing caller a stricter
    // schema could break). The file carries the receive side's owner surface
    // (authMiddleware) and the payer's unauthenticated-but-signed receipt
    // drop; the drop's body shape is exactly the enforced schema's, so a
    // malformed drop is refused before any DB read.
    'routes/receive.ts',
    // #3509 (epic #3507): the ops console is born ENFORCED. Its plugin answers
    // 404 from an onRequest hook when ops is unconfigured, so validation never
    // runs on a backend that does not serve the console.
    'routes/ops.ts',
    // #3597: `routes/feedback.ts` is a BRAND NEW module with no live caller
    // yet — born ENFORCED, same rule as `routes/receive.ts` / `routes/ops.ts`
    // above (no existing caller a stricter schema could break).
    'routes/feedback.ts',
  ],
})

// --- Process-level error handlers ---
process.on('unhandledRejection', (reason) => {
  app.log.error({ err: reason }, 'Unhandled promise rejection')
})

process.on('uncaughtException', (error) => {
  app.log.fatal({ err: error }, 'Uncaught exception — shutting down')
  process.exit(1)
})

// --- Plugins ---
// CORS:
//   - Browser dashboard: served from `config.frontendUrl`. CORS protects it
//     from other websites making authenticated requests on the user's behalf.
//   - Agent SDK clients: hit `/agents/...` and `/payments/...` from arbitrary
//     hosts (any agent runtime — Claude console, custom servers, MCP, etc.).
//     They authenticate with `Authorization: Bearer sk_agent_*` — that's the
//     real security boundary, not the Origin header.
//
// Reflecting the request origin (or accepting requests with no Origin, which
// is what server-side fetch sends) gives us both: dashboard credential flow
// keeps working, agents from anywhere can authenticate.
await app.register(cors, {
  origin: true,
  credentials: true,
})

await app.register(fastifyJwt, {
  secret: config.jwtSecret,
})

// Rate limiting (#794): registered non-global — only routes that opt in via
// `config.rateLimit` (money-path writes and the public demo reads) are
// limited; dashboard reads stay unthrottled. Keyed per presented credential
// (Authorization or X-API-Key — see rateLimitKeyFor) so each agent gets its
// own bucket regardless of network path; unauthenticated requests fall back
// to per-IP. With TRUST_PROXY_HOPS unset that per-IP fallback collapses to
// the proxy address behind Railway — acceptable for the public demo routes,
// where a shared throttle still beats an open faucet, and the reason the
// auth tier (#1670) refuses to arm itself until the proxy is trusted.
// #1680: the shared Postgres-backed store replaces the plugin's in-process
// LRU. With the default store each replica counted only its own share of the
// traffic, so the real ceiling was `max × replicas` and it ROSE with load —
// live probing of dev read x-ratelimit-remaining back as two interleaved
// descending series. The store is fail-open and deadline-bounded: a database
// problem degrades to the old per-replica counting rather than locking anyone
// out of signup or login.
await app.register(rateLimit, {
  global: false,
  keyGenerator: (request: FastifyRequest) => rateLimitKeyFor(request),
  store: SharedRateLimitStore,
})

setRateLimitDegradedReporter((reason) => {
  app.log.warn({ reason }, 'Rate-limit store fell back to per-replica counting (#1680)')
})

await app.register(openapiRoutes)
// #2531: the public, read-only facts an agent's code needs — the same values
// the setup handout computes, so a channel or hosted-MCP change propagates to
// the frontend manifest instead of being restated there.
await app.register(discoveryRoutes)

// Capture X-Haven-MCP-Tool header and write an agent_tool_invocations row
// whenever an authenticated agent request advertises an MCP tool name. Must
// be registered before routes that decorate request.agent so the onResponse
// hook fires after them.
registerAgentToolAuditHooks(app)

// Client-version signal (#3303, epic #3302): a `client_update` hint on the
// responses an outdated published client receives, and a 426
// `client_outdated` refusal — only below a SET minimum, only at the
// payment-initiating routes and (for the signer) sign-context. Registered
// before the routes so its root hooks reach them; the request-validation
// preHandler above has already restored the client's body by the time the
// refusal hook reads its idempotency key.
registerClientCompatHooks(app)

// Record agent liveness (last_seen_at) after each authenticated agent request,
// powering the dashboard "Connected · last seen" indicator. Registered as an
// onResponse hook so it runs after route handlers, never interleaving with
// their queries.
registerAgentLastSeenHook(app)

// --- Routes ---
registerHealthRoutes(app, {
  checkDatabase: () => pool.query('SELECT 1'),
  getRelayerStatus: getRelayerBalanceStatus,
  getPassportStatus: passportReadiness,
  trustProxyHops: config.trustProxyHops,
  opsToken: config.opsToken,
  getAccountingCounters: () => getAccountingOpsCounters(),
})

// Ops console (#3509, epic #3507): founders-only and read-only. Every route
// answers 404 unless OPS_* is fully configured, and the data routes also
// need OPS_DATABASE_URL — the read-only role login (#3510) — or they 404 too.
// The on-chain view (#3513) additionally needs the chain readers, injected
// here because their implementation touches `rails/` and `infra/chain/`,
// which the ops invariant-1 walk must never reach from `routes/ops.ts`.
// `/ops/health` (#3514) gets the `/health/ops` payload builder the same way:
// `routes/health.ts` reaches `infra/relayer-balance-monitor.ts`, which the
// same walk forbids — while both answers are built by ONE function, so they
// cannot disagree about what the backend's own diagnostics say.
await app.register(opsRoutes, {
  prefix: '/ops',
  ops: config.ops,
  trustProxyHops: config.trustProxyHops,
  readDb: getOpsReadDb(),
  onchainReaders: getOpsReadDb() ? opsOnchainReaders : null,
  healthDiagnostics: getOpsReadDb()
    ? () => buildHealthOpsPayload({
        checkDatabase: () => probeDatabase(),
        getRelayerStatus: getRelayerBalanceStatus,
        getPassportStatus: passportReadiness,
        trustProxyHops: config.trustProxyHops,
        opsToken: config.opsToken,
        getAccountingCounters: () => getAccountingOpsCounters(),
      })
    : null,
  lastDelegateBalanceReport: getOpsReadDb() ? lastDelegateBalanceReport : null,
})

// The accounting module's ops events (#2872: `accounting.connection.needs_attention`)
// go through the app logger like the retry sweep's, so every
// `"event":"accounting.…"` line lands on one transport.
setOpsEventSink((level, event) => app.log[level](event, event.event))

/**
 * API root document (#2530).
 *
 * `GET /` answered 404, so an agent handed only a backend URL had nothing to
 * read and no way to find the spec — the 2026-09-04 cold test guessed
 * `/openapi.json` correctly and a less lucky agent would not. This is the one
 * unauthenticated document that says what this service is and where its
 * machine-readable contract lives.
 *
 * Deliberately thin and entirely non-sensitive: names, paths, and which
 * credential each door wants. No version, no environment name, no build
 * identifier — a service banner that fingerprints the deployment is a gift to
 * a scanner and buys an agent nothing.
 *
 * The origin is derived from the request, not from a literal, so the dev
 * backend describes the dev backend.
 */
app.get('/', async (request) => buildApiRootDocument(request.headers, config.frontendUrl))

// Public chain config (#679): which chains this environment serves account
// deploys on, so the onboarding / Add-account pickers offer only those. Not
// sensitive — no auth.
app.get('/chains', async () => {
  return { deployable: deployableChainIds(), supported: SUPPORTED_CHAIN_IDS }
})

// L0 passport attestations are anchored AND revoked by the gas-only relayer
// (#972 / #973). Both are governance metadata: EAS-only targets, zero value.
setAnchor(anchorOnChain)
setAnchorRecovery(recoverAnchorFromReceipt)
// A null receipt is not evidence the attest was dropped (#1745). The re-mint
// is unlocked only by this probe finding the transaction's nonce burned by
// something else; anything less leaves the passport retryable rather than
// minting a second live credential.
setAnchorLiveness(classifyAnchorTxLiveness)
setRevoker(revokeOnChain)
// A revoke that mines after its 120 s wait expired has no other way to close
// (#1758): EAS reverts every later revoke of the same UID, so the only fresh
// attempt that could observe success can never succeed. This probe reads the
// attestation's revoked bit as of a settled block instead, which converges the
// row without broadcasting anything. Unwired, it degrades to the pre-#1758
// behaviour — a stuck `pending` row, never a wrong `confirmed` one.
setRevocationProbe(readRevocationAnchor)
// #3294: rows anchored before the fix store the staticCall-predicted UID,
// which never existed on-chain — revocation of such a row reverts NotFound()
// forever while the agent's REAL attestation stays live. The retire consults
// this repair before spending gas on an unseen UID: the row is re-derived
// from its own anchor receipt and the REAL uid is what gets revoked. Unwired,
// the retire submits the stored UID exactly as before (#3294's pre-fix
// behaviour) — never a wrong write.
setAnchorUidRepair(repairAnchorUidFromReceipt)
// Receipts the merchant-facing verifier hands out (#974) are signed with a
// DEDICATED key, never the relayer's: the relayer pays gas for user-authorised
// transactions, while this one signs public assertions and its address is
// published for pinning. Unset means verification is off, and the endpoint
// fails closed rather than serving an unsigned receipt.
// Refuses at boot if it IS the relayer key — the static invariant test reads
// source, so only a runtime check can catch that operator copy-paste.
setReceiptSigningKey(process.env.PASSPORT_RECEIPT_SIGNING_KEY ?? null, [
  config.relayerPrivateKey,
  ...relayerKeysFromEnv(),
])
// #4655 (owner decision 2): the x402 binding key is a third server key role —
// it authenticates expected context and sweep authorizations, and its address is
// published as HAVEN_X402_BINDING_SIGNER for installed signers to pin. Refuse to
// boot when an operator pasted a relayer or receipt key into it. Unset stays
// allowed (a deployment that does not sign binding context has no key to
// collide), and the refusal names the variables, never the values.
assertBindingKeyNotReused(process.env.X402_BINDING_PRIVATE_KEY, [
  { variable: 'RELAYER_PRIVATE_KEY', value: config.relayerPrivateKey },
  ...relayerKeyEntriesFromEnv(),
  { variable: 'PASSPORT_RECEIPT_SIGNING_KEY', value: process.env.PASSPORT_RECEIPT_SIGNING_KEY },
])
// Warn — once, at boot — when this deployment anchors passports it cannot
// verify (#1151). Silent in every other combination. Must run AFTER the signer
// is installed above, or it would warn on every deployment.
logPassportReadiness(app.log)

await app.register(authRoutes, { prefix: '/auth' })
await app.register(userRoutes, { prefix: '/user' })
// #3332: rides the /user prefix as its own route FILE, same reasoning as
// agent-labels.ts on /agents — the request-validation rollout keys
// enforcedModules on the file, not the mount prefix.
await app.register(ownerCompanyDetailsRoutes, { prefix: '/user' })
await app.register(balanceRoutes, { prefix: '/balances' })
await app.register(transactionRoutes, { prefix: '/transactions' })
// #3333: the receive side — persisted inbound index, receipt matching and the
// owner-signed off-ramp hand-off. Owner-scoped (authMiddleware inside the
// file); no agent-auth route reaches it. `trustProxyHops` arms the receipt
// drop's limiter — the receive side's one unauthenticated route (#794 tiers).
await app.register(receiveRoutes, { prefix: '/receive', trustProxyHops: config.trustProxyHops })
await app.register(portfolioRoutes, { prefix: '/portfolio' })
await app.register(dashboardRoutes, { prefix: '/dashboard' })
// #3804: the cached budget-remaining read — its own file on the same prefix
// (see the import comment above).
await app.register(dashboardBudgetRemainingRoutes, { prefix: '/dashboard' })
// #2847 (epic #1440): `GET /safe/:addr/details` and `POST /safe/exec` are
// deleted. `/safe` no longer mounts anything here but the safe-deploy
// tombstone below — the prefix survives only because that 410 does.
await app.register(agentRoutes, { prefix: '/agents' })
await app.register(agentTaxDeclarationRoutes, { prefix: '/agents' })
await app.register(hybridAccountRoutes, { prefix: '/accounts' })
await app.register(agentDelegationRoutes, { prefix: '/agents' })
await app.register(agentRekeyRoutes, { prefix: '/agents' })
await app.register(agentPassportRoutes, { prefix: '/agents' })
// #3167: label assignment rides the /agents prefix as its own route FILE —
// the request-validation rollout keys enforcedModules on the file.
await app.register(agentLabelRoutes, { prefix: '/agents' })
// The label vocabulary itself — GET/POST /labels, PUT/DELETE /labels/:id
// (#3167). Same prefix rule: one route file, one enforcedModules entry.
await app.register(labelRoutes, { prefix: '/labels' })
// #3164: the organization tree — GET/POST /organizations, PUT/DELETE
// /organizations/:id. Its own prefix and route file, born enforced.
await app.register(agentOrganizationRoutes, { prefix: '/organizations' })
// Public and unauthenticated (#974): the caller is a merchant deciding whether
// to serve an agent, and it has no Haven account. Registered separately from
// the dashboard-authed passport routes so the auth hook cannot be assumed.
await app.register(passportVerifyRoutes, { prefix: '/passport' })
await app.register(agentConnectionSetupRoutes, { prefix: '/agent-connection-setups' })
await app.register(contactRoutes, { prefix: '/contacts' })
await app.register(feedbackRoutes, { prefix: '/feedback' })
await app.register(paymentRoutes, { prefix: '/payments' })
// #2055: /approvals is deregistered — the approval queue died with the
// AllowanceModule rail and its table is dropped; the routes went with it.
await app.register(agentActivityRoutes, { prefix: '/agent-activity' })
await app.register(x402Routes, { prefix: '/x402' })
// #3329: task budgets — agent-auth lifecycle at /task-budgets, owner-auth
// read at /agents/:id/task-budgets (same prefix as agent-delegations.ts).
await app.register(taskBudgetRoutes, { prefix: '/task-budgets' })
await app.register(agentTaskBudgetsOwnerRoutes, { prefix: '/agents' })
// #3330: sub-budgets — agent-auth lifecycle at /sub-budgets, owner-auth
// issue/sign/list/tree/revoke at /agents/:id/sub-budgets.
await app.register(subBudgetRoutes, { prefix: '/sub-budgets' })
await app.register(agentSubBudgetsOwnerRoutes, { prefix: '/agents' })
// #2914 (naming P5, the contraction): the `/user/safes*` prefix stops
// serving and answers 410 with the replacement path. It is registered as a
// TOMBSTONE module rather than dropped, because an absent registration is a
// bare 404 — a transient-looking error for a path that is permanently gone.
await app.register(userAccountsRetiredRoutes, { prefix: '/user/safes' })
// The account vocabulary is now the only one that serves.
await app.register(userAccountsRoutes, { prefix: '/user/accounts' })
await app.register(passkeyRoutes, { prefix: '/passkeys' })
await app.register(safeDeployRoutes, { prefix: '/safe' })
await app.register(machinePaymentRoutes, { prefix: '/machine-payments' })
// #3031 round 2: the reconciliation-events route, split out of
// `machine-payments.ts` so it stays SHADOWED while that module is enforced
// (owner decision, epic #3028 2026-09-24). Same prefix, one route.
await app.register(machinePaymentsReconciliationEventsRoutes, { prefix: '/machine-payments' })
await app.register(catalogRoutes, { prefix: '/catalog' })
await app.register(catalogSubmissionRoutes, { prefix: '/catalog' })
// #3078: the merchant layer over the catalog — read-only, same auth door.
await app.register(merchantRoutes, { prefix: '/merchants' })
await app.register(analyticsRoutes, { prefix: '/analytics' })
// #2946 (epic #2944, slice B): a SEPARATE module under the SAME prefix — the
// internal onboarding funnel above owns `/analytics/funnel`, this owns
// `/analytics/overview`. Two modules on one prefix are just two path
// strings under one mount point (see `catalogRoutes` + `catalogSubmissionRoutes`
// on `/catalog` above for the same pattern); neither declares the other's
// sub-path, so there is nothing to register twice or fight over.
await app.register(analyticsOverviewRoutes, { prefix: '/analytics' })
await app.register(accountingRoutes, { prefix: '/accounting' })
// #2862: provider-generic connections (`/accounting/providers`,
// `/accounting/connections/*`) replaced the Fortnox-shaped router.
await app.register(accountingConnectionsRoutes, { prefix: '/accounting' })
await app.register(accountingFeedRoutes, { prefix: '/accounting/feed' })
// #3019: the Accounted webhook receiver. Public (the provider carries no
// session), capability-URL token + HMAC as the credentials, and its OWN
// encapsulated content-type parser — registering it as a plugin keeps the
// raw-body capture off every other route.
await app.register(accountingWebhookRoutes)
// #496: the live Fortnox feed adapter. Registering it flips hasLiveConnector()
// → true, which removes the Reporting page's "preview" banner. Gated on env:
// deployments without Fortnox credentials keep the feed inert (no-op), same
// posture as before this landed.
if (fortnoxConfigured()) {
  registerConnector(new FortnoxConnector())
}
// #3017: the Accounted adapter registers UNCONDITIONALLY. Unlike Fortnox it
// has no deployment credentials to configure — a key is per USER (pasted at
// connect, stored encrypted), so there is nothing an operator opts into here;
// `availability: 'live'` plus the per-account accounting feature gate is the
// whole exposure decision. #3018 is the push half: the receipt underlag is
// uploaded as one WORM document, delivery proven by sha256 echo.
registerConnector(new AccountedConnector())
// #4518 (epic #2875): the Igdrasil adapter, credential-gated like Fortnox —
// Haven's OAuth app is per deployment (IGDRASIL_CLIENT_ID / _SECRET /
// _REDIRECT_URI). Registered, it makes `configured: true`; the descriptor
// stays `coming_soon` until the live run (#4519), so nothing can connect yet.
const igdrasilConnector = igdrasilConnectorIfConfigured()
if (igdrasilConnector) registerConnector(igdrasilConnector)
// #1328: the legacy /demo/mpp/* MPP demo route is retired (see
// modules/mpp/challenge.ts's mppDemoRetired() for the authorize-side refusal).

// --- Start ---
const start = async () => {
  try {
    await runMigrations()
    app.log.info('Database migrations complete')

    // #2860: migration 080 copies provider secrets as plaintext (a migration
    // reads no environment); this is where they get encrypted, on the first
    // boot that has HAVEN_SECRETS_KEY. Inert without it, idempotent with it,
    // and it never blocks listen().
    await reencryptPlaintextSecretsAtBoot((m) => app.log.info(m))

    await app.listen({ port: config.port, host: '0.0.0.0' })
    app.log.info(`Haven backend running on port ${config.port}`)

    // #4764: every periodic tick lives in ONE importable table
    // (`src/background-jobs.ts`) and is started from ONE entry point, so the
    // wiring is testable without booting this file. The pool is injected here
    // because catalog refresh needs it and `pg-only-in-infra` allows no new
    // importer of `db.ts`.
    startBackgroundJobs({ log: app.log, pool: pool as unknown as QueryableLike })
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
