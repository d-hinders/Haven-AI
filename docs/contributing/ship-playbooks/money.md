---
owner: "@d-hinders"
status: current
covers: []  # narrative — process playbook
last-verified: "2026-07-27"
---

# Money / agent-authority playbook

Loaded by `ship-next` for `money-path` issues (and any backend change touching the merge-gate money-path files). This is the highest-stakes surface — the playbook **links** the regulatory perimeter; it does not restate it.

## 1. Required reading (before implementing)

Read [`docs/regulatory/casp-risk-guardrails.md`](../../regulatory/casp-risk-guardrails.md) and its payment-code merge checklist first. It is the authoritative perimeter for every payment, agent-authority, Safe-setup, relaying, x402/MPP, fiat/card, swap, yield, or advice change.

## 2. Characterization-tests-first

For any change to **existing** money-path behavior (`routes/x402.ts`, `routes/x402-resources.ts`, `routes/payments.ts`, `routes/machine-payments.ts`, `lib/{machine-payments,payment-coverage,allowance-module}.ts`, the rail seam `lib/execution-rail.ts`, the delegation rail `lib/delegation-*.ts` / `lib/hybrid-provisioning.ts` / `lib/hybrid-account-config.ts` / `routes/agent-delegations.ts`, `packages/sdk/src/signer.ts`, `middleware/agentAuth.ts`, `db/migrations/`), pin the current behavior with a characterization test **before** changing it, as required by the canonical skill's [Implement section](../../../.agents/skills/ship-next/SKILL.md#implement). The test encodes the invariant the change must preserve.

For other files in `casp-risk-guardrails.md`'s `covers:` list (e.g. `lib/relayer.ts`, `lib/safe-deployer.ts`, the passkeys / safe-deploy / user-safes routes), the §1 required reading still applies — §2 scopes only the characterization-test requirement.

## 3. Non-negotiables (CASP)

The change must not, and generated artifacts must not imply Haven can:

- hold user or agent **private keys**;
- make an **API credential sufficient to spend** (the on-chain allowance is the real control);
- rely on **off-chain policy** as the real spend control;
- mutate **signed payment intent** (amount, token, recipient, route);
- operate swaps / ramps / fiat / card / merchant settlement / yield / advice flows **without review**;
- prevent users from accessing and **revoking** Safe permissions outside Haven.

## 4. Merge gate (automatic, not a prompt)

A money-path pull request auto-merges on green CI and a clean independent review, exactly like any other — **except a migration**, which needs an independent code-owner approval in GitHub (`.github/CODEOWNERS`; the author's own approval does not count).

What protects the money path is enforced by machine and applies to **every** pull request, however it was opened ([#1024](https://github.com/d-hinders/Haven-AI/issues/1024)):

- `.github/CODEOWNERS` — irreversible schema changes;
- the `qa-freshness` job in `dev-gate.yml` — a `dev → main` promotion is refused without a green money-flow QA run on `dev` inside `QA_FRESHNESS_HOURS` (default 30h). **Read the limits before relying on it:** the check is time-based, not bound to the promoted SHA, and does not cover `hotfix/* → main` at all. See "Be precise about what gate 2 proves" in [`autonomous-pr-loop.md`](../autonomous-pr-loop.md).

The in-session pause this section used to describe covered only pull requests opened through `ship-next`; a hand-written money-path pull request merged on green CI alone. It was friction on the compliant path with no compensating protection on the other, and the approver was typically the author. Verification moved to promotion time, where it is automatic. See "Money-path safety model" in [`autonomous-pr-loop.md`](../autonomous-pr-loop.md).

**This does not relax sections 1–3.** The characterization-test requirement, the CASP guardrails, and the "never do this" list above are unchanged — the bar for *writing* money-path code is the same; only the merge routing changed.
