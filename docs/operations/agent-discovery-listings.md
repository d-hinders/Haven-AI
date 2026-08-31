---
owner: "@d-hinders"
status: current
covers:
  - packages/frontend/public/llms.txt
  - packages/frontend/public/llms-full.txt
  - packages/frontend/public/402/index.html
  - packages/frontend/public/402.md
  - packages/frontend/src/middleware.ts
  - packages/frontend/src/lib/discovery.ts
last-verified: "2026-08-31"
---

# Agent discovery listings — registry audit & cadence

Operational home of the **Agent Discovery (AEO) GTM track**, Phase 0 (strategy doc: "GTM Track: Agent Discovery" in the GTM Drive folder). Two jobs: (1) keep the agent-readable artifacts this doc `covers:` in sync with the product, and (2) keep Haven listed — accurately — on every surface agents consult when they need payment capability.

## The artifacts (this repo)

| Artifact | URL | Sync rule |
|---|---|---|
| `llms.txt` | `haven.xyz/llms.txt` | Curated manifest. Update when a top-level surface (402 page, exit tool, packages, docs) is added/renamed. |
| `llms-full.txt` | `haven.xyz/llms-full.txt` | Single-file overview. Update on product-model changes (rails, settlement schemes, onboarding flow). |
| 402 page | `haven.xyz/402/` | Human landing for the 402 moment. Mirror of `402.md` — **edit both together** (sync note in the HTML header). |
| `402.md` | `haven.xyz/402.md` | Agent-readable mirror; token-cheap, answer-first. |
| npm metadata | package.json of sdk / signer / mcp / connect / cli | Keywords + descriptions carry the category phrases (x402, agent-payments, budget, non-custodial). Ships on next `release:bump`; do not hand-edit versions (see `scripts/README.md`). |

The connect one-liner is `npx @haven_ai/connect@alpha` **everywhere, verbatim** — agents copy exact strings. If the dist-tag ever changes, sweep every artifact above in one PR.

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

> **Haven — budgeted payments for AI agents.** Give your agent a budget, not your wallet: pay x402/HTTP-402 APIs in USDC within on-chain-enforced spending limits. Non-custodial (the agent never holds funds or keys), hosted MCP + local signer, receipts for every payment. `npx @haven_ai/connect@alpha` — details: haven.xyz/402

Adapt length per registry; never change the one-liner or invent capability claims (no "MPP support" until it ships — the track's credibility rule is that every listing is verifiably true).

## Measurement (#2302 — live)

**Agent-crawler trend.** `packages/frontend/src/middleware.ts` logs one structured line per discovery-surface fetch by a known AI-agent UA family (classifier: `src/lib/discovery.ts` — under-counts, never over-counts). Query in Vercel logs:

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

The sanitization rule lives in TWO places by design — `normalizeDiscoverySource` (backend route) and `parseDiscoverySource` (frontend `lib/discovery.ts`) — keep them identical.

## Follow-ups

- Share-of-answer weekly probe (20 canonical questions vs major models) — Phase 1.
