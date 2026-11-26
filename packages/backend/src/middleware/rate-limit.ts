/**
 * Shared per-route rate-limit configs and key derivation (#794).
 *
 * The @fastify/rate-limit plugin is registered non-global in index.ts with
 * `rateLimitKeyFor` as key generator; routes opt in by spreading one of these
 * into their route `config`. Tiers:
 *
 * - moneyPathRateLimit — authenticated money-path writes (payments, x402,
 *   machine-payments). 60/min per caller is far above any legitimate
 *   agent's payment cadence (the on-chain allowance is the real spend gate;
 *   this is a per-identity request-storm ceiling on the handler — keyed on
 *   the agent, owner or key the route's auth verified (`rateLimitKeyFor`,
 *   #4955). It does NOT throttle invalid-credential probing: a refused
 *   credential is answered 401 by auth, which runs before the route-level
 *   limiter; key entropy is what makes brute force infeasible).
 * - publicVerifyRateLimit / publicIssuerRateLimit — public passport
 *   verification (#974). These override the shared key generator entirely,
 *   because per-IP is meaningless behind an untrusted proxy; see below.
 * - authRateLimit(trustProxyHops) — signup/login (#1670). SELF-DISARMING:
 *   returns no limit at all unless the deployment trusts its proxy
 *   (TRUST_PROXY_HOPS > 0), because these are the product's front door and a
 *   per-IP limit whose "IP" is one shared proxy address is a cheap global
 *   login denial-of-service, not a protection. Also the ops console's
 *   unauthenticated GitHub sign-in pair (`ops_auth`, #3509).
 * - feedbackSubmitRateLimit — `POST /feedback` (#3597), per USER (overrides
 *   the shared key generator — see its own comment for why).
 * - opsRevealRateLimit — `POST /ops/reveal` (#3509), per admitted operator
 *   (`ops:<GitHub id>`, #4955).
 * - opsSearchRateLimit — `GET /ops/search` (#3512), per admitted operator, in its own
 *   bucket (`groupId`) so searching never spends the reveal budget.
 *
 * Constants, not env: tuning is a code change with review, and the values are
 * deliberately generous — the goal is a ceiling, not throttling real use.
 */

import { admittedOpsOperator } from './ops-auth.js'

/**
 * The request fields the key generator reads — each one set only by an auth
 * hook that verified the caller (#4955). Typed structurally so the unit suite
 * can build a request without Fastify.
 */
export interface RateLimitSubject {
  ip: string
  /** Set by `agentAuthMiddleware` after the key's hash matched an agent. */
  agent?: { id?: unknown } | null
  /** Set by `merchantAuthMiddleware` after the key's hash matched a merchant key. */
  merchant?: { key_id?: unknown } | null
  /** Set by `@fastify/jwt`'s `jwtVerify` (dashboard and CLI sessions) — `sub` is the owner. */
  user?: unknown
}

/**
 * Bucket key for a request (#4955): the identity the route's own auth
 * VERIFIED, never the raw text of a header.
 *
 * - an agent → `agent:<agent id>`, whichever header (`Authorization: Bearer`
 *   or `X-API-Key`) carried its key;
 * - a Sales key (`sk_merchant_`, #4897) → `merchant_key:<key id>`;
 * - an ops session → `ops:<GitHub id>` of the admitted operator;
 * - an owner session (a dashboard or CLI JWT) → `user:<sub>`;
 * - anything else → `ip:<request.ip>`.
 *
 * Why identity and not headers: the old rule hashed whatever `Authorization`
 * held, else `X-API-Key`. The bucket was then chosen by a header the auth may
 * not use. An agent sending `Authorization: Bearer junk-<n>` beside its valid
 * key in `X-API-Key` (agent auth ignores a non-`sk_agent_` Bearer) landed in a
 * fresh bucket on every request, and any header at all moved a caller of a
 * per-IP route (signup, login, device start and token, ops sign-in, catalog
 * submit, the receipt drop) out of the IP bucket. Reading the verified
 * identity closes both: a junk header changes nothing the auth accepted, and
 * a route with no auth has no identity to read, so it is keyed per IP
 * whatever headers arrive.
 *
 * Why it can read the identity: `@fastify/rate-limit` pushes its check onto
 * the END of each route's own `onRequest` array (`index.js`, `onRoute`), and
 * every rate-limited authenticated route runs its auth as an `onRequest`
 * hook — a context `addHook('onRequest', …)` or the route's own `onRequest`
 * — so auth has run and admitted the caller before this generator runs. A
 * caller the auth refuses is answered 401 before the limiter, as before; the
 * limit is a request-storm ceiling on admitted callers, not a throttle on
 * credential probing (key entropy is that defence). A route whose auth ran
 * LATER (a `preHandler`) would find no identity here and fall back to the IP
 * bucket — a collapse, never a bypass — so new authenticated routes keep
 * their auth in `onRequest`.
 *
 * Owners and ops sessions are keyed by their verified subject, so two
 * sessions of one owner (two tabs) share a bucket and two owners behind the
 * same proxy address never do. An agent is keyed by its id rather than its
 * key, so a re-keyed agent keeps its count.
 *
 * The bucket names changed from `cred:<hash>` in #4955; that reset the live
 * counters in `rate_limit_counters` once, at deploy (a one-minute window).
 */
