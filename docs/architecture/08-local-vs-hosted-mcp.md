---
owner: "@d-hinders"
status: current
covers:
  - packages/mcp/**
  - packages/mcp-server/src/**
  - packages/connect/src/**
  - packages/signer/src/**
  - packages/sdk/src/client.ts
  - packages/sdk/src/account-reads.ts
  - packages/sdk/src/delegate-sweep.ts
  - packages/sdk/src/haven-api-transport.ts
  - packages/sdk/src/mcp-merchant-transport.ts
  - packages/sdk/src/x402.ts
  - packages/backend/src/routes/payments.ts
  - packages/backend/src/routes/x402.ts
  - packages/backend/src/middleware/agentToolAudit.ts
last-verified: "2026-09-02" # #2242: re-verified and EDITED — the one sentence in § *Key custody* calling hosted mode's signer a "dedicated, no-network signer" only. Same retired pre-#1263 property as the sibling copy corrected in `06-hosted-mcp-connect-flow.md` this pass; the sentence now names the single authenticated read-only sign-context fetch and keeps the claim that actually carries the custody argument — the fetch never carries the key. Re-derived from `packages/signer/src/sign-context.ts` (Bearer `api_key` is the only credential sent) and `core.ts` (network-free, never returns the key). The non-custody paragraph above it was re-read and is unchanged. Nothing else in this document re-verified in this pass. Prior: #2349: re-verified and EDITED (Tool model section only). The section said "the reason each remaining tool is deliberately still permissive" lives in STRICT_INPUT_TOOLS, which read as though the remainder were a standing exclusion; #2349 closed the list at 19 strict of 22, with the three permissive tools on their own explicit list (PERMISSIVE_INPUT_TOOLS) and a compile-time plus runtime guard so a new tool cannot skip the decision. Added what strictness measurably means on the two `{}` tools (absent arguments already refused, `{}` passes, only a decorated call differs — and Cursor is documented decorating exactly that call), and that the never-registered #314 legacy aliases are deleted. Custody boundary, x402 comparison table, scheme/settle-shape sections and the decomposed-flow blocks NOT re-verified in this pass. Prior: #2348: re-verified and EDITED (Tool model section only). The section said the camelCase crossover tools were deliberately still permissive; they are not, as of #2348 — all four now refuse and each refusal names the local spelling. Added the per-tool measured-consequence table: the four were NOT equally silent, which the divergence table alone implies. haven_send lost idempotency ENTIRELY (POST /payments went out with no idempotency_key field at all); haven_pay_mcp_tool had its replay scope REPLACED by a 300 s bucketed hash of the merchant quote, not merely lost; haven_quote_x402 probed with an empty body; and haven_pay_x402_quote's headline `quote` crossover ALWAYS failed loudly, because payment_required is required — only idempotencyKey was silent there. Every row measured over a real client -> InMemoryTransport -> buildHostedMcpServer round trip against origin/dev c259d9ca, not inferred from the schemas. Convergence and the missing hosted `body` recorded as #2366 with the reason they are not taken here (published-package contract change). x402 comparison table, custody boundary, scheme/settle-shape sections and the decomposed-flow blocks NOT re-verified in this pass. Prior: #2353: re-verified and EDITED (Tool model section, the `haven_complete_mcp_tool` paragraph only). That paragraph said the shipped SKILL.md "tells" agents to pass an undeclared `payment_required`; as of this PR it no longer does, and a doc that still describes the live defect in the present tense is worse than one that never mentioned it. Records what replaced it (`payment_id` + `payment_header` only, with the not-taken field named) and, more importantly, that the tool stays PERMISSIVE on purpose: previously installed copies of the skill are still in the field, so the strictness switch is a separate behaviour change and not this PR. Names the two tests that pin the halves apart, because the pairing is not obvious from either file alone. Measured, not remembered: `haven_complete_mcp_tool` is absent from `STRICT_INPUT_TOOLS` on this branch and `packages/mcp-server/src/tools.ts` is byte-identical to origin/dev here. haven-doc-reviewer found the SAME present-tense staleness in that file's `STRICT_INPUT_TOOLS` comment; it is handed to the concurrent #2347 session (which owns that comment and this doc's sibling contract doc) rather than raced, so expect that one-word fix to arrive separately. Scope: that paragraph only. The x402 comparison table, the custody boundary, the scheme/settle-shape sections and the camelCase-crossover sentence NOT re-verified in this pass. Prior: #2312: re-verified and EDITED (Tool model section only). The section said the two tool surfaces are "not byte-for-byte identical" and then listed only CAPABILITY differences, which read as though the shared tools took the same arguments. They do not: idempotencyKey/idempotency_key, quote/payment_required, and a local-only `body` on haven_quote_x402 — read off both `toolSchemas` maps rather than remembered. Until #2312 the hosted side silently STRIPPED the local spelling, so an agent lost idempotency protection on a payment without any refusal; a first batch of four record-reading money-path tools now refuses. The strict set is pointed at, not copied, so this doc cannot drift from it. x402 comparison table, custody boundary and the scheme/settle-shape sections NOT re-verified in this pass. Prior: #2292: re-verified and EDITED (hosted decomposed-flow section only). The EIP-3009 branch of the hosted flow gained a final step, haven_report_x402_outcome, and this doc held the one remaining copy of that flow without it — the parallel diagram in 06-hosted-mcp-connect-flow.md was updated in the same PR. Added with the local/hosted reason, since that split is what this doc is for: in local mode the SDK makes the merchant retry and observes the outcome, in hosted plain-HTTP mode the agent does and Haven never contacts the merchant. erc7710 branch checked and deliberately unchanged — no funding leg, and isFundedX402AwaitingMerchantLeg is scoped to settlement_scheme eip3009 (agent-payment-status.ts). Scheme-comparison table and the rest of the doc NOT re-verified in this pass. Prior: #2041: the scheme-comparison table stated, in structured form, that erc7710 settles exclusively through `haven_settle_mcp_tool` -- the doc set's most direct version of "only the MCP-merchant tools can reach the preferred scheme". The settle column is now SPLIT by merchant transport, because the two settle differently and the distinction was invisible: an MCP merchant is called BY Haven so the tool delivers the header, a plain-HTTP merchant is retried by the AGENT so the tool hands it back. The plain-HTTP erc7710 cell was empty until #2041, which is the defect. Also qualified "the absence of `payment_header` is what selects erc7710" as true of `haven_settle_mcp_tool` specifically, and recorded the generic path's different mechanic (reported at quote, echoed at submit -- #1360 explicitness on a second entry point), and added the erc7710 shape to the decomposed-flow block. The two hosted-specific edge-signer properties (#1138 binding, #1455 child verification) and the rail-scope correction this doc made on 2026-08-25 re-read against the diff: both stand unchanged. Prior: Corrected a STALE refusal claim, not a behaviour change. The doc said the hosted keyless construct rejects typed-data funding intents, so delegation-rail x402 needed the local flow, and that #1986 therefore left hosted x402 "with no working rail at all". Both halves were overtaken: #1254 forwards signature_scheme + typed_data verbatim to the edge signer (delegationSignFields, packages/mcp-server/src/tools.ts), #1456 added the hosted erc7710 settle branch, and BOTH hosted schemes have green QA scenarios against the real deployed hosted MCP plus the real signer (x402-hosted-mcp-signer.ts #1154, x402-erc7710-hosted.ts #1457). The #1986 sentence was reasoning from a premise that had already stopped holding: the fail-close is rail-scoped and applies to both topologies equally, so it removed the legacy rail, never the hosted surface. Rewrote the section around what the two topologies now actually differ on — where the key lives and which party refuses — and added the scheme/payload/settle-shape table plus the two edge-signer checks (#1138 binding, #1455 child verification) the local flow does not exercise. No code changed and no other claim in this doc was re-tested beyond re-reading it for contradiction; the custody boundary and tool-model sections stand unchanged. Prior: #1986: the rail split re-read — the hosted keyless x402 construct now has NO working rail, because the allowance rail it served fails closed. Added; the local-vs-hosted signing/relay distinction itself is unchanged and re-verified. Prior: #1672: the local-MCP example command drops --runtime claude-code — runtime selection is detection-first now (see mcp-runtime-compatibility.md); everything else re-read and unchanged. Prior: re-verified for #1352 (Node floor 24->22: engines/constant only; grep-checked: no numeric floor claim in this doc; floor prose lives in mcp-runtime-compatibility.md)
---

# Haven — Local MCP vs Hosted MCP + Edge Signer

The default is hosted MCP plus the local edge signer. The connector writes this
topology for supported runtimes. Local MCP is an advanced `--local` option for
Claude Code and Codex.

| | Local MCP (`@haven_ai/mcp`) | Hosted MCP + edge signer |
|---|---|---|
| MCP process | Runs locally | Runs at Haven's configured hosted URL |
| Signing | Delegate key is loaded by the local MCP process | Delegate key is isolated in local `@haven_ai/signer` |
| Haven API | Still used to construct, submit, and poll payments | Used through hosted MCP orchestration |
| Updates | User picks up package releases | Hosted orchestration updates centrally |
| Audit | Payment/API tool activity reaches the Haven backend | Backend plus hosted-transport activity is visible |

Local MCP removes the hosted MCP transport. It is not offline or air-gapped:
the SDK still depends on the configured Haven API and its relay/chain services,
plus merchant services. Its privacy and availability trade-off is therefore
narrower than running the whole Haven stack locally.

Opt in on a supported runtime:

```bash
npx -y @haven_ai/connect --setup hv_setup_... --api https://api.haven.example --ack-local-tools --local
```

## Custody boundary

The hosted service must never hold, process, or transmit the delegate private
key. Doing so would violate Haven's non-custodial architecture and materially
increase custody and CASP risk; any such change requires product and legal
review. The regulatory guardrails are risk guidance, not a legal opinion.

Local MCP keeps signing local but loads the key into the same process that
performs orchestration. Hosted mode narrows that key surface to a dedicated
sign-only signer, whose entire network surface is one authenticated, read-only
sign-context fetch from Haven (#1263) that never carries the key.

## Tool model

Both modes expose the common reads, direct-payment operations, x402 and MPP
quote/resume/status operations, receipt operations, and discovery where their
semantics match. They are not byte-for-byte identical:

- Local MCP can perform some one-call flows because it owns the local key.
- Hosted MCP exposes prepare/submit and paid-MCP orchestration helpers so the
  edge signer can authorize without sharing the key.
- Hosted MCP provides gasless sweep orchestration; the signer supplies
  `haven_sign_sweep_delegate`.

**Same-named tools do not always spell their arguments the same way, and until
#2312 the difference was invisible.** The local MCP takes `idempotencyKey`
where the hosted surface takes `idempotency_key`; local
`haven_pay_x402_quote` takes `quote` where hosted takes `payment_required`;
local `haven_quote_x402` takes a `body` the hosted schema has no field for. An
agent carrying the local spelling to the hosted server was **silently
stripped** — the payment still went through, without the idempotency protection
the caller believed it had set. Nothing said no, because a stripped key parses
to the same value as an absent one.

Since #2312 a first batch of hosted tools REFUSES an undeclared argument
instead: the money-path tools that read something from the payment's own record
rather than from arguments (`haven_report_x402_outcome`, `haven_submit`,
`haven_settle_mcp_tool`). #2348 added the four crossover tools above —
`haven_send`, `haven_pay_mcp_tool`, `haven_quote_x402`,
`haven_pay_x402_quote` — each with a refusal that NAMES the local spelling, so
a caller holding `idempotencyKey` is told what to send instead. #2349 closed
the list: **19 of the 22 hosted tools refuse**, and the three that do not are
on a second, equally explicit list — `PERMISSIVE_INPUT_TOOLS`, beside
`STRICT_INPUT_TOOLS` in `packages/mcp-server/src/tools.ts`. Both lists carry
the per-tool reason and neither is restated here, because a second copy
drifts. Every hosted tool is on exactly one of them: a tool on neither fails
to compile (a type-level exhaustiveness check in `tools.ts`) and fails
`strict-tool-input.test.ts`, so a new tool cannot skip the decision. The
principle that closed the list is the one #2312 opened it with — every hosted
schema already advertised `additionalProperties: false`, so permissive
behaviour was a contract mismatch, and the only reason to leave a tool
permissive is a live caller that would break. The enumeration for the final
twelve (SDK, `packages/mcp`, connect, the shipped skill text and its
byte-pinned twin, the QA legs, e2e fixtures, docs, `.agents`) found none.

Two of the three permissive tools are `haven_get_agent` and
`haven_get_allowances`, whose schema is `{}`. What `.strict()` would mean
there was measured over the transport rather than argued: absent `arguments`
is refused **today** under both forms, `{}` passes under both, and only a
*decorated* no-argument call (`{ random_string: "dummy" }`) differs — and that
is the call Cursor, a runtime `packages/connect` supports by name, is
documented producing for parameterless tools, on the very verification step
connect sends a new user to. The handlers read no input at all, so a stripped
key there can neither change what is read nor let a caller believe it pinned
something. Strictness would change one observable case and protect nothing.

The "one release cycle" aliases `haven_x402_authorize` /
`haven_list_transactions` are **deleted** rather than decided: defined in
#314 and never registered — `server.ts` has iterated `toolSchemas` only since
that commit — so a caller using either name has received "tool not found"
since then, and `strict-tool-input.test.ts` now pins that what `tools/list`
advertises is exactly `toolSchemas`.

`haven_complete_mcp_tool` is the third permissive tool,
for a different and sharper reason — Haven's own downloadable `SKILL.md` told
agents to pass it a `payment_required` it has never declared, so the guidance is
fixed before the tool refuses
([#2353](https://github.com/d-hinders/Haven-AI/issues/2353)).
That guidance **is now fixed**: the skill says `payment_id` +
`payment_header` only, and names the field the tool does not take. The tool is
still permissive, deliberately — an agent carrying a previously installed copy
of the skill is still out there, and the switch is a separate, behaviour-changing
change. What pins the two halves apart is
`packages/mcp-server/src/strict-tool-input.test.ts`: its `#2312` control asserts
the tool is absent from `STRICT_INPUT_TOOLS`, and its `#2353` block asserts the
strip that absence produces over the real transport. Both go red on the day
someone flips it, which is the point.

That is exactly the hazard the four crossover tools did **not** turn out to
have. #2348 enumerated their callers before switching them — the SDK,
`packages/mcp`, connect, the frontend, the hosted-MCP QA legs, the agent-skill
text and its byte-pinned twin, `.agents/`, docs and the e2e fixtures — and found
nothing passing the local spelling to the hosted surface, so refusing there
converts a silent path with no live caller rather than a documented flow with
one.

**What each crossover actually cost, measured over the transport rather than
read off the schemas (#2348, 2026-09-01).** The four were not equally silent,
and the divergence table alone reads as though they were:

| Tool | Key lost | What happened when it was lost |
|---|---|---|
| `haven_send` | `idempotencyKey` | Total loss. `POST /payments` went out as `{token, amount, to}` with **no** `idempotency_key` field, so the backend's replay contract never engaged and a retry was a second spend. |
| `haven_pay_mcp_tool` | `idempotencyKey` | Replay scope **replaced**, not merely lost: the SDK fell back to `buildX402IdempotencyKey`, a hash of the merchant quote over a 300 s bucket. It de-dupes two genuinely distinct purchases inside one bucket and fails to de-dupe a retry that crosses a bucket boundary. |
| `haven_quote_x402` | `body` (and `idempotencyKey`) | The hosted probe fired with an **empty** body, so the quote described a request the caller never made. A quote creates no payment, so the `idempotencyKey` half cost nothing directly. |
| `haven_pay_x402_quote` | `idempotencyKey` only | Its headline crossover, `quote` for `payment_required`, **always failed loudly** — `payment_required` is required, so the call was refused with `-32602 … Required` and made zero Haven calls. Only `idempotencyKey` was silent. |

Refusing is the on-ramp, not the destination: the two surfaces should converge
on one spelling, and `haven_quote_x402` should gain a hosted `body` rather than
stay honestly unable to quote a body-bearing paywall. Both are
[#2366](https://github.com/d-hinders/Haven-AI/issues/2366), held out of #2348
because renaming an argument on the **published** `@haven_ai/mcp` package is a
release-train decision with a deprecation window, not a parse decision.

Treat the registered tool unions in `packages/mcp/src/tools.ts`,
`packages/mcp-server/src/tools.ts`, and `packages/signer/src/tools.ts` as the
source of truth.

The four edge-signer tools are `haven_sign`, `haven_x402_sign_header`,
`haven_sign_x402`, and `haven_sign_sweep_delegate`.

## x402 comparison

Local MCP can orchestrate a one-shot `haven_pay_x402` flow from its local
process; Haven's backend still constructs and relays the payment.

For a paid MCP tool in hosted mode, prefer:

```text
haven_pay_mcp_tool → haven_sign_x402 → haven_settle_mcp_tool
```

The decomposed generic hosted flow remains, in two shapes since
[#2041](https://github.com/d-hinders/Haven-AI/issues/2041):

```text
EIP-3009 bridge
haven_pay_x402_quote → haven_sign → haven_submit
  → haven_x402_sign_header → merchant retry
  → haven_report_x402_outcome

erc7710 direct settlement
haven_pay_x402_quote → haven_sign
  → haven_submit { settlement_scheme: "erc7710" } → payment_header
  → merchant retry
```

The report step exists only on the EIP-3009 branch, and only in hosted mode's
plain-HTTP shape ([#2292](https://github.com/d-hinders/Haven-AI/issues/2292)).
It is where the local/hosted split has a consequence rather than a preference:
in local mode the SDK makes the merchant retry itself and writes the evidence
or reconciliation row from what it observed, while here the AGENT makes that
retry and Haven never contacts the merchant — so the outcome has to come back
through a tool or it does not come back at all. erc7710 needs no equivalent:
there is no funding leg, `confirmed` IS merchant settlement, and the
funded-but-undelivered state the report resolves is scoped to
`settlement_scheme: 'eip3009'`.

In both cases, Haven's backend constructs and records the payment intent.
Hosted MCP never signs; it relays already signed, context-bound payloads.

Both modes dispatch on the server-provided `sign_data.signature_scheme`,
including the delegation rail's EIP-712 typed data. Hosted MCP does not sign it
— it forwards `signature_scheme` and `typed_data` **verbatim** to the local edge
signer (`delegationSignFields`, #1254), which is the whole point of the keyless
split. So x402 works in both topologies on the delegation rail, in both
settlement schemes:

| Scheme | Signed payload | Hosted settle call (MCP merchant) | Hosted settle call (plain-HTTP merchant) | Proven by |
|---|---|---|---|---|
| EIP-3009 bridge | `eip712_userop` — the funding UserOp | `haven_settle_mcp_tool` **with** `payment_header` | `haven_submit`, then `haven_x402_sign_header` locally | `x402-hosted-mcp-signer.ts` (#1154) |
| erc7710 direct | `eip712_delegation` — the settlement child | `haven_settle_mcp_tool` **without** `payment_header` (#1456) | `haven_submit` **with** `settlement_scheme: "erc7710"` (#2041) — returns `payment_header` | `x402-erc7710-hosted.ts` (#1457) |

The settle column is split because the two merchant transports settle
differently and the distinction was previously invisible: an MCP merchant is
called BY Haven, so the settle tool delivers the header itself; a plain-HTTP
merchant is retried by the AGENT, so the tool stops at handing the header back.
Until #2041 the plain-HTTP row simply had no erc7710 entry — the generic path
could not reach the preferred scheme at all, which meant the merchant transport
was silently deciding the settlement scheme.

Both scenarios run in the `qa-dev` cadence that `qa-freshness` reads for
promotion gating; they self-skip when `QA_HOSTED_MCP_URL` /
`QA_DEMO_MERCHANT_URL` are unset, and `.github/workflows/qa-dev.yml` sets both.

The absence of `payment_header` is what selects erc7710 **on
`haven_settle_mcp_tool`**: on that scheme the signature IS the settlement child,
so it goes to `POST /x402/:id/settle` and Haven assembles the merchant header —
there is no funding leg to relay and no agent-supplied header to preflight. The
3009 path always carries a header the local signer built.

That is not the only selection mechanic in the tool surface. On the generic
`haven_pay_x402_quote` / `haven_submit` path (#2041) the scheme is instead
reported explicitly as `settlement_scheme` at quote time and echoed by the
caller at submit time — the same #1360 explicitness property, applied to a
second entry point, and the reason the generic path never has to infer a scheme
from a `payTo` shape it did not choose.

Two hosted-specific properties the local flow does not exercise, both on the
edge signer rather than on Haven: `assertExpectedBinding` verifies Haven's
signed expected context and re-derives the digest of the bytes in hand (v2
carries `typedDataHash` for typed-data schemes, #1138), and
`verifySettlementChild` re-derives the erc7710 child's meaning from
**signer-pinned** caveat-enforcer addresses rather than from anything Haven
sends (#1455). The signer is the party that refuses; hosted MCP relays.

**Rail scope (#1986).** What the legacy AllowanceModule rail's fail-close
removed is the legacy rail, not the hosted topology: `POST /x402/authorize`
answers HTTP 410 for an `allowance_module` account, above the funding leg, in
BOTH topologies equally. Delegation-rail accounts — every account onboarded
since #1984 — are unaffected, hosted and local alike.

## Related docs

- [Hosted connect flow](06-hosted-mcp-connect-flow.md)
- [Edge signer](07-edge-signer.md)
- [CASP / MiCA guardrails](../regulatory/casp-risk-guardrails.md)
