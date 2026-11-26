# @haven_ai/paywall-proxy

The merchant kit's paywall proxy: x402 in front of any HTTP API, settled through
the shared merchant payment core. A merchant that sells an HTTP API runs the
kit's container image, fills in a products file and a few settings, and accepts
x402 payments without changing their own code and without a Stripe account. The
money lands in the merchant's own Sales account.

## Quickstart: a first paid call on Base Sepolia

You need:

1. A Haven account with Sales turned on, to receive into. This release runs on
   Base Sepolia only, so you and the paying agent both use Haven's dev
   environment:
   - Sign up and sign in on the dev dashboard,
     `https://haven-ai-frontend-git-dev-daniels-projects-f3327ba2.vercel.app`.
     Your passkey is bound to that exact domain and does not work on any other.
   - Do not use `haven-ai-frontend.vercel.app`: that is Haven's production
     dashboard, on Base mainnet.
   - Haven's dev API origin is `https://havenbackend-dev-8b95.up.railway.app`
     (you set it as `HAVEN_SALES_URL` in step 5).

   Step 1 under *Then* turns Sales on and gives you `PAY_TO`. The production
   setup on Base comes later.
2. Your own Coinbase developer keys: a CDP secret API key (key id and secret),
   created in the Coinbase Developer Platform. Haven does not offer its key.
3. An upstream HTTP API and its API key. For a first test call any public
   API that needs no key will do (set `UPSTREAM_AUTH=none`): Haven's
   2026-11-26 Railway test used the echo service `https://httpbin.org/anything`
   as `UPSTREAM_BASE_URL`.
