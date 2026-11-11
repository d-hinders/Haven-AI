---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/Dockerfile
  - packages/mcp-server/Dockerfile
  - packages/demo-merchant-mcp/package.json
  - packages/backend/src/config.ts
last-verified: "2026-11-06"
---

# Railway Services

The record of how Haven's Railway services are configured. **These settings
live in Railway, not in the repo.** No service uses config-as-code
(`railwayConfigFile` is unset on all eight service instances: four services
× two environments), so this page is the only place
they are written down. When you change a setting in Railway, change this page
too. Secrets and their rotation are in
[secret-rotation.md](secret-rotation.md).

Read the live values in each service's **Settings** in the dashboard, or with
the Railway CLI's token against the GraphQL API
(`serviceInstance(environmentId, serviceId) { startCommand sleepApplication … }`).

## Services

One Railway project, **Haven AI**, with two environments of the same shape:
`dev` deploys from the `dev` branch and `production` from `main`
([dev-environment.md](dev-environment.md)).

| Service | Build | Start command | Sleep (dev / prod) | Healthcheck |
|---|---|---|---|---|
| `@haven/backend` | `packages/backend/Dockerfile`; watch `/packages/backend/**`, `/packages/sdk/**` | `node packages/backend/dist/index.js` | off / off | none set (probe `GET /health`) |
| `Haven-AI-Hosted-MCP` | `packages/mcp-server/Dockerfile` | none: the Dockerfile `CMD` | **on** / off | `/healthz` |
| `Demo-merchant` | root `/`, build `npm ci && npm run build -w packages/demo-merchant-mcp` | `node packages/demo-merchant-mcp/dist/index.js` | **on** / **on** | none set (probe `GET /healthz`) |
| `Postgres` | image `ghcr.io/railwayapp-templates/postgres-ssl:18` | none | off / off | none |

Sleep settings and start commands verified against both environments on
2026-11-04; builds and healthchecks on 2026-10-06.

### Start commands run `node`, never `npm run start`

Until 2026-10-05 (dev) and 2026-10-06 (production), both start commands were
`npm run start --workspace=…`. That keeps an `npm` parent process resident
beside `node` for the life of the container, and puts `npm` between Railway's
`SIGTERM` and the app on shutdown. Dropping it cut about 25 MB of billed memory
from the dev backend, measured over the same 17 hours in which the unchanged
prod backend rose slightly (157→162 billed units).

The commands are relative to the repo root because both services run from it
(`WORKDIR /app` in the backend Dockerfile; root `/` for Demo-merchant). The backend's command matches its
Dockerfile `CMD`. Neither process depends on its working directory: configuration comes from Railway
service variables, and Demo-merchant reads no files from disk.

### Demo-merchant builds the SDK first (#4723)

The Demo-merchant build command stays `npm ci && npm run build -w
packages/demo-merchant-mcp` — **do not change it in Railway.** Since #4723 the
package imports `@haven_ai/sdk` at runtime (the merchant-side passport
verifier), and its own `build`, `test` and `typecheck` scripts now build
`packages/core` and `packages/sdk` first, the same way the backend's scripts
do. So the Railway command is unchanged and the SDK is always built before the
merchant that consumes it.

