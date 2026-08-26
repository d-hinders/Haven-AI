---
owner: "@d-hinders"
status: current
covers: []  # narrative — process playbook
last-verified: "2026-08-25" # #1992: the §2 example cited `modules/accounts/safe-deployer.ts` as a file in `casp-risk-guardrails.md`'s `covers:` list. It was never on that list (only the safe-deploy/user-safes ROUTES are) and #1988 has since deleted the module, so the example was doubly wrong. Removed; the surviving route examples are verified against the current covers list. Scope: that one sentence. Prior: #1904: §2 gained the recorded reasoning for why NO mechanical fifth-copy detector ships — three signals measured, all fail, and the failure is directional (they measure a copy's freshness, so they are silent on stale copies). §2 re-read in full for this pass; §§1, 3-5 untouched and NOT re-verified. Prior: #1892: §2's inline restatement of the money-path file list REMOVED, not corrected — it was a third copy, it contradicted this playbook's own "links, does not restate" line, and it had drifted (no re-key surface, no infra/chain, no infra/repositories, four rails/ files missing). §2 now points at .github/money-path-globs.json, the single CI-enforced perimeter. Only §2 was re-read; §§1, 3-5 untouched and NOT re-verified in this pass. Prior: #1228: real-DB characterization pointer added (§2) / testing-strategy rule added
---

# Money / agent-authority playbook

Loaded by `ship-next` for `money-path` issues (and any backend change touching the merge-gate money-path files). This is the highest-stakes surface — the playbook **links** the regulatory perimeter; it does not restate it.

## 1. Required reading (before implementing)

Read [`docs/regulatory/casp-risk-guardrails.md`](../../regulatory/casp-risk-guardrails.md) and its payment-code merge checklist first. It is the authoritative perimeter for every payment, agent-authority, Safe-setup, relaying, x402/MPP, fiat/card, swap, yield, or advice change.

## 2. Characterization-tests-first

For any change to **existing** behavior on a file matched by [`.github/money-path-globs.json`](../../../.github/money-path-globs.json) — the single, CI-enforced perimeter — pin the current behavior with a characterization test **before** changing it, as required by the canonical skill's [Implement section](../../../.agents/skills/ship-next/SKILL.md#implement). The test encodes the invariant the change must preserve. The annotated version, with the reasoning behind each group, is the skill's [Merge Gate](../../../.agents/skills/ship-next/SKILL.md#merge-gate); `scripts/ci/money-path.test.mjs` pins the two to each other in both directions.

This section used to restate the list inline, which contradicted the line at the top of this playbook and drifted exactly as that line predicts: it was missing the re-key surface (`routes/agent-rekey.ts`, live since #1698), `infra/chain/`, `infra/repositories/`, and four `rails/` files, so a re-key change read here as *not* needing a characterization test (#1892). A perimeter is maintainable in one place or in none.

**Nothing mechanically stops a fifth copy appearing, and that is a measured decision rather than an oversight (#1904).** #1899 sketched a general detector — count distinct perimeter basenames per tracked `.md`/`.yml`, fail above a threshold — and three variants of it were measured and rejected. The reason is not that the threshold is hard to tune: every such signal counts how much of the list a document *reproduces*, which measures the copy's **freshness**, not its existence. It is therefore loudest about a copy that is perfectly maintained and silent about one that has rotted, which is the only state that matters. Re-derive it with `node scripts/ci/money-path-restatement-scan.mjs --mutate`; that script is a reporting tool, never a gate, and its header carries the numbers. What Haven checks instead is **declarations**: a doc whose structured front matter says it is maintained against this list (today, `casp-risk-guardrails.md`'s `covers:`) is pinned in `scripts/ci/money-path.test.mjs`. Prose is not checked, and the defence against a prose copy remains the "links, does not restate" line at the top of this playbook plus the doc-reviewer pass.

For other files in `casp-risk-guardrails.md`'s `covers:` list (e.g. the passkeys / safe-deploy / user-safes routes — `infra/relayer.ts` was on this list of examples until #1607 put the relayer globs on the money-path list itself), the §1 required reading still applies — §2 scopes only the characterization-test requirement. **The regulatory `covers:` list is deliberately wider than the money-path list and is not the same question**; do not treat a difference between them as drift. Worth knowing which way that asymmetry runs, though: `casp-risk-guardrails.md` has covered `routes/agent-rekey.ts`, `modules/agents/rekey-*.ts` and `infra/repositories/agent-rekeys.ts` since #1736, while the money-path list carried none of them until #1892 — the regulatory perimeter was complete and the classification perimeter was not, so the wider list is a useful place to look when adding to the narrower one.

Where the invariant being pinned is **the database's behaviour** —
idempotency, locking, constraints, transactional integrity — the
characterization test belongs in a repository test on the real-Postgres
harness, not in a positional-mock route test:
[`testing-strategy.md`](../testing-strategy.md) (epic #1219) has the rule,
the layer map, and a worked example. The `lint:db-mocks` ratchet blocks the
mock pattern from growing back.

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
- the `qa-freshness` job in `dev-gate.yml` — a `dev → main` promotion is refused unless a green money-flow QA run on `dev` actually **covered** the money-path code being promoted ([#1030](https://github.com/d-hinders/Haven-AI/issues/1030)). Recency alone does not satisfy it — a run inside `QA_FRESHNESS_HOURS` (default 30h) still fails if money-path files changed after it — and a money-path `hotfix/* → main` blocks outright, because a hotfix is deployed nowhere until it merges. **Read the limits before relying on it**, and read them at the source: "Be precise about what gate 2 proves" in [`autonomous-pr-loop.md`](../autonomous-pr-loop.md), which enumerates them and every path that fails closed.

The in-session pause this section used to describe covered only pull requests opened through `ship-next`; a hand-written money-path pull request merged on green CI alone. It was friction on the compliant path with no compensating protection on the other, and the approver was typically the author. Verification moved to promotion time, where it is automatic. See "Money-path safety model" in [`autonomous-pr-loop.md`](../autonomous-pr-loop.md).

**This does not relax sections 1–3.** The characterization-test requirement, the CASP guardrails, and the "never do this" list above are unchanged — the bar for *writing* money-path code is the same; only the merge routing changed.