4. An RPC URL for Base Sepolia, unless you use the public default
   ([Settings](#settings)).
5. Docker, and a public `https` address for the proxy: a Haven agent pays only
   a public `https` URL, never `localhost` or a private address. For a first
   test call, a quick tunnel from your own machine is enough (step 7).

Then:

1. **Copy the Sales account's receiving address.** Turn Sales on in **Settings →
   Business → Sales**, open **Sales → Setup → Receiving address** and choose
   **Show address**. It is `PAY_TO`.
   What you should see: the Sales account's address in the Receive dialog, and
   the Sales page's Overview. Every payment the proxy settles arrives there as
   USDC.
2. **Create your Coinbase developer keys.** In the Coinbase Developer Platform,
   create a secret API key ([Coinbase developer keys](#coinbase-developer-keys)).
   What you should see: the key listed in the CDP portal, and
   `coinbase key: ok (exact on eip155:84532)` when you run the check in step 6.
3. **Create a Sales key.** On **Sales → Setup → Sales keys**, create a key. It is
   `HAVEN_MERCHANT_KEY`, and it lets the proxy report each sale to Haven
   ([Sales reporting](#sales-reporting)).
   What you should see: `sales key: ok (the key was accepted)` when you run the
   check in step 6.
4. **Write the products file.** Copy
   [`products.example.json`](products.example.json) to `products.json` and set
   your routes, prices and descriptions ([The products file](#the-products-file)).
   What you should see: the proxy starts, and its `started` log line lists your
   product ids under `products`.
5. **Write the settings.** Copy [`.env.example`](.env.example) to `.env`. Docker
   reads it with `--env-file`. Inside the image, the proxy refuses to start
   without these:

   | Variable | Value |
   |---|---|
   | `NETWORK` | `eip155:84532` (Base Sepolia). |
   | `PAY_TO` | The address from step 1. |
   | `OPERATOR_NAME` | Who operates the endpoint. |
   | `UPSTREAM_BASE_URL`, `UPSTREAM_API_KEY` | Your upstream API and its key. An upstream that needs no key: set `UPSTREAM_AUTH=none` and leave `UPSTREAM_API_KEY` out. |
   | `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | The keys from step 2. |

   Also set these. The proxy starts without them, but the pilot needs the first
   two and every Haven buyer needs the third:

   | Variable | Value |
   |---|---|
   | `HAVEN_MERCHANT_KEY`, `HAVEN_SALES_URL` | The Sales key from step 3, and Haven's dev API origin, `https://havenbackend-dev-8b95.up.railway.app`. Sales reporting is required for the pilot; it is optional only for a merchant that just wants to accept payments ([Sales reporting](#sales-reporting)). |
   | `PUBLIC_BASE_URL` | The public `https` origin the proxy is reached at. Without it the challenge names `http://` and the `Host` header, and a Haven agent will not pay a plain `http` origin. |

   Delete the `PRODUCTS_FILE` and `PAYMENTS_DB` lines: the image sets both
   ([Run it as a container](#run-it-as-a-container)). Every other setting has a
   default; [All settings](#all-settings) lists them.

   **Hosting on Railway?** Do not write a `.env` file. Put these settings in
   the Railway service's variables, and run the step 6 check on Railway, not
   on your machine. That way the Coinbase secret and the Sales key never sit in
   a file on your laptop. [Host it on Railway](#host-it-on-railway) has the
   steps. Then come back for step 8.
6. **Check the settings.** With the proxy not running:

   ```bash
   docker run --rm --env-file .env \
     -v "$PWD/products.json:/config/products.json:ro" \
     -v haven-kit-data:/data \
     ghcr.io/d-hinders/haven-paywall-proxy:dev-<short-sha> check
   ```

   `<short-sha>` is the tag you pin: see [Which tag to pin](#which-tag-to-pin).
   On an Apple Silicon Mac, add `--platform linux/amd64`.
   What you should see: one line per check, each `ok`, and exit code 0
   ([Check the deployment before real traffic](#check-the-deployment-before-real-traffic)).
7. **Run the proxy.**

   ```bash
   docker run -d --name haven-paywall-proxy \
     --env-file .env \
     -v "$PWD/products.json:/config/products.json:ro" \
     -v haven-kit-data:/data \
     -p 8080:8080 \
     ghcr.io/d-hinders/haven-paywall-proxy:dev-<short-sha>
   ```

   On an Apple Silicon Mac, add `--platform linux/amd64` here too.

   Then give it a public `https` address. Pick the one that fits:

   - **A first test call: a quick tunnel (test only).** Keep the container on
     your machine and put a Cloudflare quick tunnel in front. It needs no
     account:

     ```bash
     docker network create haven-kit
     docker network connect haven-kit haven-paywall-proxy
     docker run -d --name haven-kit-tunnel --network haven-kit \
       cloudflare/cloudflared:2025.10.0 tunnel --url http://haven-paywall-proxy:8080
     sleep 10   # the tunnel takes a few seconds to get its address
     docker logs haven-kit-tunnel 2>&1 | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com'
     ```

     Set `PUBLIC_BASE_URL` to the `https://….trycloudflare.com` address the
     last command prints, and `CLIENT_IP_HEADER=CF-Connecting-IP`, then recreate
     the proxy container (`docker rm -f haven-paywall-proxy`, the `docker run`
     above, then `docker network connect` again). The address changes every time
     the tunnel starts, so update `PUBLIC_BASE_URL` and recreate the proxy each
     time. The tunnel works only while your machine runs: use it to test, never
     for real traffic.
   - **Your own host.** Put your HTTPS front (your host's edge, or a reverse
     proxy) in front of port 8080 at `PUBLIC_BASE_URL`.
   - **Railway.** Railway runs the image itself, with its own recipe: a
     two-line Dockerfile, a volume, no published port and three more variables.
     It needs a paid Railway plan or an active trial. See
     [Host it on Railway](#host-it-on-railway).

   What you should see: `status: ok` on `/healthz`, your products in the
   discovery document, and a 402 whose challenge carries the product's `price`
   as `amount` and your `PAY_TO` as `payTo`. Nothing is forwarded upstream for
   an unpaid call. To check by hand, against your public address and one of
   your own product routes:

   ```bash
   curl -s https://<your-public-address>/healthz
   curl -s https://<your-public-address>/.well-known/x402
   curl -s -i https://<your-public-address>/<one-of-your-routes>
   ```

   For a `POST` route, send a body shaped like the product's `input_example`.
8. **Pay once with a Haven agent.** The buyer must be a different Haven user
   from you. Before this step you need four things on that second user, set
   up as [A buyer for the first paid call](#a-buyer-for-the-first-paid-call)
   describes:
   - a second Haven account on the same dev dashboard;
   - an agent connected to it;
   - a budget with no recipient pin;
   - Base Sepolia test USDC on that account.

   Then give that agent the URL of one of your product routes and let it pay.
   What you should see:
   - The agent gets the upstream API's answer, with a `PAYMENT-RESPONSE` header
     carrying the settlement transaction hash.
   - The proxy logs `payment_settled` and `payment_delivered` for that payment.
   - The USDC arrives in your Sales account, and the transaction is visible on
     Base Sepolia.
   - The same payment header presented again gets `payment_already_delivered`:
     one payment buys one call.
   - The sale on your Sales page. To see your products on its **Products** tab
     too, enter your proxy's origin as the product list address
     ([The Products tab](#the-sales-account-and-its-receiving-address)).

Before you take real traffic, read [Running it for real](#running-it-for-real):
what you run, and what you monitor.

## What Haven does not do

- **Haven is not in the payment path.** The buyer pays your address directly,
  through Coinbase's facilitator. Haven does not relay, hold or forward the
  payment.
- **Haven does not hold your keys.** Your upstream API key, your Coinbase
  credentials and your receiving address are yours and stay in your deployment.
  Haven never supplies its own Coinbase key; you use your own.
- **Haven does not settle.** The proxy asks Coinbase's facilitator to verify and
  settle, and reads the chain when an answer is lost. Haven operates neither.
- Haven does not operate the proxy and receives nothing from it.

## Licence

The kit has no licence yet. A merchant in Haven's pilot may run and modify the
kit to evaluate Haven. Do not redistribute it. A licence comes before general
availability.

The kit is published as a container image. The npm package
`@haven_ai/paywall-proxy` is private and is not published; to run the kit without the image, see
[Running from source](#running-from-source).

## The parts

| Part | What it is | Required | In this release |
|---|---|---|---|
| Paywall proxy | This package. Answers an unpaid call with an x402 challenge, has the payment verified and settled by Coinbase's facilitator, then forwards the call upstream with your API key. | Yes | Yes |
| Products file | One JSON file mapping a route or model to a fixed price, with an optional output-token cap and a description. | Yes | Yes |
| Discovery document | A public, machine-readable list of your products, served by the proxy at `/.well-known/x402`. | Yes | Yes |
| Receipt | Your own receipt for a paid call, returned as the `x-receipt-json` response header. | When you configure a VAT rule | Yes |
| Sales reporter | After each settled call, a small record sent to Haven. | Required for the pilot | Yes |

## Running it for real

You run:

- The kit's container image, or Node 24 and this repository when you run from
  source.
- The proxy process, behind HTTPS on a public host name you control.
- A products file, and the settings listed in [Settings](#settings).
- Persistent disk for the consumed-payment store (`PAYMENTS_DB`). Exactly one
  proxy process uses it at a time: the proxy locks the file at startup and
  refuses to start while another process holds it. Deploy by stopping the old
  process before starting the new one, and never run two replicas on one store.
  Back the file up like a ledger: losing it loses the one-call rule for payments
  already delivered.
- Persistent disk for the sales outbox (`SALES_OUTBOX`), when you report sales.
  It holds the records Haven has not accepted yet, so it belongs on the same
  disk as `PAYMENTS_DB` and is backed up with it.
- A Sales account that receives the money.
- Your own Coinbase developer (CDP) secret API key.
- An RPC URL for the network, unless you run on Base Sepolia: there the proxy
  uses the public `https://sepolia.base.org` when `RPC_URL` is unset.

You monitor:

- **Settlement.** Verify and settle failures, and facilitator timeouts. A burst
  means buyers are paying and not being served.
- **Upstream health.** The rate of `upstream_failed_after_settlement`,
  `payment_exhausted` and `payment_in_flight` answers, and any
  `upstream_auth_refused`, which means your own upstream key is wrong.
- **Retry proofs.** The rate of `payment_retry_needs_proof` answers.
- **Overage.** `overage` log lines, when an upstream answer runs past the
  product's output-token cap.
- **Sales reporting.** The outbox depth (`/healthz` and the `sales_outbox_*`
  lines) and `sales_report_refused` lines. The depth counts the records waiting
  for a replay — a record in its first delivery round is in the file but not
  counted — so a growing depth means Haven is not receiving the sales; a refused
  record means its shape or your key is wrong.
- **Cost.** Coinbase facilitator usage against the 1,000 free transactions a
  month, and your upstream provider's spend.
- **Money.** The receiving account's balance in Haven against the settled calls
  in the proxy's log.
- **Disk.** The size of `PAYMENTS_DB` and `SALES_OUTBOX`, and the outbox's
  10,000-record bound.

## The Sales account and its receiving address

Sign in to Haven's dev dashboard (the URL is in the
[Quickstart](#quickstart-a-first-paid-call-on-base-sepolia)) and turn Sales on:
**Settings → Business → Sales**. Haven creates the Sales account the money
arrives in.

Then open **Sales → Setup → Receiving address** and choose **Show address**.
Copy that address. It is `PAY_TO`.

**The Products tab.** Haven lists your products on the Sales page's
**Products** tab once it knows where your proxy runs. Once the proxy is up,
enter its public origin, `PUBLIC_BASE_URL` with no path, under **Sales → Setup →
Product list address**. Haven reads [the discovery document](#the-discovery-document)
from `<origin>/.well-known/x402` and lists what it finds. An account has one
product list address, and saving a different one marks every product the old
address listed as *No longer offered*; past sales keep their names. Without an
address, sales still arrive and show the product the sale record names.

## Coinbase developer keys

The proxy settles through Coinbase's facilitator, so it needs a **secret API
key** from your own Coinbase Developer Platform (CDP) account. Haven does not
supply its key.

Open the CDP portal's API keys page,
<https://portal.cdp.coinbase.com/projects/api-keys> (checked 2026-11-23: an
unauthenticated visit redirects to the portal's sign-in with that path), and
create a **Secret API key** — the server-side key type, not a Client API key.
Set it up like this. These are the settings Haven used for a key that settled on Base Sepolia:

| Setting | Value | Why |
|---|---|---|
| Signature algorithm | **Ed25519**, the portal's default | The client accepts either an Ed25519 key or an ECDSA PEM, and an Ed25519 secret is one base64 line, which fits a Docker `--env-file`. |
| Mode | **Live** | A Live key settled on Base Sepolia in Haven's own test; a Sandbox key has not been tried. |
| IP allowlist | **Allow requests from any IP address** | A Railway service has no fixed outbound IP unless you enable static outbound IPs. |
| Permissions | Leave **Trade**, **Transfer**, **Receive**, **Export** and **Manage** unticked | A leaked key with them could move the Coinbase account's funds, or export or re-permission its CDP wallets. *View* is ticked by default; if verify or settle is refused without it, tick it. |

Check each setting on the page when you create the key. The portal's layout
changes, and this table records the settings Haven's key was created with, not
a promise about today's form.

The modal shows the key's **ID** and its **secret**. The ID is
`CDP_API_KEY_ID`; the secret is `CDP_API_KEY_SECRET`. Copy both from the modal:
the portal does not download a key file by default.

**In a Docker `--env-file`.** The file holds one line per variable, so the
secret must be one line. An Ed25519 secret is one base64 line and fits:

```
CDP_API_KEY_ID=…
CDP_API_KEY_SECRET=…
```

The ID is shown either as a UUID (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`, what
the portal issued in Haven's own test on 2026-11-24) or in the
older `organizations/…/apiKeys/…` form; the kit accepts both.

An ECDSA secret is a PEM block of several lines, and `--env-file` cannot carry
it: use an Ed25519 key for the container path.

**In a Railway variable.** Railway keeps a multi-line value: a PEM pasted into
the variable arrives in the container with its line breaks intact (checked
2026-11-23 on a Railway service). Either key type works there; Ed25519 is still
the simpler one.

The proxy reads the pair once, at startup, and builds one auth header locally
before it listens. A secret that cannot sign — the `.env.example` placeholder,
or well-formed junk — refuses startup, naming `CDP_API_KEY_SECRET` and never
printing its value. The same dry run is the first half of the `coinbase key`
check ([Check the deployment before real traffic](#check-the-deployment-before-real-traffic)).

## The products file

Copy [`products.example.json`](products.example.json) and edit it. The file is
JSON, read from `PRODUCTS_FILE`. The proxy refuses to start when the file is
missing, is not valid JSON, or fails validation, and the refusal names the
product and the field.

| Field | Required | Meaning |
|---|---|---|
| `version` | Yes | The products-file schema version. `1` is the only version. |
| `products[].id` | Yes | Stable, unique, lower-case identifier. It is the key the discovery document lists. |
| `products[].name` | No | Human name. When absent the document omits it; the receipt line and the sale record use the `id`. |
| `products[].route` | Yes | `METHOD /path`, matched exactly against the request's method and path after `BASE_PATH`. The discovery document lists it with `BASE_PATH` in front, so the listed route is how a buyer calls the product. |
| `products[].model` | No | When present, the request body's `model` must equal it, or the request is refused before settlement. |
| `products[].price` | Yes | The price in whole atomic USDC units, as a decimal string. USDC has 6 decimals, so `"10000"` is $0.01. A JSON number is refused. |
| `products[].output_token_cap` | No | The maximum output tokens one purchase buys. Required for an inference product. |
| `products[].description` | Yes | Shown in the 402 challenge and in the discovery document. The receipt line joins the name and the description and is at most 300 characters. |
| `products[].input_example` | No | An example request body, carried into the discovery document. It must pass the proxy's own checks, because a directory probes the route with it. |
| `products[].input_schema` | No | A JSON Schema (draft 2020-12) the request body must pass before the proxy quotes or settles. Also carried into the discovery document. |
| `products[].output_example` | No | An example response body, for the same block. |
| `products[].output_schema` | No | A JSON object describing the shape of the answer. Carried into the discovery document only: it is served, never enforced. A value that is not a JSON object is refused at startup, naming the product. |

The network is one setting of the deployment, not a field per product. A
products file that names a network is refused at startup.

**Give every product that takes a body an `input_schema`.** With one, the proxy
checks each request body against it before it answers with a price and again
before it settles a payment, so a buyer is never charged for a body your API
cannot serve. The body must be JSON, sent as `application/json` (or an `application/…+json`
type) or with no Content-Type; a `text/plain` body is refused. A body that
fails is answered 400 `invalid_request_body` (a payment the proxy already
settled gets 200 `bad_request_after_settlement` instead), with an `errors` list
of `{ path, rule }`: the field, as a JSON pointer, and the schema rule it
failed; the proxy reports the first failure it finds. The list never repeats
a value the buyer sent, though a path can contain a property name they sent
when your schema validates arbitrary keys. **Without a schema the proxy cannot
refuse a body before payment**: it forwards whatever it is sent.

The dialect is JSON Schema draft 2020-12. At startup the proxy refuses, naming
the product: a schema it cannot compile; an unknown keyword; a `$ref` that
points outside the schema (only `#...` references, so loading never makes a
network call); `input_schema` on a `GET` or `DELETE` route, which has no body;
and an `input_example` that fails its own schema. `format` is not checked.
Three things that fail startup when you paste a schema from elsewhere: a
`"$schema"` naming draft-07 (or any dialect other than 2020-12), OpenAPI's
`example` keyword (2020-12 spells it `examples`), and `x-*` extension keys.
Remove them.

## Settings

Copy [`.env.example`](.env.example) and fill it in. The proxy reads the process
environment; it does not load a `.env` file itself. In the container, Docker's
`--env-file .env` loads it; running from source, export the variables or let
your process manager do it.

Required:

| Variable | Meaning |
|---|---|
| `NETWORK` | The one network this deployment settles on, as a CAIP-2 id. `eip155:84532` is Base Sepolia. There is no default. `eip155:8453` (Base mainnet) is refused at startup in this release. |
| `PAY_TO` | The address that receives every payment: your Sales account's receiving address ([The Sales account and its receiving address](#the-sales-account-and-its-receiving-address)). |
| `OPERATOR_NAME` | Who operates the endpoint. The discovery document shows it. |
| `PRODUCTS_FILE` | The products file ([The products file](#the-products-file)). The container image sets it. |
| `PAYMENTS_DB` | The consumed-payment store. One proxy process per file. The container image sets it. |
| `UPSTREAM_BASE_URL` | Where paid calls are forwarded ([How a paid call reaches your API](#how-a-paid-call-reaches-your-api)). |
| `UPSTREAM_API_KEY` | The key paid calls are forwarded with. |
| `CDP_API_KEY_ID` | Your Coinbase developer key id ([Coinbase developer keys](#coinbase-developer-keys)). |
| `CDP_API_KEY_SECRET` | Your Coinbase developer key secret ([Coinbase developer keys](#coinbase-developer-keys)). |

The optional, receipt and sales-reporting settings are in
[All settings](#all-settings), under *Reference*.

What you should see: the proxy starts and logs its events as JSON lines on
stdout ([Log output](#log-output) says which other lines can appear). The
first is `started`, with `port`, `network`, `network_label`, `pay_to`,
`operator`, `products`, `base_path`, `rpc` (`"default (public Base Sepolia)"`
when `RPC_URL` is unset on Base Sepolia, otherwise `"configured"` — the line
never prints the URL itself, because a provider URL can embed a key),
`upstream_auth` (`"key"` or `"none"`), `sales_reporting` (`"on"` or
`"off (no HAVEN_MERCHANT_KEY)"`), `sales_outbox_depth` when reporting is on (the
records waiting for a replay), and
`receipt` (`"on"`, `"off (no VAT_RULE)"` or `"off (seller details missing)"`). A
missing or invalid setting refuses startup and names every problem at once,
never a secret's value.

## How a paid call reaches your API

Once a call is paid, the proxy sends it to `UPSTREAM_BASE_URL` like this:

- **Path.** The proxy removes `BASE_PATH` from the request path, then appends
  what is left to the path of `UPSTREAM_BASE_URL`, without its trailing slash. A
  path in `UPSTREAM_BASE_URL` is kept. With `UPSTREAM_BASE_URL=https://api.example.com/v2`
  and `BASE_PATH=/api`, a call to `/api/v1/fortune` reaches
  `https://api.example.com/v2/v1/fortune`. A request outside `BASE_PATH` is
  answered `unknown_route` and goes nowhere.
- **Query string.** The buyer's query string is forwarded as it was sent. It
  replaces any query string you write into `UPSTREAM_BASE_URL`, even when the
  buyer sent none, so do not put one there.
- **Method and body.** The method is unchanged. A `GET` or `HEAD` is sent with no
  body. A product with `output_token_cap` has its body's output limit set to the
  cap ([The products file](#the-products-file)). A redirect from your API is not
  followed.
- **Headers.** The buyer's headers are forwarded, except the payment headers,
  `Authorization`, `Cookie`, the hop-by-hop and forwarding headers, `Expect`,
  and any header the buyer names in `Connection`. The full list is in the
  design, [§ 7](../../docs/architecture/12-merchant-kit.md#7-the-proxys-request-handling).
  The proxy then sends your key as `Authorization: Bearer <UPSTREAM_API_KEY>`
  (the header and scheme are settings, see [All settings](#all-settings)), or no
  key with `UPSTREAM_AUTH=none`. Your API sees the proxy's address, not the
  buyer's.

**An API next to the proxy.** `UPSTREAM_BASE_URL` must be an address the proxy
can reach from where it runs:

- **In a container on your machine,** `localhost` is the container itself, not
  your machine. Run your API in a container on the same Docker network as the
  proxy (`docker network create`, then `--network` on both) and use its
  container name, for example `http://my-api:9000`.
- **On Railway,** a second service in the same project is reached over Railway's
  private network, at `http://<service-name>.railway.internal:<port>`. Your API
  must listen on IPv6 as well (`::`), not only IPv4 (`0.0.0.0`). Haven's own test had
  to make that change. Railway's private networking documentation has the
  details.

## Log output

The proxy writes its events as JSON lines on stdout: one line per event, with
`time` and `event`. These are the lines to build alerts on. Other lines appear
in the same output, and are not JSON:

- **The payment library's own line.** On a paid call, `@x402/core` prints
  `[x402] extension responses: {…}` on stdout.
- **The payment core's warnings.** When verify, settle or a chain read fails,
  lines starting `[x402] CDP …` go to stderr, followed by an object that can
  span several lines. The same outcomes are also logged as JSON events
  (`settle_error`, `payment_refused`, `settlement_unknown`), so you do not need
  to parse these lines.
- **A refused start.** A missing or invalid setting prints its problems as plain
  text on stderr and exits non-zero.

A JSON log pipeline should skip the lines that do not start with `{`. Once the
proxy is running, every line, JSON or not, passes through the same redaction,
so a configured secret is never printed. A refused start happens before that,
and its messages name variables, never their values.

## Check the deployment before real traffic

Before you take a real payment, run the check. It reads the same settings the
proxy reads, and it adds the network calls startup does not make:

```bash
node packages/paywall-proxy/dist/index.js check
```

In the container, `check` runs through the image's entrypoint: the command is
in step 6 of the [Quickstart](#quickstart-a-first-paid-call-on-base-sepolia).

It prints one line per check (`ok`, `fail`, `skipped` or `not verified`, and a
reason in words) and exits non-zero when any check fails:

```
settings: ok
products: ok (2 products: lookup, chat)
rpc: ok (eip155:84532 at sepolia.base.org)
coinbase key: ok (exact on eip155:84532)
sales key: ok (the key was accepted)
store: ok (will be created at /var/lib/paywall-proxy/payments.sqlite)
outbox: ok (will be created at /var/lib/paywall-proxy/sales-outbox.jsonl)
```

What each line means:

| Line | What it checks |
|---|---|
| `settings` | The same validation startup runs. A missing or invalid setting prints its problem, one line each, and the checks that need it print `skipped (settings invalid)`. |
| `products` | The products file, with the same validation startup runs. On success it prints the product count and ids. |
| `rpc` | `eth_chainId` on `RPC_URL` (or the Base Sepolia default), compared with `NETWORK`. A wrong chain fails. An unreachable node fails naming the host only, because a provider URL can embed a key. |
| `coinbase key` | A local signing dry run with `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` (no network call), then one authenticated `GET …/supported`, and that the facilitator lists `exact` on your network. A secret that cannot sign prints `CDP_API_KEY_SECRET cannot sign a request (not a usable Ed25519 or EC key)`; a key the facilitator refuses prints `refused the key (401)`; a facilitator that cannot be reached prints `did not answer`. `not verified` means the client could not exercise the key, and says why. |
| `sales key` | `POST {HAVEN_SALES_URL}/merchant/sales` with `HAVEN_MERCHANT_KEY` and the body `{}`. A `401` prints `the key is missing, wrong or revoked, or its account is no longer a merchant account`; `403` is Sales off for the account; `400` with Haven's `error_code` `invalid_request` or `invalid_record` is an accepted key; a `400` without one of those prints `HAVEN_SALES_URL is not Haven's API origin (400 without Haven's error_code)`; a `429` prints `not verified (rate limited)`. Nothing is written. `skipped` when `HAVEN_MERCHANT_KEY` is unset. |
| `store` | That `PAYMENTS_DB`'s directory exists and is writable, and, when the file exists, that it can take the exclusive lock. `in use by a running proxy; stop it first` means a proxy is running. A missing file prints `will be created at <path>`, so a mistyped path is visible and no ledger is created there. |
| `outbox` | The same directory check for `SALES_OUTBOX`, and its depth when the file exists. It never replays or changes it. |

Run it with the proxy stopped: the store check takes the same exclusive lock the
proxy takes, so a running proxy makes it fail. The check makes no call that can
move money or settle (no verify, no settle, no sale record), and it never prints
a secret or an error's message.

`GET /healthz` is a different thing: it is the running proxy's readiness probe.
`check` is what you run before you start it.

## Run it as a container

The kit is published as a container image, so you do not need Node, a clone or a
build:

```
ghcr.io/d-hinders/haven-paywall-proxy
```

The image sets two paths for you, and you do not put them in the env file:

| Path | What it is |
|---|---|
| `PRODUCTS_FILE=/config/products.json` | Your products file, mounted read-only. On Railway, your own Dockerfile copies it into the image instead ([Host it on Railway](#host-it-on-railway)). |
| `PAYMENTS_DB=/data/payments.sqlite` | The consumed-payment store, on the `/data` volume. `SALES_OUTBOX` defaults to `sales-outbox.jsonl` beside it, so the outbox lands at `/data/sales-outbox.jsonl`. |

The `docker run` command is step 7 of the
[Quickstart](#quickstart-a-first-paid-call-on-base-sepolia).

### Which tag to pin

Every command in this README writes the tag as `dev-<short-sha>`. This is the
one rule for what to put there:

- **Pin a tag, not `dev`.** A moving tag pulls config-breaking changes into your
  container on restart. `dev` moves on every publish and is not for a
  deployment.
- **Before the kit's first production release, pin the newest
  `dev-<short-sha>`,** against Haven's dev environment. `<short-sha>` is the
  short commit hash in the tag's name.
- **Once a `pilot-<short-sha>` tag exists, pin the newest one** in place of
  `dev-<short-sha>`. It arrives with that first release.

The tags are listed on the
[package page](https://github.com/d-hinders/Haven-AI/pkgs/container/haven-paywall-proxy),
but that page does not order them by date. This prints the newest one, using
the registry's public API and `docker buildx`:

```bash
IMG=ghcr.io/d-hinders/haven-paywall-proxy
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:d-hinders/haven-paywall-proxy:pull" | sed -E 's/.*"token":"([^"]+)".*/\1/')
for t in $(curl -s -H "Authorization: Bearer $TOKEN" https://ghcr.io/v2/d-hinders/haven-paywall-proxy/tags/list | grep -oE '"(dev|pilot)-[0-9a-f]+"' | tr -d '"'); do
  printf '%s %s\n' "$(docker buildx imagetools inspect "$IMG:$t" --format '{{ .Image.Created }}')" "$t"
done | sort | tail -1
```

It prints the build time and the tag, for example
`2026-11-23 13:03:09.085608048 +0000 UTC dev-b9657c0`. When a `pilot-` tag is listed,
prefer the newest `pilot-` tag over a newer `dev-` one.

**Read the commit inside the image.** Images from `dev-b9657c0` on carry
`org.opencontainers.image.revision`, the commit they were built from, beside
the Dockerfile's own labels; older tags do not:

```
docker inspect ghcr.io/d-hinders/haven-paywall-proxy:dev-<short-sha> \
  --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
```

**Apple Silicon.** The image is published for `linux/amd64` only. On an Apple
Silicon Mac, add `--platform linux/amd64` to `docker run`; the image then runs
under emulation, and Docker warns about the platform.

**Use a named volume for `/data` (recommended).** Docker creates it with the
image directory's ownership, so the container's non-root user can write it. A
host-directory bind mount is the second choice, and it has two caveats: the
directory must be writable by uid 1000, and SQLite file locking across Docker
Desktop bind mounts on macOS is not dependable. A store the process cannot open
for a permission reason says so in words — it names the directory and says it is
not writable — rather than printing a bare error class.

**One container per `/data` volume.** The proxy locks `PAYMENTS_DB` and refuses
to start while another process holds it. So: stop the old container before
starting the new one, never scale above one replica on a volume, and run
`report-sale` and `check` with the proxy container stopped. A second container
started on the same volume exits non-zero with the store's locked message.

**Back `/data` up like a ledger** — a disk snapshot, or the in-process
`backup()`. An external `sqlite3 .backup` cannot run while the proxy holds the
lock.

The image's entrypoint is the CLI, so the subcommands run through it:

```bash
docker run --rm --env-file .env -v haven-kit-data:/data \
  ghcr.io/d-hinders/haven-paywall-proxy:dev-<short-sha> report-sale 0x<transaction-hash>
```

`dev-<short-sha>` is the tag you pin ([Which tag to pin](#which-tag-to-pin)).

### Running from source

Before you start it, run `check` with the proxy stopped (see
[Check the deployment before real traffic](#check-the-deployment-before-real-traffic)):
it tells you whether the settings, the products file, the RPC, the Coinbase key
and the Sales key work, and exits non-zero when one does not.

```bash
npm run build -w packages/paywall-proxy
node packages/paywall-proxy/dist/index.js
```

Then check it:

```bash
curl -s http://127.0.0.1:8080/healthz
# {"status":"ok","network":"eip155:84532"}
# with sales reporting on, it also carries "sales":{"reporting":"on","outbox_depth":0}

curl -s http://127.0.0.1:8080/.well-known/x402
# the discovery document: your products, prices, network, asset, pay_to, operator

curl -s -i -X POST http://127.0.0.1:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"your-provider/your-model","messages":[{"role":"user","content":"hi"}]}'
# HTTP/1.1 402 Payment Required
# PAYMENT-REQUIRED: <base64 challenge>
# {"x402Version":2,"resource":{...},"accepts":[{"scheme":"exact","network":"eip155:84532",
#  "amount":"10000","payTo":"0x...","asset":"0x036CbD53842c5426634e7929541eC2318f3dCF7e",
#  "extra":{"name":"USDC","version":"2"}}],...}
```

The same three checks work against the container, at its published port. Use one of your own product routes in place of the chat route, and for a `GET` route leave out `-X POST` and the body.

## Host it on Railway

Railway is one worked example, not a requirement: any host that gives the
container a public `https` origin and a persistent disk works. **It needs a paid
Railway plan or an active trial.** On an expired trial, creating the project
fails with "Your trial has expired. Please select a plan to continue using
Railway." (Haven's own test, 2026-11-24). For a first test call without a
Railway plan, use the quick tunnel in Quickstart step 7. Haven's own demo
is configured to run on Railway too, and its settings are in
[`docs/operations/railway-services.md`](../../docs/operations/railway-services.md)
§ *Paywall-proxy (the #4892 demo)*. That recipe builds from source, because the
demo's products file lives in the repository; this one deploys the published
image with your own products file, which is why the two are kept apart.

**The products file.** Railway cannot mount a single file into a container: a
volume mounts a directory. So the image's `PRODUCTS_FILE=/config/products.json`
has nothing to read unless the file is in the image. Put a two-line Dockerfile
beside your `products.json`, in your own repository or in a folder you deploy
with `railway up`:

```dockerfile
FROM ghcr.io/d-hinders/haven-paywall-proxy:dev-<short-sha>
COPY products.json /config/products.json
```

Put the tag you pin in place of `dev-<short-sha>` ([Which tag to pin](#which-tag-to-pin)). Railway builds this
Dockerfile and deploys it, so the products file stays in version control and a
change to it is a commit and a redeploy. The base image declares
`VOLUME ["/data"]`, and Railway accepts a build that inherits it (checked
2026-11-23). The copied file is readable by the image's non-root user without
`--chown` (checked 2026-11-23: `COPY` leaves it `root:root` mode 644, which uid
1000 can read).

**The service.** One service, one replica, one volume mounted at `/data`, and
the healthcheck path `/healthz`:

| Setting | Value |
|---|---|
| Source | the folder or repository with the Dockerfile above at its root |
| Volume | one, mounted at `/data` |
| Replicas | one. The proxy locks `PAYMENTS_DB`, and a second process on the same store refuses to start |
| Healthcheck | `/healthz` |
| Sleep | your choice; see *Sleep* below |

**Variables.** Set the variables from Quickstart step 5, and add:

| Variable | Value |
|---|---|
| `PUBLIC_BASE_URL` | the service's `https://` Railway domain, with no port |
| `CLIENT_IP_HEADER` | `X-Real-IP`, the client address Railway's edge sets (what Haven's own service uses) |
| `RAILWAY_RUN_UID` | `0` — see *Volume ownership* below |

Do not set `PORT`: Railway injects it, and the proxy listens on it (checked
2026-11-23: the container saw `PORT=8080`, the proxy logged `port=8080`, and
the public domain served `/healthz` with no port setting). Do not paste
`PRODUCTS_FILE` or `PAYMENTS_DB` from `.env.example`: they would override the
image's paths, and the image's paths are the ones this recipe mounts. Delete
those two lines, as Quickstart step 5 says.

**Step by step.** This order works (followed end to end on 2026-11-26, from a
folder holding only the Dockerfile and `products.json`, with the Railway CLI;
the dashboard does the same things):

1. **Create the project and the service.** `railway init` creates a project
   and `railway add` adds an empty service. A new project's first environment
   is called `production` by Railway, whatever network you run; the name does
   not change anything here.
2. **Add the volume** at `/data` (`railway volume add`, mount path `/data`).
3. **Generate the domain** (`railway domain`). Do this before the variables:
   `PUBLIC_BASE_URL` is that domain, and it does not exist until you generate
   it.
4. **Set the variables**, including `RAILWAY_RUN_UID=0`, before the first
   deploy. Paste the secrets (`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`,
   `HAVEN_MERCHANT_KEY`) straight into the service's variables. In the
   dashboard, an edit is held as a *staged change* until you click **Deploy**
   on the banner at the top of the canvas (Railway's staged-changes guide,
   checked 2026-11-26): a variable you pasted is not in the service until you
   do. With no source deployed yet, applying runs nothing.
5. **Run the check on Railway.** Add a third line to the Dockerfile for one
   deploy:

   ```dockerfile
   CMD ["check"]
   ```

   The image's entrypoint is the proxy's CLI, so this deploy runs `check` with
   the service's own variables and volume, prints one line per check in the
   deploy log, and exits. No proxy is running yet, so the store's lock is free.
   Deploy it from the folder with `railway up` (it uploads the folder and
   builds the Dockerfile at its root), or by pushing it to the connected
   repository. Checked 2026-11-26: every line `ok`, and the store and outbox
   lines named `/data`. Do this before you set the healthcheck: the check
   container exits without serving `/healthz`.
6. **Deploy the proxy.** Remove the `CMD` line and deploy again. What you
   should see: the `started` line in the deploy log, and `status: ok` on
   `https://<your-domain>/healthz`.
7. **Set the healthcheck, replicas and sleep** in the service's settings:
   the healthcheck path `/healthz`, one replica (the *Scale* section), and
   Serverless (Railway's new name for Sleep) as you choose. Railway's
   healthcheck and scaling pages place these "in the service settings"
   (checked 2026-11-26). A `railway.json` can set them too, but Railway CLI
   5.62 reports that file as deprecated (2026-11-26).

**Volume ownership, and the non-root user.** Railway mounts a volume as `root`
(Railway's volumes page, checked 2026-11-23), so a volume at `/data` is not
writable by the image's `node` user (uid 1000). The proxy then exits at startup
with:

```
PAYMENTS_DB cannot be opened: the directory "/data" is not writable by this process. …
```

Railway's documented answer is the service variable `RAILWAY_RUN_UID=0`, which
runs the container as root (checked 2026-11-23: with it, the container's first
process ran as uid 0; without it, as uid 1000). That gives up the image's
non-root posture for this service: the proxy process can write anywhere in the
container, and a compromise of the proxy is no longer contained by the user
boundary. The alternative is a host where you can set the volume's ownership to
uid 1000; Railway does not offer that.

Checked on a Railway volume on 2026-11-26: with `RAILWAY_RUN_UID=0`, `check`
named `/data/payments.sqlite` and `/data/sales-outbox.jsonl`, and the proxy
logged `started` with the store open. If you see the error above instead, the
variable is missing.

**Check before the first deploy.** `check` cannot run inside the running
service: it takes the store's exclusive lock and fails with `in use by a
running proxy; stop it first`. On Railway, run it as its own deploy (step 5
above). To run it on your own machine instead, you need the same settings in a
local `.env`, secrets included:

```bash
docker run --rm --env-file .env \
  -v "$PWD/products.json:/config/products.json:ro" \
  -v haven-kit-data:/data \
  ghcr.io/d-hinders/haven-paywall-proxy:dev-<short-sha> check
```

Use the same tag as your Dockerfile ([Which tag to pin](#which-tag-to-pin)).

**Redeploys.** Railway does not run two deployments of a service with a volume
at once: it stops the old container before starting the new one, so the store
lock is never contended, and a redeploy has a short window with no container
serving (Railway's healthcheck documentation, checked 2026-11-23). On
2026-11-26 a second deploy on the same volume started cleanly, but the first
deploy was the `check` run, which had already exited: taking the lock over from
a running proxy is still untested. A buyer's call in that window gets a
connection error, not a charge.

**Sleep.** Railway's Sleep setting stops an idle service after about ten
minutes without traffic and cold-starts it on the next request
([`railway-services.md`](../../docs/operations/railway-services.md) § *Sleep*).
Haven's own demo is configured with Sleep on. With Sleep on, a buyer's first
call after an idle period waits for the container to start — measured at
3.8–5.0 s for Haven's demo — and then gets the normal 402 challenge; nothing is
charged for the wait. With Sleep off the service answers immediately and bills
for the time it is up.

## Paying with a Haven agent

Give a Haven agent the URL of one of your product routes and let it pay. For now
only a Haven agent with an **open budget** can pay: an agent whose budget is
pinned to one recipient cannot pay an arbitrary merchant, because the pin
restricts the transfer to that recipient.

**The paying agent must belong to a different Haven user, or be a wallet outside
Haven.** A payment from the merchant's own agent or account is a move between
your accounts: Haven shows it as "Moved between your accounts" and it is **not a
sale**, so it does not appear as revenue on the Sales page.

If the upstream call fails after settlement, the buyer gets HTTP 200 with
`error: "upstream_failed_after_settlement"` and the transaction hash. The
payment settled, so the answer stays 2xx. Serving the call again needs a
`SIGN-IN-WITH-X` proof signed by the payer, and a Haven agent cannot send that
proof yet: a Haven buyer whose call failed after settlement has paid for
nothing, and your log is where you see it. How a buyer can recover in that case
is not decided yet.

A Haven buyer whose agent pays through the EIP-3009 bridge makes two transfers
for one sale: one from its account to the agent's own address, then the payment
to your `PAY_TO`. Only the second reaches you; the buyer's history shows both.

These are the rules of the sale, and the discovery document states them in its
`terms` object, so a buyer's agent can read them before it pays. `terms` is the
one place they are written for the buyer; this section is the merchant's view of
the same facts.

## A buyer for the first paid call

The paying agent must belong to a different Haven user: a payment from your own
agent or account is a move between your accounts, not a sale
([Paying with a Haven agent](#paying-with-a-haven-agent)). So the first paid
call needs a second Haven user: a colleague, or a second account of your own on
another email address.

1. **A second Haven user on the dev frontend.** Sign up on the dev frontend,
   `https://haven-ai-frontend-git-dev-daniels-projects-f3327ba2.vercel.app`
   ([`docs/operations/dev-environment.md`](../../docs/operations/dev-environment.md)).
   This release runs on Base Sepolia, so both sides use Haven's dev
   environment.
2. **Connect an agent through that user's dashboard.** The connect flow gives
   the command for the dev environment; run it and let the agent connect. The
   command belongs to the connect flow, so it is not repeated here.
3. **Give the agent a budget with no recipient pin.** A budget pinned to one
   recipient cannot pay an arbitrary merchant, because the pin restricts the
   transfer to that recipient. Leave the recipient unpinned.
4. **Put Base Sepolia USDC on that account.** On that user's dashboard, open
   **Add funds**. Under **Get test USDC**, choose **Open Circle's faucet**, pick
   USDC and Base Sepolia there, and paste the account address the dialog shows.
5. **Hand the agent the product URL.** Give it the route from your products
   file at your `PUBLIC_BASE_URL`, for example
   `https://your-service.up.railway.app/v1/chat/completions`, and let it pay.

What you should see: the agent gets the upstream answer with a
`PAYMENT-RESPONSE` header, the proxy logs `payment_settled` and
`payment_delivered`, and the USDC arrives in your Sales account.

## Reference

### All settings

Required settings are in [Settings](#settings).

Optional:

| Variable | Meaning |
|---|---|
| `ENDPOINT_NAME` | The endpoint's human name, shown in the discovery document. Default `OPERATOR_NAME`. |
| `ENDPOINT_DESCRIPTION` | The endpoint's description, shown in the discovery document. Default: a sentence built from the products file and the network, for example "Pay-per-call API by Acme: 2 products, paid in USDC on Base Sepolia testnet." |
| `RPC_URL` | An RPC URL for the network. Default on Base Sepolia: the public `https://sepolia.base.org`. Required on Base mainnet, where real money would rest on a rate-limited public node; Base mainnet is refused at startup in this release, and the rule stays for go-live. |
| `OPERATOR_CONTACT` | A URL or address a reader can use to reach you. |
| `ICON_URL` | A public image URL (JPG, PNG, WebP or GIF), for a directory listing. |
| `UPSTREAM_AUTH_HEADER` | The header the upstream key is sent in. Default `Authorization`. |
| `UPSTREAM_AUTH_SCHEME` | The scheme before the key. Default `Bearer`; set it empty to send the key bare, for an `x-api-key` style header. |
| `UPSTREAM_AUTH` | Set to `none` for an upstream that needs no key. Then `UPSTREAM_API_KEY`, `UPSTREAM_AUTH_HEADER` and `UPSTREAM_AUTH_SCHEME` must be unset, and the proxy sends no upstream auth header. Unset: `UPSTREAM_API_KEY` is required. |
| `BASE_PATH` | The path prefix your products' routes are matched under. Empty by default. The discovery document lists each route with it in front. |
| `PUBLIC_BASE_URL` | The public origin the challenge names. Set it whenever the proxy is reached through an `https` front: without it the challenge names `http://<Host>`, and a Haven agent does not pay a plain `http` origin. |
| `CLIENT_IP_HEADER` | The header your own front proxy sets to the client's address, for the per-IP limits. |
| `PORT`, `HOST` | Listen address. Defaults `8080` and `0.0.0.0`. |
| `UPSTREAM_TIMEOUT_MS` | The whole upstream call's deadline, at most `180000`. |
| `RESERVATION_DEADLINE_MS` | How long the request that reserved a payment is trusted to finish settling, at least `110000`. |
| `DIRECTORY_LISTING` | Coinbase's directory listing. Off by default, and `on` is refused in this release. |

Receipt (optional). With no `VAT_RULE` the proxy sends no receipt and needs no
seller detail:

| Variable | Meaning |
|---|---|
| `VAT_RULE` | Your tax rule. The pilot has one value, `SE_25_WITH_EU_REVERSE_CHARGE`: 25% Swedish VAT taken out of the price, and reverse charge when the buyer's accepted declaration names another EU country. Unset: no receipt. |
| `SELLER_NAME` | Your legal name, on the receipt's seller block. Required with `VAT_RULE`. |
| `SELLER_ORG_NR` | Your organisation number. Required with `VAT_RULE`. |
| `SELLER_VAT_NR` | Your VAT registration number. Required with `VAT_RULE`. |
| `SELLER_ADDRESS` | Your address, on the seller block. Optional. |
| `SELLER_IBAN`, `SELLER_BIC` | Your bank details, on the seller block. Optional. |
| `SELLER_SUPPORT_CONTACT` | Your own support contact. Optional, and never Haven's. The proxy sends the receipt as JSON only, and that shape carries no support line, so this value has no effect on the receipt the proxy emits. |

On Base mainnet the proxy refuses to start with `VAT_RULE` set and any of
`SELLER_NAME`, `SELLER_ORG_NR` or `SELLER_VAT_NR` missing. On a test network it
starts with a warning and sends no receipt. Base mainnet itself is refused at
startup in this release, and the rule stays for go-live.

Sales reporting: required for Haven's pilot; optional for a merchant that only
wants to accept payments. With no `HAVEN_MERCHANT_KEY` the proxy reports
nothing and starts exactly as without it. With the key set, reporting is on and
the key and Haven's origin are required: a key that is not a Sales key, or a
missing or unusable Haven origin, refuses startup and names the variable.

| Variable | Meaning |
|---|---|
| `HAVEN_MERCHANT_KEY` | Your Haven Sales key (`sk_merchant_…`), created on **Sales → Setup → Sales keys**. It is receive-only: it authenticates the sales routes and nothing else. The proxy never logs it and never returns it. |
| `HAVEN_SALES_URL` | Haven's API origin: `https://havenbackend-dev-8b95.up.railway.app` on Base Sepolia. The proxy appends `/merchant/sales` itself, so give the origin and no path. |
| `SALES_OUTBOX` | The file the proxy keeps every sale record in until Haven accepts it or refuses it for good. One proxy process per file, on persistent disk. Default `sales-outbox.jsonl` in the same directory as `PAYMENTS_DB`. |

### The discovery document

`GET /.well-known/x402` returns the document. It is built from the products file,
the deployment's settings, and the kit's own constants (`terms` and `payment`,
which describe what the handler does for every product and are not products-file
content). Answering it verifies nothing, settles nothing and makes no
facilitator call. Changing the products file changes the document when the proxy
restarts. Each product's `route` is the products-file path with `BASE_PATH` in
front, so it is the path a buyer calls.

| Field | Meaning |
|---|---|
| `version` | The kit document version. `1` is the only version. |
| `operator.name` | Who operates the endpoint: your `OPERATOR_NAME`. |
| `operator.contact` | Your `OPERATOR_CONTACT`, when set. |
| `name`, `description` | Your `ENDPOINT_NAME` and `ENDPOINT_DESCRIPTION`. Defaults: the name is your `OPERATOR_NAME`; the description is a sentence built from the products file and the network, for example "Pay-per-call API by Acme: 2 products, paid in USDC on Base Sepolia testnet." |
| `network` | The CAIP-2 id, the same value the challenge advertises. |
| `network_name` | The chain's display name: `Base mainnet` or `Base Sepolia testnet`. |
| `testnet` | Whether that chain is a test network. |
| `asset` | The USDC contract address on that network. |
| `asset_symbol` | `USDC`. |
| `asset_decimals` | `6`. |
| `pay_to` | Your receiving address. Every product is paid to it. |
| `settlement` | `{"scheme":"exact","facilitator":"coinbase-cdp","methods":["eip3009"]}`. |
| `terms` | The rules of the sale, true for every product: `one_payment_one_call`, `replay`, `payment_response`, `upstream_answered`, `on_failure_after_settlement`. Each entry is a code the handler answers with plus one sentence. |
| `payment` | How to pay: `headers` (`PAYMENT-SIGNATURE`, preferred, and `X-PAYMENT`), `preferred_header`, `x402_version: 2`, and `spec`, the x402 v2 specification. |
| `products[]` | Every product in the products file, with one change: `route` carries `BASE_PATH` in front of the path, so it is the absolute path a buyer calls. The other fields are as the file spells them: `id`, `name`, `model`, `price`, `price_usdc`, `output_token_cap`, `description`, and the optional `input_example`, `input_schema`, `output_example` and `output_schema`. |
| `products[].price_usdc` | The same price as a decimal USDC string with no trailing zeros: `"0.01"` for `"10000"`, `"0.018"` for `"18000"`, `"0.0001"` for `"100"`. `price` stays the atomic string. |
| `products[].output_schema` | The shape of the answer, when the products file carries one beside `output_example`. Served only, never enforced. |
| `updated` | The products file's last change, an RFC 3339 timestamp. |
| `icon_url` | Your `ICON_URL`, when set. |

`terms` says nothing about retries or the payer-signed `SIGN-IN-WITH-X` proof:
that recourse policy is not decided yet. `on_failure_after_settlement`
names your `OPERATOR_CONTACT` when you set one, and says you published none when
you did not.

Every field above is optional for readers: a reader that knows version 1 reads
the fields it knows and ignores the rest, and `price` is unchanged.

It is not the demo merchant's document. The demo merchant serves
`/.well-known/haven-demo-merchant` and `/`, and names an `mcp_url`; Haven's SDK
probes those paths and acts on `mcp_url` for MCP merchants. The kit's document
is at `/.well-known/x402` only, carries no `mcp_url`, and is a catalogue for
agents, directories and Haven.

### What the proxy answers

Before settlement it refuses with the narrowest 4xx or 503 and makes no verify
or settle call. Once a payment has settled it answers 2xx with a machine
readable body, so Haven never reads a payment that reached you as rejected.

| Condition | Status | Body `error` |
|---|---|---|
| No payment header, route is a product | 402 | `payment_required`, with `message`; the challenge is in `PAYMENT-REQUIRED` |
| Payment does not match the challenge | 402 | `payment_mismatch`, with `field` and `expected` when exactly one quoted option shares the payment's method, scheme and network |
| The payment header cannot be read, or decodes without the payload fields | 402 | `payment_invalid`; when it decodes, `field` names the missing field (`payload`, `payload.authorization`, `payload.signature`, `payload.authorization.<field>`) and `next` says what to send |
| The facilitator rejects the payment at verify | 402 | `payment_invalid` |
| Settle failed and the authorization is unused | 402 | `settle_failed` |
| Route is not in the products file, including `GET /` | 404 | `unknown_route`, with `discovery_url` |
| The path is sold, but not with this method | 405 | `method_not_allowed`, with `expected` and an `Allow` header |
| The product has an `input_schema` and the body fails it (not JSON, not sent as JSON, or a schema rule) | 400 | `invalid_request_body`, with `errors` |
| Body is not JSON (no `input_schema`) | 400 | `bad_request` |
| The route sells by `model` and the body has none | 400 | `model_required`, with `field: "/model"` and `expected` |
| The route sells by `model` and the body's `model` is not sold there | 400 | `model_not_sold`, with `field: "/model"` and `expected` |
| Product has a cap and the body has no `messages` field | 400 | `messages_required`, with `field: "/messages"` |
| Product has a cap and the body cannot carry it | 400 | `cap_not_settable` |
| Body over 1 MiB | 413 | `body_too_large` |
| Too many unpaid or unverified requests from one address | 429 | `rate_limited` |
| The facilitator gave no answer, or no capacity | 503 | `facilitator_unavailable`, `at_capacity` |
| Upstream call failed after settlement | 200 | `upstream_failed_after_settlement` |
| Same payment while its call is in flight | 200 | `payment_in_flight` |
| Same payment after its call was delivered | 200 | `payment_already_delivered` |
| A retry that needs a `SIGN-IN-WITH-X` proof | 200 | `payment_retry_needs_proof` |
| Settle outcome not known yet | 503 | `settlement_unknown` |

Every refusal carries `error` (a code) and `message` (words), and may add
`field` (the field the request got wrong: a JSON pointer into the body such as
`/messages`, or a dotted path into the payment payload such as
`accepted.amount`), `expected` (what would be accepted) and `next` (what to do
next). An unknown path also carries `discovery_url`, the absolute URL of the
discovery document, so an agent given only your base URL can find the products.
`OPTIONS` on a sold path answers 204 with the same `Allow` header and makes no
facilitator call.

The full table, with the buyer's recourse for each, is in the design,
[§ 8](../../docs/architecture/12-merchant-kit.md#8-refusals-before-settlement-and-every-answer-after-it).

### The receipt

With a VAT rule configured, a paid call returns your own receipt as the
`x-receipt-json` response header: the receipt's JSON, base64-encoded so the
header stays ASCII-safe. It is sent with the response headers of a delivered
call — a 2xx passed through, or a 3xx/4xx the proxy wraps into a 200 — and it
is the JSON only. A proxy has no carrier for the rendered text, because the
response body is your upstream API's goods; a reader that wants the text
renders it from the header.

The receipt carries:

- your seller block, from the settings above: name, address, organisation
  number, VAT number, optional bank details, and the receiving address;
- the buyer block: the payer address the proxy verified the payment from, and
  the buyer's declaration when the request carried an `X-Tax-Declaration` that
  verifies against that payer, on this network, and is unexpired. A
  declaration that fails any check is treated as absent and never refuses the
  purchase;
- the VAT treatment your rule gives that declaration, and the VAT figures it
  implies;
- one line built from the products file entry: `<name> — <description>` (the
  `id` when there is no name), the price that settled (the products file's
  price when the payment was made, kept even if you change the price later),
  and no billing period for a per-call product;
- a receipt number derived from the settlement transaction hash, so the same
  transaction gives the same number after a restart and on a retry, and an OCR
  reference derived from it;
- the settlement transaction hash and the status.

**The merchant decides its own tax treatment.** The kit applies the rule you
configure and makes no tax decision of its own: it neither computes a
treatment you did not choose nor files tax. The price never changes with the
treatment — VAT is taken out of the price, never added to it.

**With no VAT rule configured, no receipt is sent.** Haven's reader accepts a
receipt only when it states VAT figures, and a receipt stating a VAT of zero
would be read as a stated zero — a tax claim the kit has no basis to make. A
seller the Swedish rule does not fit configures no rule, and the proxy logs
`receipt: "off (no VAT_RULE)"` at startup.

The receipt names no Haven address or contact: the seller block and the
support contact are yours. The proxy removes `x-receipt-json` and
`x-receipt-url` from your upstream's response, so an upstream cannot pass off
its own receipt as the kit's. A receipt that cannot be built never fails a
settled call: the header is left out and the failure is logged.

The shape is the one Haven's accounting reads, documented field by field in
[`docs/operations/merchant-receipt-shape.md`](../../docs/operations/merchant-receipt-shape.md).

### Sales reporting

With `HAVEN_MERCHANT_KEY` set, the proxy sends Haven one sale record for each
settled call, so the sale appears on your Sales account's Sales page. The record
is the one in the design,
[§ 5](../../docs/architecture/12-merchant-kit.md#5-the-sale-record): the settlement's transaction hash, the
chain, the product's `id` and name from the products file, the amount, the payer
address, the `merchantReference` the proxy reserved for the payment, and — when
the deployment issues a receipt — the receipt number and the VAT treatment the
buyer's receipt carries. With no VAT rule the record states neither.

**The buyer never waits on Haven.** The record is sent after settlement and
before the call is forwarded, and the proxy does not wait for the answer: the
buyer's response is the same, and as fast, whether Haven accepts the record,
refuses it, is slow, or is unreachable.

**Delivery, and the resend limit.** The record is written to the outbox
(`SALES_OUTBOX`) *before* the first attempt, so a proxy that stops mid-delivery
— between resends, or inside one — loses nothing: the next proxy started on the
same store and outbox sends it. The proxy then resends a record Haven answers
with a 5xx, a timeout, a network failure, or the route's one retry answer (425
`transaction_not_visible`, which is normal straight after settlement: Haven
accepts a record once the transaction has three confirmations) after 1 s, 4 s
and 16 s. A record still undelivered after those three resends stays in the
outbox, which replays it every 60 s. **The outbox replays one record at most 5
times, then logs `sales_outbox_gave_up` and drops it** — so a record is
attempted at most 4 + 5 times in total. A record Haven accepts, or refuses for
good, is removed from the outbox by key, so no restart sends it again. Any other
4xx is a refusal: the record's shape or your key is wrong, resending it changes
nothing, and the proxy logs `sales_report_refused` once with the answer's status
and error code. A 429 (Haven's 120-a-minute limit per key) is not a refusal: the
record stays in the outbox like a 5xx.

The outbox holds at most 10,000 records. When it is full the proxy keeps what it
has and logs `sales_outbox_full` for each record it cannot add; clear the cause
(Haven unreachable, or a key that is being refused) and the outbox drains. The
file is JSON Lines, rewritten whole on every change, and it is the record: a
restart picks it up where it left off. Haven's ingest is idempotent on an
identical record, so a resend is harmless.

**Reporting a past sale again.** A sale whose record was cleared on Haven, or
that was never recorded, can be sent again from the payment the proxy kept:

```bash
# Stop the proxy first: the command opens PAYMENTS_DB, and one process per store.
node packages/paywall-proxy/dist/index.js report-sale 0x<transaction-hash>
# {"outcome":"accepted","status":201,"code":null,"attempts":1,"tx_hash":"0x…","merchant_reference":"sale_…"}
```

The command rebuilds the record from the store's payment — the same product,
payer, amount and `merchantReference` — and posts it with the same retry policy.
It exits 0 only when Haven accepted the record. Two options:

- `--new-reference` sends the record with a fresh `sale_<ULID>` instead of the
  reference the store reserved, for a sale Haven still holds under the old one.
- `--vat-treatment SE_25|REVERSE_CHARGE` states the VAT treatment the buyer's
  receipt carried. The buyer's tax declaration is not stored, so a re-reported
  sale otherwise states the rule's default treatment.

Run it with the proxy's environment (the same variables), and with the proxy
stopped: `PAYMENTS_DB` is locked by the running proxy, and the command refuses
to open it.

**What the key can and cannot do.** The Sales key is receive-only: it
authenticates the sales routes and nothing else, cannot move funds, sign, or
change signers, budgets or agents. Haven stores a sale only against a USDC
transfer it reads from the chain into the key's own account, taking the amount,
payer, token and time from the chain and never from the record, so a wrong or
malicious record cannot create revenue or reach another account. The limits, and
how revocation works, are in
[`docs/security/merchant-key-limits.md`](../../docs/security/merchant-key-limits.md).

**What you should see.** After a paid call, one `sales_report_accepted` line
with the transaction hash and the merchant reference, and the sale on your
Sales account's Sales page. A refused record logs `sales_report_refused` with
the status and error code; a record whose first delivery round ended without an
answer logs `sales_outbox_queued` and then, on a later replay,
`sales_outbox_accepted`. A record Haven accepts or refuses for good logs
`sales_outbox_removed` with the reason. No line, and no response, ever carries
the key.

## Haven's own demo on Base Sepolia

Haven runs one deployment of this proxy itself: an internal technical demo in
front of Opper's inference API, on Base Sepolia, with test money only. It is not
listed in any directory or catalogue, and it is not Haven selling: it receives
into a Haven dev account until Opper has its own, and then into Opper's.

- Products: [`demo/opper-products.json`](demo/opper-products.json). Two models
  on Opper's one chat-completions route (`POST /v3/compat/chat/completions`),
  each with its own output-token cap. Products on one route are told apart by
  `model`, so one model cannot be sold at two caps on the same route.
  `azure/gpt-5-mini` is a reasoning model, and its reasoning tokens count
  against the cap, so a 1,000-token answer can come back short. Check it on the
  first paid call and raise the cap and price if it does.
- Where it runs and what it is set to:
  [`docs/operations/railway-services.md`](../../docs/operations/railway-services.md)
  § *Paywall-proxy (the #4892 demo)*. The secrets are listed in
  [`docs/operations/secret-rotation.md`](../../docs/operations/secret-rotation.md).
- It says what it is: `OPERATOR_NAME` and `ENDPOINT_DESCRIPTION` name it an
  internal technical demo run by Haven, and every product description in the
  demo file starts the same way, so the 402 challenge and the discovery
  document both say so.
- Its receipts carry Haven's demo seller (Haven Demo AB, the demo merchant's
  `DEMO_SELLER`) for as long as Haven runs the endpoint, never the pilot
  partner's details.

### Running the same thing yourself

To run this demo as your own merchant endpoint, change these:

| What | Variable | Change it to |
|---|---|---|
| Your upstream key | `UPSTREAM_API_KEY` | Your own Opper key (or your own provider's, with its `UPSTREAM_BASE_URL`). |
| Your receiving account | `PAY_TO` | Your own Sales account's receiving address ([Quickstart](#quickstart-a-first-paid-call-on-base-sepolia) step 1). |
| Your Coinbase keys | `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | A secret API key from your own Coinbase Developer Platform account ([Coinbase developer keys](#coinbase-developer-keys)). |
| Who you are | `OPERATOR_NAME`, `ENDPOINT_NAME`, `ENDPOINT_DESCRIPTION`, and optionally `OPERATOR_CONTACT` | Your own name and description, without the "internal technical demo" wording. |
| Your chain access | `RPC_URL` | Your own Base Sepolia RPC URL, or unset it to use the public `https://sepolia.base.org`. Haven's deployment references its own backend's provider URL, which you cannot use. |
| Where you run it | `PUBLIC_BASE_URL`, `CLIENT_IP_HEADER`, `PAYMENTS_DB` | Your own `https` origin, the client-address header your own host's edge sets (or unset), and a path on your own persistent disk ([Host it on Railway](#host-it-on-railway) is one worked example). |
| Your receipt | `VAT_RULE`, `SELLER_*` | Your own legal details, or unset `VAT_RULE` for no receipt. |
| Your products | `PRODUCTS_FILE` | Your own copy of the demo file, with your prices and descriptions. |

Check your upstream provider's terms allow you to offer calls made with your
key to other parties before you take a real payment.

## Not in this release

- Coinbase directory listing. `DIRECTORY_LISTING=on` is refused at
  startup.
- Base mainnet. This release runs on Base Sepolia only, and the kit refuses
  `NETWORK=eip155:8453` at startup. Removing that refusal is a
  deliberate go-live step once the
  [regulatory review](https://github.com/d-hinders/Haven-AI/issues/4888) allows mainnet.

## Where the design lives

- [`docs/architecture/12-merchant-kit.md`](../../docs/architecture/12-merchant-kit.md):
  the design this package is built to. Read it before changing behaviour; this
  README is the merchant's path through it.
- [`docs/security/merchant-key-limits.md`](../../docs/security/merchant-key-limits.md):
  what a Haven Sales key can and cannot do, for the sales reporter.
