---
owner: "@d-hinders"
status: current
covers: []  # narrative — process playbook
last-verified: "2026-06-29"
---

# Money / agent-authority playbook

Loaded by `/ship-next` for `money-path` issues. **Stub — filled in [#655](https://github.com/d-hinders/Haven-AI/issues/655).**

When complete, this playbook will require, by reference: reading `docs/regulatory/casp-risk-guardrails.md` + its merge checklist first; characterization-tests-first for any change to existing money-path behavior; and the non-negotiables (no Haven-held keys, no API-key-only spend authority, no off-chain-only spend control, no mutation of signed amount/token/recipient/route). The **human merge gate stays** — money-path PRs never auto-merge (Phase 6).

Until #655 lands, follow `docs/regulatory/casp-risk-guardrails.md` directly.
