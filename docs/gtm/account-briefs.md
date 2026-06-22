# GTM — account briefs (Tier A)

Deeper briefs for prioritised Tier A targets from [`sweden-target-list.md`](./sweden-target-list.md):
what the company does, where its machine spend sits, how Haven fits, the regulatory
screen, and a tailored intro email.

All email copy follows the **Positioning guardrails** in
[`README.md`](./README.md#positioning-guardrails-read-before-writing-copy) and the copy
checklist in [`outreach-playbook.md`](./outreach-playbook.md): non-custodial language,
"appears in your bookkeeping tool" (never "audit-ready"), payout/PSP screened out, no
custody/PSP/merchant-settlement claims.

> Fit is a hypothesis from public info — confirm in the first call that they run *paying*
> agents and where the spend actually sits.

---

## Sana (Sana from Workday)

**What they do.** Stockholm-based enterprise AI assistant and agent platform (founder Joel
Hellermark). Companies build expert AI agents grounded in their own knowledge, no code.
100+ connectors / 50+ integrations (Google Workspace, M365, Slack, Notion, Confluence,
Jira, GitHub, Salesforce, HubSpot, Zendesk, …) with inherited permissions and a custom
connector SDK. Agents find, orchestrate and automate work across systems; the Self-Service
agent has 300+ HR/finance skills. **Acquired by Workday (announced 17 Mar 2026)** and now
marketed as "Sana from Workday"; enterprise security posture (SOC 2, ISO, EU residency).

**Where the spend sits.** Per-run LLM/inference; paid connectors / customer-specific data
APIs; compute per agent or per customer tenant — today typically on shared API keys with no
per-agent budget.

**Haven fit.** Lead with the budgeted wallet for the agents' own model/connector/compute
spend: per-agent on-chain limit, over-budget queues for approval, clean per-agent/per-tenant
attribution. Bookkeeping feed as the second hook. Non-custody sits cleanly next to their
SOC 2 / ISO / EU-residency story.

**Reg-fit.** `Own-spend ✓` — pays its own model/connector/compute suppliers within its own
limits. In scope.

**Entry note.** Post-acquisition, procurement likely runs through Workday. Enter via the
Sana Stockholm agent/platform team, not Workday central procurement.

**Tailored email**

```text
Subject: per-agent budget for Sana's AI agents

Hi [Name],

Sana's agents reach across 100+ connectors and run multi-step automations on
real data — which means they're already spending on models, paid connectors,
and compute on every run.

Most teams run that on shared API keys with no per-agent budget, so when an
agent loops or misfires there's no native limit, and finance can't tell which
agent (or customer tenant) drove the cost.

Haven gives each agent its own budget with on-chain limits, and the spend
appears in your bookkeeping tool automatically. You keep custody throughout —
Haven is non-custodial software, not a payment processor — which should sit
cleanly next to your SOC 2 / ISO / EU-residency posture.

Worth 20 minutes? I can show an agent pay for a live API under a budget you
set, end to end.

[Name]
```

---

## Epiminds

**What they do.** Swedish startup (founded 2025) building agentic AI for marketing. Core
product **Lucy** — an "AI marketing manager" coordinating 20+ specialised agents that handle
reporting, pacing, creative analysis, budget optimisation and campaign execution, sold to
marketing agencies. Founders Elias Malm (ex-Google) and Mo Elkhidir (ex-Spotify/Kry).
**$6.6M seed led by Lightspeed (Oct 2025)**; signed agencies covering 240+ brands within
~12 weeks.

**Where the spend sits.** Two layers: (1) the agents' own per-run spend on models and paid
marketing-data/analytics APIs — the clean fit; (2) ad-channel budgets — the headline
vision, but ad platforms bill in fiat via cards/invoices, not on-chain, so Haven is not the
ad-payment rail today.

**Haven fit.** Lead with the budgeted wallet for the agents' own API/model/compute spend
(in scope, acute as agent volume scales): per-agent on-chain limit, over-budget approval,
per-agent/per-client attribution + bookkeeping feed. Keep ad-channel spend as a "where we
could grow," not a same-day promise.

**Reg-fit.** `Confirm` — confirm it's the agency's/brand's *own* accounts and *own* budget,
not disbursing ad budgets on clients' behalf (the latter is payout/on-behalf territory and
out of scope). Also separate the steerable API/compute spend (Haven today) from fiat ad
spend (not our rail).

