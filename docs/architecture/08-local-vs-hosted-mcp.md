---
owner: "@d-hinders"
status: current
covers:
  - packages/mcp/**
  - packages/mcp-server/src/**
  - packages/sdk/src/next-step.ts
  - packages/sdk/src/types.ts
  - packages/sdk/src/payment-mappers.ts
  - scripts/ci/vocabulary-map.json
  - scripts/lint-next-steps.mjs
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
  - packages/backend/src/modules/agents/agent-connection-setup.ts
  - packages/backend/src/routes/transactions.ts
  - packages/backend/src/routes/machine-payments.ts
  - packages/backend/src/modules/transactions/x402.ts
last-verified: "2026-09-20"
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
npx -y @haven_ai/connect@<channel> --setup hv_setup_... --api https://api.haven.example --ack-local-tools --local
```

`<channel>`, `hv_setup_...` and `https://api.haven.example` are all
placeholders — production hands out `@alpha`. Run the connector command your dashboard hands you with
`--ack-local-tools --local` appended: since #2422 the package in that command
is per-deployment — the backend's setup response names it in
`connector_package` — and a connector pinned by hand to another channel
installs a signer that skews against that backend.

## Custody boundary

The hosted service must never hold, process, or transmit the delegate private
key. Doing so would violate Haven's non-custodial architecture and materially
increase custody and CASP risk; any such change requires product and legal
review. The regulatory guardrails are risk guidance, not a legal opinion.

Local MCP keeps signing local but loads the key into the same process that
performs orchestration. Hosted mode narrows that key surface to a dedicated
sign-only signer, whose entire network surface is an authenticated, read-only
sign-context fetch from Haven (#1263 for x402, #3271 for direct payments) that
never carries the key.

The same boundary decides **who retires a superseded agent** (#2561). A
connector run on a machine that already holds agents leaves those agents alive
with their own keys, and it reports their ids so the DASHBOARD can offer the
owner a one-click revoke. The connector never revokes: `POST /agents/:id/revoke`
is owner-authenticated and the connector holds only agent API keys, so an agent
credential retiring a sibling agent would be the "agent editing its own
authority" that the re-key routes (#1694) already refuse. Nothing is automatic
— the offer is rendered, the owner clicks, one agent at a time.

The report distinguishes three states rather than two, and the third is why:
a list of ids, `[]` when the credential scan ran and found none, and `null`
when it could not run at all. Collapsing the last into the second would have
the dashboard tell somebody their machine is clean when nobody managed to read
it — the sort of claim this boundary exists to keep Haven from making.

## Tool model

Both modes expose the common reads, direct-payment operations, x402 and MPP
quote/resume/status operations, receipt operations, and discovery where their
semantics match. They are not byte-for-byte identical:

- Local MCP can perform some one-call flows because it owns the local key.
- Hosted MCP exposes prepare/submit and paid-MCP orchestration helpers so the
  edge signer can authorize without sharing the key.
- Hosted MCP provides gasless sweep orchestration; the signer supplies
  `haven_sign_sweep_delegate`.

**A receipt read is not a transaction-history read, and since #3132 every row
says which it is.** `haven_list_receipts` (both runtimes, via the SDK's
`listReceiptsPage`) returns this agent's evidence rows only — agent-scoped by
the authenticated principal, no query-time narrowing — so each row carries
`scope: { source: 'agent', filter: null }`. The wallet feed (`GET
/transactions`, the CLI's `activity list`) is a different population: every
account's explorer window plus synthesized confirmed intents, sweeps and
funding legs included, with `agentId` / `accountId` applied as narrowing
filters — its rows carry `scope: { source: 'wallet', filter: 'agent' |
'account' | 'account+agent' | null }`. The two values are separate because one
value cannot say both without lying about one of them (owner decision 3 on
#3130): `agentId` narrows a wallet-scoped query, it does not turn it into the
receipts view. The declaration is per row because the SDK's
`mapPaymentReceipt` discards the envelope, and it reaches an agent only once
the SDK that maps it (`HavenPaymentReceipt.scope`) is published. The same
slice stopped the feed's x402 rows from substituting values silently: a
confirmed payment with no evidence row reports `paymentProofStatus: null`
(not `'payment_confirmed'`), and `timestamp`'s `confirmed_at ?? created_at`
fallback is named by `timestampSource` with the recorded, nullable
`confirmedAt` beside it — the value the receipts view reports as
`confirmed_at`.

**Since #3134 the two views spell their shared concepts the same way.** Four
pairs named one value each — proof state, merchant address, resource URL,
payment rail — and the receipt side now carries the transaction feed's names
(`paymentProofStatus`, `x402MerchantAddress`, `x402ResourceUrl`, `source`),
decided at `mapPaymentReceipt` only (owner decision 1: the transactions wire
is frozen, the receipts wire stays snake_case, nothing moves in the backend).
The old receipt names (`rail`, `proofStatus`, `resourceUrl`,
`merchantAddress`) were dual-emitted as deprecated twins from `0.5.0-alpha.0`
through `0.5.0-alpha.1` and removed by #3306 once all three release clocks —
`@haven_ai/sdk` `latest`, `@haven_ai/mcp` `latest`, the hosted mcp-server
deploy's `serverInfo.version` on `initialize` — read `0.5.0-alpha.1`; a receipt
row now carries only the transaction feed's names. The pairs are declared in
#3131's vocabulary map (beside the guard;
[`cli-json-conventions.md`](../product/cli-json-conventions.md) covers it),
whose open count is now 0. Three pairs stay divergent on purpose — `txHash`/`hash`,
`amountRaw`/`value`, `amount`/`valueFormatted` — with their reasons in the same
map; a new undeclared pair fails `lint:vocabulary`.

**Same-named tools do not always spell their arguments the same way, and until
#2312 the difference was invisible.** The local MCP takes `idempotencyKey`
where the hosted surface takes `idempotency_key`; local
`haven_pay_x402_quote` takes `quote` where hosted takes `payment_required`;
local `haven_quote_x402` took a `body` the hosted schema had no field for
(closed by [#2366](https://github.com/d-hinders/Haven-AI/issues/2366) — `body`
is now declared on both, spelled the same). An
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
the list: **21 of the 23 hosted tools refuse**, and the two that do not are
on a second, equally explicit list — `PERMISSIVE_INPUT_TOOLS`, beside
`STRICT_INPUT_TOOLS` in `packages/mcp-server/src/tools/contracts.ts` (both
have lived there since #2807 split the contracts out of `tools.ts`, which
re-exports them). Both lists carry the per-tool reason and neither is
restated here, because a second copy drifts. Every hosted tool is on exactly
one of them: a tool on neither fails to compile — a type-level exhaustiveness
check in that same module — and fails `strict-tool-input.test.ts`, so a new
tool cannot skip the decision. The
principle that closed the list is the one #2312 opened it with — every hosted
schema already advertised `additionalProperties: false`, so permissive
behaviour was a contract mismatch, and the only reason to leave a tool
permissive is a live caller that would break. The enumeration for the final
twelve (SDK, `packages/mcp`, connect, the shipped skill text and its
byte-pinned twin, the QA legs, e2e fixtures, docs, `.agents`) found none.

Two of the permissive tools are `haven_get_agent` and
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

`haven_complete_mcp_tool` was the third permissive tool, for a different and
sharper reason — Haven's own downloadable `SKILL.md` told agents to pass it a
`payment_required` it has never declared, so the guidance was fixed before the
tool refused
([#2353](https://github.com/d-hinders/Haven-AI/issues/2353)). That guidance
**is fixed**: the skill says `payment_id` + `payment_header` only, and names
the field the tool does not take, and it has shipped to npm
(`@haven_ai/sdk@0.1.34-alpha.0`, 2026-09-01T19:21Z, the `alpha` dist-tag
`npx @haven_ai/connect@alpha` resolves). **As of #2353's switch PR
(2026-09-03) the tool refuses**: it is on `STRICT_INPUT_TOOLS`, with a refusal
that names `payment_required` and points at the rehydration by `payment_id`,
and the residual risk — an agent still carrying a pre-0.1.34 auto-installed
copy on disk — meets that refusal rather than the silent strip. The tests that
used to pin the two halves apart now pin the switch:
`packages/mcp-server/src/strict-tool-input.test.ts`'s former `#2353` strip
block asserts the refusal over the real transport (with the same
declared-arg-survives control), and #2363's block pins the corrected skill
literals the refusal presumes.

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
| `haven_quote_x402` | `body` (and `idempotencyKey`) | The hosted probe fired with an **empty** body, so the quote described a request the caller never made. A quote creates no payment, so the `idempotencyKey` half cost nothing directly. **`body` is converged since #2366**; `idempotencyKey` is the divergence that remains on this tool. |
| `haven_pay_x402_quote` | `idempotencyKey` only | Its headline crossover, `quote` for `payment_required`, **always failed loudly** — `payment_required` is required, so the call was refused with `-32602 … Required` and made zero Haven calls. Only `idempotencyKey` was silent. |

Refusing is the on-ramp, not the destination, and **#2366 has now walked half of
it.** The hosted `haven_quote_x402` takes a `body`, threaded verbatim into the
probe's `RequestInit` and distinguished from *no* body by `!== undefined` rather
than truthiness — an empty-string body is a body, and a paywall that varies on a
payloadless `POST` is a different request from one with no body at all. The two
really are distinguishable on the wire, and the mechanism is worth naming
because it is not the obvious one: both send `Content-Length: 0`, and what
differs is that `fetch` adds `Content-Type: text/plain;charset=UTF-8` for
`body: ''` and no such header for no body (measured against a real HTTP server
during this change's review). The distinction is inherited from `fetch` and
already held on the local surface; hosted now matches it rather than inventing
it. Conflating the two would be the same class of error the refusal existed to
avoid committing. That divergence is gone rather than mitigated: one field, one name,
both surfaces.

**The spelling half is now IN its window** (owner decision 2026-09-06). The local
surface accepts `idempotency_key` alongside `idempotencyKey`, warns on the legacy
name in an additive `warnings` field, and **refuses the pair when they disagree**
rather than resolving it — choosing either would be Haven deciding which replay
scope the caller meant, and on this argument a wrong choice is a second spend.
Equal values are not ambiguous and are accepted. The legacy name still works,
because a published package cannot break installed callers on the release that
renames an argument; removing it is a later, separate release.

**And one item on that list turned out not to belong on it.** `quote` (local)
versus `payment_required` (hosted) is **not a spelling difference**, and the two
schemas say so:

| Surface | Field | Type | What the handler does with it |
|---|---|---|---|
| hosted | `payment_required` | `z.record(z.string(), z.unknown())` | the parsed HTTP 402 object itself |
| local | `quote` | `z.unknown()` | reads `quote.paymentRequired`, then passes the whole `X402Quote` to `payX402Quote` |

The local field holds the object the hosted field is a **member of**. Renaming
either would change *what a caller must send*, not what it is called — silently,
and in the direction that looks correct: an installed caller passing its
`X402Quote` under the new name would be passing the wrong shape with no error to
read, on a tool that funds a payment.

> **Owner decision (2026-09-06):** the `quote` / `payment_required` divergence
> **stands**. It is a difference in the value each surface takes, not in what
> that value is called, and it exists because the flows differ: the local flow
> has built the quote and holds it, while the hosted flow is handed a 402 by an
> agent that may never have built one. #2348's refusal is the permanent
> mitigation — neither surface accepts the other's field name, so a caller that
> sends the wrong one is told, rather than having its argument silently dropped.
> Recorded here so the pairing is not re-proposed as an obvious convergence.

**Why not converge it anyway**, since that is the question a later reader will
ask. Making hosted accept a `quote` means the hosted surface starts accepting a
shape it currently refuses, which loosens #2348's strictness — the property that
stopped a caller believing it had set a replay scope it had not. Making local
accept `payment_required` means the caller must know which field of its own
quote to send, and gains a second deprecation to run for no behavioural benefit.
Both trade a real guard for a cosmetic symmetry.

**Nothing schedules the removal.** The window is open; its closing is a
release-train decision and has not been taken. Until it is, `idempotencyKey`
keeps working and keeps warning — which is a window only for as long as someone
means to shut it.

Treat the registered tool unions in `packages/mcp/src/tools.ts`,
`packages/mcp-server/src/tools/contracts.ts` (re-exported by
`packages/mcp-server/src/tools.ts`, the facade), and
`packages/signer/src/tools.ts` as the source of truth.

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

> **Re-verification (#3097, the paid retry's target, 2026-09-18):** this diff
> touches `packages/mcp-server/src/tools/{plain-http-x402,contracts,paid-mcp-completion}.ts`,
> `packages/mcp-server/src/tools/support/mcp-context.ts` and the SDK's
> `mcp-merchant-transport.ts` (in this document's coverage list; the SDK's
> `x402-protocol.ts` is covered by `04-x402-payment-sequence.md`). Both surfaces keep their contracts; what is new is an optional `url` on
> `haven_pay_x402_quote` / `haven_resume_x402_payment` (the URL the agent
> quoted), `request_url` / `retry_url` / `resource_url_differs_from_request` on
> the quote, `retry_url` on pay and resume, and the `INSECURE_RETRY_TARGET`
> refusal of a public `http://` retry target — the same rule on the SDK's
> `McpMerchantTransport.deliverPayment` seam, which the local runtime crosses. The
> local/hosted divergence this document describes is unchanged: the local
> runtime always retried the caller's URL; the hosted surface now carries it.
> Scope of this note: those fields and that refusal. Nothing else in this
> document was re-verified.

> **Re-verification (#3100, discovery hands out arguments its suggested tool
> accepts, 2026-09-18):** this diff touches both discovery maps (`packages/mcp-server/src/tools/catalog-purchase.ts`, `packages/mcp/src/tools.ts`) and the hosted strict-refusal builder. Additive on the read side:
> every discovery entry gains `suggested_arguments` in the suggested tool's
> vocabulary (hosted MCP entries now suggest the cap-free
> `haven_quote_catalog_purchase { catalog_id }` instead of prepare; HTTP entries
> `haven_quote_x402 { url }`; the local runtime keeps its pay tools with
> `{ merchant_url, tool_name, arguments }` / `{ url }`), and a hosted strict
> refusal now names the declared keys and a rejected key's declared alias
> (`TOOL_ARGUMENT_ALIASES` + folded-spelling equality) on both the handler and
> the transport parse paths. No tool name, schema key, strict/permissive split,
> expected-context version or signer contract changes; the local/hosted
> divergence this document records is unchanged (the two surfaces suggest
> different tools by design — same property, not the same values). The
> `haven_quote_x402` reason no longer claims the hosted surface has no body
> field (it has had one since #2366). A row no verbatim hint exists for — an MCP
> row without `tool_name` on either surface, a degraded MCP row on the hosted
> one — carries `suggested_tool_omitted_reason` instead of a hint, on BOTH
> surfaces (review rounds 1–2), so that field is not a divergence. Scope of
> this note: those fields and that text. Nothing else in this document was
> re-verified.

> **Re-verification (#3101, the typed next-step builder, 2026-09-18):** this
> diff adds `packages/sdk/src/next-step.ts` (the builder, exported from the
> SDK's `index.ts`) and touches `packages/mcp-server/src/tools/support/{guidance,errors}.ts`,
> `packages/mcp-server/src/tools/{contracts,catalog-purchase,plain-http-x402,paid-mcp-completion,state-direct-recovery}.ts`,
> `packages/mcp-server/src/server.ts` (instructions name the omitted-reason
> field), the SDK's `types.ts` (a new optional `next_tool_omitted_reason` on
> `AgentNextStep`) and `skill-content.ts`, and, annotation only,
> `packages/signer/src/tools.ts` and `packages/mcp/src/tools.ts`. The
> hosted `next_tool` family is now rendered by the SDK's builder from a bare
> tool name + server role over a target map derived from the hosted
> `toolSchemas` (which keeps its keys via `as const satisfies`) plus the two
> signer handoff shapes the hosted server declares itself — it never imports
> the edge signer at runtime; a test pins them to the signer's schemas; the
> wire strings are byte-identical on the 9 sites the epic did not re-decide,
> and all 17 `buildAgentGuidance` call sites (a census the characterization
> test enforces — an 18th site fails it) are pinned by
> `next-step-characterization.test.ts`, the 8 re-decided ones marked. New on the wire:
> `next_tool_omitted_reason` wherever no tool is named (the three refusals
> that used to hand `{ payment_id: null }` to a tool requiring a string, the
> recovery module's own-HTTP-retry step, the report-accepted step and the
> three settled done-states), and the same `next_tool` family on refusals
> whose `HostedToolError` carries a step. No tool name, schema key,
> strict/permissive split, expected-context version, signer contract, cap,
> funding, signing or settlement decision changes; the local runtime's
> `nextAction` emission is untouched (slice #3103). Scope of this note: those
> fields. Nothing else in this document was re-verified.

> **Re-verification (#3102, every hosted refusal names its next step, 2026-09-18):**
> this diff touches `packages/mcp-server/src/tools/support/{errors,guidance,cap-price,catalog-entry,mcp-context}.ts`
> and `packages/mcp-server/src/tools/{catalog-purchase,plain-http-x402,paid-mcp-completion}.ts`.
> `HostedToolError` no longer takes a bare `nextAction`: a refusal thrown as a
> `HostedToolError` names an action only through a typed `nextStep`
> (`refusalNextStep`, the same builder and target map as the success path),
> so each of the 28 refusal steps (27 sites, one of them following the live
> payment state) now also carries either a tool with arguments that tool declares
> (six name a tool: `haven_get_payment_status { payment_id }` on the
> post-funding timeout, the erc7710 rejection and an eip3009 rejection whose
> live state says retry or poll; `haven_sweep_delegate {}` on the eip3009
> rejection and the funded insecure-target branch, as their messages say) or `next_tool_omitted_reason` (every stop-and-tell-user,
> retry-with-explicit-context, fund-account and window-expired refusal). The
> one other hosted refusal shape, the SDK's `HavenPaymentStateError` passed
> through `normalizeError`, takes its step from the per-action default table
> (status read, sweep) or says why none follows, so no hosted refusal carries
> a bare `next_action`. `next_action` and `suggested_tool` are byte-identical
> on every refusal, pinned by `next-step-refusals-characterization.test.ts`
> (written before the change; a census of `refusalNextStep` calls enforces the
> 27); `status`, `phase`, `rail` and `retry_with_new_quote` are untouched by
> the diff and pinned where they were, in `tools.test.ts` and
> `paid-mcp-completion.test.ts`. No tool name, schema
> key, cap, funding, signing or settlement decision changes; the local
> runtime is untouched (slice #3103). Scope of this note: those fields.
> Nothing else in this document was re-verified.

> **Re-verification (#3104, cross-surface handoff parity and the ratchet,
> 2026-09-18):** this diff adds `scripts/lint-next-steps.mjs` (+ test +
> zero baseline, wired in `ci.yml` and `package.json`), moves the hosted
> next-step fixtures to `packages/mcp-server/src/test-support/next-step-fixtures.ts`,
> and extends `packages/mcp-server/src/next-step-signer-parity.test.ts` into
> the cross-surface walk: every hosted emission fixture is built for real and
> its arguments parsed with the named tool's strict schema on the surface its
> role names. No emission, tool name, schema key or decision changes; the epic's
> contract as it stands after #3100–#3103 is what the walk and the ratchet
> hold. Scope of this note: the tests and the gate. Nothing else in this
> document was re-verified.

> **Re-verification (#3103, the signer and the local runtime name a next tool,
> 2026-09-18):** this diff adds `packages/signer/src/next-step.ts` (the signer's
> declared hosted handoff shapes — `haven_get_payment_status { payment_id }` —
> and its refusal-side builder over the SDK's) and touches
> `packages/signer/src/{sign-context,tools,index}.ts` and `packages/mcp/src/tools.ts`.
> The signer's five decision sites now carry a typed step beside `next_action`:
> a backend refusal of the signing context (not expired) names the hosted
> status read with the payment id through the role fields
> (`next_tool_server_role: hosted`, `next_tool_name`), so a `--name <slug>`
> install resolves it; a transport failure, a malformed body, an expired window
> and a version skew name no tool and say why (`next_tool_omitted_reason`).
> `HavenSignContextError` gains the optional `next_tool*` fields additively;
> no signing decision, expected-context version or binding version changes.
> The local runtime's failure envelope dual-emits `nextAction` and
> `next_action` (decision 10, one release before the old spelling is dropped;
> this supersedes the #2983 note's "its failure shape is camelCase") and its
> two decision sites — the ones the signer's symmetric grep returns
> (`nextAction: …` or `nextAction = …`): the `MERCHANT_NOT_READY` envelope
> and the `UNKNOWN_ERROR` fallback — say why no tool follows.
> Every field the refusals emitted before is byte-identical, pinned by
> `next-step-characterization.test.ts` in each package (written before the
> change). The hosted server's suite pins the signer's declared shapes to the
> hosted schemas. Scope of this note: those fields. Nothing else in this
> document was re-verified.
