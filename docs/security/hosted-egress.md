---
owner: "@d-hinders"
status: current
covers:
  - packages/sdk/src/merchant-egress.ts
  - packages/sdk/src/merchant-discovery.ts
last-verified: "2026-10-07"
---

# Hosted merchant egress — the string-level policy

Hosted Haven sends requests to merchant URLs **agents choose**. Since #3747
every hosted merchant request — quote, MCP session setup, tool call, paid
delivery, and discovery — runs under a string-level egress policy installed by
`createHostedHavenClient` (`strictMerchantEgressPolicy()`, from the SDK's
`merchant-egress.ts`). The backend SSRF guard is untouched; this is the
hosted client's own outbound rule.

## The rules

1. **https only**, any port.
2. **No IP-literal hosts** (v4 or v6 — `URL` normalises the exotic spellings
   to these two shapes before the check runs, as #3112 established).
3. **No local or internal names**: `localhost`, any single-label host, and the
   suffixes `.internal` (covering `*.railway.internal`), `.local`,
   `.localhost`, `.test`, `.invalid`, `.example`.
4. **Redirects**: GET redirects are followed with every hop re-checked
   against 1–3, up to 3 hops (`redirect: 'manual'`; nothing is ever followed
   un-checked). A redirect on any other method is refused — the paid POST is
   never followed, so a payment header is never sent to a redirect target.
5. **Bounded budgets per use**: quotes and MCP session setup 15 s, discovery
   5 s, paid delivery 300 s; response caps enforced **while reading** —
   256 KiB on quotes and MCP session setup, 64 KiB on discovery, 5 MiB on
   paid delivery (the body stream errors mid-read — nothing is buffered past
   the cap, and a body that never ends cannot hold a call open).

## Where it runs

- `HavenClient` accepts an optional `merchantEgress` config; the merchant
  transport checks `assertUrl` before every request and redirect hop, caps
  bodies at the stream, and resolves per-use timeouts via `budgetFor`. Tests
  reach local fixtures through the explicit `HostedClientOptions.merchantEgress`
  seam — there is no exemption in the production policy.
- The same policy runs at **quote/prepare time**: `haven_quote_x402`'s
  transport, the `quoteMcpToolCall` family (before the probe and before the
  #1271 discovery fallback), and `haven_pay_x402_quote`'s pre-intent retry
  target all refuse a bad target **before funding**, so a bad target can
  never surface only as a funded-but-undeliverable payment. The settle fast
  path resolves the merchant call context BEFORE the funding signature relay
  / erc7710 submit (`haven_settle_mcp_tool`) and asserts the URL there — an
  explicitly supplied bad target is refused while the intent is still
  `pending_signature`; stored-context rehydration was validated at quote
  time, so re-asserting is a no-op there.
- Discovery (`discoverMerchantMcpUrl`) asserts the input origin before it
  fetches and reads its 64 KB document with the cap enforced while reading.
- `haven_pay_x402_quote`'s request mode (#3739) makes its own unpaid probe
  under the same policy: `assertUrl` before the fetch, the quote budgets
  (15 s, 256 KiB while reading), and a STRICTER redirect rule —
  `redirect: 'error'`, so no hop is followed at all.

## Refusals

- A refusal **before anything was sent** raises `MerchantEgressRefusedError`
  with `beforeRequest: true` and reaches agents as structured tool failures
  (`MERCHANT_EGRESS_REFUSED`, `next_tool_omitted_reason`), naming the
  agent-chosen URL — never a resolved address (this policy never resolves
  DNS).
- A refusal **during paid delivery, after the request was sent** — a redirect
  the merchant answered, a refused hop, or the byte cap crossed mid-read —
  is the #1300 **verify-then-sweep** state: the response carries the
  `payment_id`, `phase funded_but_unsettled`, and routes to
  `haven_get_payment_status` FIRST. Never a blind sweep: the merchant may
  still settle late. On erc7710 there is no funding leg, so the no-sweep
  handling applies — check status later, ignore any sweep guidance.

## Accepted residual (owner, 2026-10-07)

A **public host name whose DNS answer points at a private address is not
blocked.** This is a string-level policy; it never resolves DNS. Closing that
needs the resolution-time checks parked in #3742–#3744. Status-code and
timing oracles on allowed hosts also remain: the hosted error mapping returns
only the status code (the narrow `merchant_not_ready` 503 shape is the one
body that surfaces), but an allowed hostile host can still observe that it
was contacted.

## CASP note

This is **network policy, never spend control**. It gates where a request
may connect, not whether money moves — the on-chain allowance and the caveat
stack stay the real control, and no refusal here changes a signed payment
intent. See `docs/regulatory/casp-risk-guardrails.md`.
