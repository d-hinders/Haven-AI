# Haven AI UX Review

Use this checklist before finishing any Haven UI task. It is written for AI implementers and reviewers, so each item should be checked against the actual changed screen, not just the code diff.

## Product Clarity

- The screen has one obvious primary action.
- The user can tell what happens next.
- First-run or onboarding-adjacent screens show only the next useful action and the minimum context needed for it; they do not expose normal dashboard density, empty management panels, or multi-step setup tours by default.
- Money-moving or authority-changing screens answer:
  - Who can spend?
  - From which Haven wallet?
  - How much?
  - On what or for whom?
  - When is approval required?
  - What happened already?
  - How can the user pause, revoke, reject, or stop it?
- Agent authority is described as constrained by `agent rules` or an `agent budget`.
- Haven never appears to have custody or unrestricted spending authority.

## Visual System

- Existing primitives in `packages/frontend/src/components/ui` are reused before adding new styles.
- Haven-domain components in `packages/frontend/src/components/haven` are reused for agent budget, wallet identity, approvals, and risk explanations.
- Activity and history surfaces reuse `AgentActivityRow` or `TransactionActivityRow` before creating one-off transaction rows.
- Cards, buttons, inputs, shadows, radii, and typography match `docs/design_system/DESIGN_SYSTEM.md`.
- No new gradient buttons, glow shadows, dark app surfaces, or one-off card styles were introduced.
- Dense app surfaces use compact headings and readable spacing, not marketing hero typography.

## Copy And Terminology

- Primary product UI uses `Haven account`, `Haven wallet`, `agent rules`, `agent budget`, `connect your agent`, and `approve actions`.
- Technical terms are hidden unless the surface is advanced, account detail, transaction detail, or developer-facing.
- Error copy explains the next useful action.
- Empty states include a clear next step.
- Loading states preserve layout and do not look broken.

Run these checks when relevant:

```sh
rg -i "policy engine|safe deployed|relayer|allowance module|session key|owner type|enroll signer|generate credentials|hand the credential|drop the credential" packages/frontend/src/app packages/frontend/src/components
rg -n "bg-gradient-to-r from-indigo|from-indigo-500 to-violet-600|bg-gray-|text-gray-|dark:" packages/frontend/src/app packages/frontend/src/components
```

Any remaining matches should be deliberate technical disclosure, developer copy, tests, or legacy content outside the touched surface.

## Responsive And States

- Mobile uses one column and does not hide the money/risk summary.
- Touch targets are at least 44px where practical.
- Text does not overflow buttons, cards, rows, or modal panels.
- Empty, loading, error, success, and long-content states are handled when the screen can enter them.
- Modal and overlay flows support Escape and focus-visible states unless an irreversible execution step intentionally blocks dismissal.

## Final Verification

- Inspect `/design-system` when adding or changing shared UI patterns.
- Check at least one desktop and one mobile viewport for changed screens.
- Run relevant frontend tests or `npm run build -w packages/frontend` when practical.