export function rateLimitKeyFor(request: RateLimitSubject): string {
  const merchantKeyId = request.merchant?.key_id
  if (typeof merchantKeyId === 'string' && merchantKeyId.length > 0) {
    return `merchant_key:${merchantKeyId}`
  }
  const agentId = request.agent?.id
  if (typeof agentId === 'string' && agentId.length > 0) {
    return `agent:${agentId}`
  }
  const operator = admittedOpsOperator(request)
  if (operator) {
    return `ops:${operator.githubId}`
  }
  const sub = (request.user as { sub?: unknown } | null | undefined)?.sub
  if (typeof sub === 'string' && sub.length > 0) {
    return `user:${sub}`
  }
  return `ip:${request.ip}`
}

export const moneyPathRateLimit = {
  rateLimit: {
    max: 60,
    timeWindow: '1 minute',
  },
} as const

/**
 * `POST /merchant/sales` (#4897): the merchant key's sale ingest, 120/min per
 * merchant key (`rateLimitKeyFor` keys it on the verified key's id, so the
 * same key shares one bucket through either header). Higher than the money-path tier because a busy
 * merchant reports one record per settled payment and a 425 retry resends the
 * same record. It is a request-storm ceiling, not a throttle on real use, and
 * it bounds the RPC reads one key can cause.
 */
export const merchantSalesRateLimit = {
  rateLimit: {
    max: 120,
    timeWindow: '1 minute',
  },
} as const

/**
 * `POST /ops/reveal` (#3509): one unmasked customer field per call, by a
 * signed-in founder. Keyed per admitted operator (`rateLimitKeyFor` reads
 * the GitHub id `opsAuth` verified, #4955). Tight on purpose — a reveal is a deliberate click,
 * and a script walking the customer table one reveal at a time is exactly
 * what this ceiling exists to slow down.
 */
export const opsRevealRateLimit = {
  rateLimit: {
    max: 20,
    timeWindow: '1 minute',
  },
} as const

/**
 * `GET /ops/search` (#3512): keyed per operator like reveal, but a separate
 * bucket — `groupId` is appended to the key, so a console that searches as the
 * founder types cannot 429 their next reveal. Looser than reveal because a
 * search returns masked rows only; still a ceiling on a script enumerating
 * email prefixes.
 */
export const opsSearchRateLimit = {
  rateLimit: {
    max: 60,
    timeWindow: '1 minute',
    groupId: 'ops_search',
  },
} as const

/**
 * Owner company details writes (#3332 review M3): `PUT /user/company-details`
 * and `POST /user/company-details/vies-check`, both dashboard-JWT-authenticated
 * so the shared key generator buckets per OWNER (the verified JWT's `sub`,
 * #4955), never per shared proxy IP: two sessions for the same owner (two
 * open tabs, a second device) share one bucket, and two owners behind one
 * proxy address never do. Each write can start a VIES check
 * against the EU
 * Commission's endpoint — the ceiling here is about being a considerate
 * caller of THAT external service (and giving the async
 * `recheckIfStalePending`/atomic-claim guard less to race against), not about
 * an on-chain spend the way `moneyPathRateLimit` is. 20/min is far above any
 * legitimate owner editing their own details by hand.
 */
