---
name: "🔁 Loop task (code-quality)"
about: A small, self-contained task for the autonomous PR loop (/ship-next). Auto-labeled code-quality so the loop picks it up.
title: ""
labels: ["code-quality"]
assignees: []
---

<!--
This issue feeds the autonomous PR loop (/loop /ship-next). It is picked up
automatically because of the `code-quality` label. Keep it small and
self-contained — one PR's worth of work. See docs/contributing/autonomous-pr-loop.md.
The loop will STOP and ask you to sharpen anything it can't implement safely,
so fill in Scope + Acceptance concretely.
-->

## Scope

<!-- One paragraph the implementer can act on WITHOUT guessing: state the change
AND its acceptance criteria. -->

## Acceptance criteria

<!-- The observable bar for "done". E.g.: new tests green; existing backend suite
+ `tsc --noEmit` unchanged; behavior unchanged. -->

-

## Files (best-effort ownership)

<!-- The file(s) this change should own. -->

-

## Surface

<!-- Check all that apply, AND add the matching label(s) so /ship-next can
classify deterministically and load the right playbook. See
docs/contributing/ship-playbooks/README.md. -->

- [ ] `area:frontend` — UI in packages/frontend
- [ ] `area:backend` — backend / API in packages/backend
- [ ] `area:sdk` — SDK / connect / API contract / credentials
- [ ] `area:mcp` — MCP server / signer / hosted MCP
- [ ] `area:docs` — docs only
- [ ] `money-path` — payments, agent authority, allowances, migrations

## Money-path?

<!-- The `money-path` Surface label above drives playbook routing; this section
drives the MERGE GATE (yes = human merge required). Set both consistently.
Check one. Money-path issues are implemented by the loop but NEVER
auto-merged — .github/CODEOWNERS routes them to a human merge, and any change to
existing money-path behavior must be characterization-tested first. -->

- [ ] No — docs / tests / non-money refactor (eligible for reviewer-gated auto-merge)
- [ ] Yes — touches x402 / machine-payments / payment-coverage / allowance / migrations (human merge required)
