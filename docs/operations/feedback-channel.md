---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/routes/feedback.ts
  - packages/backend/src/infra/repositories/feedback.ts
  - packages/backend/src/modules/feedback/secret-check.ts
  - packages/backend/src/db/migrations/106_feedback.ts
  - packages/cli/src/secret-check.ts
  - packages/backend/src/middleware/rate-limit.ts
  - packages/backend/src/platform/leader-lock.ts
  - packages/backend/src/middleware/owner-cli.ts
  - packages/backend/src/middleware/auth.ts
  - packages/backend/src/domain/redact-vendor-secrets.ts
last-verified: "2026-10-02"
---

# CLI feedback channel (#3597)

`haven feedback submit "<text>"` is a one-way channel from a signed-in user
(or the agent working in their terminal, under the same session) to Haven —
a feedback report or a bug report, 4000 code points or fewer
(`commands.ts`'s `MAX_FEEDBACK_TEXT_LENGTH`, imported from `secret-check.ts`
where it is actually defined). There is no
reader yet: the founders-only, masked-by-default ops console read is a
separate issue, [#3602](https://github.com/d-hinders/Haven-AI/issues/3602),
a slice of epic #3507.

## Who can call it

**Signed-in users only — a user JWT, nothing else** (owner decision,
2026-10-02). No agent API key, no anonymous caller, no MCP tool. `authMiddleware`
refuses an agent key the same way it refuses every other owner-only route —
an agent key is not a verifiable JWT, so it never reaches the handler.

**The device-flow (`haven login`) token is NOT the dashboard's own JWT,
though.** It carries `purpose: 'owner_cli'` (`routes/auth.ts`), and #1640's
standing rule refuses ANY `purpose`-carrying token on every route by
default — an agent-driven CLI session is treated as narrower than a
dashboard session unless a route opts in by name. `POST /feedback` and `GET
/accounts/hybrid/{address}/signers` (the read layer 3 needs — see below) are
both on the `owner_cli` allow-list (`middleware/owner-cli.ts`'s
`OWNER_CLI_ALLOWED_ROUTES`), audited by `owner-cli-route-census.test.ts`:
that census discovers every registered route, so a future route added
without a decision refuses by construction, never by omission.

## Retention

Seven days. Every row's `expires_at` defaults to `created_at + 7 days`
(migration 106). **Every read filters `expires_at > NOW()`**, so the seven
days hold even if the purge sweep lags — a read never serves an expired row,
whether or not it has physically been deleted yet.

The purge (`deleteExpiredFeedback`) runs on `index.ts`'s
`FEEDBACK_SWEEP_INTERVAL_MS` (5 minutes), leader-gated through `runIfLeader`
(`platform/leader-lock.ts`, `LEADER_LOCK_KEYS.feedbackSweep` = `811012`) —
exactly one replica sweeps per tick, mirroring the rate-limit-counter sweep
(`#1680`) this was modelled on. A missed tick only leaves dead rows longer;
it never serves one, because the read-side filter above is independent of
the sweep.

## The secret check — three layers of defence

**The CLI is the control.** `packages/cli/src/secret-check.ts` refuses to
send text that looks like a secret BEFORE any network request carrying that
text is made:

1. **Prefixed/labelled secrets** (an agent API key, a setup token, a session
   JWT, a labelled URL/query-string credential) — a superset of
   `domain/redact-vendor-secrets.ts`'s own patterns.
2. **Secrets this machine holds, exact match** — read with `node:fs` from
   `~/.haven/agents/<slug>/{signer.json,identity.json,rekey-pending.json}`
   (tombstoned directories included — they keep their keys), the
   `HAVEN_DELEGATE_KEY` env var, and the CLI's own `~/.haven/session.json`
   token.
3. **Any other 64-hex token: derive its address, compare to this user's own
   key-backed addresses** (`GET /agents`'s `delegate_address`, `GET
   /accounts/hybrid/{address}/signers`'s `owner_address`). A transaction hash,
   a delegation hash and a schema hash have the same SHAPE as a private key,
   so shape alone cannot decide — this layer asks what the token would DO.
   The address read runs only when a candidate token exists, and **fails
   closed**: an unreadable address set refuses to send, with a retry hint,
   rather than silently skipping the one layer that stops a private key
   reaching Haven.
4. **Recovery phrases** — a run of 12 or more consecutive BIP-39 English
   words (`@scure/bip39`'s wordlist, bundled as a devDependency so
   `@haven_ai/cli` keeps zero runtime dependencies).

**The second layer: the backend route re-runs the check, as a backstop, not
the control.** `routes/feedback.ts` re-runs layer 1
(`modules/feedback/secret-check.ts`'s `detectLabelledSecret`), layer 3
(`isKeyBackedAddress`, against every agent's `delegate_address` and every
Hybrid DeleGator's `owner_address` **system-wide across the database**, not
scoped to the caller — a private key reaching Haven at all is the custody
problem, whoever it belongs to) and layer 4 (`containsRecoveryPhrase`, using
`viem/accounts`'s English wordlist) before any write. It is what catches a
caller that bypasses the CLI (a direct API call, or any future second
client) — not the primary defence. A refused request's text is never
logged; the 400 body carries only a `reason` code.

**The third layer, independent of the first two:** `domain/redact-vendor-secrets.ts`
runs again at the repository's own write boundary (`insertFeedback`), the
same place it already runs for stored failure text elsewhere in the backend.

## Abuse controls

- Body size capped at 16 KB. Closer than it looks: 4000 Unicode code points
  (the cap below) at 4 UTF-8 bytes each — the worst case, every code point
  outside the Basic Multilingual Plane — plus the JSON envelope is 16,011
  bytes against a 16,384-byte (16 KB) ceiling, 373 bytes of headroom, not
  "far more". Both the CLI's own pre-send cap and ajv's `maxLength` count
  Unicode CODE POINTS, not UTF-16 units (`[...text].length`, not
  `text.length` — verified against ajv directly: `maxLength: 1` accepts one
  emoji, which is two UTF-16 units).
- Text length capped at 4000 code points (enforced by the OpenAPI
  request-validation plugin's `maxLength`, since `routes/feedback.ts` is a
  brand-new module born **enforced**).
- Rate limit: 10 submissions per hour, keyed **per user** (`request.user.sub`,
  read by the rate-limiter's own `keyGenerator`). That key generator runs
  AFTER `authMiddleware` — measured, not assumed: `@fastify/rate-limit`
  attaches its per-route check through `onRoute`, appended to that specific
  route's own hook array, so the route's own `authMiddleware` (added via
  `app.addHook('onRequest', authMiddleware)`) runs first and `request.user`
  is already verified by the time the key generator runs. This is the one
  rate-limit tier in the backend keyed per user rather than per credential or
  per IP — see the comment on `feedbackSubmitRateLimit`
  (`middleware/rate-limit.ts`) for why the distinction matters here
  specifically.

## If it needs to change

- **Raising the retention window or adding a reader**: #3602 is already the
  reader slice; a retention change is an owner decision, same as the
  original seven days.
- **A new local secret source for layer 2**: add it to both
  `packages/cli/src/secret-check.ts`'s `readLocalSecrets` and this doc's
  list above — the CLI's own tests (`secret-check.test.ts`) are the
  mutation-proof for each source.
- **A new labelled-secret pattern for layer 1**: add it to both
  `packages/cli/src/secret-check.ts` and
  `packages/backend/src/modules/feedback/secret-check.ts` — they are
  deliberately two copies (the CLI stays dependency-free and never imports
  `@haven_ai/connect`), not one shared module, so a change to one is not
  automatically a change to the other. Keep them in sync by hand.