export const ownerProfileRateLimit = {
  rateLimit: {
    max: 20,
    timeWindow: '1 minute',
  },
} as const

/**
 * Public passport verification (#974). Keyed per **SUBJECT**, not per caller.
 *
 * The endpoint is unauthenticated, so the default key is `ip:` — and there is
 * no `trustProxy` on the Fastify instance, so behind Railway's proxy every
 * external client collapses into ONE bucket (the comment on `rateLimitKeyFor`
 * above says so explicitly, and the demo route accepts that only because it is
 * a demo). Inheriting it here would be much worse than on a demo route: a
 * single unauthenticated client sending 121 requests a minute would 429 passport
 * verification for **every merchant at once**, and the endpoint exists precisely
 * to gate live payments. Raising the ceiling does not fix that; it just makes
 * the shared bucket bigger.
 *
 * Keying on the queried address or UID fixes the blast radius rather than the
 * size. Merchants verifying different agents mostly do not collide, and an
 * abusive caller mostly exhausts only the bucket for the agent it is hammering.
 * That is also the right shape for the actual threat here — enumerating or
 * hammering a specific subject — rather than for "who is calling", which behind
 * an untrusted proxy we cannot know anyway.
 *
 * "Mostly", precisely: the key generator runs as an `onRequest` hook, BEFORE the
 * handler validates the address, so it buckets raw query text.
 *
 * #1680 changed what that costs, and in the right direction. This used to sit
 * on the plugin's in-process LRU capped at 5000 entries, where a caller
 * flooding >5000 distinct junk subjects inside a window could EVICT a
 * legitimate subject's counter and reset its ceiling — the isolation was a
 * large improvement on one global bucket, but not a guarantee. Counters now
 * live in `rate_limit_counters`, so no eviction resets anyone: a subject's
 * count survives any amount of junk beside it, and the count is shared across
 * replicas rather than per-process.
 *
 * The residual risk MOVED rather than vanished. Junk subjects now become real
 * rows until the leader-gated sweep clears them, so a flood costs table growth
 * instead of a lost counter — bounded, because a row is keyed by subject and
 * updated in place, so the table tracks DISTINCT subjects seen recently rather
 * than requests. Trading an eviction that breaks the guarantee for rows that
 * cost space is the trade worth making.
 *
 * 120/min per subject is generous on purpose: receipts carry a 5-minute signed
 * TTL and are explicitly cacheable, so a correctly integrated merchant needs
 * roughly one call per agent per TTL.
 *
 * Making per-caller limits real needs `trustProxy`, which changes `request.ip`
 * semantics for every rate-limited route including the money path. That is a
 * deliberate cross-cutting change, not a rider on this PR.
 */
export const publicVerifyRateLimit = {
  rateLimit: {
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: (request: { query?: unknown }) => {
      const query = (request.query ?? {}) as { address?: string; uid?: string }
      const subject = (query.address ?? query.uid ?? '').toLowerCase()
      // A missing or malformed subject is rejected 400 by the handler anyway;
      // bucketing them together stops that path being a free-for-all.
      return `passport:${subject || 'invalid'}`
    },
  },
} as const

/**
 * `GET /passport/issuer` — one static response, no subject to key on. A single
 * shared bucket is the right shape here, but it gets its own so a flood of
 * malformed `/verify` calls (which bucket as `passport:invalid`) cannot take
 * out the endpoint merchants use to bootstrap their pinned issuer.
 */
export const publicIssuerRateLimit = {
  rateLimit: {
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: () => 'passport:issuer',
  },
} as const

