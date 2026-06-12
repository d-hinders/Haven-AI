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
| [`architecture/`](architecture/README.md) | System diagrams and contracts (Mermaid is canonical). | How identity, custody, payments, x402, and MCP actually flow through the code. |
| [`product/`](product/README.md) | UX doctrine, design system, copy guidelines, screen recipes, review checklist. | Anything user-facing — visual system, terminology, and product UX rules. |
| [`contributing/`](contributing/ai-agent-workflow.md) | How we build: agentic workflow, review patterns, PR checklist, code-quality program. | Process for shipping changes and keeping PRs reviewable. |
| [`operations/`](operations/hosted-mcp.md) | Deploying and running the hosted MCP server, runtime compatibility, and the local→hosted migration. | Production deployment and runtime setup. |
| [`regulatory/`](regulatory/casp-risk-guardrails.md) | CASP / MiCA non-custodial guardrails and the payment-code merge checklist. | The compliance perimeter every payment change must respect. |
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
- [Code-quality roadmap](contributing/code-quality-roadmap.md) and [running loop](contributing/code-quality-loop.md)

**Operations**
- [Deploy the hosted MCP server](operations/hosted-mcp.md)
- [MCP runtime compatibility](operations/mcp-runtime-compatibility.md)
- [Migrate local → hosted MCP](operations/local-to-hosted-mcp.md)

**Regulatory**
- [CASP / MiCA risk guardrails](regulatory/casp-risk-guardrails.md)

## Conventions

- File and folder names are lowercase `kebab-case`. The exception is each
  folder's `README.md` index.
- Architecture diagrams are authored in Mermaid inside the markdown; PNG/SVG
  exports are regenerated from it (see [architecture/README.md](architecture/README.md)).
- When work ships, move its point-in-time plan/handoff into `archive/` with an
  `ARCHIVED` banner rather than leaving it beside current docs.
