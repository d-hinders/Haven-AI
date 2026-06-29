---
owner: "@d-hinders"
status: current
covers:
  - .claude/commands/ship-next.md
  - .github/labels.yml
last-verified: "2026-06-29"
---

# Ship-next playbooks

`/ship-next` is the default way to ship anything defined as a GitHub issue. It
**routes, it does not contain**: it classifies the issue's surface, then loads
the matching *playbook* — a small file that links the standards, checks, and
agents for that surface. Playbooks link the canonical docs; they never copy
them (that would drift — see [`docs-quality-system.md`](../docs-quality-system.md)).

Epic: [#651](https://github.com/d-hinders/Haven-AI/issues/651).

## Surface taxonomy

Classification is driven by **labels first** (applied to the issue), with the
**files the change touches** as a fallback/confirmation. The labels live in
[`.github/labels.yml`](../../../.github/labels.yml) and are synced to the repo by
`.github/workflows/labels.yml`.

| Label | Surface | Playbook |
|---|---|---|
| `area:frontend` | UI in `packages/frontend` | `frontend.md` |
| `area:backend` | backend / API in `packages/backend` | `backend.md` |
| `area:sdk` | SDK / connect / API contract / credentials | `sdk.md` |
| `area:mcp` | MCP server / signer / hosted MCP | `sdk.md` |
| `area:docs` | docs only | `docs.md` → [`docs-quality-system.md`](../docs-quality-system.md) |
| `money-path` | payments, agent authority, allowances, migrations | `money.md` |

An issue may carry several surface labels; the skill loads each matching
playbook. `money-path` always keeps the human merge gate.

## How a run uses these

1. **Classify** (skill Phase 1.5): read the issue's `area:*` / `money-path`
   labels; if absent, infer from the files the change will touch.
2. **Load** only the matching playbook(s) — not all of them, so each run stays
   cheap.
3. **Apply** the playbook's required reading + checks + agents, and record in
   the PR that they were applied.

## Status

Phase 1.5 routing and all five playbook files are live and complete
(`frontend.md`, `backend.md`, `sdk.md`, `money.md`, `docs.md`). New checks land
**advisory** first, then graduate to blocking once trusted. The remaining epic
work ([#656](https://github.com/d-hinders/Haven-AI/issues/656)) wires the
cross-surface closeout (populated PR template + preflight) into the skill.