/**
 * Signup + login (#1670). Unauthenticated, so the shared key generator falls
 * back to `ip:` — which is only meaningful when `request.ip` is the CLIENT.
 * Behind an untrusted proxy it is the proxy, one bucket for every external
 * caller, and a limit tight enough to slow bulk account-enumeration (#1654)
 * or credential stuffing would be a cheap global denial-of-service on the
 * front door: ~one attacker request per two seconds locks everyone out.
 *
 * So the tier arms itself ONLY when the operator has set TRUST_PROXY_HOPS
 * (config.ts) — never partially, never with a fallback key. Returning `{}`
 * rather than a looser limit is deliberate: a limit that exists but cannot
 * bind to a caller is worse than none, because it reads as protection.
 *
 * Signup is tighter than login: a person signs up once, and signup is where
 * the #1654 enumeration disclosure lives; login absorbs NAT'd offices and
 * password managers retrying. Both are ceilings on automation, not throttles
 * on people. Per-EMAIL keying on login was considered for single-account
 * credential stuffing and deliberately NOT used here: it hands an attacker a
 * one-request-per-window lockout of any victim's login (worse behind the
 * LRU-eviction caveat documented on publicVerifyRateLimit), and it cannot
 * touch enumeration anyway — every probed address is its own fresh bucket.
 *
 * ACCEPTED residual risk, named rather than implied: a shared IP means a
 * shared fate. A workshop, an office NAT, or carrier-grade NAT putting many
 * people behind one address will 429 the 11th signup in a minute — and
 * anyone behind that NAT can be locked out deliberately by one abuser next
 * to them. That is inherent to any per-IP limit; the ceilings are set where
 * automation is throttled and a room of humans usually is not, and raising
 * them is a reviewed constant change, not an env knob.
 */
export function authRateLimit(
  trustProxyHops: number,
  route: 'signup' | 'login' | 'device_start' | 'device_token' | 'device_lookup' | 'ops_auth',
): { rateLimit?: { max: number; timeWindow: string } } {
  if (trustProxyHops <= 0) return {}
  return {
    rateLimit: {
      // #2526's three tiers sit either side of login, for opposite reasons.
      //
      // `device_lookup` is the only one behind a session, so its bucket is a
      // signed-in caller rather than the open internet. It is still tighter
      // than login: an approver types one code, and the endpoint's one job is
      // to answer questions about codes somebody else generated.
      //
      // `device_start` mints a user code a human will type, so it is the
      // guessing surface: tighter than signup, because nobody needs ten CLI
      // logins a minute and each unclaimed code widens the window an attacker
      // can walk.
      //
      // `device_token` is a POLL. The flow itself tells the client to come
      // back every 5 seconds for up to 10 minutes — 120 legitimate calls — so
      // a limit near login's would 429 the happy path. It is deliberately the
      // loosest of the four, and it is not the guessing surface: the device
      // code is 32 random bytes, not eight typed characters.
      //
      // `ops_auth` is the ops console's unauthenticated GitHub sign-in pair
      // (`/ops/auth/github/start` and `/callback`, #3509). A founder signs in
      // a few times a day; ten a minute is a ceiling on automation only.
      max:
        route === 'signup' || route === 'ops_auth'
          ? 10
          : route === 'device_start'
            ? 5
            : route === 'device_token'
              ? 200
              : route === 'device_lookup'
                ? 20
                : 30,
      timeWindow: '1 minute',
    },
  }
}

/**
 * The payer's signed receipt drop (`POST /receive/:addr/receipt-drop`, #3333).
 * The receive side's ONLY unauthenticated route, so like signup/login and the
 * catalog submit it follows the self-disarming pattern: a per-IP ceiling whose
 * "IP" is one shared proxy address (no `trustProxy` on the instance) is a
 * cheap global denial-of-service on the drop, so the tier refuses to arm
 * itself unless the operator trusts the proxy (`TRUST_PROXY_HOPS > 0`).
 *
 * Tighter than the passport tiers on purpose: the drop's authentication is the
 * payload's own ECDSA signature, and a signature that fails verification has
 * already cost the caller nothing but a 400 — without a limiter the route is
 * the repo's only unauthenticated surface a flood could hammer for free (round-
 * 2 finding F-3). 20/min per client IP is far above any legitimate payer (a
 * payer drops one receipt per transfer) and below any meaningful flood. The
 * handler's own 404 on an unknown receiving address is the resilient second
 * layer, and a forged signature never reaches a match write regardless.
 */
