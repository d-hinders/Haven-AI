---
name: "📦 Loop epic"
about: A multi-PR plan for the autonomous ship-next workflow. Add sub-issues, then run ship-next epic=#<this>.
title: "Epic: "
labels: ["epic"]
assignees: []
---

<!--
An epic is a parent issue whose SUB-ISSUES are the loop's queue. Drive it with
`ship-next epic=#<this-issue>` and repeat it with the client's loop capability
when available. The workflow takes the open sub-issues
lowest-number-first and closes each with `Closes #`, so the epic burns down on
its own. A sub-issue shipped in operator-verify mode is the exception: it is
labelled `operator-verify`, its PR writes `Refs #` and it stays open until a
human finishes the live step, so the epic will not burn that line down for you. You do NOT also need the `code-quality` label on the sub-issues; that
label is for the standalone queue. See docs/contributing/autonomous-pr-loop.md.
-->

## Goal

<!-- What this epic delivers and why it's more than one PR. -->

## Sub-issues (the queue, in order)

<!-- Create each as its own issue (well-scoped: scope + acceptance + files +
money-path), then add it as a sub-issue of this one. List them here for
visibility. -->

- [ ] #
- [ ] #

## Surface(s)

<!-- The union of surfaces the sub-issues touch. Apply the matching label(s) to
each sub-issue (not the epic) so ship-next routes per PR. See
docs/contributing/ship-playbooks/README.md. -->

- [ ] `area:frontend`
- [ ] `area:backend`
- [ ] `area:sdk`
- [ ] `area:mcp`
- [ ] `area:docs`
- [ ] `money-path`

## Promotion checklist

<!-- Owner decision 2026-09-08 (#2767). Two kinds of box, every one unticked when
the epic is filed, each naming WHERE it is done (a dashboard, a runbook step, a
repo variable, a QA scenario): (1) the operator steps the epic depends on — the
sub-issues' operator-verify steps, collected here; (2) the epic's product
verification — which runbook or QA scenario is run on `dev`, by whom, before
promotion. `new-task` writes this section from the slices' operator-step notes.
ship-next's closeout reports the epic "ready to close" only when every box here
is ticked (`node scripts/ci/epic-promotion-checklist.mjs`), and otherwise lists
the unticked ones; the epic stays open across the promotion until a human ticks
the last box. -->

- [ ] Operator step: <what> — done in <where>
- [ ] Product verification on `dev`: <runbook or QA scenario> — run by <whom>

## Notes

<!-- Shared context, invariants to preserve, money-path callouts, etc. -->