**Tailored email**

```text
Subject: cost guardrails for Lucy's agent team

Hi Elias,

Lucy coordinates 20+ agents across reporting, pacing and campaign work — each
one spending on models and paid marketing-data APIs on every run.

Today that typically runs on shared API keys with no per-agent budget, so a
looping or misfiring agent has no native limit, and it's hard to attribute
cost per agent or per client.

Haven gives each agent its own budget with on-chain limits — within budget it
just works, over budget it waits for your approval — and the spend appears in
your bookkeeping tool automatically. You keep custody throughout; Haven is
non-custodial software, not a payment processor.

(To be clear up front: this is for the API/model/compute spend your agents
incur — not for moving client ad budgets on their behalf.)

Worth 20 minutes? I can show an agent pay a live API under a budget you set,
end to end.

[Name]
```

---

## Legora

**What they do.** Swedish legal-AI platform (Stockholm, formerly Leya) — agentic AI for
lawyers: research case law, review contracts, analyse documents, draft across complex
matters. **~$5.6B valuation (Series D led by Accel, 2026), ~$100M ARR**, grown 40 → 400
people across Stockholm, London, New York, Denver, Sydney, Bengaluru. Customers include
Barclays, White & Case, Linklaters. Acquired Stockholm legal-research startup **Qura
(Apr 2026)**; NVIDIA's NVentures among Series D investors.

**Where the spend sits.** Metered per-query research/legal-data APIs (and their own Qura
research) plus model inference at serious volume. Note: much legal data is enterprise
flat-licensed, not per-call — the wedge is the genuinely metered per-query/inference spend.

**Haven fit.** Budgeted wallet per agent + verifiable receipt per payment; on-chain limit
per agent/matter, clean per-matter attribution, bookkeeping feed. Non-custody fits the
traceability bar their clients (Barclays, Linklaters) expect.

**Reg-fit.** `Own-spend ✓` — pays its own data/model suppliers within its own limits. In
scope.

**Entry note.** A $5.6B unicorn at ~$100M ARR — enterprise procurement, not a quick
design-partner handshake. Enter via a platform/infra or FinOps team with the "cost control +
per-agent attribution as agent volume explodes" angle. Reference value is top-tier.

**Tailored email**

```text
Subject: per-agent spend control as Legora's agent volume scales

Hi [Name],

Legora's agents research case law and review contracts at serious volume —
which means real, metered spend on research/data APIs and model inference on
every query.

At your scale that typically runs on shared keys with no per-agent budget, so
there's no native limit when an agent misfires and no clean per-matter or
per-agent attribution for finance.

Haven gives each agent its own budget with on-chain limits and a verifiable
receipt per payment, and the spend appears in your bookkeeping tool
automatically. You keep custody throughout — Haven is non-custodial software,
not a payment processor — which fits the traceability bar your clients expect.

Worth 20 minutes with whoever owns agent platform / FinOps? I can show an
agent pay a live API under a budget you set, end to end.

[Name]
```

---

## Sources

- Sana: [sanalabs.com](https://sanalabs.com/products/sana/) · [sana.ai](https://sana.ai/) ·
  [Workday newsroom (17 Mar 2026)](https://newsroom.workday.com/2026-03-17-Introducing-Sana-from-Workday-Superintelligence-for-Work-That-Finds-Answers,-Takes-Action,-and-Automates-Workflows)
- Epiminds: [epiminds.com](https://epiminds.com/) ·
  [ArcticStartup — $6.6M seed](https://arcticstartup.com/epiminds-raises-6-6-million-seed/) ·
  [Unite.AI](https://www.unite.ai/epiminds-raises-6-6m-to-build-autonomous-multi-agent-ai-marketing-teams/)
- Legora: [TechCrunch — $5.6B](https://techcrunch.com/2026/04/30/legal-ai-startup-legora-hits-5-6-valuation-and-its-battle-with-harvey-just-got-hotter/) ·
  [Crunchbase News](https://news.crunchbase.com/venture/unicorn-legal-tech-ai-startup-legora-triples-valuation/) ·
  [StartupDaily — Qura acquisition](https://startupdaily.news/2026/04/24/legora-snaps-up-stockholm-legal-research-startup-qura/)
