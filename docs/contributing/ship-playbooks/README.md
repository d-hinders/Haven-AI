---
owner: "@d-hinders"
status: current
covers:
  - .agents/skills/ship-next/SKILL.md
  - .github/labels.yml
last-verified: "2026-08-04"
---

# Ship-next playbooks

The canonical `ship-next` skill is the **default route** for shipping a GitHub
issue — the fastest way through the standards, not a mandate ([#1025](https://github.com/d-hinders/Haven-AI/issues/1025)).
It **routes, it does not contain**: it classifies the issue's surface, then loads
the matching *playbook* — a small file that links the standards, checks, and
agents for that surface. Playbooks link the canonical docs; they never copy
them (that would drift — see [`docs-quality-system.md`](../docs-quality-system.md)).

> **Default, not mandate.** The mechanical standards are **CI required checks**
> and apply to every pull request however it was opened — see the ruleset
> inventory in [`autonomous-pr-loop.md`](../autonomous-pr-loop.md). What this
> skill adds on top is judgement work no check performs: playbook routing, the
> independent review passes, the `covers:` doc-reviewer step, and closeout
> evidence. A contributor who prefers another workflow is free to use it and
> **owns an equivalent review themselves** — say so in the pull request. There
> is deliberately no check for whether the skill was used.

Epic: [#651](https://github.com/d-hinders/Haven-AI/issues/651).

## Surface taxonomy

Classification is driven by **labels first**, with the **files the change
touches** as a fallback/confirmation. Labels are applied two ways:

- **PRs are auto-labeled by changed path** — `.github/workflows/labeler.yml`
  (`actions/labeler`, config in [`.github/labeler.yml`](../../../.github/labeler.yml))
  applies `area:*` / `money-path` from the paths the PR touches. This is the
  authoritative signal for what a change actually is, and surfaces the money path
  on every PR. It's additive — a manually-applied label is never stripped.
- **Issues can be labeled manually** (the template's Surface checklist) for the
  pre-implementation hint, before any files exist.

The labels themselves live in [`.github/labels.yml`](../../../.github/labels.yml)
and are synced to the repo by `.github/workflows/labels.yml`.

| Label | Surface | Playbook |
|---|---|---|
| `area:frontend` | UI in `packages/frontend` | `frontend.md` |
| `area:backend` | backend / API in `packages/backend` | `backend.md` |
| `area:sdk` | SDK / connect / API contract / credentials | `sdk.md` |
| `area:mcp` | MCP server / signer / hosted MCP | `sdk.md` |
| `area:docs` | docs, **plus any diff touching `covers:`-mapped code** | `docs.md` → [`docs-quality-system.md`](../docs-quality-system.md) |
| `money-path` | payments, agent authority, allowances, migrations | `money.md` |

An issue may carry several surface labels; the skill loads each matching
playbook. `money-path` selects `money.md` and its characterization-test bar; since #1024 it no longer pauses the merge — only migrations stay hard-gated.

## How a run uses these

1. **Classify** in the canonical skill's [Prepare section](../../../.agents/skills/ship-next/SKILL.md#prepare): read the issue's `area:*` / `money-path`
   labels; if absent, infer from the files the change will touch.
2. **Load** only the matching playbook(s) — not all of them, so each run stays
   cheap.
3. **Apply** the playbook's required reading + checks + agents, and record in
   the PR that they were applied.

## Status

Surface routing and all five playbook files are live and complete
(`frontend.md`, `backend.md`, `sdk.md`, `money.md`, `docs.md`), and the skill's
cross-surface closeout — the Captain Self-Check Preflight before review, the
standard doc-accuracy step, and a PR body filled from the template — is wired in.
New checks land **advisory** first, then graduate to blocking once trusted.
