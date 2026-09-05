---
owner: "@d-hinders"
status: current
covers:
  - packages/frontend/public/llms.txt
  - packages/frontend/public/llms-full.txt
  - packages/frontend/public/402/index.html
  - packages/frontend/public/402.md
  - packages/frontend/public/for-agents.md
  - packages/sdk/src/agent-guidance.ts
  - packages/frontend/src/middleware.ts
  - packages/frontend/src/lib/discovery.ts
  - packages/frontend/src/lib/__tests__/discovery-artifacts.test.ts
  - packages/frontend/src/lib/discovery-surfaces.ts
  - packages/frontend/src/app/robots.txt/route.ts
  - packages/frontend/src/app/sitemap.xml/route.ts
  - packages/frontend/src/app/layout.tsx
  - packages/backend/src/domain/handoff-links.ts
  - packages/backend/src/routes/auth.ts
  - packages/frontend/src/lib/__tests__/handoff-links.test.ts
  - packages/backend/src/infra/repositories/onboarding-funnel.ts
  - packages/backend/src/routes/analytics.ts
  - packages/frontend/src/lib/__tests__/middleware-funnel-matcher.test.ts
  - packages/backend/src/infra/repositories/__tests__/handoff-attribution.test.ts
last-verified: "2026-09-05" # #2529: § *Measurement* — the crawler-trend paragraph is rewritten as an explicit LOWER BOUND and the funnel pages (`/signup`, `/login`, `/onboarding`, `/for-agents.md`, `/device`) join the middleware matcher; a new subsection adds the two D1 queries (agent-driven signups → conversion; stall points for agent-driven setups). Three things measured rather than asserted. First, the lower-bound claim is now a TEST, not a sentence: `middleware-funnel-matcher.test.ts` pins a real Chrome UA string classifying as NOT an agent beside `ClaudeBot` classifying as one, so the limit fails loudly if the classifier is ever "fixed" into pretending otherwise. Second, attribution is per USER and not per event — `handoff_via`/`run_mode` are written only by `signed_up` and `agent_created`, so a per-event GROUP BY reports zero agent-driven first payments and reads as "agents never convert"; the mutation that makes the query per-event turns 4 of 10 real-DB tests red. Third, every query in this entry was EXECUTED against a real Postgres with seeded rows and returned rows — which is how the first draft's `expires_at` was caught: the column is `setup_token_expires_at` and the query would have errored. NOT verified against the DEV database (no credentials in the build environment), so "runs on dev" is unproven here. `avg_seconds_in_status` is explicitly an approximation: `updated_at` is the last write of any kind, and a precise per-transition series would need a status-history table #2529 deliberately did not add. `segment=via` reads the metadata key `handoff_via`, never the older `via` key that names the code path — the mutation pointing it at `via` turns 5 of 10 red. Scope: § *Measurement* only, plus the three new `covers:` entries. NOT re-verified: § *The artifacts*, § *Discovery hooks*, the registry/listing inventory, the `next` open-redirect section, or the `?src=` attribution half. Prior: #2528: § Measurement gains the run-mode paragraph and its `run_mode × runtime × via × source` query, and the § Hand-off links table's budget-approval row now names `/register` as a third source of `approval_url` — which is what puts the link in the connector's `--json` outcome (`approval.url`) and its printed next steps. Two things measured rather than asserted, because the issue asked for something slightly different from what the code needed. First, the migration adds ONE column: `runtime` has been on `agent_connection_setups` since migration 017 and is already written by `markSetupRegistered`, so the issue's "`run_mode text` and `runtime text`" would have created a second, always-null column shadowing a populated one — pinned by a characterization test asserting `runtime` reaches the existing UPDATE. Second, the SQL above COALESCEs a NULL `run_mode` to `unreported` rather than `prose`: absent means a connector older than #2528, which is a different fact from a narrated run, and collapsing them would inflate `prose` by exactly the pre-#2528 population. The `run_mode` write is proven on the real-DB harness (`infra/repositories/__tests__/agent-connection-setups.test.ts`), mutation-proven two ways — dropping the SQL assignment and swapping the `runtime`/`run_mode` bind positions each turn it red. Scope: § Measurement and that one table row. NOT re-verified: the registry/listing inventory, the crawler-trend query, the `next` open-redirect section, or this doc's other claims. Prior: #2523: § *The artifacts* gains the `/for-agents.md` row, and `covers:` gains that file plus `packages/sdk/src/agent-guidance.ts` — the canonical string it is generated from, so a change to the runbook re-implicates this doc rather than only a change to the served copy. The same-origin rule and the connect one-liner rule below were re-read against the new artifact and hold: every link in it is a path, and it prints the full `npx -y @haven_ai/connect@alpha --setup …` command the backend builds rather than the bare one-liner (the guard test now asserts both halves). Scope: that row, those two `covers:` entries and this note ONLY — the registry checklist and the measurement section were not re-read. Prior: #2522: new § *Hand-off links and the `via=agent` marker* under *Measurement* — the four link shapes with their sync rules, the two open-redirect cases that an origin check alone does NOT catch (`/..//evil.com` resolving same-origin to a protocol-relative pathname; a tab stripped during parsing), the enum-not-slug rule for `via`, and the metadata-key collision that decided the design: the funnel already uses `via` to name which CODE PATH created a record, so the hand-off marker rides as `handoff_via` and reusing `via` would have silently redefined every historical row. Five new `covers:` entries — widened on review: `lib/discovery.ts` and `routes/auth.ts` are the source of truth for the frontend sanitiser and the signup wiring this section describes, and neither was declared in the first draft. Migration 076 is deliberately NOT covered: a landed migration never changes, so coupling it buys nothing. Two review rounds. haven-reviewer found the resumed connect step rendering a blank body and, on re-review, two more states reachable only because this change added the resume path — a stale link showing chrome over nothing, and terminal states offering "Create a new setup" where that would post an unnamed, budget-less setup; the table row now records the not-found deviation from the issue's "no modal". haven-doc-reviewer found the login row claiming `&via=agent` works there — it does not, and should not; that row and a new paragraph now record the asymmetry and its two reasons. Scope: that new section and the front matter — § *The artifacts*, § *Discovery hooks* and the registry checklist were read against this diff and are unchanged, and the #2302 `?src=` half of *Measurement* is untouched. Prior: #2521: § *The artifacts* gains rows for `robots.txt`, `sitemap.xml` and the auth-wall marker, and the new § *Discovery hooks* records the four hooks and why the two generated artifacts are route handlers rather than files in `public/`. Scope: those additions and the four `covers:` entries above them. The URL column of the pre-existing rows is #2520's work, merged in beneath this and not re-read here; the registry checklist was not re-read either. Prior: #2520 (follow-up): the *Listing copy (canonical)* block one section below still said `haven.xyz/402` — found by haven-doc-reviewer, and my own scope sentence in the entry below had excluded exactly that part of the file. It cannot take a same-origin path (the copy is pasted into external registries and needs an absolute URL), and no production host is recorded here, so it now reads `<host>/402` with a paragraph saying it is unsubmittable until a domain is decided. Scope: that block and its new paragraph. Prior: #2520: § *The artifacts* URL column rewritten from the `haven.xyz` / `app.haven.xyz` / `docs.haven.xyz` hosts, none of which resolve, to same-origin paths; the section gains the same-origin rule, its guard test (added to `covers:` with this entry) and the one temporary off-site allow-list entry (product docs, until #2532). Scope: that table and the paragraph above the connect-one-liner rule — the one-liner rule itself is unchanged and still reads verbatim-everywhere, and the registry checklist below was not re-read. First entry on this chain; the file carried a bare date before.
---