`ci.yml`'s `demo_merchant_checks` job runs `npm run smoke:start -w
packages/demo-merchant-mcp` after the build: it spawns the built
`dist/index.js` with a throwaway config and waits for the startup banner, which
is printed inside `server.listen`'s callback. A green `tsup` alone would not
prove the emitted entrypoint can resolve its workspace dependency.

**Operator step — the passport env flip.** The demo merchant advertises
`haven-passport` only when BOTH of these are set on the service:

| Variable | Value |
|---|---|
| `MERCHANT_HAVEN_BASE_URL` | the Haven API origin to resolve passports against (e.g. the dev backend's public URL) |
| `MERCHANT_PASSPORT_ISSUER` | the issuer address from `GET /passport/issuer` on that deployment |

With either missing it advertises only `haven-demo`, exactly as before. Set
both **together, on a service that is not mid-quote**: the merchant's echo rule
refuses a payment whose extensions do not contain every advertised key, so a
402 quoted before the flip and paid after it is refused — and on the EIP-3009
bridge that happens after funding, so the funds strand until a sweep. The
window is one quote lifetime (`maxTimeoutSeconds`, 300 s).

Rotating `PASSPORT_RECEIPT_SIGNING_KEY` breaks this pin: the merchant will
answer `not_signed_by_issuer` for every receipt until `MERCHANT_PASSPORT_ISSUER`
is updated. See [secret-rotation.md](secret-rotation.md).

### Sleep

A sleeping service (Railway "serverless") stops after about 10 minutes without
outbound traffic and cold-starts on the next request. It is on for both
Demo-merchants and the dev hosted MCP. Dev Demo-merchant joined them on
2026-10-05. It sees QA traffic and the dev backend's hourly catalog probe,
which wakes it once an hour. Since #4281 that probe runs under the SSRF
guard with a 15 s total deadline (`CATALOG_REFRESH_PROBE_TIMEOUT_MS`). That
covers the cold start (3.8–5.0 s, measured 2026-10-22), so a cold start
alone does not fail the probe, and an entry is only marked degraded after
three consecutive failures. Since #4300 the whole refresh run is bounded to
10 min. A row the run does not reach is not counted as a failure, and is
probed first next run.

**The dev hosted MCP's setting is on, but it does not sleep in practice.** One
of our own long-running clients keeps it busy, seen in its HTTP logs as
`python-httpx2` (four small requests every 3 minutes) and `Python-urllib` (one
every 6, matching `haven_get_allowances` in the service log). Its billed memory
stayed at 84–144 MB in every 6-hour window from 2026-11-01 to 2026-11-04, close
to the roughly 110 MB of the always-on production copy.

### Dev Postgres memory

Dev Postgres runs `shared_buffers = 32MB`, set on 2026-11-04. It is an
`ALTER SYSTEM` setting, so it lives in `postgresql.auto.conf` on the volume and
does not appear in the service's variables. Production was not changed.

Shared memory was the largest part of the container: 162 MB of 280 MB, against
24 MB private to Postgres processes, with 128 MB of it the buffer pool for a
210 MB database. `max_connections` stays at 500. Lowering it to 100 would free
about 14–20 MB (measured on a local idle `postgres:18.6`), and the reason it was
raised is not recorded.

Container memory also counts the page cache, and pages dropped from the buffer
pool can move there, so the saving can be smaller than the change in
`shared_buffers`. Judge it from the billing meter over a full day, not from a
reading taken soon after a restart, while the caches are still settling. Dev now
has a much smaller buffer pool than production, so its query timings are
slightly less representative.

The database has no public URL, so reach it from inside the container. To undo
the change, run this from your machine:

```bash
railway ssh --service Postgres --environment dev -- sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "ALTER SYSTEM RESET shared_buffers"'
```

Then restart the service, which briefly interrupts everything using dev:

```bash
railway restart --service Postgres --environment dev --yes
```

## Postgres access

Neither database has a public endpoint. The production TCP proxy was closed on
2026-10-27 and the dev proxy on 2026-10-29 (owner decision after the 2026-10-21
Railway incident; the inventory is in
[secret-rotation.md](secret-rotation.md)). Both `RAILWAY_TCP_PROXY_DOMAIN`
values are empty, checked on 2026-11-06.

Use `railway connect Postgres` instead. It tunnels over SSH when the service has
no public proxy URL, so it works with the proxy closed:

```bash
railway connect Postgres -e dev
railway connect Postgres -e production
```

The local database client must be installed. `--tunnel-only` opens the tunnel
without a client and prints connection details for a GUI tool (TablePlus,
DBeaver, pgAdmin); it holds the tunnel open until Ctrl+C.

If a tool truly needs a TCP proxy, open it temporarily in Railway → Postgres →
Settings → Networking → TCP Proxy, use it, then close it. Do not leave it open:
the incident exposed both database passwords, and a public endpoint widens the
blast radius for no operational gain.

## Reading cost

Railway bills Hobby usage per resource-minute, and **memory is nearly all of
it**: $8.20 of the $8.68 on the 2026-09 invoice. The cost of the project is
roughly how many MB the eight service instances keep resident, around the clock:
100 MB held all month costs about $1. The $5 Hobby fee is a usage minimum, so
savings stop once usage reaches $5.

**Read memory from the billing meter, not the Metrics graph.** For a sleeping
service the graph holds the last reported value, so a service that slept most
of the day still draws a flat line at its awake size. The `usage` query
(grouped by `SERVICE_ID`, `ENVIRONMENT_ID`) is what Railway bills, and it does
fall while a service sleeps: dev Demo-merchant billed 41% less in the 17 hours
after sleep was switched on, while its graph rose.
