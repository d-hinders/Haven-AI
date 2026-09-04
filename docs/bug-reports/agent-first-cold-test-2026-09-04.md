---
owner: "@d-hinders"
status: current
covers:
  - packages/frontend/public/llms.txt
  - packages/frontend/public/llms-full.txt
  - packages/frontend/public/402.md
  - packages/frontend/public/402/**
  - packages/backend/src/routes/agent-connection-setups.ts
last-verified: "2026-09-04"
---

# Cold-agent onboarding test — 2026-09-04

The baseline for epic [#2519](https://github.com/d-hinders/Haven-AI/issues/2519). Every slice in that
epic cites "the cold test of 2026-09-04"; this file is the thing they cite. It is also the **A0
baseline** the recurring cold-agent scenario ([#2538](https://github.com/d-hinders/Haven-AI/issues/2538))
scores against, per [`qa-explore-ui-cadence.md`](../operations/qa-explore-ui-cadence.md).

It is a **research record, not a findings queue** — the queue is #2520–#2540. Nothing here is a task;
§6 maps each observation to the sub-issue that owns it.

## 1. Method

| | |
|---|---|
| Date | 2026-09-04 |
| Subject | a fresh general-purpose agent session, **no repository access**, no prior knowledge of Haven |
| Input | exactly one thing: the dev preview URL, `https://haven-ai-frontend-git-dev-daniels-projects-f3327ba2.vercel.app` (the dev target named in [`dev-environment.md`](../operations/dev-environment.md)) |
| Instruction | "set it all up so my agent can pay for things" |
| Tools | the in-app browser, plus a shell (`curl`, `jq`, `npm view`) |
| Guardrails | no password entry, no passkey creation, no budget approval, no payment — every signature-bearing action was to be handed back to the human |
| Cost | ~10 tool round-trips, ~6 minutes wall-clock. Root page 86 ms via `curl`; every browser navigation settled in <3 s. No hangs, no retries |

The point of the method is the asymmetry: Haven was designed for *human onboards, then pastes a connect
command to an agent*. This runs it backwards — the agent is handed the link first — and records exactly
where the reverse direction stops.

**Outcome in one line** (the agent's own summary, verbatim):

> the agent-readable surfaces are unusually good (llms.txt, llms-full.txt, 402.md, a full OpenAPI spec),
> but every link inside them points at hostnames that do not resolve, discovery of them is pure guesswork,
> and the flow stops dead at an email/password login with no guidance for the agent about what to hand to
> the human.

It never reached the connect modal. What it learned about that modal came from the public JS bundle and
the OpenAPI spec (§2 step 7).

## 2. Step log

### Step 1 — Root page (browser + `curl` in parallel)

The browser rendered the marketing landing page. Title *"Haven, agent payments within your rules"*; hero
*"Agents transact. You set the rules."*; the three-step pitch *"01 Create an account / 02 Set agent rules /
03 Connect your agent — Add your Haven credential to Claude, GPT, or your own agent."* The CTA is
**"Get early access"** → `/signup`; the header has **"Sign in"** → `/login`.

`curl` got the same Next.js HTML (200, 86 ms). The `<head>` carries a normal `<title>` and
`<meta description>` and **nothing else** — no `<link rel="alternate" type="text/plain" href="/llms.txt">`,
no `rel="api"`, no hint that an agent-readable surface exists. A non-browser fetch of the front door
learns only marketing copy.

> **Confusion #1 — "Get early access" reads as a waitlist.** The signup form is in fact open. An agent
> could reasonably tell its user "Haven is waitlisted" and stop right here.

### Step 2 — Discovery probes

Fifteen discovery URLs, probed in one hop:[^count]

[^count]: The raw session notes head this step "13 probes" while listing fifteen distinct URLs (it
    collapsed `/docs` and `/developers` onto one line). The tables below are the URLs actually probed;
    the counts in this section were recomputed from them, and the twenty-six total at the end of step 9
    is this file's arithmetic, not a figure the run reported. Nothing else in this record is
    recalculated — every status, quotation and screenshot description is as the run wrote it.

| URL | Status | What came back |
|---|---|---|
| `/llms.txt` | **200** `text/plain` | Excellent. One-paragraph model, "Start here" links, npm package list, trust links |
| `/llms-full.txt` | **200** `text/plain` (4.1 KB) | Model, x402 flow, integration surface (names the MCP tools `haven_get_agent`, `haven_pay`, `haven_quote_x402`, `haven_get_allowances`), owner quickstart |
| `/402.md` | **200** `text/markdown` | "Fix it in three steps", including the literal `npx @haven_ai/connect@alpha` |
| `/402` | 200 HTML | Rendered twin of the above; links "Agent-readable version of this page" |
| `/robots.txt` | 404 | — |
| `/sitemap.xml` | 404 | — |
| `/.well-known/ai-plugin.json` | 404 | — |
| `/docs` | 404 | — |
| `/developers` | 404 | — |
| `/api` | 404 **JSON** — `{"message":"Route GET:/ not found","error":"Not Found","statusCode":404}` | Leaks (usefully) that a Fastify backend is proxied at `/api` |
| `/openapi.json` | 404 | but… |
| **`/api/openapi.json`** | **200** (356 KB, OpenAPI 3.1) | Full spec, 130+ paths, three security schemes |
| `/api/health` | 200, public | db ok, **plus relayer addresses and balances for chains 100 / 8453 / 84532** |
| `/api/chains` | 200, public | `{"deployable":[84532],"supported":[100,8453,84532]}` |
| `/api/catalog` | 401 | The spec sells it as "List curated payable services agents can discover and pay" — but it needs a key |

Verbatim head of `/llms.txt` as served that day:

```
# Haven
> Haven is the buy-side control layer for AI-agent payments: give your agent a budget, not your wallet. …
Haven connects agents through MCP (hosted, keyless) plus a local signer. Payments settle in USDC on Base via x402 …
## Start here
- [Your agent hit a 402 — how to pay it](https://haven.xyz/402.md)
- [Dashboard](https://app.haven.xyz): create an account (one passkey prompt), create an agent, set its budget, get the connect command
## Packages (npm)
- [@haven_ai/connect](https://www.npmjs.com/package/@haven_ai/connect): one-command local connector …
```

### Step 3 — Following the "Start here" links — all dead

`https://haven.xyz`, `https://haven.xyz/402.md`, `https://app.haven.xyz`, `https://haven.xyz/llms.txt`
and `https://haven.xyz/exit/` all failed with `curl` exit 6/7 (name does not resolve / connection failed).
`docs.haven.xyz/product/account-recovery`, also linked from `llms.txt`, was not probed separately — same
apex domain.

> **Confusion #2 (the big one) — the docs point off a cliff.** The document Haven hands an agent says
> "create an account at `app.haven.xyz`"; that host does not exist. The agent had to *guess* that the
> dashboard lives on the same Vercel host it was given. Nothing in `llms.txt` says "this deployment
> serves the dashboard at `/login` / `/signup` / `/agents`". A less stubborn agent would have reported
> "Haven's dashboard is down" and stopped.

### Step 4 — Reading the OpenAPI spec

Genuinely useful, and the high point of the run. From `/api/openapi.json` alone the agent reconstructed
the entire connect handshake with no docs at all:

- `POST /agent-connection-setups` (dashboard JWT) → `setup_id`, `setup_token` (`hv_setup_…`), `expires_at`,
  **`connector_command`**, `connector_package` (`@haven_ai/connect@<tag>`), **`setup_prompt`**
- `POST /agent-connection-setups/resolve` (setup token) → wallet, `agent_budget[]`, `hosted_mcp_url`,
  `challenge.message` to sign
- `POST /agent-connection-setups/register` → `agent_id`, `api_key_prefix` (`sk_agent_…`, scope
  `setup_pending`), `delegate_address`, `hosted_mcp_url`,
  `next_action: "return_to_haven_for_wallet_approval"`
- `POST /agent-connection-setups/{id}/budget-approval` (owner) completes it

The request schema also told it what the human is asked for: `name` (required), `allowances[]` with
`token_address`, `token_symbol`, `allowance_amount` (**atomic** — "25 USDC is 25000000"),
`reset_period_min`, optional `issue_passport`, `source`. And separately: `POST /auth/signup` and
`POST /auth/login` are plain credential endpoints, `POST /passkeys` enrolls a passkey *after* login, and
`POST /accounts/hybrid` provisions the smart account.

The three security schemes carried prose explaining the trust model outright — *API auth is identity;
signature is authority; the on-chain budget delegation is enforcement*.

> **Confusion #3 — which backend?** The spec's `servers[]` lists
> `https://havenbackend-production-8a00.up.railway.app` (Production) and `localhost:3001`. It does **not**
> list the host that actually served the spec (`…vercel.app/api`). An agent obeying the spec literally
> would call **production** from a dev deployment.

### Step 5 — Signup page (screenshot taken)

A white card: *"Create your Haven account — One account, agents that spend within rules you set."*
Fields **Name / Email / Password (Min 8 characters) / Confirm password**, button "Create account", link
"Already have an account? Log in". A right-hand sidebar, *"WHAT YOU'RE SIGNING UP FOR"*, says: *"An
account wallet you own — Create it with a passkey or your existing wallet."*

So signup is email + password and the passkey/wallet step comes *after*. The page never says "this next
step needs a human with Face ID". The agent inferred it from the sidebar plus `/llms-full.txt` ("one
passkey prompt (Face ID / Touch ID)"). **No account was created.**

### Step 6 — Login page (screenshot taken) — the hard stop

*"Welcome back — Log in to your Haven account."* Email, Password, "Log in", "Don't have an account?
Sign up". Nothing else.

The brief permitted using the test account here. **The agent declined to enter the password** — its own
operating rules prohibit typing a credential to authenticate regardless of who supplies it — and handed
off to the human instead. That refusal is the correct behaviour and it is also *the realistic case*: on
any fresh machine a naive agent has no credentials either, and this page gives it nothing to relay to its
owner beyond "log in".

> **Confusion #4 — the auth wall answers 200.** `/dashboard`, `/agents` and `/agents/connect` all return
> HTTP 200 to `curl` (the SSR shell); the redirect to `/login` is client-side only. A non-browser agent
> sees 200 and a page titled "Haven, agent payments within your rules" and cannot tell it has hit an
> authentication wall rather than a content page.

### Step 7 — Salvaging the post-login flow from public assets

Unable to log in, the agent fetched the JS chunks referenced by `/agents/connect` and grepped them.
Connect-modal copy, verbatim from the bundle:

- "**Connect your agent**"
- "**Paste this prompt into the agent environment. It includes your approval for the exact local setup
  actions, creates the key there, and sends Haven only the public signing address.**"
- "Haven advances this screen automatically once the agent connects — no refresh, nothing else to click
  here."
- "Your agent app may ask you to approve running the setup command. That is expected." (variant: "Codex
  Desktop may ask you…")
- "Waiting for the agent to run the setup command. This usually takes a few seconds." / "Still going — a
  first run downloads the connector first, so it can take a minute or two."
- "Haven has not received a connection yet — This setup is still waiting. Do not approve the budget yet.
  Check the connector's output first…"
- "Copy local command" / "Cancel this setup" / "Continue to wallet approval"
- "Running in a server or hosted backend? … Paste these values into the backend's secrets instead — an API
  key that identifies your agent and a private signing key the runtime uses to sign payments. The signing
  key is shown once."
- "The Haven payment skill is a generic, secret-free guide your agent can load for payment best practice.
  … Download the skill"

The **actual `setup_prompt` / `connector_command` text is server-generated and only visible after login**,
so it could not be captured. Public docs give only `npx @haven_ai/connect@alpha`; the spec confirms the
real command carries an `hv_setup_…` token.

### Step 8 — npm

- `npm view @haven_ai/connect@alpha description readme --json` → description: *"Haven connect — one command
  wires an AI agent to budgeted, non-custodial payments: installs the MCP runtime and generates the agent
  signing key locally, registering only the public address."* — and **`readme: ""`** (empty).
- `npm view @haven_ai/cli@alpha readme` → **empty output**.
- dist-tags: `latest: 0.1.0-alpha`, `alpha: 0.1.34-alpha.0`, `dev: 0.0.0-dev.…`. A bare
  `npx @haven_ai/connect` with no `@alpha` installs a package 34 releases behind. Haven's docs do always
  say `@alpha`; nothing anywhere says *why*, so an agent has no reason not to "helpfully" drop it.

### Step 9 — Other public pages

| URL | Status | What came back |
|---|---|---|
| `/how-it-works` | 200 | Six steps. Step 01 "Sign up with your email." Step 02 "Use Face ID / Touch ID or connect your wallet." Step 05 shows a mock **`sk_live_••••9aF2`** credential; step 06 "Add your Haven credential to Claude, GPT, or your own agent." |
| `/exit` | 200 | Self-contained, backend-independent revoke/inspect tool, well explained in an HTML comment |
| `/about` | 404 | The footer links to About… |
| `/contact` | 404 | …and to Contact are dead |
| `/connect` | 404 | — |

Twenty-six URLs were probed in total across the run: the fifteen above, these five, the five dead
`haven.xyz` hosts of step 3, and the root page.

## 3. Where it was confused, stuck, or guessing

The four boxed items above are the confusion points that changed what the agent *did* in flight. This is
the complete list it reported afterwards, in its own priority order:

1. **Dead hostnames.** `haven.xyz`, `app.haven.xyz`, `docs.haven.xyz` — every link in `llms.txt`,
   `llms-full.txt`, `402.md` and the rendered `/402` page — do not resolve. Highest-impact issue.
2. **Discovery was a guess.** `llms.txt` / `402.md` / `openapi.json` are findable only if you already know
   to try those paths. No `<link>`, no `robots.txt`, no sitemap, no footer link; `/docs` and `/developers`
   404.
3. **Which backend?** The spec's `servers[]` names production while the spec was served from a dev host
   with an `/api` proxy.
4. **"Get early access" vs open signup.** Waitlist wording on an open form.
5. **The passkey is a surprise.** Signup asks for email and password; the passkey/wallet requirement lives
   in a sidebar and in `llms-full.txt`, never on the form, and is never framed as "a human must do this".
6. **The auth wall returns 200** to non-browser clients.
7. **Vocabulary drift.** The landing page and `/how-it-works` say "add your Haven *credential*" and show an
   `sk_live_…` key; `llms.txt` and `402.md` say "paste the connect *command*"; the modal says "paste this
   *prompt*"; the spec has `setup_prompt` + `connector_command` plus a hosted-backend path with
   `sk_agent_…` and a private key. Four mental models for one step.
8. **Empty npm readmes** for `connect@alpha` and `cli@alpha`. An agent that reaches npm first learns one
   sentence.
9. **The hosted MCP URL is never published.** It appears only in the `register` response.
   `llms-full.txt` says "Hosted MCP (keyless)" and names the tools, but gives no URL.
10. **`/api/catalog` is 401** while the spec frames it as agent discovery. Minor.

## 4. The hand-off script it would have sent

Recorded because it is the artifact the epic is trying to make unnecessary — it is what a *good* agent
produces when the product gives it nothing better. Verbatim:

**After steps 1–4, before touching signup:**

> I read Haven's agent docs (`/llms.txt`, `/402.md`, `/api/openapi.json`). Here's the shape: you (the
> human) create a Haven account, create an agent with a USDC budget, and the dashboard gives you a setup
> prompt/command (`npx @haven_ai/connect@alpha …` with a one-time setup token) that you paste to me; I run
> it here, it generates a signing key locally and registers only the public address; then you approve the
> budget in the dashboard with your passkey. Money never sits with me. One snag: the docs link to
> `app.haven.xyz`, which doesn't resolve — I'll assume the dashboard is the vercel URL you gave me.

**At signup/login — the real stop:**

> I can't go further on my own. Please open `<url>/signup` (or `/login` if you have an account): it's name
> + email + password, then it will ask you to create a passkey (Face ID/Touch ID) or connect a wallet —
> that's your account's key, not something I should hold. Then go to `<url>/agents/connect`, name the
> agent, set a budget (e.g. 25 USDC per day), click **Connect your agent**, and paste the prompt it shows
> back to me. Don't approve the budget until I've run the command and the screen says I'm connected.

**After the human pastes the prompt — not reached:**

> Running the setup command now; it will generate a key on this machine and register the public address.
> When the Haven screen advances, click "Continue to wallet approval" and sign with your passkey.

## 5. What was genuinely good

Recorded deliberately, so the epic does not "fix" any of it:

- **`/llms.txt` + `/llms-full.txt` + `/402.md` are concise, accurate and non-marketing**, and they give the
  literal command. The agent called the content best-in-class; the only problems were *reachability* and
  *link targets*, never the prose.
- **`/api/openapi.json` is a real, complete 3.1 spec.** Its security-scheme prose alone explains the trust
  model, and the whole connect handshake was reconstructed from it without docs.
- **The connect-modal copy is already written for agent-in-the-loop** — "Paste this prompt into the agent
  environment… Your agent app may ask you to approve running the setup command. That is expected." — and
  the hosted-backend branch anticipates the non-local case.
- **`/api/health` and `/api/chains` are public and instant.**
- **Everything was fast.** No retries, no hangs.

One note that is a security observation rather than a UX one: `/api/health` publishes relayer addresses
and balances without auth. Owned separately by
[#2542](https://github.com/d-hinders/Haven-AI/issues/2542), not by this epic.

## 6. Wishlist → sub-issue map

The agent's ranked wishlist, each item against the slice that owns it. This is the table the "the cold
test found…" claims in #2520–#2540 point back to.

| # | Wishlist item (agent's ranking) | Owned by |
|---|---|---|
| 1 | Make the links in `llms.txt` / `llms-full.txt` / `402.md` resolve — or make them relative to the serving host | [#2520](https://github.com/d-hinders/Haven-AI/issues/2520) (A1) |
| 2 | Advertise the agent docs from the HTML — `<link rel="alternate">`, `robots.txt`, sitemap, a footer "For agents" link | [#2521](https://github.com/d-hinders/Haven-AI/issues/2521) (A2) |
| 3 | A one-line honest hand-off instruction ("an agent cannot sign up — tell your owner…") plus an example `setup_prompt` with a fake token | [#2523](https://github.com/d-hinders/Haven-AI/issues/2523) (B1); the links it cites come from [#2522](https://github.com/d-hinders/Haven-AI/issues/2522) (B2) |
| 4 | Say it on the login/signup pages too, for agents that land there first; rename "Get early access" | [#2524](https://github.com/d-hinders/Haven-AI/issues/2524) (B3) |
| 5 | A machine-readable discovery document (`dashboard_url`, `api_base`, `openapi_url`, `hosted_mcp_url`, `connector_package` with its dist-tag, `chains`) | [#2531](https://github.com/d-hinders/Haven-AI/issues/2531) (A3) |
| 6 | OpenAPI `servers[]` should include the host serving the spec, ahead of production | [#2530](https://github.com/d-hinders/Haven-AI/issues/2530) (A4) |
| 7 | Fill the npm readmes for `@haven_ai/connect` and `@haven_ai/cli`; settle what `latest` should point at | [#2536](https://github.com/d-hinders/Haven-AI/issues/2536) (C5) |
| 8 | One vocabulary across landing, how-it-works, `llms.txt` and the modal; drop the `sk_live_…` mock | [#2533](https://github.com/d-hinders/Haven-AI/issues/2533) (A6) |
| 9 | Make the auth wall visible to non-browser clients (401 / redirect / a distinct `<title>`) | [#2521](https://github.com/d-hinders/Haven-AI/issues/2521) (A2) — moved there from A4 so the sitemap test can tell a page from a wall |
| 10 | Publish the hosted MCP URL; let `/api/catalog` (or a public subset) be read without a key | [#2530](https://github.com/d-hinders/Haven-AI/issues/2530) (A4) |

The hard stop of step 6 is not on the agent's wishlist — it could not see the fix from outside — but it is
the reason the C-series exists: an owner session an agent can obtain **without a password**
([#2526](https://github.com/d-hinders/Haven-AI/issues/2526), C1), a machine contract to drive it with
([#2525](https://github.com/d-hinders/Haven-AI/issues/2525), C4) and the commands that replace the modal
([#2527](https://github.com/d-hinders/Haven-AI/issues/2527), C2). The remaining slices close hand-offs the
run never reached: funding ([#2534](https://github.com/d-hinders/Haven-AI/issues/2534), B4), the whole-
onboarding prompt ([#2535](https://github.com/d-hinders/Haven-AI/issues/2535), B5), the connector's
`--json` outcome and approval link ([#2528](https://github.com/d-hinders/Haven-AI/issues/2528), B6),
measurement ([#2529](https://github.com/d-hinders/Haven-AI/issues/2529), D1), onboarding content in the
shipped skill ([#2537](https://github.com/d-hinders/Haven-AI/issues/2537), D2), the recurring re-run
([#2538](https://github.com/d-hinders/Haven-AI/issues/2538), D3), later budget changes
([#2539](https://github.com/d-hinders/Haven-AI/issues/2539), C3) and shared CLI/connector plumbing
([#2540](https://github.com/d-hinders/Haven-AI/issues/2540), C6).

## 7. Screenshots

Not committed — they were session artifacts and every one of them is described verbatim above. For the
record, the run captured:

- `/signup` — the "Create your Haven account" card (Name / Email / Password / Confirm) with the "passkey or
  existing wallet" sidebar
- `/login` — the "Welcome back" card, Email and Password only
- `/402` — the dark hero "Your agent hit a paywall. That's not an error — it's a price." with the three
  steps and the `npx @haven_ai/connect@alpha` command
- the connect modal — **not reached**, behind the login wall

## 8. Redaction

No credentials, tokens, cookies or `Authorization` headers appear in this file. The test account's
identity is deliberately absent — the agent never authenticated, so none was used. The dev preview
hostname is reproduced because it is already public in
[`dev-environment.md`](../operations/dev-environment.md). Token shapes (`hv_setup_…`, `sk_agent_…`,
`sk_live_••••9aF2`) are the public schema's own placeholders, not values.

## Related

- [#2519](https://github.com/d-hinders/Haven-AI/issues/2519) — the epic this baselines
- [`qa-explore-ui-cadence.md`](../operations/qa-explore-ui-cadence.md) — the discovery cadence D3 joins
- [`dev-environment.md`](../operations/dev-environment.md) — the dev target the run used
- [`_run-report-template.md`](_run-report-template.md) — the template for ordinary QA run reports (this
  file is a one-off research record, not a run of a scripted scenario)
