---
name: new-task
description: Capture a freeform Haven task as a well-scoped GitHub backlog issue with concrete acceptance criteria, likely files, surface labels, and money-path classification. Use when a user asks to create, record, file, or queue a new Haven task or issue; ship only when explicitly requested.
---

# New Task

Turn a freeform request into a loop-ready GitHub issue without implementing it.

## Workflow

1. Inspect the repository just enough to anchor the scope, likely files, and existing patterns. Use a read-only explorer role from [haven-agent-workflow](../haven-agent-workflow/SKILL.md) for non-trivial work.
2. Classify every affected surface using `area:frontend`, `area:backend`, `area:sdk`, `area:mcp`, `area:docs`, and `money-path`. Confirm money-path classification against [ship-next](../ship-next/SKILL.md).
3. Ask one or two focused questions when scope, acceptance, or surface is ambiguous. Always ask before defining acceptance for money movement, authentication, authorization, or schema work.
4. Draft the body using [the loop-task template](../../../.github/ISSUE_TEMPLATE/loop-task.md):
   - **Scope**: one actionable paragraph.
   - **Acceptance criteria**: observable completion conditions.
   - **Files**: best-effort ownership.
   - **Surface**: checked surface labels.
   - **Money-path?**: explicit Yes or No.
5. Check GitHub for a materially duplicate open issue.
6. Create the issue with the available GitHub integration. If no integration is available, use an authenticated `gh` CLI.
7. Apply every inferred `area:*` label and `money-path` when applicable. Assign the requester when their GitHub identity is discoverable.
8. Return the issue link and applied labels.

## Backlog And Shipping

- Default to backlog-only: do not add `code-quality`.
- When the requester passes `--ship` or clearly asks to ship now, add `code-quality` and continue with [ship-next](../ship-next/SKILL.md).
- To queue an existing backlog issue later, add `code-quality` or make it an epic sub-issue.

## Guardrails

- Do not fabricate requirements for money-path, authentication, authorization, or schema tasks.
- Keep generated and hand-written loop issues interchangeable.
- Prefer an editable, correctly shaped issue over speculative implementation detail.
