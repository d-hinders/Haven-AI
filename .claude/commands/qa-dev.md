---
description: "Exploratory agent-driven QA against the dev environment — connects the real Haven MCP with the dev QA credentials, drives natural-language payment goals through the live tool surface, and writes a docs/bug-reports/ run report. Non-gating (Layer 2b, #577); testnet/dev-only."
---

Run an exploratory QA pass as the agent, using **this session's own model** (no separate API key), against the **shared dev** Haven stack. This is **Layer 2b** of the QA epic (#573): it exercises the **real Haven MCP tool surface** customers use — catching protocol/runtime/UX bugs the deterministic harness (Layer 2a) can't — and is **non-gating** (LLM nondeterminism never blocks a deploy).

**Safety:** dev/testnet only (Base Sepolia), using the **capped QA delegate**. Only revocable QA credentials are used; the connector never exposes a Safe owner key. Never run this against prod.

## Phase 1 — Connect (or confirm) the dev QA setup

1. If a Haven MCP is **already connected to the QA agent on dev**, use it — confirm with `claude mcp list` (both `haven` and `haven-signer` connected). Skip to Phase 2.
2. Otherwise connect the QA setup with the connector pinned to the alpha tag, pointed at the **dev backend**:
   `npx @haven_ai/connect@alpha --setup <QA setup token> --api <dev backend URL>`
   (The QA setup token + dev backend URL are owner-provisioned — see `docs/operations/agent-qa.md` "QA identity, funding & secrets". If you don't have them, stop and ask; do not invent credentials.)
3. If the signer fails to connect or you need a clean slate, run `/haven-reset` first, then retry step 2.

## Phase 2 — Confirm wiring (do not skip)

4. `haven_get_agent` → returns the QA agent identity + readiness. Confirm it is the **dev QA** agent, not a real one.
5. `haven_get_allowances` → shows the budget and **live remaining** for the capped QA token. Note the remaining amount — Phase 3 goals depend on it.

If either call fails or returns a non-dev/uncapped identity, **stop and report** — do not move money against an unexpected agent.

## Phase 3 — Drive the goals (natural language, real tools)

Run each goal through the actual tools. Record the outcome (pass/fail + what you observed) as you go.

6. **Within-budget payment** — pay the demo-merchant x402 call for an amount **within** the remaining budget (`haven_pay_x402`). Expect: it **settles** and a receipt is produced.
7. **Over-budget** — use direct `haven_pay` for an amount **larger than the
   remaining budget**. Expect: it is **queued for approval, not executed** (no
   settlement). Confirm it did not silently spend.
8. **Over max price** — make a priced call **above the configured max price**. Expect the `PRICE_EXCEEDS_MAX` rejection — not a settlement.
9. **Receipts** — `haven_list_receipts` for recent activity, then `haven_verify_receipt` on the within-budget payment from step 6. Expect the receipt verifies.

Stop and report on the **first failed step** rather than pressing on (a failed money-path step is the signal).

## Phase 4 — Report

10. Copy `docs/bug-reports/_run-report-template.md` to a unique UTC/run-id path
    such as `docs/bug-reports/2026-07-01T143022Z-manual-qa-dev-claude-code.md`.
11. Fill in run metadata, exact command/exit, per-goal pass/fail/skip, public
    evidence, artifacts, cleanup, secret review, versions, and concrete
    friction/bugs. A required skip makes the result partial/blocked.
12. File any concrete bug as its own issue and link it from the report. Leave **Notes for the coding agent** with anything worth feeding back.

The run report (not a green check) is the deliverable — this layer's value is the friction it surfaces, not a pass/fail gate.
