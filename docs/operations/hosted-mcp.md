---
owner: "@d-hinders"
status: current
covers:
  - packages/mcp-server/**
  - docker-compose.yml
  - packages/backend/src/middleware/agentToolAudit.ts
  - packages/sdk/src/connector-channel.ts
last-verified: "2026-10-05"
---

# Deploy — Hosted MCP server (`@haven_ai/mcp-server`)

How to deploy and operate the hosted, keyless MCP server on Railway alongside
the existing Haven backend. Pairs with the edge signer (#184); see
[`docs/architecture/06-hosted-mcp-connect-flow.md`](../architecture/06-hosted-mcp-connect-flow.md)
for the wire contract and the custody invariant.

## What this service does

- Speaks Streamable HTTP MCP on `POST /v1`, authenticated per-request via
  `Authorization: Bearer sk_agent_*`.
- Constructs and relays payments. It **holds no key material** — both code-level
  (`createHostedHavenClient` is keyless by construction) and process-level
  (`assertHostedEnv` refuses to start if `HAVEN_DELEGATE_KEY` is in env).
- Exposes `GET /healthz` for liveness probes.
- Emits one structured JSON access-log line per request — `{ts, method, path,
  status, ms, tool}` — with no body content or auth headers.

## Prerequisites

- A Railway project that already runs `havenbackend-production-*` (the Haven
  backend the hosted MCP relays through).
- Repo branch with this package built (CI's **MCP server checks** job
  exercises typecheck/test/build; **Docker build (MCP server)** exercises the
  image so a broken Dockerfile is caught before deploy).
- On the **user's** machine, Node.js `>=22.0.0`. This service is hosted, but the
  default topology pairs it with a local signer, and since
  [#1161](https://github.com/d-hinders/Haven-AI/issues/1161) connect refuses to
  set up — and the signer refuses to start — below that floor. See
  [Where the Node floor is enforced](mcp-runtime-compatibility.md#where-the-node-floor-is-enforced).

## Railway setup (one-time)

1. **New Service** in the same project → "Deploy from GitHub repo" → pick the
   Haven repo.
2. **Build → Dockerfile path:** `packages/mcp-server/Dockerfile`.
   (Leave context as the repo root — the Dockerfile copies workspace
   `package.json`s and builds the SDK before the server.)
3. **Variables:**
   - `HAVEN_API_URL` = the existing backend's public URL,
     e.g. `https://havenbackend-production-8a00.up.railway.app`.
   - `HAVEN_MCP_PATH` = `/v1` (default — only change if you need a different
     mount path).
   - `HAVEN_CONNECTOR_CHANNEL` (optional, #2423) = the npm dist-tag this
     deployment's connector hints (since #3412, `npx -y @haven_ai/connect@<tag> --doctor`) should name.
     **Unset is `alpha`**, the production channel, which is what production
     wants — leave it unset there. A deployment paired with a non-production
     package channel sets it to that tag so the hints it emits install the
     matching connector instead of sending the tester to production. A value
     that is not a well-formed dist-tag (`[a-z][a-z0-9-]{0,31}`) makes the process
     **refuse to start**: a silent fallback would leave a misconfigured
     deployment quietly handing out the production connector while looking
     configured. Setting this on any environment is an operator action; no
     agent performs it, and nothing in this repository records which
     deployments have it set.
   - `BASE_RPC_URL` (optional) = a read-only Base mainnet RPC URL. When it is
     set, a paid MCP call waits for one on-chain confirmation of the funding
     transaction (up to 30 s) before the payment header reaches the merchant;
     unset, that wait is skipped.
   - **Do not set** `HAVEN_DELEGATE_KEY`. The process refuses to start if it
     is set to a non-empty value; this is intentional defense-in-depth.
   - `PORT` is provided by Railway automatically.
4. **Networking → Generate Domain.** You get a `*.up.railway.app` domain
   straight away (Railway-issued TLS); production's is the host in the
   backend's `DEFAULT_HOSTED_MCP_URL`. Use this URL while shaking the service
   out.
5. **Healthcheck → Path:** `/healthz`. Status code: `200`.
6. **Resources:** start at Railway's defaults; this service is stateless and
   per-request, scale horizontally if traffic warrants.
7. **Backend handout.** Agents get the hosted URL from the backend's
   `HAVEN_HOSTED_MCP_URL`. On any backend other than production, set it to
   this service's `https://<domain>/v1`; until then, connector setup fails
   with an error naming the variable. Production falls back to the backend's
   `DEFAULT_HOSTED_MCP_URL`.

### Custom domain — when the frontend (#187) needs a stable URL

> Haven does not own a custom domain today; the hosted MCP is reached at its
> Railway URL. These steps apply only once a domain we control is registered —
> use that domain (e.g. `mcp.<your-domain>`), not a placeholder we don't own.

1. Railway → Service → **Networking → Custom Domain** → add `mcp.<your-domain>`.
2. Add the displayed `CNAME` record at your DNS provider.
3. Wait for Railway to issue a cert (TLS automatic).
4. Set `HAVEN_HOSTED_MCP_URL` on the backend service to `https://mcp.<your-domain>/v1`.
   The connector handout and the discovery document read the hosted URL from
   the backend, and the dashboard takes it from there.

## Local development

```sh
# Brings up backend + frontend + mcp-server (builds an image only when it is
# missing — after a code change, run `docker compose up -d --build`):
npm run docker:up
# Hosted MCP: http://localhost:8788 (POST /v1, GET /healthz)
```

The `mcp-server` service in `docker-compose.yml` depends on `backend` and
points `HAVEN_API_URL` at the internal Compose hostname.

## Smoke tests after a deploy

```sh
URL=https://<this-service>.up.railway.app    # or your custom domain once mapped

# 1. Liveness:
curl -s $URL/healthz                 # → {"status":"ok"}

# 2. Unauth POST rejects with 401:
curl -s -o /dev/null -w "%{http_code}\n" -X POST $URL/v1 \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'   # → 401

# 3. End-to-end (with a real agent key + the edge signer running):
claude mcp add --transport http haven $URL/v1 \
  --header "Authorization: Bearer sk_agent_..."
# Then drive a payment from your MCP client: haven_pay → edge signs → haven_submit.
```

Acceptance for #186: `/healthz` → 200, unauth `POST /v1` → 401, and a successful
`haven_pay`/`haven_submit` round trip. Neither of those tools leaves an
`agent_tool_invocations` row, because the backend records only allowlisted tool
names (see Observability); a follow-up `haven_get_payment_status` on the payment
does leave one.

## Observability

- **Per-request access log** — one JSON line per request on stdout (Railway
  ingests these as structured logs). Includes the MCP tool name for
  `tools/call`, never the api key or any body content.
- **Backend audit log** — the hosted server sets `X-Haven-MCP-Tool: <name>` on
  every backend request a tool dispatch makes. The backend writes an
  `agent_tool_invocations` row only for an agent-authenticated request whose
  name is on its allowlist (`MCP_TOOL_NAMES` in
  `packages/backend/src/middleware/agentToolAudit.ts`): the x402
  quote/pay/resume tools and the read tools. Other tools, including
  `haven_pay`, `haven_send` and `haven_submit`, leave no row. The agent
  activity feed in the dashboard reads from there.
- **Railway HTTP metrics** — request counts, latencies, status mix.

If you wire Sentry or another error reporter later, drop it in
`packages/mcp-server/src/cli.ts` next to `assertHostedEnv()`.

## Rollback

Railway → Service → **Deployments → previous successful build → Redeploy**.
Stateless service with no DB, so rollbacks are instant. Confirm via the smoke
tests above.

## Verifying the custody posture in production

- Railway → Service → **Variables** has no `HAVEN_DELEGATE_KEY`, no
  credential JSON, no relayer key. (Only `HAVEN_API_URL`, optional
  `HAVEN_MCP_PATH`, optional `HAVEN_CONNECTOR_CHANNEL`, optional
  `BASE_RPC_URL` — a read-only RPC endpoint, which may carry a provider API key
  but never signing material — and the Railway-provided `PORT`.)
- Service logs at startup do **not** include the line
  `HAVEN_DELEGATE_KEY is set in the environment…` — if they do, the process
  has refused to boot and the deploy is misconfigured.
- **No row** anywhere contains key material. A payment leaves an
  `agent_tool_invocations` row only when an allowlisted tool, such as
  `haven_pay_x402_quote`, makes it (see Observability).

## Out of scope (future)

Rate limiting / WAF, Sentry, autoscaling beyond Railway defaults, custom
domain DNS automation. Tracked separately if/when needed.

Re-verified 2026-09-21 (weekly docs audit #3206, at dev `7f17c9f3`), 42
mcp-server commits after the last verification: every operational claim above
still matches the code: `assertHostedEnv`'s `HAVEN_DELEGATE_KEY` refusal and
message text (`boot.ts`), `HAVEN_CONNECTOR_CHANNEL` dist-tag validation
(`connector-channel.ts`), the `POST /v1` + `GET /healthz` surface
(`http.ts`, `HAVEN_MCP_PATH` in `cli.ts`), the one-line access log (`log.ts`),
the compose wiring (`docker-compose.yml` `mcp-server` service: Dockerfile
path, 8788, `depends_on`, `HAVEN_API_URL: http://backend:3001`), and the CI
job names this doc cites ("MCP server checks", "Docker build
(MCP server)"). The intervening commits (#2812 tool extraction into
`src/tools/`, #3118/#3155 the plain-HTTP x402 profile, #3102 refusal next
steps, #3126 `haven_check_funds`) changed the tool surface behind the same
HTTP and custody posture this doc describes; nothing here needed rewriting.

Re-verified 2026-10-05 (weekly docs audit #3645, at dev `c3df5b19`), a full
re-read, 50 covered commits after the last verification. The 2026-09-21 note
above was wrong in one respect, and none of these errors came from the
intervening commits; each was already wrong at `7f17c9f3`:

- **Audit rows.** The doc said every tool dispatch leaves an
  `agent_tool_invocations` row. The backend records only an allowlist
  (`MCP_TOOL_NAMES`), and `haven_pay`/`haven_submit` were never on it.
- **Environment.** The variables list missed `BASE_RPC_URL`.
- **Custom domain.** The step pointed at a frontend URL generator. The hosted
  URL actually comes from the backend's `HAVEN_HOSTED_MCP_URL`, which a
  non-production backend must set.
- **Domain names.** The predicted domain `havenmcp-production-*` matches no
  deployed host.
- **Dist-tag pattern.** It lacked its 32-character cap.

`covers:` gains the two backend/SDK files those claims rest on.
