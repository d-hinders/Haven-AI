---
name: "📦 Loop epic"
about: A multi-PR plan for the autonomous PR loop. Add sub-issues, then run /loop /ship-next epic=#<this>.
title: "Epic: "
labels: ["epic"]
assignees: []
---

<!--
An epic is a parent issue whose SUB-ISSUES are the loop's queue. Drive it with
`/loop /ship-next epic=#<this-issue>` — the loop takes the open sub-issues
lowest-number-first and closes each with `Closes #`, so the epic burns down on
its own. You do NOT also need the `code-quality` label on the sub-issues; that
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
each sub-issue (not the epic) so /ship-next routes per PR. See
docs/contributing/ship-playbooks/README.md. -->

- [ ] `area:frontend`  [ ] `area:backend`  [ ] `area:sdk`  [ ] `area:mcp`  [ ] `area:docs`  [ ] `money-path`

## Notes

<!-- Shared context, invariants to preserve, money-path callouts, etc. -->
