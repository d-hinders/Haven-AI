---
owner: "@d-hinders"
status: current
covers:
  - packages/sdk/src/merchant-egress.ts
  - packages/sdk/src/merchant-discovery.ts
last-verified: "2026-10-22"
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
   A GET hop that changes origin (scheme, host or port, compared hop to hop)
   carries only `accept`, `accept-language`, `user-agent` and `x402-wallet`.
   `Authorization`, `Cookie`, API keys and any other caller header stay with
   the origin they were supplied for, and are not restored if a later hop
   returns there (#4244). Same-origin hops carry the request unchanged.
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

## Without a policy (#4257)

The SDK default, the local MCP, connect and every embedder that sets no
`merchantEgress` get no URL check, no byte cap and no per-use budget. The
transport still follows redirects itself, so both paths share the
cross-origin rule:

- A hop to another origin (scheme, host or port, compared hop to hop) carries
  only `accept`, `accept-language`, `user-agent` and `x402-wallet`, exactly as
  in rule 4. An API key, a cookie or an x402 payment header supplied for one
  merchant never reaches the origin it redirects to, and an `https` → `http`
  hop is a different origin.
- A redirect that would re-send a request body to another origin (a 307/308,
  or a 301/302 on a method other than POST) is refused
  mid-flight (`redirect_cross_origin_body`) only when the request carries a
  payment: the paid delivery (`deliverPayment`), or a body with an x402
  payment in `_meta["x402/payment"]`. That body can be a string, a
  `Uint8Array`/`ArrayBuffer` decoded as UTF-8 JSON, or a JSON-RPC batch with
  any element carrying it. A body that cannot be read that way (a stream,
  form data, bytes that are not UTF-8 JSON) is not treated as paid. Every
  other request (MCP `initialize`,
  quote probes, a plain `fetch` POST) follows that redirect with its body, as
  the platform did, with the headers reduced.
- Everything else is the platform's behaviour, kept as it was: up to 20 hops
  (`NO_POLICY_MAX_REDIRECTS`); the Fetch spec's rewrite, in which a 301 or 302
  rewrites only a POST to a body-less GET and a 303 rewrites every method
  except GET and HEAD; a 3xx without `Location` returned as the answer; a
  non-HTTP(S) `Location` failing with a `TypeError`; and a caller's
  `redirect: 'manual'` or `'error'` passed straight to the platform.

A refusal on the paid delivery is the funded, undelivered state on this path
too (see Refusals). `MerchantCompletion.retryRequest` records it as
`merchant_retry_rejected_after_payment`. Without a policy the only refusal
that can reach it is `redirect_cross_origin_body`. Every other refusal below
fires only when an embedder sets `merchantEgress` on the local completion.
The event's `retry_status` is the redirect status and `retry_body` is `null`.
Its `details` carry `refusal` and one more key:
- `redirect_location`, the redirect target, when the refusal names one:
  `redirect_cross_origin_body`, and with a policy `redirect_budget_exceeded`
  or a hop that `assertUrl` refused;
- `refused_url`, the URL that answered with the redirect, otherwise (all
  with a policy): `redirect_on_non_get`, `redirect_missing_location` or
  `redirect_invalid_location`.
It then re-throws the refusal with the `payment_id`, and the local MCP
answers with `haven_get_payment_status` as the
next tool and "do not pay again".

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
