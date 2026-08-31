---
owner: "@d-hinders"
status: current
covers:
  - packages/frontend/public/llms.txt
  - packages/frontend/public/llms-full.txt
  - packages/frontend/public/402/index.html
  - packages/frontend/public/402.md
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

## Follow-ups filed

- Agent-crawler analytics (log GPTBot/ClaudeBot/PerplexityBot UAs + llms.txt fetches) and connect-funnel source attribution — backlog issue, Phase 0's measurement half.
- Share-of-answer weekly probe (20 canonical questions vs major models) — Phase 1, needs the analytics issue first.