export function receiptDropRateLimit(
  trustProxyHops: number,
): { rateLimit?: { max: number; timeWindow: string } } {
  if (trustProxyHops <= 0) return {}
  return {
    rateLimit: {
      max: 20,
      timeWindow: '1 minute',
    },
  }
}

/**
 * `POST /feedback` (#3597): keyed per USER, not per credential or IP — the
 * one tier in this file that is, because the issue's owner decision says so
 * explicitly ("the rate limit... keyed per user, not per IP"). Since #4955
 * the shared `rateLimitKeyFor` also keys an owner session on its verified
 * `sub`, so the bucket would be the same owner either way; this generator
 * stays because it keeps the feedback count in its own `feedback_user:`
 * bucket (the shared `user:` count is spent by every other rate-limited
 * owner route) and because it refuses loudly, below, if auth ever stopped
 * running first.
 *
 * Keyed on the VERIFIED `request.user.sub` — measured (not assumed):
 * `@fastify/rate-limit` attaches its per-route check through `onRoute`, which
 * appends to that specific route's own hook array rather than running as a
 * plugin-wide `onRequest` in registration order, so a route's own
 * `authMiddleware` (added by `app.addHook('onRequest', authMiddleware)` in
 * `routes/feedback.ts`'s encapsulated context) runs FIRST and `request.user`
 * is already verified and populated by the time this key generator runs. No
 * unverified pre-auth decode, and no IP fallback: a request that reaches this
 * generator at all has already passed `authMiddleware`, so `request.user.sub`
 * is always present.
 *
 * **No `'unknown'` fallback — THROWS instead (round 2 review, S-b).** A
 * silent fallback bucket is a single point of failure disguised as
 * resilience: if `authMiddleware` ever stopped running first (a refactor, a
 * route moved, a future plugin reordering), every caller missing `user.sub`
 * would collapse into the ONE shared `feedback_user:unknown` bucket — a
 * global rate limit on every user at once, indistinguishable from an outage,
 * caused by a wiring mistake nothing would flag until users started getting
 * 429s. Throwing instead turns that wiring mistake into a loud failure: every
 * request to the route answers 500 with an error log, and
 * `feedback-rate-limit.test.ts` catches the reordering in CI before it ships.
 * A loud outage beats quietly rationing everyone.
 */
export const feedbackSubmitRateLimit = {
  rateLimit: {
    max: 10,
    timeWindow: '1 hour',
    keyGenerator: (request: { user?: { sub?: unknown } }) => {
      const sub = request.user?.sub
      if (typeof sub !== 'string' || sub.length === 0) {
        throw new Error(
          'feedbackSubmitRateLimit: request.user.sub is missing — authMiddleware must run before this key generator',
        )
      }
      return `feedback_user:${sub}`
    },
  },
} as const

/**
 * Public `POST /catalog/submit` (epic #1717, #1711). Unauthenticated, so the
 * shared key generator falls back to `ip:` — the same untrusted-proxy trap as
 * `authRateLimit`, and the same answer: a per-IP ceiling whose "IP" is one
 * shared proxy address is a cheap global denial-of-service (every external
 * caller collapsed into one bucket can 429 every other), so the tier refuses
 * to arm itself unless the operator trusts the proxy (`TRUST_PROXY_HOPS > 0`),
 * exactly like signup/login (#1670).
 *
 * Tighter than auth's login tier on purpose: a merchant submits once, and
 * submission is the spam vector the queue exists to cheapen (the ownership
 * proof in #1712 is the real anti-abuse gate; this is just the request-storm
 * ceiling before it). 10/min per client IP is far above any legitimate
 * submitter and below any meaningful flood. The queue cap
 * (`countPendingCatalogSubmissions`) is the resilient second layer — unlike
 * this tier it binds even behind an untrusted proxy.
 */

export function catalogSubmitRateLimit(
  trustProxyHops: number,
): { rateLimit?: { max: number; timeWindow: string } } {
  if (trustProxyHops <= 0) return {}
  return {
    rateLimit: {
      max: 10,
      timeWindow: '1 minute',
    },
  }
}
