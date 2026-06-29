---
owner: "@d-hinders"
status: current
covers:
  - packages/mcp-server/**
  - docker-compose.yml
last-verified: "2026-06-28"
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
   - **Do not set** `HAVEN_DELEGATE_KEY`. The process refuses to start if it
     is set; this is intentional defense-in-depth.
   - `PORT` is provided by Railway automatically.
4. **Networking → Generate Domain.** You get
   `havenmcp-production-*.up.railway.app` straight away (Railway-issued TLS).
   Use this URL while shaking the service out.
5. **Healthcheck → Path:** `/healthz`. Status code: `200`.
6. **Resources:** start at Railway's defaults; this service is stateless and
   per-request, scale horizontally if traffic warrants.

### Custom domain — when the frontend (#187) needs a stable URL

> Haven does not own a custom domain today; the hosted MCP is reached at its
> Railway URL. These steps apply only once a domain we control is registered —
> use that domain (e.g. `mcp.<your-domain>`), not a placeholder we don't own.

1. Railway → Service → **Networking → Custom Domain** → add `mcp.<your-domain>`.
2. Add the displayed `CNAME` record at your DNS provider.
3. Wait for Railway to issue a cert (TLS automatic).
4. Update the frontend connect command generator to point at the custom domain.

## Local development

```sh
# Builds backend + frontend + mcp-server images and brings them up:
npm run docker:up
# Hosted MCP: http://localhost:8788 (POST /v1, GET /healthz)
```

The `mcp-server` service in `docker-compose.yml` depends on `backend` and
points `HAVEN_API_URL` at the internal Compose hostname.

## Smoke tests after a deploy

```sh
URL=https://havenmcp-production-XXXX.up.railway.app    # or your custom domain once mapped

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
`haven_pay`/`haven_submit` round trip writes `agent_tool_invocations` rows on
the backend (already wired via the `X-Haven-MCP-Tool` header).

## Observability

- **Per-request access log** — one JSON line per request on stdout (Railway
  ingests these as structured logs). Includes the MCP tool name for
  `tools/call`, never the api key or any body content.
- **Backend audit log** — `agent_tool_invocations` rows are written by the
  backend whenever a request arrives with `X-Haven-MCP-Tool: <name>` (the
  hosted server sets this for every tool dispatch). The agent activity feed in
  the dashboard reads from there.
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
  `HAVEN_MCP_PATH`, and the Railway-provided `PORT`.)
- Service logs at startup do **not** include the line
  `HAVEN_DELEGATE_KEY is set in the environment…` — if they do, the process
  has refused to boot and the deploy is misconfigured.
- A real payment leaves an `agent_tool_invocations` row but **no row** anywhere
  containing key material.

## Out of scope (future)

Rate limiting / WAF, Sentry, autoscaling beyond Railway defaults, custom
domain DNS automation. Tracked separately if/when needed.