# Agent discovery listings — registry audit & cadence

Operational home of the **Agent Discovery (AEO) GTM track**, Phase 0 (strategy doc: "GTM Track: Agent Discovery" in the GTM Drive folder). Two jobs: (1) keep the agent-readable artifacts this doc `covers:` in sync with the product, and (2) keep Haven listed — accurately — on every surface agents consult when they need payment capability.

## The artifacts (this repo)

| Artifact | URL | Sync rule |
|---|---|---|
| `llms.txt` | `/llms.txt` | Curated manifest. Update when a top-level surface (402 page, exit tool, packages, docs) is added/renamed. |
| `llms-full.txt` | `/llms-full.txt` | Single-file overview. Update on product-model changes (rails, settlement schemes, onboarding flow). |
| 402 page | `/402` | Human landing for the 402 moment. Mirror of `402.md` — **edit both together** (sync note in the HTML header). |
| `402.md` | `/402.md` | Agent-readable mirror; token-cheap, answer-first. |
| `for-agents.md` | `/for-agents.md` | The onboarding runbook written to an agent whose user has no account (#2523). **Not hand-edited**: it is generated byte-identically from `HAVEN_AGENT_RUNBOOK_MD` in `packages/sdk/src/agent-guidance.ts`, which is also where the setup prompt's rule sentences live — edit there, and a parity test fails if the served file drifts. |
| npm metadata | package.json of sdk / signer / mcp / connect / cli | Keywords + descriptions carry the category phrases (x402, agent-payments, budget, non-custodial). Ships on next `release:bump`; do not hand-edit versions (see `scripts/README.md`). |
| `robots.txt` | `/robots.txt` | **Generated**, not a static file (`src/app/robots.txt/route.ts`). Names the agent-readable artifacts and `Disallow`s the authenticated prefixes. Update when a public artifact is added or an authenticated prefix appears — both come from `AUTHENTICATED_PREFIXES` in `src/lib/discovery-surfaces.ts`, so edit that list, not the template. |
| `sitemap.xml` | `/sitemap.xml` | **Generated** (`src/app/sitemap.xml/route.ts`) from `PUBLIC_SURFACES` in `src/lib/discovery-surfaces.ts`. Add a public page → add it there. The guard test fails if an entry resolves to no route or file, or if an authenticated prefix reaches the list. |
| Auth-wall marker | `<meta name="haven:auth" content="required">` | Emitted by `src/app/(authenticated)/layout.tsx` on every authenticated page, plus a `<noscript>` sentence. Lets a non-browser client tell a wall from a page — they all answer 200 with an SSR shell. Never add it to a public route; never remove it from an authenticated one. |

**Own-product links in these artifacts are same-origin paths, never absolute hosts (#2520).**
The URL column above is written that way for the same reason: the dev preview,
production and any custom domain mapped later all resolve the same file, so a
host change never needs a sweep. Until #2520 these files pointed at `haven.xyz`,
`app.haven.xyz` and `docs.haven.xyz` — three domains nobody owns — and every one
of those links answered `Could not resolve host`. Off-site links are allow-listed
in `packages/frontend/src/lib/__tests__/discovery-artifacts.test.ts`, which fails
on a reintroduced dead host or an unlisted one; adding a host is a decision, not
an edit. `llms.txt` and `llms-full.txt` also state in one line that their links
are paths on the serving host, since an agent may have been handed the text
rather than the URL it came from.

One allow-list entry is temporary and says so: the product docs have no served
home until [#2532](https://github.com/d-hinders/Haven-AI/issues/2532) publishes
them under `/docs/`, so `account-recovery` points at the public repository
meanwhile. That entry leaving the allow-list is how you know #2532 finished.

The connect one-liner is `npx @haven_ai/connect@alpha` **everywhere, verbatim** — agents copy exact strings. If the dist-tag ever changes, sweep every artifact above in one PR.

## Discovery hooks (#2521)

The artifacts above are only worth having if an agent can *find* them. The 2026-09-04 cold test ([`agent-first-cold-test-2026-09-04.md`](../bug-reports/agent-first-cold-test-2026-09-04.md) §2 step 1, §3.2) found them by guessing the convention — nothing in the served HTML pointed anywhere. Four hooks now do:

1. **`<link rel="alternate">` in the root layout** — `/llms.txt` (`text/plain`) and `/api/openapi.json` (`application/json`). Written as literal tags rather than Next `Metadata.alternates`, because Next resolves metadata URLs against `metadataBase` and would emit an absolute host; a **relative** href is correct on the dev preview, on production and on a future custom domain alike.
2. **`/robots.txt`** — allows crawling, names the artifacts in a comment block, `Disallow`s the authenticated prefixes, and carries an absolute `Sitemap:` URL.
3. **`/sitemap.xml`** — the public surfaces, absolute.
4. **One server-rendered sentence on the landing page**, plus a **"For agents"** footer link. Real content in the HTML a `curl` sees, not a hidden element.

**Why `robots.txt` and `sitemap.xml` are route handlers and not files in `public/`.** Both specs require *absolute* URLs — a relative `Sitemap:` line is silently ignored by crawlers, which is the same defect class as the dead hosts #2520 removed. Epic #2519's invariant forbids hardcoding a host. Taking the origin off the request satisfies both, with no env var to set per deployment and nothing to sweep if a custom domain is ever mapped.

Guard test: `packages/frontend/src/lib/__tests__/discovery-surfaces.test.ts`.

## Registry & directory checklist

Status legend: `listed` / `submitted` / `todo`. Re-audit **monthly** (rank + freshness), full sweep **quarterly** (new registries appear constantly).

### MCP registries

| Surface | Status | Notes |
|---|---|---|
| Official MCP Registry | todo | Tool names are indexed — they already read as capabilities (`haven_pay`, `haven_quote_x402`). |
| Anthropic connector directory | todo | Keyless story up front. |
| Smithery | todo | |
| PulseMCP | todo | |
| Glama | todo | |
| mcp.so | todo | |
| Cursor directory | todo | |

### x402 ecosystem

| Surface | Status | Notes |
|---|---|---|
| x402scan | todo | List client-side tooling AND Haven-wired merchants (demo merchant; partners when live). |
| x402 Bazaar (CDP discovery API) | todo | Demo merchant + partner endpoints. |
| x402 Foundation ecosystem page | todo | Working-group participation earns the listing. |
| awesome-x402 lists | todo | PR with genuinely useful entry. |

### Package & template surfaces

| Surface | Status | Notes |
|---|---|---|
| npm (5 packages) | listed | Metadata pass done (this PR); verify rendering after next publish. |
| Starter template repo | todo | Phase 1. |
| PyPI | todo | **Open roadmap decision** — flagged in the track doc; decide, don't inherit the gap. |

## Listing copy (canonical)

> **Haven — budgeted payments for AI agents.** Give your agent a budget, not your wallet: pay x402/HTTP-402 APIs in USDC within on-chain-enforced spending limits. Non-custodial (the agent never holds funds or keys), hosted MCP + local signer, receipts for every payment. `npx @haven_ai/connect@alpha` — details: <host>/402

**This copy is not submittable yet, and the `<host>` placeholder is why (#2520).** It carried `haven.xyz/402` — a domain nobody owns, so any registry that accepted this text would publish a dead link on our behalf. Unlike the artifacts, a registry submission cannot take a same-origin path: the copy is pasted somewhere else and needs an absolute URL that resolves. No production host is recorded in this repository today, so the placeholder stays until one is — which fits the epic's own decision (#2519) not to submit listings for now. Fill it in the same PR that decides the domain; do not fill it from memory.

Adapt length per registry; never change the one-liner or invent capability claims (no "MPP support" until it ships — the track's credibility rule is that every listing is verifiably true).

## Measurement (#2302 — live)

**Agent-crawler trend — a LOWER BOUND, never the headline number (#2529).** `packages/frontend/src/middleware.ts` logs one structured line per fetch of a discovery surface *or a funnel page* (`/signup`, `/login`, `/onboarding`, `/for-agents.md`, `/device` — added by #2529) when the User-Agent classifies as a known AI-agent family (classifier: `src/lib/discovery.ts`).

**Read this series as crawler traffic only.** `classifyAgentUserAgent` matches crawler UA needles — `gptbot`, `claudebot`, `claude-user`, `perplexitybot`, `ccbot`. A coding agent driving onboarding for its user fetches with an ordinary browser User-Agent and does **not** classify, so this series misses the exact scenario epic #2519 exists for. The agent-driven share comes from `via=agent` (#2522) and `run_mode` (#2528), below — what the agent PASTED, not what a client claimed to be. `packages/frontend/src/lib/__tests__/middleware-funnel-matcher.test.ts` pins the limit with a real browser UA string so it cannot be quietly reinterpreted. `/device` is matched ahead of the route existing (C1, #2526): a matcher observes, it does not advertise, so until then it logs probes. Query in Vercel logs:

```
evt=agent_discovery_fetch
```

Each line carries `surface` (`/llms.txt`, `/402`, …), `agent` (family: openai, anthropic, perplexity, …) and `ts`. Trend = weekly count per surface × family. Deliberately log-based: an unauthenticated ingest endpoint on the money-path backend would be an abuse surface. Upgrade path if Vercel log retention becomes the bottleneck: a log drain, not a public write endpoint.

**Attributed connects.** Tag any inbound link with `?src=<slug>` (lowercase, ≤32 chars: `402-page`, `registry`, `template`, `skill`, per-registry slugs like `smithery`). The app captures it to localStorage at first touch (root-layout capture — the query string alone does not survive the login hop) and reads it at setup creation, URL param winning over stored; the backend sanitizes and stores it on `agent_connection_setups.source` (migration 074) and echoes it into the `agent_created` funnel event's metadata. KPI queries:

```sql
-- Attributed connects (share of setups that reached connected, by source)
SELECT COALESCE(source, 'organic') AS source, COUNT(*) AS connects
FROM agent_connection_setups
WHERE status <> 'awaiting_connection'
GROUP BY 1 ORDER BY connects DESC;

-- Time-to-first-payment segmented by source (via onboarding_events metadata)
-- DISTINCT user_id: agent_created is repeatable (one row per agent), while
-- first_payment_settled is one-time — plain COUNT(*) would double-count
-- multi-agent users (same reason queryFunnel counts DISTINCT).
SELECT COALESCE(ac.metadata->>'source', 'organic') AS source,
       COUNT(DISTINCT fp.user_id) AS users_reached_first_payment,
       COUNT(DISTINCT ac.user_id) AS users_with_agents
FROM onboarding_events ac
LEFT JOIN onboarding_events fp
  ON fp.user_id = ac.user_id AND fp.event = 'first_payment_settled'
WHERE ac.event = 'agent_created'
GROUP BY 1;
```

**Run mode — how the connector was invoked (#2528).** The connector reports
`run_mode` (`json` | `prose`) on `POST /agent-connection-setups/register`;
the backend sanitises it to that two-value enum (400 on anything else, so the
dimension cannot absorb junk), stores it on `agent_connection_setups.run_mode`
(migration 077) and echoes it into the `agent_created` funnel metadata beside
`source` and `handoff_via`. `runtime` has been on the same row since migration
017 and needed no schema change. Together with `via` (#2522) this answers
whether the machine-readable path converts differently from the narrated one —
which D1 (#2529) builds on.

```sql
-- Share of setups by run_mode × runtime × via × source.
-- NULL run_mode = a connector older than #2528, NOT a prose run: the two are
-- different facts and collapsing them would silently inflate `prose`.
SELECT COALESCE(run_mode, 'unreported') AS run_mode,
       COALESCE(runtime, 'unknown')     AS runtime,
       COALESCE(via, 'direct')          AS via,
       COALESCE(source, 'organic')      AS source,
       COUNT(*)                         AS setups,
       COUNT(*) FILTER (WHERE status <> 'awaiting_connection') AS connected
FROM agent_connection_setups
GROUP BY 1, 2, 3, 4
ORDER BY setups DESC;
```

**The agent-driven funnel (#2529 — D1).** The two queries below are the ones
the epic's definition of done names. Both answer from `onboarding_events`, and
both depend on one rule that is easy to get wrong: **attribute the USER, then
count them at every step.** `handoff_via` and `run_mode` are written by exactly
two emissions (`signed_up`, `agent_created`); `first_payment_settled` carries
neither. A `GROUP BY metadata->>'handoff_via', event` therefore reports
agent-driven signups and then **zero** agent-driven first payments, which reads
as "agents never convert" and means only that the later event does not restate
the marker. `GET /analytics/funnel?segment=via` serves exactly these semantics
over the API (`queryFunnelSegments`), so a dashboard and a psql session give
the same answer rather than two plausible ones.

```sql
-- Agent-driven signups and their conversion through the funnel.
-- First touch wins; DISTINCT users throughout, because agent_created is
-- repeatable and COUNT(*) would put a multi-agent user's conversion over 100%.
WITH attribution AS (
  SELECT DISTINCT ON (user_id) user_id, metadata ->> 'handoff_via' AS via
  FROM onboarding_events
  WHERE metadata ->> 'handoff_via' IS NOT NULL
  ORDER BY user_id, created_at ASC, id ASC
)
SELECT COALESCE(a.via, 'unattributed')                                   AS via,
       COUNT(DISTINCT e.user_id) FILTER (WHERE e.event = 'signed_up')            AS signed_up,
       COUNT(DISTINCT e.user_id) FILTER (WHERE e.event = 'agent_created')        AS created_agent,
       COUNT(DISTINCT e.user_id) FILTER (WHERE e.event = 'safe_funded')          AS funded,
       COUNT(DISTINCT e.user_id) FILTER (WHERE e.event = 'first_payment_settled') AS paid
FROM onboarding_events e
LEFT JOIN attribution a ON a.user_id = e.user_id
GROUP BY 1 ORDER BY signed_up DESC;

-- Stall points for agent-driven setups: where they stop, and how long they sit.
-- `approved` is the terminal success; an expired row that never connected is
-- the agent hand-off failing before the human ever saw the link.
SELECT COALESCE(via, 'direct')                                      AS via,
       status,
       COUNT(*)                                                     AS setups,
       ROUND(AVG(EXTRACT(EPOCH FROM (updated_at - created_at))))    AS avg_seconds_in_status,
       COUNT(*) FILTER (WHERE setup_token_expires_at < NOW()
                          AND status = 'awaiting_connection')       AS expired_unconnected
FROM agent_connection_setups
GROUP BY 1, 2 ORDER BY via, setups DESC;
```

`avg_seconds_in_status` is an approximation, and it is worth being exact about
which one, because the honest version is weaker than it first looks.
`agent_connection_setups` carries two timestamps and no history table, so
`updated_at - created_at` is **time since the row was created** — the
cumulative elapsed time across every status the row has passed through, not
time spent in the status it is grouped by. A setup that reached `active` after
several retries reports a large figure against `active` even though almost none
of that time was spent there. Read it as "how long these setups have been
alive", never as "how long they sit in this step". A real per-step series needs
a status-history table, which #2529 deliberately did not add — no schema
change, per its own scope.

**Both queries above are unwindowed on purpose, and that is an asymmetry worth
knowing.** They answer over all time, while `GET /analytics/funnel` takes
`from`/`to` and `queryFunnelSegments` resolves attribution only from events
INSIDE that window. Pasting one of these into psql therefore gives an all-time
number, not a recent one. Add `WHERE created_at >= now() - interval '30 days'`
to the outer query (and to the `attribution` CTE, or first touch is resolved
from events the count then excludes) to match the API's default window.

The sanitization rule lives in TWO places by design — `normalizeDiscoverySource` (backend route) and `parseDiscoverySource` (frontend `lib/discovery.ts`) — keep them identical.

### Hand-off links and the `via=agent` marker (#2522)

An agent cannot approve a budget, sign up, or complete onboarding — a human
must. So every human-only step is a link the agent can paste, and each one
carries `via=agent` so the funnel it drives is measurable rather than inferred.

| Link | Shape | Sync rule |
|---|---|---|
| Signup with a return target | `/signup?next=<same-origin path>&via=agent` | `next` SURVIVES onboarding — that is the contract. Adding a new post-auth redirect means routing it through `postAuthDestination`, never a bare `/dashboard`. |
| Login with a return target | `/login?next=<same-origin path>` | Same sanitiser, same helper. **No `via` here, deliberately** — see below. |
| Onboarding resume | `/onboarding?next=<same-origin path>` | Carried in the URL by `postAuthDestination`; onboarding's completion and its already-has-an-account redirect both honour it. |
| Budget approval for a setup | `/agents?setup=<setupId>` | Opens the connect modal on the step that setup's live status calls for. The canonical form is `approval_url` from setup create, status **and — since #2528 — the connector's `/register` response**, which is what puts it in the connector's `--json` outcome as `approval.url` and in its printed next steps. Print that, never a hand-assembled URL: the outcome carries no setup id, so an agent has the whole link or none. A stale or foreign id renders a not-found state **inside** the modal (deviation from the issue's "no modal", so someone who followed a link is told what happened). |

**`next` is an open-redirect boundary, and an origin check alone does not close
it.** Two cases, measured with the real URL parser rather than reasoned about,
and both live in `packages/frontend/src/lib/__tests__/handoff-links.test.ts`:

- `/..//evil.com` resolves to the **same** origin — the origin check passes —
  but its pathname is `//evil.com`, which a browser reads as a
  protocol-relative URL. `sanitizeNextPath` therefore tests the leading slashes
  of the RESULT, not only of the input.
- `/foo<TAB>bar` is silently stripped to `/foobar` while parsing, so the string
  that was checked is not the string that gets resolved. Control characters are
  **refused**, never stripped: a stripper has to be right about every character
  a parser removes, and being wrong once reopens the redirect.

**`via` is carried on signup, not on login, and that asymmetry is deliberate.**
`POST /auth/signup` accepts the marker; `login()` does not, and nothing on the
login path reads it. Two reasons, and neither is an oversight: a returning user
never re-fires `signed_up`, so there is no funnel event for the marker to ride;
and `users.via` records first touch — writing it at every login would let the
most recent link overwrite how the account was actually acquired, which is the
opposite of what the measurement is for. A `via=agent` on a login URL is
therefore inert, and the shape column above omits it rather than implying
parity with the signup row.

**`via` is an ENUM (`agent` or absent), not a slug like `source`.** It answers
one closed question — did an agent produce this link — and the agent-driven
funnel is segmented on it, so a free-text field would let whoever writes a link
write anything into that metric. Sanitised in TWO places by design, the same as
`source`: `normalizeViaMarker` (`packages/backend/src/domain/handoff-links.ts`)
and `parseViaMarker` (frontend `lib/discovery.ts`) — keep them identical.

It is stored on `users.via` and `agent_connection_setups.via` (migration 076)
and rides the `signed_up` and `agent_created` funnel events as **`handoff_via`**.

> **Not `via`, and this is the trap to avoid re-stepping in.** That metadata key
> already exists and means something else — which CODE PATH created the record
> (`'connection_setup'` from the connect flow; absent from `POST /agents`,
> which is how the two are told apart today). Reusing it would give one key two
> meanings and silently redefine every historical row. A real-DB test
> (`handoff-attribution.test.ts`) pins both keys surviving one emission.

```sql
-- Agent-driven share of signups
SELECT COALESCE(via, 'human') AS origin, COUNT(*) AS signups
FROM users GROUP BY 1 ORDER BY signups DESC;

-- Agent-driven share of the funnel, from what the agent PASTED —
-- never from a user agent, which says what the client claimed to be and is
-- wrong by construction here: the human arrives in an ordinary browser.
SELECT event,
       COUNT(DISTINCT user_id) FILTER (WHERE metadata->>'handoff_via' = 'agent') AS agent_driven,
       COUNT(DISTINCT user_id) AS total
FROM onboarding_events
WHERE event IN ('signed_up', 'agent_created')
GROUP BY 1;
```

## Follow-ups

- Share-of-answer weekly probe (20 canonical questions vs major models) — Phase 1.
