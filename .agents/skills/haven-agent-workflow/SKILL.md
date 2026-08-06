---
name: haven-agent-workflow
description: Coordinate Haven feature, bug-fix, UX, payment, SDK, and documentation work through scoped explorer, worker, reviewer, and documentation-review roles. Use for non-trivial Haven implementation or review tasks where delegated discovery, bounded ownership, independent review, or merge-readiness checks improve delivery quality.
---

# Haven Agent Workflow

Keep one captain responsible for product judgment, shared files, git, integration, verification, and closeout. Delegate only bounded work with explicit ownership.

## Choose Roles

Read the applicable role reference completely before delegating or performing that role:

- [Workflow coordinator](references/workflow-coordinator.md): choose roles, ownership, sequencing, checks, and risks for non-trivial work.
- [Explorer](references/explorer.md): map files, patterns, constraints, tests, and cross-surface risks without editing.
- [UI worker](references/ui-worker.md): implement one explicitly owned frontend slice.
- [Backend worker](references/backend-worker.md): implement one explicitly owned backend, SDK, MCP, API, policy, or test slice.
- [Reviewer](references/reviewer.md): perform findings-first product, security, regression, UX, and test review.
- [Documentation reviewer](references/doc-reviewer.md): check whether changed behavior invalidates covered documentation.

When the client supports subagents, delegate the role with its reference and a narrow task. Otherwise use the same reference for a separate, explicitly scoped pass in the captain session.

## Delegation Contract

For every worker, state:

- goal and acceptance criteria;
- exact files it may edit or create;
- files and gravity surfaces it must not touch;
- checks it should run;
- required report contents.

Do not assign overlapping writes. Workers report required shared changes instead of expanding scope. The captain integrates, reviews, and owns all git mutations.

Follow [the full Haven agent workflow](../../../docs/contributing/ai-agent-workflow.md) and the repository instructions in `AGENTS.md`. Load product, regulatory, and surface playbooks only when the task triggers them.

## Closeout

Before completing non-trivial work:

1. Run the surface-specific Captain Self-Check Preflight.
2. Run an independent reviewer pass for user-facing UX, money movement, agent authority, shared behavior, public contracts, generated artifacts, or meaningful risk.
3. Run documentation coupling and documentation review when mapped behavior changed.
4. Report checks, review coverage, risk, why the change is safe, residual risk, and merge order.
