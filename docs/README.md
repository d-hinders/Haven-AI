---
owner: "@d-hinders"
status: current
covers:
  - docs/contributing/docs-quality-system.md
last-verified: "2026-10-25"
---

# Haven Documentation

Start here. This folder is the engineering and product reference for Haven. Each
subfolder owns one concern; the tables below say what is authoritative and where
to look.

For the product vision and design principles, read [`CLAUDE.md`](../CLAUDE.md)
and [`ABOUT_HAVEN.md`](../ABOUT_HAVEN.md) at the repo root first — the docs here
describe how the system is actually built and how we work on it.

## Map

| Folder | What lives here | Authoritative for |
|---|---|---|
| [`architecture/`](architecture/README.md) | System diagrams and contracts (Mermaid is canonical where a doc carries it). | How identity, custody, payments, x402, and MCP actually flow through the code. |
| [`product/`](product/README.md) | UX doctrine, design system, copy guidelines, screen recipes, review checklist. | Anything user-facing — visual system, terminology, and product UX rules. |
| [`contributing/`](contributing/ai-agent-workflow.md) | How we build: agentic workflow, the autonomous PR loop and its ship playbooks, review patterns, PR checklist, the docs-quality system and the testing strategy. | Process for shipping changes and keeping PRs reviewable. |
| [`operations/`](operations/hosted-mcp.md) | Runbooks for deploying and running Haven: the hosted MCP server and runtime compatibility, the dev environment and Railway, QA and evals, promotion and release, and the operator jobs (accounting feed, catalog ingestion, alarms). | Production deployment, runtime setup and operator procedures. |
| [`regulatory/`](regulatory/casp-risk-guardrails.md) | CASP / MiCA non-custodial guardrails, the payment-code merge checklist, and the dated CASP changelog (`casp-changelog/`). | The compliance perimeter every payment change must respect. |
| [`security/`](security/delegation-rail-security-model.md) | The delegation rail's security model and the hosted merchant-egress policy. | What the rail and the hosted server do and do not protect against. |
| [`exit/`](exit/README.md) | How an account holder inspects and revokes agent budgets without Haven. | The non-custody exit guarantee. |
| [`quality/`](quality/scan-ledger.md) | The append-only `quality-scan` ledger, and the per-issue classification behind the 2026-09 issue retrospective. | What each quality scan found and how it was disposed of. |
| [`bug-reports/`](bug-reports/_run-report-template.md) | Dated QA run reports and quality-scan reports, plus the run-report template. | What a run observed on the day — a record, not current state. |
| [`backlogs/`](backlogs/README.md) | A redirect (the loop's backlog moved to GitHub Issues) and one retired YAML track kept as a record. | Nothing current — see the autonomous PR loop. |
| [`research/`](research/README.md) | Forward-looking investigations and decision aids, often with a prototype spec. | Where a part of the system *could* go — options and recommendations, not current contracts. |
| [`archive/`](archive/README.md) | Shipped designs and point-in-time artifacts, frozen for context. | Historical rationale only — never current state. |

## Quick links

**Architecture**
- [Overview — the whole stack at a glance](architecture/00-overview.md)
- [System context & trust boundaries](architecture/01-system-context.md)
- [Identity & custody map](architecture/02-identity-and-custody.md)
- [Payment execution sequence](architecture/03-payment-sequence.md)
- [x402 payment sequence](architecture/04-x402-payment-sequence.md)
- [Agent API (OpenAPI) contract](architecture/05-agent-api-openapi.md)
- [Hosted MCP connect flow](architecture/06-hosted-mcp-connect-flow.md)
- [Local vs hosted MCP](architecture/08-local-vs-hosted-mcp.md)
- [Rail-agnostic fee module](architecture/09-fee-module.md)

**Product / UX**
- [Product & UX guide (start)](product/README.md)
- [Design system](product/design-system.md)
- [Copy guidelines (authoritative for wording)](product/copy-guidelines.md)
- [Screen recipes](product/screen-recipes.md)
- [Design review checklist](product/design-review.md)

**Contributing**
- [Agentic delivery workflow](contributing/ai-agent-workflow.md)
- [Recurring review patterns](contributing/ai-review-patterns.md)
- [PR workflow checklist](contributing/pr-workflow-checklist.md)
- [Code-quality discovery method](../.agents/skills/quality-scan/references/discovery-method.md) — the `quality-scan` skill's reference (redirect stub at [contributing/code-quality-loop.md](contributing/code-quality-loop.md))
- [Documentation-quality system](contributing/docs-quality-system.md)
- [Branch & release flow (dev → prod, issue lifecycle)](contributing/branch-and-release-flow.md)

**Operations**
- [Deploy the hosted MCP server](operations/hosted-mcp.md)
- [MCP runtime compatibility](operations/mcp-runtime-compatibility.md)
- [Migrate local → hosted MCP](operations/local-to-hosted-mcp.md)
- [Dev environment (Railway + Vercel, `dev` branch)](operations/dev-environment.md)
- [Railway service settings and cost](operations/railway-services.md)
- [Automated agent QA (local + GitHub Actions)](operations/agent-qa.md)
- [E2E QA runbook (agent connection & x402)](operations/e2e-qa-runbook.md)
- [qa-explore-ui cadence (recurring UX discovery → backlog)](operations/qa-explore-ui-cadence.md)

**Regulatory**
- [CASP / MiCA risk guardrails](regulatory/casp-risk-guardrails.md)

**Research**
- [Smart-account-native x402 settlement](research/x402-smart-account-settlement.md)

## Conventions

- File and folder names are lowercase `kebab-case`. The exceptions are each
  folder's `README.md` index and `bug-reports/`, where some run reports carry a UTC
  timestamp prefix (`2026-10-14T135237Z-…`) and the template is
  `_run-report-template.md`.
- Where an architecture doc carries a diagram in Mermaid, the Mermaid inside the
  markdown is canonical and the PNG/SVG exports are regenerated from it (see
  [architecture/README.md](architecture/README.md)).
- When work ships, move its point-in-time plan/handoff into `archive/` with an
  `ARCHIVED` banner rather than leaving it beside current docs.
