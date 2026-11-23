---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/Dockerfile
  - packages/mcp-server/Dockerfile
  - packages/demo-merchant-mcp/package.json
  - packages/backend/src/config.ts
  - packages/paywall-proxy/demo/opper-products.json
last-verified: "2026-11-18"
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
verifier), and since #4890 `@haven_ai/merchant-payments` (the shared receipt
and payment core). Its own `build`, `test` and `typecheck` scripts build
`packages/core`, `packages/sdk` and `packages/merchant-payments` first, the
same way the backend's scripts do. So the Railway command is unchanged and both
are always built before the merchant that consumes them.

`ci.yml`'s `demo_merchant_checks` job runs `npm run smoke:start -w
packages/demo-merchant-mcp` after the build: it spawns the built
`dist/index.js` with a throwaway config and waits for the startup banner, which
is printed inside `server.listen`'s callback. A green `tsup` alone would not
prove the emitted entrypoint can resolve its workspace dependency. Since #4851
the throwaway config includes a fake CDP key pair: the smoke then asks the
local `/healthz` and fails if CDP is not reported or if the key secret appears
in the startup output or `/healthz`.

**Operator step — the passport env flip.** The demo merchant advertises
`haven-passport` only when BOTH of these are set on the service:

| Variable | Value |
|---|---|
| `MERCHANT_HAVEN_BASE_URL` | the Haven API origin to resolve passports against and, with the Sales settings, to report Sales to (#4950) (e.g. the dev backend's public URL) |
| `MERCHANT_PASSPORT_ISSUER` | the issuer address from `GET /passport/issuer` on that deployment |

With either missing it advertises only `haven-demo`, exactly as before. Set
both **together, on a service that is not mid-quote**: the merchant's echo rule
refuses a payment whose extensions do not contain every advertised key, so a
402 quoted before the flip and paid after it is refused — and on the EIP-3009
bridge that happens after funding, so the funds strand until a sweep. The
window is about 10 minutes: the 300 s quote (`maxTimeoutSeconds`) plus the
300 s forward margin Haven's SDK adds when it signs
(`X402_SETTLEMENT_FORWARD_MARGIN_SECONDS`).

Rotating `PASSPORT_RECEIPT_SIGNING_KEY` breaks this pin: the merchant will
answer `not_signed_by_issuer` for every receipt until `MERCHANT_PASSPORT_ISSUER`
is updated. See [secret-rotation.md](secret-rotation.md).

**Operator step — the CDP key (#4851, epic #4849).** The demo merchant offers
its CDP-settled joke product only when BOTH of these are set on the service:

| Variable | Value |
|---|---|
| `CDP_API_KEY_ID` | the key ID of a Coinbase Developer Platform secret API key used only by the demo merchant |
| `CDP_API_KEY_SECRET` | that key's secret |

**Creating the key.** The Coinbase Developer Platform portal has no projects:
a secret API key belongs to the whole account, which has a **Live** and a
**Sandbox** mode. So the key cannot be isolated in a project of its own;
isolate it by giving the demo merchant its own key, with nothing ticked that
it does not need:

- **Mode:** Live. A Live key settled the joke on Base Sepolia in #4852's dev
  run; a Sandbox key has not been tried.
- **IP allowlist:** tick *Allow requests from any IP address*. An allowlist
  works only with fixed outbound IPs, which a Railway service has only when
  static outbound IPs are enabled on it.
- **Permissions** (*Advanced settings*): leave *Trade*, *Transfer* and
  *Receive* (Coinbase App & Advanced Trade) and *Export* and *Manage*
  (Non-custodial) unticked: #4852's dev run settled with a key set up this
  way, and with them a leaked key could move the Coinbase account's funds
  (*Transfer*) or export or re-permission its CDP wallets (*Export*, *Manage*).
  *View* is ticked by default and unticking it has not been tried — the dev
  key that settled may have had it ticked — so if verify or settle is refused
  without it, tick *View*. A key with *View* can read the account's CDP
  wallets, so keep wallets out of this account or accept that.
- **Signature algorithm:** the default, Ed25519.
- One key per environment, so dev and production can be revoked apart.

Paste the values straight into the service variables, never into chat, an
issue, a file or a log, then redeploy: the pair is read once, at startup. With
neither set the merchant is exactly as before to buyers and on `/healthz` (the
startup banner gains a `CDP: not configured` line). With one set, or with both
set but the Coinbase client failing to build, it logs a warning (naming the
variables, or the error class only) and does not offer the joke; every other
product is unaffected.

**Setting** the pair needs no coordination with in-flight quotes: no joke quote
can exist before it, and every other product's 402 is rebuilt from the product
on each request, so it is unchanged. **Removing** it does: a joke quoted before
the removal and paid after it gets "unknown tool" — nothing settles, so the
merchant is not paid — but on Haven's EIP-3009 bridge, the joke's only path,
the refusal comes after the funding leg, so 0.01 USDC strands on the agent's
delegate until it is swept. Remove the pair on a service that is not mid-quote;
the window is the same 10 minutes as for the passport flip above. Either redeploy
also drops every in-memory MCP session, which buyers recover from by
re-initialising, as after any redeploy.

Check the result with `GET /healthz`, which carries a `cdp` block
(`configured: true`, no credential) only when CDP is on — it also catches the
client-build failure above. See [secret-rotation.md](secret-rotation.md) for
the key's inventory row.

### Paywall-proxy (the #4892 demo)

**Not deployed yet.** It waits on Haven's Opper API key, which does not exist
yet, and on the receiving address. This is the configuration it is created
with. When it is created, move it into the table above and record the date.

The merchant kit's paywall proxy in front of Opper's inference API, run by
Haven as an internal technical demo on Base Sepolia (#4892, owner decision
2026-11-16: the owner accepted the added running cost). It exists in **dev
only**: it is created in the dev environment and never in production.

**Why it keeps building from source, and does not run the published image
(#5007).** The kit's image is published to
`ghcr.io/d-hinders/haven-paywall-proxy`, and it sets
`PRODUCTS_FILE=/config/products.json` — the merchant's own file, mounted
read-only. This demo's products file is
`packages/paywall-proxy/demo/opper-products.json`, a file in the repository, and
the image deliberately does not carry it: the published image is the kit, not
Haven's demo configuration. Railway cannot mount a single repository file into a
container (a volume mounts a directory, and copying the file onto it by hand
would take it out of version control), so running the image here would mean
either baking Haven's demo config into every merchant's image or maintaining an
unversioned copy on a volume. The source build reads the file from the
repository root, which is what the service already does. When the demo is
created, if Railway gains a way to mount a repository file, moving it to the
image is a one-row change: the same `/data` volume, and `PRODUCTS_FILE` pointing
at the mounted file.

The merchant's own Railway recipe, which deploys the published image with the
merchant's products file copied in by a two-line Dockerfile, is in the kit's
README § *Host it on Railway*.

| Setting | Value |
|---|---|
| Build | root `/`, `npm ci && npm run build -w packages/paywall-proxy` (the package's build script builds the SDK and `@haven_ai/merchant-payments` first); watch `/packages/paywall-proxy/**`, `/packages/merchant-payments/**`, `/packages/sdk/**`, so an unrelated push to `dev` does not restart it |
| Start command | `node packages/paywall-proxy/dist/index.js` |
| Volume | one volume, mounted at `/data`, for `PAYMENTS_DB`. Not backed up: it holds test-money payments only, and losing it loses only the one-call rule for those (design §12 asks a real merchant to back it up) |
| Replicas | one. The proxy locks `PAYMENTS_DB` and a second process refuses to start, so a deploy must stop the old container before starting the new one. Check this on the first redeploy |
| Sleep | on |
| Healthcheck | `/healthz` |

Variables, named, with values only for those that are not secret:

| Variable | Value |
|---|---|
| `NETWORK` | `eip155:84532` |
| `PAY_TO` | the receiving Sales account's address: the Sales account the demo reports sales to, so its sales land on that account's Sales page. A Haven dev account until Opper has its own, then Opper's |
| `OPERATOR_NAME` | `Haven (internal technical demo)` |
| `ENDPOINT_NAME` | `Haven inference demo (Opper)` |
| `ENDPOINT_DESCRIPTION` | `Internal technical demo run by Haven on Base Sepolia. Test money only. Not a Haven product and not listed in any directory.` |
| `PRODUCTS_FILE` | `packages/paywall-proxy/demo/opper-products.json`, relative to the repository root, which is the process's working directory because the service root is `/`. This is the one service that depends on its working directory |
| `PAYMENTS_DB` | `/data/payments.sqlite` |
| `UPSTREAM_BASE_URL` | `https://api.opper.ai` (Opper's key goes in `Authorization: Bearer`, the proxy's default) |
| `UPSTREAM_API_KEY` | secret: Haven's Opper key, pasted in by the owner ([secret-rotation.md](secret-rotation.md)) |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | references to Demo-merchant's dev values, `${{Demo-merchant.CDP_API_KEY_ID}}` and `${{Demo-merchant.CDP_API_KEY_SECRET}}`, so the secret is set in one place |
| `RPC_URL` | a reference to the dev backend's `${{@haven/backend.RPC_URL_BASE_SEPOLIA}}` (the Alchemy URL, which embeds a key) |
| `PUBLIC_BASE_URL` | the service's `https://` Railway domain. Haven's signer answers a retry challenge only for an `https` origin |
| `CLIENT_IP_HEADER` | `X-Real-IP`, the client address Railway's edge sets. Check it against a request on the first deploy |
| `VAT_RULE` | `SE_25_WITH_EU_REVERSE_CHARGE` |
| `SELLER_NAME`, `SELLER_ADDRESS`, `SELLER_ORG_NR`, `SELLER_VAT_NR`, `SELLER_IBAN`, `SELLER_BIC` | Haven's demo seller, the demo merchant's `DEMO_SELLER`: `Haven Demo AB`, `Birger Jarlsgatan 57, 113 56 Stockholm`, `559412-3456`, `SE559412345601`, `SE35 5000 0000 0549 1000 0003`, `ESSESESS`. Never the pilot partner's details while Haven runs the endpoint |

### Sleep

A sleeping service (Railway "serverless") stops after about 10 minutes without
outbound traffic and cold-starts on the next request. It is on for both
Demo-merchants and the dev hosted MCP. Dev Demo-merchant joined them on
2026-10-05. It sees QA traffic and the dev backend's hourly catalog probe,
which wakes it once an hour. With Stripe recording on (#4856; dev only, since
Stripe is dev and sandbox only), the merchant
also reads a USDC→SEK rate from CoinGecko at startup and every 30 minutes;
that interval is above the idle threshold, so it does not keep the service
awake. Since #4281 that probe runs under the SSRF
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
