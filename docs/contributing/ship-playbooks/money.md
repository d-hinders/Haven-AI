---
owner: "@d-hinders"
status: current
covers: []  # narrative — process playbook
last-verified: "2026-06-29"
---

# Money / agent-authority playbook

Loaded by `/ship-next` for `money-path` issues (and any backend change touching the Phase 6 money-path files). This is the highest-stakes surface — the playbook **links** the regulatory perimeter; it does not restate it.

## 1. Required reading (before implementing)

Read [`docs/regulatory/casp-risk-guardrails.md`](../../regulatory/casp-risk-guardrails.md) and its payment-code merge checklist first. It is the authoritative perimeter for every payment, agent-authority, Safe-setup, relaying, x402/MPP, fiat/card, swap, yield, or advice change.

## 2. Characterization-tests-first

For any change to **existing** money-path behavior (`routes/x402.ts`, `routes/x402-resources.ts`, `routes/payments.ts`, `routes/machine-payments.ts`, `lib/{machine-payments,payment-coverage,allowance-module}.ts`, `middleware/agentAuth.ts`, `db/migrations/`), pin the current behavior with a characterization test **before** changing it (skill Phase 2). The test encodes the invariant the change must preserve.

## 3. Non-negotiables (CASP)

The change must not, and generated artifacts must not imply Haven can:

- hold user or agent **private keys**;
- make an **API credential sufficient to spend** (the on-chain allowance is the real control);
- rely on **off-chain policy** as the real spend control;
- mutate **signed payment intent** (amount, token, recipient, route);
- operate swaps / ramps / fiat / card / merchant settlement / yield / advice flows **without review**;
- prevent users from accessing and **revoking** Safe permissions outside Haven.

## 4. Merge gate (unchanged — human in the loop)

Money-path PRs **never auto-merge.** Phase 6 routes them to an in-session approval (`AskUserQuestion`); a **migration** additionally needs an independent code-owner review in GitHub (`.github/CODEOWNERS`). This playbook does not relax that gate — it reaffirms it.
