# AI Review Patterns

Use this as shared memory for PR review feedback that was worth fixing. Keep it pattern-based, not PR-based, so future agents can apply it to new surfaces.

## Data Semantics

- Keep raw and formatted values separate. Raw amounts, ids, hashes, timestamps, and addresses should not be replaced with display strings.
- Treat totals, counts, pagination, and dashboard summaries as derived contracts. If rows are merged, filtered, or deduped on the client, verify that counts still mean what the UI says they mean.
- Do not render fallback activity rows with missing safe, wallet, chain, recipient, or source identifiers unless the empty value is intentional and explained in the UI.

## Status And State Transitions

- New statuses need end-to-end support: database constraints or migrations, backend validation, shared types, frontend labels, filters, notifications, tests, and empty states.
- Error copy must describe the state after the action already taken. If a backend row was saved as approved, do not tell the user the request is still waiting for review.
- Approved, proposed, submitted, executed, rejected, cancelled, and expired states should be visually and behaviorally distinct when they lead to different next actions.

## API And Hook Contracts

- Avoid optional hook or function arguments when missing values make the old call compile but fail at runtime. Make required context required in TypeScript.
- Audit all callers after changing hook signatures, response fields, status values, or API payloads.
- Prefer explicit response fields over matching on free-text reason strings. If a free-text fallback is necessary, document it as temporary.

## Async UX And Modals

- Primary action hierarchy should match the next useful action. A "Close" button should not be visually stronger than the action the copy asks the user to take.
- Disabled actions should explain what is missing, and labels should not flicker between meanings while prerequisite data is loading.
- Modal content should fit normal laptop screens when practical. If more information is needed, prefer a step, disclosure, or detail surface over forcing scroll.
- Check z-index, backdrop, close, Escape, and unsaved-work behavior for modals that contain required actions or wallet/signing controls.

## Recipient And Form Behavior

- Do not hijack typing with eager exact-name matching or autocomplete side effects. Suggestions should be committed by an explicit user action or a clearly bounded blur behavior.
- Client-side duplicate checks should be backed by server-side uniqueness or a clear API error.
- Network and chain context should be visible before a user sends or receives funds, especially when saved contacts are chain-neutral.

## Shared UI And Cross-Surface Consistency

- If the same movement, transaction row, status badge, contact row, or money summary appears in multiple places, prefer one shared component or utility.
- Keep dashboard, account detail, agent detail, transaction history, approvals, and design-system examples aligned after changing shared presentation.
- If a temporary frontend shim or preview backfill is added, label it clearly and avoid letting it redefine backend-owned totals or durable semantics.

## Test Gaps Worth Catching

- Add tests for changed non-happy states: loading, empty, error, proposed/submitted, approved-but-not-executed, expired, cancelled, and duplicate cases.
- For money movement, test the selected account, selected chain, selected token, recipient, and signer context rather than only the happy path rendering.
- If review feedback finds a bug that survived tests, add or update the smallest regression test that would have caught it.
