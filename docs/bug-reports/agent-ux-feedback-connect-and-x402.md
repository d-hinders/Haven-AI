---
owner: "@d-hinders"
status: current
covers: []  # narrative — no direct code mirror
last-verified: "2026-06-28"
---

# Agent UX Feedback: Connect Flow & x402 Payment Flow

**Date:** 2026-06-17
**Author:** Claude (agent perspective — direct experience using Haven MCP tools)
**Flows covered:** Initial agent connect/setup · x402 paid MCP tool call (Soundside `create_text`)

---

## Overview

This report captures friction points and UX observations from two flows experienced directly as an agent using Haven. The goal is to identify where the agent interaction model can be tightened — both in the MCP tool interface and in how Haven communicates state.

---

## Flow 1: Agent Connect

### What the flow is

A fresh Claude session connects to Haven for the first time via the Haven MCP server. The agent must discover its identity, understand its budget, and verify it is ready to act.

### Observations

**No single "am I ready?" tool.**
The agent has to make at least two calls (`haven_get_agent` + `haven_get_allowances`) to understand its identity and spending authority. There is no single tool that returns "connected, here is who you are and what you can spend." For a new session, this is the first thing an agent needs and the current split creates unnecessary round-trips.

**Tool discovery is disconnected from readiness.**
`haven_discover_tools` exists to probe merchants, but there is no equivalent "discover my own capabilities" summary. The agent bootstraps from two separate tool calls and has to mentally assemble the picture.

**Allowance format is not immediately actionable.**
`haven_get_allowances` returns raw on-chain values (amount in atomic units, reset period in minutes). Remaining allowance is not returned directly — the agent has to compute `allowance_amount - spent` if that is even derivable from the response. An agent that needs to answer "can I pay 0.10 USDC right now?" should not have to do arithmetic.

**No clear signal for "ready to pay."**
After connecting, the agent has no affirmative "you are configured and can make payments" signal. It has to infer readiness from the absence of errors and the presence of an allowance. A `status: "ready"` or `status: "needs_approval"` at the agent level would reduce ambiguity.

---

## Flow 2: x402 Payment (Soundside `create_text`, $0.04 USDC on Base)

### What the flow is

Three-step fast path: `haven_pay_mcp_tool` → `haven_sign_x402` (local signer) → `haven_settle_mcp_tool`.

### What worked well

- The three-call fast path is clean and logical once understood.
- Error codes are structured and actionable (`MERCHANT_REJECTED_AFTER_FUNDING`, `PAYMENT_WINDOW_EXPIRED`, etc.).
- The sweep recovery flow (`haven_sweep_delegate` → `haven_sign_sweep_delegate` → `haven_sweep_delegate`) was straightforward and worked first time.
- The skill docs correctly described the fast path and the sweep fallback.

### Friction points

**The `x402_expected` parameter name is confusing.**
`haven_sign_x402` takes `x402_expected` but the value comes from `data.x402.expected` in the `haven_pay_mcp_tool` response. The nesting level is easy to get wrong — passing the whole `x402` object instead of just `x402.expected` is a natural mistake. The parameter name should be more explicit (`x402_expected_context`) or the tool description should call out the nesting explicitly with a code example.

**`payment_required` must be passed verbatim — but it's large and noisy.**
The agent has to carry `payment_required` (a large object including the full Bazaar schema, tags, category, etc.) from `haven_pay_mcp_tool` through to `haven_sign_x402`. Almost all of that content is irrelevant to signing. A signing-scoped subset (scheme, network, amount, asset, payTo) would make the handoff smaller and harder to corrupt. Alternatively, Haven could accept a `payment_id` reference instead of the full object.

**No intermediate confirmation that funding succeeded before `haven_settle_mcp_tool` returns.**
When `haven_settle_mcp_tool` returns `MERCHANT_REJECTED_AFTER_FUNDING`, the agent learns two things at once: (1) funding succeeded, (2) the merchant rejected. There is no moment where the agent can observe "funding confirmed, about to call merchant" and decide whether to proceed. For high-value payments this matters — the agent might want to confirm funding before taking the irreversible step of calling the merchant.

**Sweep is a multi-step manual recovery, not automatic.**
After `MERCHANT_REJECTED_AFTER_FUNDING`, the agent must initiate three more tool calls to recover funds. This is correct from a security standpoint (local key stays local), but the error response could include a clearer "here is exactly what to call next with these exact parameters" rather than just `suggested_tool: "haven_sweep_delegate"`. The agent currently has to re-read docs to know the sweep is also a two-phase signed operation.

**Tool schema for `haven_sign_x402` shows `expires_at` inside `x402_expected` but the field is optional.**
The `auth` object inside `x402_expected` does not declare `expires_at` as required in the schema, but the signer validates it. If it is validated, it should be required. If it is not, it should not be validated. The mismatch created confusion during debugging.

**No receipt or payment ID surfaced to the agent after success.**
`haven_settle_mcp_tool` returns `funding_tx_hash` and `settlement_tx_hash` but not the `payment_id` that was used. The agent cannot easily cross-reference the settled payment against `haven_list_receipts` or `haven_get_payment_status` without retaining the `payment_id` from step 1 through to the end. It should be echoed in the success response.

---

## Summary Table

| Area | Issue | Severity |
|---|---|---|
| Connect | No single "am I ready?" bootstrap tool | Medium |
| Connect | Remaining allowance not returned directly | Medium |
| Connect | No affirmative ready/not-ready status signal | Low |
| x402 | `x402_expected` parameter name / nesting is easy to get wrong | High |
| x402 | `payment_required` passed in full when only a subset is needed for signing | Medium |
| x402 | No observable funding-confirmed moment before merchant call | Low |
| x402 | Sweep recovery is not guided step-by-step in the error response | Medium |
| x402 | `payment_id` not echoed in `haven_settle_mcp_tool` success response | Low |

---

## Suggested Quick Wins

1. **Echo `payment_id` in `haven_settle_mcp_tool` success** — one-line change, eliminates a class of agent state-tracking bugs.
2. **Rename `x402_expected` → `x402_expected_context`** and add a one-line code snippet to the tool description showing the exact path in the `haven_pay_mcp_tool` response.
3. **Return `remaining_allowance_atomic` and `remaining_allowance_human` directly** from `haven_get_allowances` so agents don't have to compute it.
4. **In `MERCHANT_REJECTED_AFTER_FUNDING` error**, include a `sweep_instructions` block with the pre-filled `authorization` and `expected_auth` fields so the agent can proceed to the local signer immediately without a second round-trip.
