---
owner: "@d-hinders"
status: current
contract: true
covers:
  - packages/mcp/**
  - packages/connect/**
  - packages/signer/**
  - packages/mcp-server/src/tools.ts
  - .github/workflows/publish.yml
last-verified: "2026-09-04" # #2557: re-verified, NOT edited. Implicated because the PR touches `packages/mcp-server/src/tools.ts` and `packages/sdk/src/types.ts`, both in covers:. The only section claiming anything about them — *Tool naming across runtimes*, rewritten by #2550/PR #2555 — still holds verbatim: this diff is type-only (a type alias, a return-type annotation, docstrings), so no field, value or emission moved. What did change is the published `AgentNextStep` docstring, which now carries the same default-server-names caveat this section states, so the two agree rather than one correcting the other. Scope: that ONE section. NOT re-verified: the Supported Runtime Manifest table, the Node floor, the connector profiles, the skew contract, the failure vocabulary. Prior: chain-reset(#2562): the chain sat 88 code units below the ceiling on f37184b5c0d6 — `line.length` 65,448 against `MAX_CHAIN_BYTES` 65,536 in `scripts/docs/chain-integrity.mjs` (#2477) — which is roughly one verification note from blocking the next edit to this doc, whoever makes it and for whatever reason. Two figures worth keeping straight, because they differ here by 271: the gate compares `line.length` (UTF-16 code units) while naming the result `bytes`; the same line is 65,719 actual bytes, already over 65,536 by THAT measure. Recorded in #2562. Compacted to the 20 newest entries, retained VERBATIM; the 35 older ones are dropped from the line and remain fully recoverable in git history (`git log -p -- docs/operations/mcp-runtime-compatibility.md`, or read the line at f37184b5c0d6). The chain had 55 entries and no duplicates — counted with the validator's own `chainEntries` and `chainAnomalies`, not by eye — so this is genuine growth, not the concatenating-merge damage the ceiling was written for. Retention count is a one-time judgement to leave real headroom, NOT a convention: the rule itself is #2562. Nothing was re-verified by this edit and no claim in the body changed. Prior: #2550: the *Tool naming across runtimes* bullet said agents on a runtime that does not use Claude-family namespacing "resolve via the pair" — `next_tool_server` + `next_tool_name`. That was complete for Codex and FALSE for a `--name <slug>` connector install: `next_tool_server` is parsed out of the same hardcoded literal as `next_tool`, so it names the DEFAULT server on every install, named or not. Observed on dev 2026-09-04 with `--name devtest` (servers `haven-devtest` / `haven-signer-devtest`; the response still said `haven-signer`). The bullet now documents `next_tool_server_role` and says to read the ROLE whenever the servers are not the default pair, naming both non-default runtimes. Verified against the emission point (`buildAgentGuidance`, `packages/mcp-server/src/tools.ts`) rather than the issue text: one derivation, no new literal beside the six existing `next_tool` ones. Scope: that ONE bullet. NOT re-verified in this pass: the Supported Runtime Manifest table, the Node floor, the connector profiles, the signer/hosted-MCP skew contract, and the `--doctor` bullet below it. Prior: #2515: re-verified, NOT edited. The command examples in `packages/connect/README.md` and `packages/signer/README.md` became channel-neutral (`@haven_ai/connect@<channel>`); this doc's claims about `packages/connect/**` are about runtime behaviour and the version-skew rule, not about which dist-tag a README prints, and were re-read unchanged. Scope: that one claim class. Prior: #2425: EDITED, scope = two sentences. (a) The paragraph closing the "This table describes the PRODUCTION channel" block gains a pointer to the new runbook `docs/operations/package-dev-channel.md` (this doc = contract, that doc = loop + owner steps). (b) In § Signer / hosted-MCP version skew, the parenthetical "an owner step not performed at the time of writing" was a deployment-state claim, stale since 2026-09-03 (#2420 thread); replaced by a pointer to the runbook's checklist that asserts no state either way. Manifest table, chain and everything else untouched. Prior: #2484: re-verified, EDITED (completion-handoff section only — the approve-budget CTA and the approval-wait paragraphs). Two narration changes in connect's prose flow around the approval moment: (1) a prose run whose STDOUT is not a TTY now skips the budget-approval wait unless waitForApproval is explicitly true — the wait exists to narrate to a watching human, and an agent running the prose command as a tool call has none — printing the full approve-whenever-ready handoff instead. Keyed on STDOUT via a NEW deps.isStdoutTty seam, distinct from the #1719 prompt gate's stdin TTY: interactivity vs narration. A real terminal still waits; --json (waitForApproval: false) is unchanged; an explicit waitForApproval: true from a library caller still waits; (2) the approve-budget CTA now carries the approval-relevant facts — budget amount/token/period and the wallet label + network, composed from setup.agent_budget through the same helpers as the celebration line (formatAtomicAmount/describeResetPeriod/resolveTokenFromAddress), unknown token addresses both now fall back to describeApprovedBudget's atomic-units phrasing; multi-budget setups join rows with commas and empty-budget setups keep the plain phrasing; no secrets: only atomic amounts and the wallet LABEL, both already in printSetupSummary's output. #2279's CTA gating is unchanged. #2353 (switch): re-verified and EDITED (the strict-input Troubleshooting entry's first bullet ONLY). This PR moved `haven_complete_mcp_tool` to STRICT_INPUT_TOOLS, so the bullet now says 20 of the 22, adds the switch to the list's history with the npm propagation fact (0.1.34-alpha.0, 2026-09-01T19:21Z), and gains the operator-facing consequence: a `payment_required` key in that tool's refusal means a pre-0.1.34 auto-installed skill copy, and the rehydration contract it should rely on instead. The permissive side is re-counted to the two `{}` tools. Counts re-derived from the live lists on the branch, not carried. Scope: that ONE bullet. The Supported Runtime Manifest table, the Node floor, the version constants, the header-name section and the connector profiles were NOT re-verified in this pass. #2424: EDITED, scope = ONE new paragraph in the remediation section, directly under the `--repair` rewrites-only-the-pair (#1910) paragraph: the local runtime-spec override (`HAVEN_SIGNER_SPEC` / `HAVEN_SDK_SPEC` / `HAVEN_MCP_SPEC`) — what it installs, the `override-<hash>` directory, the loud setup line, and the `runtime_spec_override` doctor finding. Written against `packages/connect/src/runtime-spec-override.ts` on this branch. The Supported Runtime Manifest table is untouched (an override installs beside the pin, it does not move the pin), and nothing else in this document was re-verified in this pass. Prior: #2423: EDITED, scope = TWO places, not one. (a) A new subsection under Supported Runtime Manifest ("The connector channel is a fifth bump-managed constant"). (b) The forward-reference paragraph in the remediation section, which said making the re-run hints "environment-derived" was "the explicit job of #2423" — this branch IS #2423, and what it shipped does the opposite of that description: a published tarball cannot read a deployment's environment, so the hints are channel-derived at build/publish time from the npm dist-tag. Only the backend handout (#2422) and the hosted MCP server read the env var at runtime. That paragraph was rewritten in 37355bfe; an earlier draft of this note claimed a one-subsection scope and was therefore false about its own diff. Every published package's "re-run `npx @haven_ai/connect@<tag>`" hint now renders from HAVEN_CONNECTOR_CHANNEL in packages/sdk/src/connector-channel.ts, written by release-bump.mjs with publish.yml's own version-to-dist-tag rule; the hosted MCP server reads the same-named env var at boot with the constant as fallback. The Supported Runtime Manifest table itself did NOT move and is unaffected (its four rows are version constants; the channel is derived from the version and is not a row). Nothing else in this document was re-verified in this pass Prior: #2477: chain-reset(#2477): this line held 947 entries of which 860 were exact duplicates of 87 unique ones — four successive merges concatenated the chain instead of interleaving it (measured 474 → 946 at ab4ea742), and even fully deduplicated it was 78,740 bytes against chain-integrity's 65,536-byte ceiling. Compacted 2026-09-03 by owner decision: duplicates removed, the 49 unique entries from release 0.1.29-alpha.0 onward kept here VERBATIM, and the 38 earlier unique entries (#1719 back to the first) moved VERBATIM to `docs/archive/mcp-runtime-compatibility-last-verified-chain-2026-09-03.md`. Nothing was dropped; the gate prints the moved refs so the move is in the run log. Scope: the front-matter line only; no body text changed. One entry, #2310 (2026-08-31, from PR #2462), sat at the very TAIL of the chain — appended rather than prepended, against the newest-first convention the gate does not check — and is restored here near the top by its date rather than archived by its position. Prior: #2310: re-verified, NOT edited — the untagged @haven_ai/* install/npx commands across the docs and package READMEs were tagged @alpha (npm install @haven_ai/sdk@alpha, npm i -g @haven_ai/cli@alpha, npx @haven_ai/signer@alpha, npx @haven_ai/mcp@alpha) so first-contact installs resolve to the alpha train rather than the stale latest dist-tag; no rule change. The diff is .md-only: packages/mcp/README.md and packages/signer/README.md change install-command spelling only, and no tool schema, version constant, runtime floor, consent surface or Supported Runtime Manifest row moves, so nothing this document pins is affected. Prior: #2421: the § "Supported Runtime Manifest" preamble re-read against `.github/workflows/publish.yml` and `scripts/release-bump.mjs`, both of which this PR changes. The claim that survives verbatim: the four `@haven_ai/*` rows are written by the bump script and checked against their own constants on every PR, so a hand-edit still fails CI. The claim that needed saying rather than correcting: the committed table now describes ONE of two channels. A push to `dev` publishes `0.0.0-dev.*` snapshots under the `dev` dist-tag from a throwaway tree — the bump rewrites this table there and the tree is discarded, so the committed rows keep naming the production versions and are NOT stale when a `@dev` install reports different ones. Deliberately no docs check runs against that tree (#2420 invariant). Scope: the manifest section ONLY. The Node floor, the connector profiles, the detection-first selection rules, the failure vocabulary and the signer/hosted-MCP version-skew contract were NOT re-verified in this pass — the skew contract is unchanged BY this PR, which touches no signer, MCP or connect source file. Prior: #2422: § "Signer / hosted-MCP version skew" gains one paragraph — the `@alpha` in its remediation is the PRODUCTION channel, and the backend's connector handout became per-deployment (`HAVEN_CONNECTOR_CHANNEL`) in this PR. Re-read the two claims that paragraph rests on and both still hold EXACTLY as written: `signer_compatibility.fallback` and the signer's structured refusal `fallback` are still the same string, and both still say `@alpha` — this PR does not touch `packages/sdk/src/types.ts` or `packages/signer/src/capabilities.ts`, and making those hints environment-derived is #2423's job, which the new paragraph forward-references rather than pre-empts. The Supported Runtime Manifest table, the Node floor, the release checklist and the runtime-selection sections are UNCHANGED and were NOT re-verified in this pass. This doc was pulled in as a blocking contract doc solely because the diff edits prose in `packages/connect/README.md`, which its `covers:` matches via `packages/connect/**`. Prior: #2242: re-verified, NOT edited — the one paragraph in § "Signer / hosted-MCP version skew" that describes the #1263 `payment_id` byte source ("A signer old enough to lack the #1263 `payment_id` fetch (or an install missing `identity.json`) therefore has no byte source in the default flow; its error names the fallback"). Re-read against `packages/signer/src/sign-context.ts` and `tools.ts` on this branch: `resolveSignContext` returns null without a `payment_id`, throws the named `typed_data_b64` refusal when `loadHavenIdentity` yields null, and `loadHavenIdentity` reads `identity.json` from the credential file's own directory — so both halves of that sentence, the missing-`identity.json` case included, still hold exactly as written. This PR changed only prose in `packages/signer/`: the `README.md` § Custody network paragraph, the `credentials.ts` file JSDoc, the `capabilities.ts` module JSDoc and one `cli.ts` `--help` line — all four asserted or implied the pre-#1263 "no network calls" property. It also corrects a method count in `README.md` (`EdgeSigner` exposes six signing methods, not five; counted against the interface in `core.ts`), in the two places that state it. No exported symbol, schema, tool, version constant or runtime behaviour moves, so the Supported Runtime Manifest, the Node floor section and the version-skew contract are all untouched. Nothing else in this document re-verified in this pass. Prior: #2395: re-verified, NOT edited — § "Signer / hosted-MCP version skew" only, the one section that cites `packages/signer/src/core.ts`. This pass changed only the JSDoc on `X402ExpectedPayment.resourceUrl` / `.merchantTo` in that file (they named the deleted `haven_x402_authorize` alias as the hosted funder; the real hosted producer is `haven_pay_x402_quote`). The section cites `core.ts` for `SUPPORTED_X402_EXPECTED_VERSIONS`, `assertSupportedBindingVersion` and `HavenUnsupportedSignerVersionError` — the version handshake, which this change does not touch — and says nothing about which hosted tool sets the two fields, so every claim in it still holds. Nothing else in this document re-verified in this pass; the Supported Runtime Manifest table is release-bump-owned and untouched. Prior: #2349: re-verified and EDITED — § "An undeclared argument is refused, not stripped" only. Its first bullet said the strict list "began" with batch 1, that #2348 added four, and that "everything else still strips"; as of #2349 the list is closed at 19 of 22 and the three permissive tools are named with their reasons. Nothing else in this document re-verified in this pass; the Supported Runtime Manifest table is release-bump-owned and untouched. Prior: 0.1.34-alpha.0 release: manifest rows re-pinned by release-bump.mjs (never hand-edited). What this release carries for the runtime surface: the #2361 x402 v2 resource/extensions envelope echoes — the local signer (the EIP-3009 emitter) now echoes the merchant challenge's resource/extensions verbatim, and the hosted preflight accepts both the old three-key and new echoing envelopes, so ORDERING is an operator risk window, not a guarantee: the dev->main merge TRIGGERS the prod hosted-MCP deploy (Railway) and the npm publish (publish.yml) as independent pipelines with no ordering between them, so a client updated from npm before the prod hosted preflight has redeployed can briefly hit the old strict validator and be refused with INVALID_PAYMENT_HEADER — fail-closed and self-healing once the deploy lands, but real; confirm the prod deploy before updating clients. Also carried: #2362 (comment/string attribution wording, no behaviour) and #2359 (shipped skill no longer tells agents to pass an undeclared payment_required argument). What did NOT move: Node floor, runtime selection, connector profiles, consent surface — packages/mcp/src/{tools.ts,consent.ts} are byte-unchanged since the 0.1.33 tarballs, so no operator is re-prompted. Only the fast-settle envelope sentence and the manifest were re-verified in this pass. Prior: #2363: re-verified the strict-input Troubleshooting entry ONLY, against `packages/mcp-server/src/tools.ts` on this branch; NOT edited, because it is accurate as written. Both its bullets were checked field by field against the live `toolSchemas` map rather than read: the declared list is still `STRICT_INPUT_TOOLS`, it still holds 7 of 22 hosted tools (#2312's three record-reading money-path tools plus #2348's four crossover tools), everything else still strips, and the three named spellings (`idempotencyKey`/`idempotency_key`, `quote`/`payment_required`, the local-only `body` on `haven_quote_x402`) all still hold. This PR changes a doc comment and a test in that file and nothing else — no tool joins or leaves the strict set, so no claim in this entry moves. The Supported Runtime Manifest table, the Node floor, the version constants, the header-name section and the connector profiles were NOT re-verified in this pass and were not touched. Full analysis in docs/regulatory/casp-changelog/2026-09-01-2363.md. Prior: #2348: re-verified and EDITED (the strict-input troubleshooting entry only). Its first bullet said STRICT_INPUT_TOOLS "starts with the money-path tools that read from the payment record rather than from arguments" and that "everything else still strips" — true on 2026-09-01 morning, stale by that afternoon: #2348 added the four ARGUMENT-driven crossover tools (haven_send, haven_pay_mcp_tool, haven_quote_x402, haven_pay_x402_quote), which is the opposite category. Second bullet extended with the local-only `body` (the third crossover shape, not just the two case/name ones) and with the fact that the refusal now NAMES the hosted spelling, so an operator hitting unrecognized_keys no longer has to look the mapping up. The Supported Runtime Manifest table, the Node floor, the header-name section and the version constants were NOT re-verified in this pass and were not touched — release-bump.mjs owns that table. Prior: #2361: re-verified, EDITED (Hosted-runtime connector profiles — the fast-settle envelope sentence). The v2 payment envelope now carries optional verbatim `resource`/`extensions` echoes of the merchant challenge; the sentence pinned the exact three-key shape, which would have read the echoing signer as unsupported. Both forms are accepted by the hosted preflight (`validateStandardX402PaymentHeader` widened with the two optional keys, structurally checked). No connector profile, runtime pin, Node floor or consent surface moves; the Supported Runtime Manifest is untouched. Only that sentence was re-verified in this pass. Prior: #2347: re-read the version-skew section only (rows, Zod strings and the "do not rewrite auth.version" guidance), against `packages/signer/src/core.ts` on `dev`. EDITED one word: the guidance said rewriting the field "misrepresents what Haven authorised"; Haven signs this binding and nothing more, so it now says "declared", the word `signer/src/settlement-child.ts` already uses for this binding. No row, code, version set or behaviour claim changed. Prior: #2312: re-verified, EDITED (Signer / hosted-MCP version skew section — one new subsection). The skew table teaches the -32602 "Input validation error" vocabulary as a version-skew signal; since #2312 a CURRENT runtime can get the same -32602 for an undeclared argument, so the doc would have routed a name mismatch into a package upgrade. The new subsection names the real cause (the local/hosted argument spellings) and records the one server-side build constraint the change creates: a strict tool needs McpServer.registerTool, because the deprecated .tool() overload refuses a ZodObject. Measured, not assumed: the advertised JSON Schema is byte-identical strict or loose for all 22 hosted schemas, so no connector profile, runtime pin or consent surface moves. Supported Runtime Manifest, Node floor, runtime-selection and Troubleshooting sections NOT re-verified in this pass — and the manifest rows moved to 0.1.33-alpha.0 under me while this branch was open (see the entry below), which is release-bump.mjs's output and never hand-edited here: this merge takes those rows verbatim from dev and touches only the new subsection. Prior: 0.1.33-alpha.0 release: the four manifest rows move 0.1.32-alpha.0 -> 0.1.33-alpha.0. That half is mechanical — re-pinned by release-bump.mjs and verified against MCP_VERSION / SIGNER_VERSION / CONNECTOR_VERSION and the connect runtime-manifest — so what is verified BY HAND here is the claim the table cannot make: that nothing in this span is a compatibility break. The release carries epic #2288's client half (#2289 wire header name, #2290 signer funded-retry window, #2291 signer binding-retirement contract, #2292 one new HOSTED tool, #2330 agent-facing descriptions, #2341 the erc7710 header-name narrowing that fixed the HTTP 431 #2289 introduced on that scheme) plus #2262, #2280, #2245 and #2301; each slice already argued its own consent and skew position in the chain below and those arguments are not restated. The SPAN-WIDE claim is checked rather than inherited from them, because a per-slice "adds no tool" does not compose into a per-release one: packages/mcp/src/tools.ts and packages/mcp/src/consent.ts are BYTE-UNCHANGED across 273cf376..0f7fa978, so registeredToolNames() returns the same sorted names, computeConsentHash is unchanged, and NO operator is re-prompted on upgrade. The span was re-checked, not carried over, after #2341 landed and widened it: #2341 edits packages/mcp-server/src/tools.ts descriptions and HOSTED_INSTRUCTIONS, neither of which is the local schema map the hash is computed over. #2292's new tool is hosted-only and never enters that map. SUPPORTED_X402_EXPECTED_VERSIONS is untouched in the same span, as are the expected-context shape and the >= 22.0.0 Node floor. No new skew axis: an older runtime on this release carries older agent GUIDANCE (#2330) and an older signer refusal shape (#2291), neither of which is negotiated with the backend and neither of which fails closed on version — carrying stale guidance is the defect being fixed, not a break. Prior: #2341: re-verified, EDITED (Signer / hosted-MCP version skew section). #2341 scopes the x402 payment header names by SETTLEMENT SCHEME: both (PAYMENT-SIGNATURE + X-PAYMENT) on the EIP-3009 bridge, PAYMENT-SIGNATURE ALONE on erc7710, whose header carries a delegation chain and was refused with HTTP 431 when duplicated. Consent is UNAFFECTED and checked rather than assumed: no tool is added, removed or renamed, packages/mcp/src/tools.ts and consent.ts are byte-unchanged, so registeredToolNames() and computeConsentHash are identical and no operator is re-prompted. **This IS a real skew axis, unlike #2330's description-only pass, and is recorded as one.** deliverPayment lives in @haven_ai/sdk, so a client pinned at <= 0.1.32-alpha.0 keeps sending BOTH names on erc7710 and keeps hitting the 431 until it upgrades; nothing negotiates this and nothing fails closed on it, because the merchant's header limit is not a Haven contract. The failure is loud (HTTP 431, MERCHANT_REJECTED_AFTER_FUNDING on the hosted path) rather than silent, and it is the SAME failure those versions already have — this release fixes it, it does not introduce a new incompatibility. Hosted-server guidance (HOSTED_INSTRUCTIONS) is served by the deployment, not the client, so an old client connecting to a new server DOES get the corrected instruction for its own manual retries even before it upgrades. SUPPORTED_X402_EXPECTED_VERSIONS, the expected-context shape, the signer surface and the Node floor are untouched.
# #2253: The release-time completeness gap noted above is resolved by the
# dedicated `--unwire` Troubleshooting entry below; verified against Connect's
# argument parsing, teardown behavior, and published operator guide.
---

# MCP Runtime Compatibility

> **Scope:** This covers the **local stdio MCP runtime** installed during agent
> setup — the advanced/local path. For the default topology (hosted MCP + local
> signer) and how to deploy it, see [hosted-mcp.md](hosted-mcp.md).
>
> **Recent re-verification (#2258):** Connect's `pending_approval` wording
> describes zero spending authority, with the exact sweep-recovery exception
> documented as stranded-balance recovery only. This does not change the local
> runtime's capabilities, consent hash, or version-skew contract.
>
> **Two sections sit outside that scope**, each for its own reason:
>
> - [Where the Node floor is enforced](#where-the-node-floor-is-enforced) applies
>   to **both** topologies. The floor is a property of the machine, not of the
>   chosen topology — scoping it to the local path is exactly the mistake
>   [#1161](https://github.com/d-hinders/Haven-AI/issues/1161) fixed, so it is
>   documented in one place rather than split across two.
> - [Signer / hosted-MCP version skew](#signer--hosted-mcp-version-skew-1138-1143)
>   and its [pre-payment detection](#detecting-skew-before-a-payment-1155)
>   subsection are the **opposite** case: they apply only to the hosted MCP +
>   local signer topology, because skew needs two independently versioned
>   components and the local runtime signs in-process with the SDK it shipped
>   with. They live here because this is the runtime-compatibility doc, not
>   because they describe the local path.

Haven Connect Agent 2 installs a local stdio MCP runtime for Codex Desktop,
Codex CLI, and Claude Code. The connector must not rely on `npx` at agent
startup; setup preinstalls a tested runtime and writes a stable wrapper:

`haven_discover_tools` remains skew-flat across the local and hosted MCP
topologies: since #1350 it accepts the same optional `search` argument on both
surfaces, alongside the existing `category` and `rail` filters. `category`
matching is case-insensitive after trim, `search` matches catalog `name`,
`description`, or `category`, and omitting the new field preserves the older
request shape exactly. Since #1716 both surfaces also accept the same optional
`verified` (`any` | `verified` | `operator`) provenance filter and return the
`source` / `domain_verified` / `verified_payable` badge fields on each entry —
added to BOTH surfaces together, so the skew-flat claim holds unchanged. The
result is still read-only discovery metadata: catalog prices are indicative
hints, never payment authority, and the badges mean domain-controlled and
verified-payable only.

The default hosted MCP + local signer topology additionally exposes
`haven_quote_mcp_tool` and `haven_quote_catalog_purchase` (#1397). They are
read-only live-price probes for an arbitrary MCP merchant or a curated catalog
entry: no payment intent, approval, signing context, allowance check, funding,
or paid retry is created. Their response is informational only; a later hosted
`haven_pay_mcp_tool` or `haven_prepare_catalog_purchase` always obtains a fresh
quote and enforces its own cap before creating an intent. The local stdio MCP
intentionally does **not** expose these tools yet: its current one-shot payment
path cannot honor that quote-then-pay cap/re-quote contract, so publishing the
same names there would imply a safety guarantee it cannot make.

`haven_pay_x402_quote` — the generic plain-HTTP x402 entry point — selects its
settlement scheme the same way since #2041, using the shared #1450/#1453
preference rule rather than hard-routing to the EIP-3009 bridge. On the
delegation rail against a merchant advertising
`extra.assetTransferMethod: "erc7710"` it composes `prepareX402Erc7710` and
returns the `settlement_scheme` / `settlement.funding_leg` fields
`haven_pay_mcp_tool` already returns; every other case is byte-identical to
before. It carries **no new skew row**, for two reasons worth stating rather
than implying: the local stdio MCP's `haven_pay_x402_quote` is a different,
key-holding one-shot path that was never the surface this table describes, and
the erc7710 shape (like `haven_pay_mcp_tool`'s and
`haven_prepare_catalog_purchase`'s) carries no `signer_compatibility` — the
signer's own signing-time refusal is the guard there.

`haven_submit` gains an OPTIONAL `settlement_scheme` (`erc7710` | `eip3009`) in
the same change, so the generic erc7710 flow has a settle leg: on `erc7710` the
signature is the settlement child rather than a funding authorization, so it
goes to `POST /x402/:id/settle` and the response carries the Haven-assembled
`payment_header` with `tx_hash` / `funding_tx_hash` null — there is no
Haven-submitted transaction on that scheme. Omitting the field, or sending
`eip3009`, relays the funding signature exactly as before, so **every existing
caller is unchanged and there is nothing to upgrade**. `haven_submit` is a
hosted-only tool — the local stdio MCP does not expose it — so nothing here is
skew.

An **erc7710-ONLY merchant** — no untagged `accepts[]` entry — is reachable
through `haven_pay_mcp_tool` and `haven_prepare_catalog_purchase` since #2054:
the shared quote helper (`buildX402Quote`) describes the erc7710 entry when no
standard one exists instead of refusing the merchant outright. Additive shape,
stated so nobody re-derives it: the **hosted** read-only quote tools
(`haven_quote_mcp_tool`, `haven_quote_catalog_purchase`, and the hosted
`haven_quote_x402`) gain `accepted_scheme: 'standard' | 'erc7710'` plus
`erc7710_only: true` on the erc7710 case — new fields only, nothing existing is
renamed or retyped — and the two purchase tools gain one new refusal,
`ERC7710_RAIL_REQUIRED`, raised when the account's rail cannot settle the
merchant's only compatible entry (or the rail could not be read). It is a
`code` on the standard failure envelope, not a wire-enum change; no tool
argument changed, no capability handshake, no signer surface, and the Supported
Runtime Manifest table is untouched.

One **deliberate local/hosted skew**, recorded because this table exists to
catch exactly that: the **local stdio** `haven_quote_x402` is a bare
passthrough of the SDK's `X402Quote`, so it now also QUOTES an erc7710-only
merchant (it used to throw) — but it returns the SDK's own `acceptedScheme`
(camelCase) and no `erc7710_only` convenience field, since none of the hosted
response shaping runs there. The local **pay** paths are unchanged in behavior
(`HavenClient.fetch` / `authorizeX402` / `payX402Quote` still re-select through
`selectStandardPaymentOption` and refuse an erc7710-only merchant — a
key-holding EIP-3009 path cannot settle it); what changed is only the refusal
TEXT, which now names the erc7710 tag as the reason
(`noCompatiblePaymentOptionError`) instead of implying Base USDC is the limit,
so the quote-succeeds-then-pay-refuses sequence is legible rather than
contradictory.

`haven_submit_catalog_entry` (#1716) is also skew-flat: both surfaces expose
the same queue-only submission tool (same `resource_url` + honeypot `website`
input, same id/verify_token/status output). It writes a submission row only —
no outbound request, no token reuse, no authority — and domain-ownership proof
plus the read-only quote probe still gate any listing on the backend.

```text
~/.haven/agents/<agent-id>/bin/haven-mcp
```

## Supported Runtime Manifest

The source of truth is `packages/connect/src/runtime-manifest.ts` (the SDK and
signer versions are pinned there; `@haven_ai/mcp` tracks its own `MCP_VERSION`,
and `@haven_ai/connect` its own `CONNECTOR_VERSION`).

**Do not re-pin the four `@haven_ai/*` rows by hand.** Since
[#1790](https://github.com/d-hinders/Haven-AI/issues/1790) `npm run release:bump`
writes them, and a check compares each row against its own constant — on every
release *and* on every pull request, so a hand-edit that drifts from the source
fails CI rather than quietly becoming a false compatibility claim. The
`last-verified` note above is still written by hand; that is the part of this
doc that carries an argument rather than a number.

| Component | Supported version |
| --- | --- |
| Node.js | >= 22.0.0 (`engines` floor; repo development and CI pin LTS 24 via `.nvmrc`) |
| `@haven_ai/connect` | `0.1.34-alpha.0` |
| `@haven_ai/mcp` | `0.1.34-alpha.0` |
| `@haven_ai/sdk` | `0.1.34-alpha.0` |
| `@haven_ai/signer` | `0.1.34-alpha.0` |
| Codex Desktop / Codex CLI | local stdio MCP via `~/.codex/config.toml` |
| Claude Code | local stdio MCP via `claude mcp add-json --scope user` |

**This table describes the PRODUCTION channel — the `alpha` and `latest`
dist-tags — and only that.** Since [#2421](https://github.com/d-hinders/Haven-AI/issues/2421) a push
to `dev` also publishes a snapshot of all five packages under the **`dev`**
dist-tag at `0.0.0-dev.<YYYYMMDDHHMM>.<shortsha>`, so `npx @haven_ai/connect@dev`
installs a different set of versions from the ones above. That is not drift and
this table is not stale when it happens:

- the snapshot bump runs in a **throwaway CI tree**. It rewrites this table
  there, exactly as a release does, and the tree is discarded — nothing is
  committed to `dev`, so the committed table keeps naming the production
  versions. There is deliberately **no docs check run against the snapshot
  tree**: it would be checking a file nobody will ever read.
- a snapshot's four `@haven_ai/*` rows are *internally* consistent for the same
  reason a release's are — one bump script rewrites every version, pin and
  constant together. `npx @haven_ai/connect@dev --version` prints the snapshot
  version, and the signer and SDK it installs carry it too.
- `0.0.0-` sorts below every real version, and the two channels cannot cross:
  a snapshot can reach neither `alpha` nor `latest`, and the `main` path
  refuses a `0.0.0-dev.*` version outright. The enforcement points are named in
  the header comment of `.github/workflows/publish.yml`.

The **version-skew contract below is unchanged by the dev channel**, and reads
the same on both: a signer must be paired with a backend that emits an
`x402_expected_context_version` it knows. What the `dev` tag adds is the ability
to test that pairing before a production release rather than after one. How to
run that test — merge, wait for the run, poll `npm view`, install against the
dev backend, `--doctor` — and the owner steps that make the dev dashboard hand
out `@dev` are in [`package-dev-channel.md`](package-dev-channel.md): this doc
is the contract, that one is the runbook.
### The connector channel is a fifth bump-managed constant (#2423)

Every "re-run `npx @haven_ai/connect@<tag>`" hint the published packages emit —
in `@haven_ai/connect`'s doctor, repair, re-key and tombstone messages, in the
signer's capability text and its version-skew refusal, and in the SDK's shared
`SIGNER_UPDATE_FALLBACK` — renders from a single build-time constant,
`HAVEN_CONNECTOR_CHANNEL` in `packages/sdk/src/connector-channel.ts`.

**Do not hand-edit it either.** `npm run release:bump` writes it from the
version being cut, by the same rule `.github/workflows/publish.yml` uses to
choose `npm publish --tag`:

| version | channel |
| --- | --- |
| `0.1.34-alpha.0` | `alpha` |
| `0.0.0-dev.<ts>.<sha>` | `dev` |
| `0.2.0` | `latest` |

Read as one sentence: a prerelease publishes under its own prerelease label, a
stable version under `latest`. Two guards keep the two halves honest, and they
fail differently. `scripts/release-bump.test.mjs` **executes** the workflow's
own `case` block in `bash` and compares its answer to the bump script's for the
same versions, so a rewritten-but-equivalent workflow passes and a
rewritten-and-different one fails; the same suite compares the constant on disk
against `packages/sdk/package.json`'s version on every pull request, which is
what catches a bump that stopped writing it. `scripts/verify-connect-bundle.mjs`
then checks the BUILT SDK by calling its helper, catching a stale
`packages/sdk/dist` that would ship hints for the previous channel — the same
failure the `mcpVersion` check above exists for, one constant over.

**The hosted MCP server is the exception, because it is deployed rather than
published.** It reads the `HAVEN_CONNECTOR_CHANNEL` **environment variable** at
startup and falls back to the SDK constant, so an unconfigured deployment names
the production channel exactly as before. A malformed value refuses the boot
rather than falling back — a silent fallback would put the production connector
in front of a deployment that looked configured. Which value any given
environment sets is an operator action this repository cannot observe and does
not record here.

## Hosted-runtime connector profiles

For the hosted fast-settle path, the local signer may produce either the
supported legacy x402 v1 envelope or the current v2 `{ x402Version, resource?,
accepted, payload, extensions? }` envelope — since #2361 the signer echoes the
merchant challenge's `resource` and `extensions` verbatim when the challenge
carries them (the extensions echo is an x402 v2 spec MUST, and a strict live
facilitator rejects its absence, #2360), so a v0.1.33-or-earlier signer's
echo-less three-key envelope and the current echoing one are BOTH accepted.
Hosted MCP validates either recognizable form against the persisted intent
before it relays funding — the echoes are checked structurally, never against
the intent, since they are merchant data rather than spend authority. A
malformed, unsupported, expired, or mismatched header returns
`INVALID_PAYMENT_HEADER` with no funding relay; recreate it through the local
signer from the same `payment_id`. This preflight does not replace merchant or
facilitator verification.

The default Connect topology writes a keyless hosted Haven MCP entry plus a
separate local `haven-signer` stdio entry; it is distinct from the local-stdio
runtime described above. Hermes Agent is a supported hosted-runtime profile:
Connect writes `$HERMES_HOME/config.yaml` and its matching owner-only `.env`
when `HERMES_HOME` is set, otherwise `~/.hermes/config.yaml` and `.env`. The
hosted API key stays in `.env`; config uses the `Bearer ${MCP_HAVEN_API_KEY}`
template. Connect preserves source text outside `mcp_servers` and replaces only
the `mcp_servers.haven` and `mcp_servers.haven-signer` entries.
Hermes discovers MCP servers at process startup, so start a new session (or run
`/restart` for a gateway). Hermes also needs its Python MCP SDK installed (`pip
install mcp`) to load MCP tools.

## Runtime selection is detection-first (#1672)

Which runtime's config the connector writes is resolved in
`packages/connect/src/runtime-registry.ts` (`resolveRuntimeSelection`), in this
precedence order:

1. `--runtime-force <name>` always wins (an unknown name refuses, listing the
   valid values).
2. Environment detection (`CLAUDECODE`/`CLAUDE_CODE` → claude-code,
   `CODEX_SANDBOX`/`CODEX_HOME` → codex-cli, `VSCODE_*` → vscode,
   `HERMES_*` → hermes) **beats a contradicting `--runtime` hint**, with a
   printed one-line notice. Detection only fires inside a real agent shell,
   where writing a different client's config is almost surely wrong — the
   failure this closed was a `--runtime claude-desktop` hint pasted into
   Claude Code, which would have configured the Desktop chat app and left the
   Code session with no Haven entries.
3. An explicit `--runtime` with no contradicting detection applies as given —
   the plain-terminal "configure Claude Desktop by hand" case, unchanged.
4. Detection alone.
5. **The agent's own answer (#1719).** When nothing was detected, an agent
   executing the command may say which harness it is — by re-running the
   command once with `--runtime <name>` added. It enters at rung 3's
   precedence, which is the whole reason it is safe: a self-report can only
   fill a vacuum, and loses to a detection exactly as a typed hint does. The
   dashboard's setup prompt permits that one retry explicitly (see below), and
   the refusal at rung 7 is written as an instruction to the agent rather than
   to a human.
6. **The clients installed here (#1719).** When nothing was detected and stdin
   is an interactive terminal, the connector scans for the config locations it
   can actually write (`~/.claude`, `~/.codex/config.toml`, `~/.cursor/mcp.json`,
   the VS Code / VS Code Insiders user `mcp.json`, a workspace `.vscode/`,
   Claude Desktop's `claude_desktop_config.json`, `$HERMES_HOME/config.yaml`)
   and offers **only those**, likeliest first — an existing MCP config outranks
   a bare client directory. The scan **populates the choices; it never
   selects.** Finding exactly one installed app still prompts, because an
   installed app tells you what exists, not where the user wants their agent to
   run, and a silent wrong write plants an API key and a delegate key in an app
   they do not use. This rung is **omitted entirely** — not answered — under
   `--json` and whenever `process.stdin.isTTY` is false, so CI and automation
   reach the refusal instead of blocking on stdin.
7. Nothing known → the connector **refuses before any side effect** (the
   #1161 discipline: no half-created agent, no burned setup token), naming
   the valid `--runtime` values.

An `--runtime` value that is not a runtime name at all is not a hint, it is a
mistake, and it must never fall through to a config location nobody asked for.
With no detection to fall back on it refuses (`runtime_unrecognized`). With a
detection it loses to it *loudly* — a printed notice naming the value that did
nothing — because the detected client is the right write either way, and
refusing there would turn every rollout window in which the dashboard learns a
picker id before the published connector does into a hard failure.

### Failure vocabulary for runtime selection (#1719)

Each of these is a stable `code` with a next action, raised as a `ConnectError`
and surfaced through `--json` as `error.code` / `error.next_action`. They are
additive and never renamed.

Since [#2091](https://github.com/d-hinders/Haven-AI/issues/2091) the `--json`
failure record also carries (additively, still `schema_version` 1):

- `error.message` — the redacted refusal prose, for every `ConnectError`. Only
  the connector-authored vocabulary is serialized; a plain `Error`'s message
  (which can carry arbitrary server/filesystem detail) stays out of the JSON.
- `error.allowed_runtimes` — on the three runtime-selection refusals
  (`runtime_undetermined`, `runtime_unrecognized`, `runtime_force_unrecognized`),
  the exact `--runtime` values a retry may use, as an array. The values used to
  live only in the prose, which `--json` discarded — while the backend's setup
  prompt permits a retry only with "one of the values that refusal lists". A
  Codex agent followed both rules and deadlocked; this field is what makes the
  rung-5 self-report reachable from automation.
- On every `--json` failure path the redacted message is also **mirrored to
  stderr** (stdout stays one pure-JSON line), so the prose channel is never
  silently discarded.

Since [#2174](https://github.com/d-hinders/Haven-AI/issues/2174), a
`runtime_undetermined` refusal also carries what the installed-client scan
found on **this machine** (additive, still `schema_version` 1):

- `error.installed_clients` — runtime ids the scan found, likeliest first. This
  is the same rung-6 scan described above, whose interactive prompt `--json`
  deliberately omits; before this the finding was thrown away in automation,
  leaving a retrying agent to pick from the nine-value `allowed_runtimes` menu
  on self-knowledge alone. `allowed_runtimes` says what is *permitted*;
  `installed_clients` says what is *here*.
- `error.suggested_runtime` — the top hit, and only when it is unambiguously
  top: a lone candidate, or a live MCP config file outranking bare client
  directories. Two candidates in the same evidence tier are separated only by
  the scan's fixed order, which is a preference rather than a fact about the
  machine, so no suggestion is offered there.

**The scan populates choices; it never selects.** This is #1719's invariant and
it is unchanged: a `suggested_runtime` is a value the agent may echo back as
`--runtime`, never a selection the connector makes. Finding exactly one
installed client does **not** flip the outcome to success — an installed app
tells you what exists, not where the user wants their agent to run, and the
cost of being wrong is an API key and a delegate key written into an app they
do not use. The outcome stays `failed` with
`rerun_connect_with_explicit_runtime`, and the retry stays explicit.

Both fields are **absent** when the scan found nothing *or* could not run: the
scan is best-effort and read-only (filesystem existence checks, before any
setup token is resolved and before any key or credential exists), and a scan
error degrades to the un-hinted refusal rather than replacing a precise refusal
with a filesystem error. An empty array is deliberately not emitted — it would
assert a finding that neither case made. The prose message names the same
clients, so the human and machine channels cannot disagree about one machine.
`runtime_unrecognized` and `runtime_force_unrecognized` are unchanged: the hint
answers "nothing is known", not "what you named is wrong".

Additionally, a dead setup token (the backend's 410 "Setup token expired" —
the token's TTL is 30 minutes — or 401 "Invalid setup token") is now
classified as `setup_challenge_expired_or_invalid` with next action
`return_to_haven_for_fresh_setup`, instead of degrading to the generic
`connect_failed` because the wording missed a legacy regex. The check runs at
both token-bearing calls, `resolveSetup` and `registerSetup` — the TTL can
lapse in the gap between them. Per the #1719 rule, the failure mode joined
the `ConnectError` vocabulary rather than the regex ladder.

| Code | When | What to do |
|---|---|---|
| `runtime_undetermined` | Nothing detected, no `--runtime`, no self-report, and no interactive terminal (CI, `--json`, a pipe) | Re-run with `--runtime <name>`; `other` stores credentials and prints the manual MCP steps |
| `runtime_unrecognized` | A supplied `--runtime` / self-report is not a runtime Haven knows, with no detection to carry the run | Re-run with one of the listed values — never a guessed one |
| `runtime_force_unrecognized` | `--runtime-force` names something unknown | Re-run with a valid name |
| `runtime_no_installed_clients` | Interactive terminal, but no client Haven can configure is installed | Re-run with `--runtime <name>`, or `other` |
| `runtime_prompt_aborted` | Ctrl-C / EOF at the prompt, or three invalid answers | Re-run and choose, or pass `--runtime` to skip the prompt |
| `runtime_config_unreadable` | The chosen client's config file exists but is not parseable JSON/YAML | Fix (or move aside) the named file, then `--doctor --repair --runtime <name>` — **not** the setup command |

The first five refuse **before any side effect**, so there is nothing to
recover from: no agent registered, no key minted, no credential written, and
the setup token still unused — each pinned by a mutation-proof test. Because
they precede the setup-token resolve, they are also the connector's exit
contract only: with no agent and no API key there is no authenticated channel
to report them on, so they never appear in the dashboard's `install_status`.

`runtime_config_unreadable` is the exception, and the only one of the six that
reaches the dashboard (`runtimeStatusHelper`): it happens after credentials
exist, during the config write. It is deliberately distinct from its
retryable sibling `runtime_config_write_failed` — an unparseable config fails
identically on every re-run until the file itself is fixed. Parsing happens
**before** the write, so the file is left byte-identical. Codex keeps its own
older `codex_config_invalid` for the same class.

Its recovery is `--repair`, **not** a re-run of the setup command, and the
reason is the ordering: this failure lands after `registerSetup` consumed the
one-shot setup token, so the pasted command now 409s at `/resolve`, and
starting a fresh connection instead would mint a SECOND agent
([#1688](https://github.com/d-hinders/Haven-AI/issues/1688)). `--repair`
rewrites exactly this config from the credentials already on disk — no token,
no new agent — so it is what both the connector's message and the dashboard's
status helper point at.

Accordingly, the dashboard's generated setup command carries **no `--runtime`
flag at all** ([#1720](https://github.com/d-hinders/Haven-AI/issues/1720)).
Every user gets the identical command; the connector resolves the runtime with
the ladder above and reports it back through the setup status, and the
dashboard's runtime-specific copy keys off that reported value. Two known
detection limits: Codex Desktop's environment detects as `codex-cli` — both
write the same `~/.codex/config.toml`, so the config lands correctly and only
restart phrasing can differ. And **Codex commonly detects as nothing at all**
([#2091](https://github.com/d-hinders/Haven-AI/issues/2091)): the `CODEX_*`
variables rung 2 sniffs are only present for sandboxed commands (or a
customised `CODEX_HOME`), and `npx` needs network, which Codex runs escalated
— outside the sandbox. An undetected-Codex run reaching the rung-7 refusal is
therefore the *expected* Codex path, and the `--runtime codex` self-report
retry (rung 5) is its designed continuation, which is exactly why the refusal
must stay actionable under `--json` (below).

### There is no picker (#1720)

The dashboard asks nothing about the runtime. It never had a way to answer:
a browser sees no environment markers, no installed clients and no live agent,
while the connector sees all three. So the question moved to the component that
can answer it, and every user now gets a **byte-identical** setup command.

`#1682` had made the picker a flat list of nine product names, replacing
`#1672`'s single collapsed "AI agent (Claude Code, Codex, Cowork)" row. That
row asked users to classify their own app — a question a Hermes or OpenClaw
user answers "yes, mine is an AI agent" and gets wrong. The named rows fixed
the mis-classification; `#1720` removed the question. The row → modality
mapping `#1682` introduced is what made this safe to reason about, and the rows
themselves were transitional.

The **id vocabulary survives the picker**, because ids still arrive from two
places that are not a user's choice:

| id | Meaning now |
|---|---|
| `claude-code`, `codex`, `codex-cli`, `codex-desktop`, `cowork`, `agent` | reported by the connector after detection; `cowork` is an alias resolving to `claude-code` |
| `claude-desktop`, `cursor`, `vscode`, `vscode-insiders`, `openclaw`, `hermes`, `other` | reported by the connector after a self-report, a prompt, or an explicit `--runtime` |

The backend still **accepts and stores** a `runtime` an older client sends, so
setup rows created before this change keep reading back correctly; it simply
never spells one into the command. An explicit unsupported runtime is still
refused for `local_mcp`, where the answer is known at setup time.

**What this cost, deliberately.** The consent text a user approves before
anything runs is now generic — "update the local agent MCP config when
supported" for everyone, where it once named `~/.codex/config.toml` or the
Hermes `.env`. A universal prompt cannot be specific about a runtime it does
not know. This is a real loss of precision, bounded by the fact that it is
already what every command-path user saw.

The Hermes-specific block that used to ride in the dashboard prompt is gone
with it. Its substance is emitted by the connector itself once Hermes is
configured — restart guidance including `/restart` for gateway users,
`hermes mcp list` / `hermes mcp test`, and the `pip install mcp` fallback —
which is both later and better placed. The one line without a connector
counterpart, "do not run `hermes mcp add`", is subsumed by the prompt's
universal rule that only two changes to the command are permitted.

**OpenClaw needed a published connector, and now has one.** The `openclaw`
alias lives in `runtime-registry.ts`, and `npx @haven_ai/connect@alpha`
resolves to whatever is on npm — so the alias shipped only with release
`0.1.29-alpha.0`. Note what that required: a Railway/Vercel deploy is NOT
enough, because `publish.yml` skips any version already on npm, so an alias
ships only behind a `npm run release:bump`. The alias resolves `openclaw` to
the `other` profile, because "credentials on disk, no auto-written config,
paste the snippet" IS the OpenClaw flow. An id the published connector does not
know still refuses before any side effect — since #1719 as
`runtime_unrecognized`, naming the values it does know.

Pre-run, the dashboard knows nothing about the environment, so the "your app
may ask you to approve running the setup command" heads-up shows for everyone
during the waiting state, sharpening to app-specific wording once the
connector's resolve reports the detected runtime. `--doctor`/`--repair` still
require an explicit `--runtime` (they examine a stored config, which is a
choice, not a detection).

**A failure the dashboard cannot name.** The runtime-resolution refusals above
(`runtime_undetermined`, `runtime_no_installed_clients`, `runtime_prompt_aborted`,
`runtime_unrecognized`) all fire *before* the connector contacts Haven, so no
setup row records them and the modal has nothing to render. It falls through to
the waiting state's recovery block, which since #1720 sends the user to the
connector's own output — which does name the problem — before suggesting a
re-run, because a re-run reproduces that refusal exactly.

## Guidance surfaces (skill parity, #1332)

Setup also installs the generic, secret-free payment skill wherever the
runtime has a documented instruction mechanism. The substance is the single
canonical string in `packages/sdk/src/skill-content.ts` on every runtime —
only the wrapper differs, never the content:

- **Claude Code** — `~/.claude/skills/haven-pay/SKILL.md` (canonical bytes).
- **Hermes** — `$HERMES_HOME/skills/haven-pay/SKILL.md` (default
  `~/.hermes/skills/…`); Hermes auto-discovers SKILL.md skills in the same
  front-matter format, so the file is byte-identical to the Claude install.
- **Codex CLI / Codex Desktop** — a marker-delimited managed section in the
  global `~/.codex/AGENTS.md` (Codex's documented global-guidance file, shared
  by both). The section carries the skill body without front matter
  (`HAVEN_SKILL_BODY_MD`); re-runs replace the section in place, everything
  outside the markers is preserved byte-for-byte, and a damaged marker pair
  makes the write fail closed with the file untouched. `AGENTS.override.md` is
  never written.
- **Every other runtime** (Cursor, VS Code, Claude Desktop, `other`) — no
  documented instruction file; the MCP server-level initialize instructions
  carry the baseline guidance and nothing is written.

A guidance write happens only when the runtime config write itself succeeded,
and a failed skill install never fails the setup — the messages point at the
dashboard download instead.

## Completion handoff after Connect

The published `haven-connect` package is also checked through the npm bin
topology: the package smoke test invokes its packed `node_modules/.bin`
symlink, not only `node dist/cli.js`. This matters because Node keeps the
symlink path in `argv[1]`; Connect resolves it before deciding whether it is
the program entrypoint. A command that exits with no output before it creates
the local files has not registered an agent and must not be described as a
completed connection.

The connector's final output is deliberately short, ordered, and — since #1542
— shaped by what its own approval wait observed. When the budget is still
pending (or the wait was skipped): return to Haven to approve the budget first,
activate the current runtime second, then run the read-only `haven_get_agent`
and `haven_get_allowances` tools to confirm the Haven wallet and live budget.
Approval — not a restart — unlocks Haven tools. When the wait itself saw the
approval land, the handoff confirms it instead of re-requesting it — the
connector never celebrates the approval and then instructs the user to go
perform it — and only the activation and verification steps remain. When the
setup ended in Haven during the wait, the single next step is a fresh
connection from the dashboard. One name for the gate throughout the
connector's output: the **budget** (never "agent rules"). The activation step
for restart-bound runtimes also states why it survives the connector's own
in-process verification: session/app-scoped runtimes only read MCP config at
start-up. The verification must not sign, fund, or create a payment.

Since #1377 the connector does not go silent after registering, and since
#1543 the budget-approval unlock no longer waits for the whole install: the
moment the runtime MCP config write settles — before the network probes and
the skill install, whose tail approval does not depend on — the connector
sends an early, best-effort install-status report carrying the config-write
facts (configured/consent booleans, restart and next-action state; no probe
verdict, no skill state), which is what the dashboard's approval unlock
actually reads. When that early report is DELIVERED, the connector prints an
imperative approve-the-budget call-to-action at that exact moment
([#2279](https://github.com/d-hinders/Haven-AI/issues/2279) — the field
failure was a user watching the live dashboard button for minutes while the
terminal ran the install tail in silence). Two things silence the CTA, for
two different reasons: an early report that never arrived (the button may
not be live yet — though the unlock itself accepts a delivered report in
either state, clean or errored), and a delivered errorCode whose completion
handoff will say "start a fresh connection" (a fresh connection mints a NEW
agent, #1688, so "approve now" would spend the approval on a setup the run
is about to disown — `manual_runtime_setup_required` is the errorCode whose
handoff still recommends approving, and it keeps the CTA). Known limitation,
inherent to the two-report design: the CTA fires before the probes, so a
probe failure discovered after it can still end the run in fresh-connection
guidance — the early report is explicitly a bet that the probes will turn
out fine, and delaying the CTA past them would recreate the silence #2279
exists to close. In the silent
cases the instruction first reaches the user with the wait flow
below. After probes and skill install finish it makes the complete
install-status report — still the authoritative one, refining the same keys
with probe verdicts and skill state, and the fallback unlock path when the
early report failed (either report's failure is silent and cannot activate an
agent or change budget authority). It then polls the narrow read-only
`connector-status` endpoint (pending agent
API key, usable while `setup_pending`-scoped) and waits for the budget approval
— an immediate first check (#1542: users routinely approve while the install
is still running, and the "waiting for you to approve" line is only printed
once a check has actually observed a pending state, never ahead of a first
check that may find the wait already over), then every 5 seconds, for at most
3 minutes, with a progress reminder every 30 seconds that states elapsed time,
the poll cadence, and the give-up bound (#2279 — so a watcher can tell active
polling from a hang, and the bound is visible before it fires; the waiting
line itself is phrased as status, since the CTA above already carried the
ask). A failed report remains
readiness metadata only: it cannot activate an agent or change any budget
authority. On approval it prints a celebratory line
naming the granted authority (amount, token, reset period); on a terminal setup
status it says the setup ended in Haven; at the bound it exits cleanly with
"approve whenever ready" guidance — the connector always terminates on its
own. A flaky poll is retried inside the same bound, never treated as a verdict.
`--json` automation runs skip the wait entirely so the structured outcome is
emitted promptly.

Before registration, the dashboard stages what it says about a missing
connection over three periods, in one status slot that is never empty (#1399).
On arrival it says only that it is waiting for the agent to run the setup
command. After one minute of a confirmed `awaiting_connection` it acknowledges
that a first run downloads the connector before it can register — an
observation, not a warning: it offers no recovery actions and does not suggest
anything is wrong. After **three minutes** of confirmed `awaiting_connection`
it says Haven has not received a connection yet, asks the user not to approve
agent rules, offers the same local command for copying, and lets them cancel
the one-time setup before creating a fresh prompt. A status-read error resets
the clock rather than advancing it: it remains an error state, not evidence
that the connector succeeded or failed.

That three-minute bound is sized against a cold `npx` download on a poor
network — the case that most often strands this screen — and is not tied to
anything else. It happens to equal the connector's approval wait described
above, but the two are **not** coupled and must not be reasoned about as a
pair: `waitForBudgetApproval` only starts once `registerSetup` has succeeded,
and a successful register moves the setup to `connected_local`, which is
precisely the transition that ends the dashboard's `awaiting_connection` clock.
The two govern disjoint phases and can never run concurrently, so either can be
retuned on its own evidence. They live in `AWAITING_CONNECTION_RECOVERY_MS`
(`packages/frontend/src/hooks/useAgentConnectionSetupStatus.ts`) and
`waitForBudgetApproval`'s `timeoutMs` default (`packages/connect/src/runtime.ts`).

Automation can pass `--json`: Connect keeps progress and recovery prose on
stderr and emits one parseable, versioned object on stdout. `schema_version: 1`
is the stable contract; `outcome` is `complete`, `action_required`, or
`failed`. The record carries runtime/topology, configuration and probe state,
activation, next action, approval and any approval expiry, read-only
verification guidance, and — since #2173, additive within the same
`schema_version` — `hosted_mcp_url` and `superseded_agent_ids`. It is
redacted by construction: no API/private keys, credential contents, full
credential paths, or full delegate address are serialized. Library callers use
the same object at `runConnect(...).outcome`.

Activation is owned by the Connect runtime registry. Claude Code needs a new
session; Codex CLI can start a fresh session with `codex resume --last`; Codex
Desktop and Claude Desktop need a full app restart; Cursor and VS Code hot
reload; and Hermes needs a new session or `/restart` in Gateway. An unknown
runtime is the only manual case: Connect cannot write its configuration, so use
the secret-free file references it prints and then start a fresh session.

If a setup challenge has expired, return to Haven for a fresh connection and
rerun Connect. If a package install, runtime configuration, or MCP probe fails,
use the structured `error.code` and `error.next_action` (or the matching human
recovery note). Never manually edit runtime configuration or paste credentials
into prompts, logs, or configuration. The `other` runtime is intentionally
`action_required`: finish the secret-free manual setup references, then start a
fresh runtime session; do not request another one-shot setup solely because the
runtime is unrecognized.

Normal Connect output abbreviates the public delegate address. For an operator
diagnostic that needs the full public identifier, use the owner-only, non-secret
`agent.json` orientation file Connect reports. Never inspect or share
`identity.json` or `signer.json` for that purpose: they contain credentials.

### The hosted MCP endpoint is not the `--api` backend URL (#2173)

`hosted_mcp_url` is the endpoint Connect wired this run up to — written into
the runtime's MCP config, or, on a manual runtime Connect cannot configure,
printed as the endpoint to enter by hand. It is **deliberately a different
deployment** from the backend URL passed as `--api`: the hosted MCP server runs on its own service. A caller that
compares the two and finds them different is looking at intended topology, not
an environment mismatch — which is exactly how a field run read it before the
field existed, because the wired endpoint appeared nowhere in the outcome. The
value is non-secret: the same string already sits in the user's own MCP config
file, and the API key travels beside it in a header, never in the URL.

`superseded_agent_ids` makes the #1688 heads-up structural. A re-run mints a
NEW agent and retires nothing, so earlier credential directories keep live API
and signing keys; the ids of those other directories are now in the record
instead of only in stderr prose. The list is empty on a clean first run — and
an empty list is **not** proof of a clean machine, because a scan that cannot
read the credential root also yields an empty list rather than failing a
completed setup. Directories are excluded by path, never by agent id (#1696):
a named agent's directory is its slug, which never equals its agent uuid.

### Recovering the outcome after a lost stream (#2173)

Connect writes its terminal outcome to **`last-connect-outcome.json`** in the
agent's credential directory (`~/.haven/agents/<slug-or-agent-id>/`), as
pretty-printed JSON whose content is exactly the object emitted on stdout —
same shape, same secret-free construction, never credential-file contents.
Every terminal outcome lands there, all three: `complete` and
`action_required` on the return path, `failed` on the throw path. A refusal
that happens *before* credentials are written (`runtime_undetermined`, an
expired setup challenge, the Node floor) writes nothing, because no directory
exists yet and nothing was created that could need recovering. The write is
best-effort: a failure to write it never fails a setup that otherwise
completed, and never changes the verdict the run already reached.

**Guidance for agent harnesses.** Allow **several minutes** for a first run: a
cold `npm` install of the signer routinely outruns a command harness's default
watch window, and the last line such a harness sees is the install heartbeat,
not the verdict. That is a stream loss, not a failure — the setup usually
finished. Do not reconstruct completion from a runtime's own MCP listing; read
`last-connect-outcome.json` instead, which carries the activation instruction
(including `restart_required` and the "start a fresh session" step) and the
read-only verification sequence the missed stdout line would have carried.

## Where the Node floor is enforced

`>=22.0.0` is declared in three places that must agree: the `engines.node` of the
four packages this floor governs (`sdk`, `connect`, `signer`, `mcp`),
`HAVEN_MINIMUM_NODE_VERSION` in `@haven_ai/sdk`, and
`MCP_RUNTIME_MANIFEST.minimumNodeVersion`. The manifest field is **derived** from
the SDK constant, and a guard test in each of those four packages pins its own
`engines.node` to it. They cannot drift silently. `.nvmrc` is separate: it pins
the version the repo itself develops and runs CI on (LTS 24), which may sit
*above* the user-facing floor but never below it. The floor is what an agent's
machine must satisfy; `.nvmrc` is what ours does.

The floor is 22 (maintenance LTS until April 2027) rather than 24 because the
runtime uses nothing newer than `AbortSignal.any` (Node 20.3), and Node 20 is
past end-of-life — 22 is the oldest still-supported LTS
([#1352](https://github.com/d-hinders/Haven-AI/issues/1352)).

They did drift once, which is why the constant exists. `engines` said `>=24`
everywhere while the manifest enforced `20.0.0`, so the guard meant to hold the
floor passed Node v23 — and because that guard only ran inside local-MCP
installation, the **default** (hosted MCP + local signer) path never called it at
all. A full connect on Node v23.1.0 completed, installed the signer, and produced
a real testnet payment signature ([#1161](https://github.com/d-hinders/Haven-AI/issues/1161)).

`@haven_ai/cli` is **out of scope and declares no `engines` floor today** — it is
published but sits outside the connect/signer/MCP runtime this section governs.
Neither do the unpublished workspace packages (`backend`, `frontend`, `core`,
`mcp-server`, `demo-merchant-mcp`, `qa-agent`), which are pinned by `.nvmrc` in
CI instead. Read "the floor" here as the agent-runtime floor, not a repo-wide one.

That list was already correct when [#1526](https://github.com/d-hinders/Haven-AI/issues/1526)
was filed; the **manifests** were what disagreed. `mcp-server` and
`demo-merchant-mcp` lacked `private: true`, so tooling that classified by that
flag — `release-bump.mjs` and connect's `package-smoke.test.ts` — treated them
as published and demanded exact internal pins. Both are now flagged private and
use `"*"`, which is what a workspace-only consumer must use; `npm run
lint:workspace-pins` enforces both directions of that rule on every PR. Nothing
about the runtime floor, the version-skew contract, or the Supported Runtime
Manifest below moves — the published set this section governs is unchanged at
`sdk`, `signer`, `mcp`, `connect`, `cli`.

Enforcement now happens at three points, all refusing rather than warning:

| Point | What refuses | Why there |
| --- | --- | --- |
| `runConnect` (every topology) | Setup, before the setup token is resolved, credentials are written, or an agent is registered | A failed precondition must not strand a half-created agent or burn a one-shot token |
| `prepareLocalMcpRuntime` | The `--local` install | Kept; it is the deeper of the two connect paths |
| `runSignerStdioServer` / `runStdioServer` | Startup, before credentials are read | Install-time checks cannot see a Node **downgrade** after setup, or a version manager handing the agent runtime a different Node than the shell that connected |

Refusing rather than warning is deliberate. `engines` alone is advisory — npm
prints `EBADENGINE` and installs anyway unless the user runs `engine-strict` — so
before this the floor held by luck. And what gets installed is the **signer**,
which holds the delegate key and produces every payment signature; on an
unsupported runtime the plausible failure is a wrong or missing signature. "It
seemed to work" is exactly the evidence that cannot be trusted there.

## Release Checklist

> Publishing itself is automated: `npm run release:bump -- <version>` produces
> the bump, the release PR goes into `dev` (never `main` — `dev-gate` rejects a
> `release/*` branch aimed at `main`), and the later `dev → main` promotion
> triggers the **Publish packages** workflow
> (`.github/workflows/publish.yml`), which builds and publishes the
> changed packages. Do not run `npm publish` by hand. See
> [`scripts/README.md`](../../scripts/README.md) and the README's
> [Releasing npm packages](../../README.md#releasing-npm-packages) section. The
> checks below still matter — they are what CI enforces on the release PR
> before merge.

- Each published package needs its **own npm trusted publisher** (repo
  `d-hinders/Haven-AI`, workflow `publish.yml`) and a `repository` block in its
  `package.json` — configured once, per package, before its first release.
  `@haven_ai/cli` shipped without either and its first workflow publish failed
  with `E404` (#1159); the publish loop now attempts every package and reports
  per-package outcomes, but the npm-side configuration is an operator step no
  code change can do.
- Update `packages/connect/src/runtime-manifest.ts` whenever `connect`, `mcp`,
  `sdk`, or `signer` compatibility changes.
- Keep `packages/connect/package.json` and `packages/mcp/package.json` pinned
  to the tested SDK/runtime versions; do not use wildcard dependencies.
- Run `npm run test -w packages/connect` before publishing connector or MCP
  packages. CI runs connector tests whenever SDK, MCP, signer, or connector
  files change.
- Run `npm run smoke:pack -w packages/connect` before publishing connector or
  MCP packages. The smoke packs Connect plus local SDK/MCP artifacts, verifies
  the packed npm bin starts through an npm-style symlink, stages them into a
  temp Haven runtime, and verifies the wrapper can complete an MCP `initialize`
  + `tools/list` handshake.
- Verify the generated wrapper with an MCP `initialize` + `tools/list`
  handshake before setup reports local MCP as ready.
- Confirm setup output, logs, generated config, wrapper scripts, and sidecars do
  not include API keys or delegate private keys.

## Signer / hosted-MCP version skew (#1138, #1143)

`haven_sign` and `haven_sign_x402` take an optional `typed_data`, and the
x402 expected context has a second version that carries `typedDataHash`. Both
additions are backward compatible in the only direction that can actually occur
— a **v1** (legacy-rail) context is byte-identical to what shipped before, so an
older signer keeps verifying it — but the delegation rail needs both halves
current, and the failure mode differs by which half is stale:

| Stale half | Symptom |
|---|---|
| Signer older than the backend, **`@haven_ai/signer` ≥ the #1143 release** | `This signer is out of date: it supports x402 expected context versions up to <N>, and Haven sent version <M>. Update @haven_ai/signer …` |
| Signer older than the backend, **signer predating #1138** | `MCP error -32602: Input validation error: Invalid arguments for tool haven_sign_x402: Invalid literal value, expected 1 at x402_expected.auth.version` |
| Signer with #1138 but predating #1143 (forward-looking — see below) | `… Invalid input at x402_expected.auth.version` — Zod says nothing at all about a failing literal *union* |
| Backend older than the signer | `Refusing to sign typed data under an expected context that does not commit to it` |

All of these fail closed, which is the point: none produces a signature. Treat any
of them on the delegation rail as a version-skew report, not a credential
problem — and note the last is also what a *legacy-rail* intent looks like if
a caller passes `typed_data` that the context never committed to.

### An undeclared argument is refused, not stripped (#2312)

This produces the same `-32602` vocabulary as the skew rows above, and it is
**not** a skew report — a correct, current runtime gets it when it sends a key
the tool does not declare:

```text
MCP error -32602: Input validation error: Invalid arguments for tool
haven_settle_mcp_tool: [ { "code": "unrecognized_keys", "keys": ["max_amount"], … } ]
```

Read it as an argument-name mismatch, not an out-of-date package. Two things
worth knowing before you reach for an upgrade:

- **The affected tools are a declared list — and since #2353's switch that
  list is 20 of the 22.** It is `STRICT_INPUT_TOOLS` in
  `packages/mcp-server/src/tools.ts`. It began (#2312) with the money-path
  tools that read from the payment record rather than from arguments, #2348
  added the four the local MCP reaches under the same name with a different
  argument spelling, #2349 closed it with the remaining twelve, and #2353's
  switch added `haven_complete_mcp_tool` — the last money-path tool to leave
  the permissive set — once the corrected `SKILL.md` had shipped to npm
  (0.1.34-alpha.0). If you see `payment_required` in the keys of a
  `haven_complete_mcp_tool` refusal, you are carrying a pre-0.1.34
  auto-installed skill copy: the field is not taken, and Haven rehydrates the
  merchant call context AND the 402 from `payment_id`. The two that still
  strip are on their own list beside it, `PERMISSIVE_INPUT_TOOLS`, each with
  its reason: `haven_get_agent` and `haven_get_allowances` (schema `{}` — the
  handlers read no input, and a supported runtime decorates no-argument calls
  with a dummy key, so a refusal there would protect nothing and break a real
  client). A tool on neither list does not compile.
- **The most likely cause is the local-vs-hosted argument spelling**, not a
  typo: `idempotencyKey` where the hosted surface takes `idempotency_key`,
  `quote` where it takes `payment_required`, and a `body` on
  `haven_quote_x402` that only the local surface declares. Since #2348 those
  four tools say so in the refusal itself — the message names the hosted
  spelling to send instead, so the refusal is actionable without leaving the
  terminal. See
  [`08-local-vs-hosted-mcp.md` § Tool model](../architecture/08-local-vs-hosted-mcp.md#tool-model),
  which also records what each crossover cost while it was silent, and
  [#2366](https://github.com/d-hinders/Haven-AI/issues/2366) for the
  convergence that would remove the skew rather than report it.

**Server-side runtime requirement.** A strict tool registers a `ZodObject`
rather than a raw shape, which the deprecated `McpServer.tool(name, description,
schema, handler)` overload refuses outright ("received an unrecognized object").
The hosted server therefore registers through `McpServer.registerTool`, so
`@modelcontextprotocol/sdk` must be at a version that has it. This is a
hosted-server build constraint only — nothing about a client, a connector or the
local runtime changes, and the advertised JSON Schema is byte-identical either
way (`additionalProperties: false` in both cases, which is what the permissive
behaviour had been contradicting).

**The merchant payment header name is NOT a skew axis (#2289).** Since #2289 the
SDK sets both `PAYMENT-SIGNATURE` (x402 v2) and `X-PAYMENT` (v1) to the same
value on every merchant retry.

> **#2330 — the same defect, one level up, and why it is still not a skew axis.**
> #2289 fixed the retry the SDK *performs*. It did not fix the retry Haven
> *instructs an agent to perform*, and `haven_pay_x402_quote`'s premise is
> "retry the merchant YOURSELF". Three tool descriptions still named `X-PAYMENT`
> alone, two named no header, and nothing named `PAYMENT-SIGNATURE` to an agent
> — so an operator or agent following Haven's own guidance by hand reproduced
> the v1-only defect no matter which runtime or backend they were on. #2330
> makes every such instruction name both names and guards the property.
> **Superseded in part by #2341:** on the erc7710 scheme the instruction now
> names `PAYMENT-SIGNATURE` ALONE, because that header carries a delegation
> chain and duplicating it is refused with HTTP 431. Both names remain correct,
> and remain the instruction, on the EIP-3009 bridge. This is
> still not a version-skew axis: it is a description-only change, no tool is
> added, removed or renamed, and an older runtime simply carries older guidance
> text rather than failing closed against a newer backend. That choice is made entirely inside whichever
`@haven_ai/sdk` the installed runtime bundles — the backend neither sends the
header nor negotiates its name, and the name is not part of the Haven-signed
expected context — so there is no version to agree on and no combination of
runtime and backend that fails closed on it. An operator on a runtime predating
#2289 keeps sending only the v1 name, which strict x402 v2 merchants do not read;
that is the defect being fixed, and its remedy is an ordinary runtime update, not
a skew diagnosis. Nothing in the table above applies to it.

**Why three stale-signer rows (#1143).** The second is what the field actually
returned on 2026-08-06, and #1141's original version of this table got it wrong:
it listed `x402 expected context authentication message is invalid`, which is what
the *binding* check produces. That check is never reached — the tool schema pinned
`auth.version` to a literal, so the MCP server rejected the call before any Haven
code ran, and anyone grepping the documented string during an incident found
nothing. #1143 opened the schema and moved the decision into the signer
(`SUPPORTED_X402_EXPECTED_VERSIONS` in `packages/signer/src/core.ts`), which is
the first row. The other two rows stay because they are not historical: every
signer published before that release still behaves this way, and they remain
installed until users update. Both Zod strings were reproduced against `zod/v3`
rather than inferred — note that a failing literal *union* degrades to a bare
`Invalid input`, so the pre-#1143 signer that knows v2 is even less diagnosable
than the older one that reported `expected 1`.

Row three cannot fire on today's traffic and is listed for the next context bump:
a signer carrying #1138 accepts both v1 and v2, so it only breaks once a v3
context ships while that signer is still installed. Row two is the one seen in
the field on 2026-08-06.

If you see either Zod row, **do not** "fix" it by editing `auth.version` to a
supported value. The version is inside the Haven-signed binding message, so
rewriting it invalidates the signature and misrepresents what Haven declared —
the update is the fix. ("Declared", not "authorised" (#2347): Haven signs this
message, and that is all it does here — the word matches
`packages/signer/src/settlement-child.ts`, which describes the same binding.
Spend authority is the owner-signed delegation and the on-chain caveat that
enforces it, never Haven.) The same applies to `expected_auth.version` on the sweep
binding, which shares the mechanism (`SUPPORTED_SWEEP_BINDING_VERSIONS`) and will
hit this the first time that binding is versioned.

**Row one is now machine-readable, not just named (#1309).** The Zod rows
above are a diagnosability gap the table exists to translate; row one — a
signer ≥ the #1143 release, still stale relative to the backend — no longer
needs that translation, because it is now structured at the source. The tool
boundary (`haven_sign` / `haven_sign_x402` / `haven_sign_sweep_delegate`)
returns the row-one message verbatim (unchanged) PLUS
`{ code: 'UNSUPPORTED_EXPECTED_CONTEXT_VERSION' | 'UNSUPPORTED_SWEEP_BINDING_VERSION',
supported_versions, received_version, fallback, next_action:
'stop_and_tell_user' }` — `assertSupportedBindingVersion` in
`packages/signer/src/core.ts` throws a typed
`HavenUnsupportedSignerVersionError` (`@haven_ai/sdk`) instead of the plain
`HavenSigningError` every other signing refusal uses, so `code` and the two
version fields are DERIVED at the throw site from
`SUPPORTED_X402_EXPECTED_VERSIONS` / `SUPPORTED_SWEEP_BINDING_VERSIONS` rather
than a second hand-written literal. `fallback` is the same
`SIGNER_UPDATE_FALLBACK` string the hosted quote's advisory
`signer_compatibility.fallback` (below) carries, so an agent that hits either
surface is told the identical fix. This narrows *how* the refusal is
diagnosed; it enforces nothing new — nothing was ever signed on this path
either, before or after.

One more skew row since #1272: the hosted x402 quote tools are **compact by
default** — no `typed_data`/`typed_data_b64` in the response. A signer old
enough to lack the #1263 `payment_id` fetch (or an install missing
`identity.json`) therefore has no byte source in the default flow; its error
names the fallback, and the recovery is to re-run the quote tool with the SAME
`idempotency_key` plus `include_signing_payload=true`, which replays the
ORIGINAL sign_data (#1207) with the full payload. This is a transport change
only — the signer's verification is identical on both paths — but it converts
"old signer silently relays bulk bytes" into "old signer asks for them
explicitly", which is the observable difference an operator will see.

One more skew row since #1307, on the SETTLE leg rather than the sign leg:
`haven_settle_mcp_tool` / `haven_complete_mcp_tool` accept `merchant_url` /
`tool_name` / `arguments` / `mcp_transport` as optional and rehydrate them by
`payment_id` from the stored intent when omitted. Omitting them against a
backend that never stored a call context — pre-#1307 backend, or an intent
that was never quoted through `haven_pay_mcp_tool` (a plain non-MCP-tool x402
resource) — gets a structured `MERCHANT_CALL_CONTEXT_UNAVAILABLE` refusal
naming the fallback in-band: re-send the four fields explicitly (the same
values `haven_pay_mcp_tool` returned at quote time). Same shape as the
`include_signing_payload=true` fallback above: no signature verification
changes, only which call carries the bulk bytes.

On a successful hosted settle (#1349), agents report from the compact
`agent_summary.purchase_summary` rather than parsing the merchant's raw
`result`. This is a backward-compatible reporting extension only: Haven state
sets status and payment fields, while product/invoice metadata comes from the
merchant and `settlement_tx_hash` is only an optional merchant PAYMENT-RESPONSE
receipt reference. Missing values are explicit; it changes neither signing nor
runtime compatibility.

`haven_prepare_catalog_purchase` (#1306) — the guided catalog-id preflight —
persists the SAME `mcpCallContext` at quote time (it composes the identical
authorize calls `haven_pay_mcp_tool` uses, just sourced from a
`merchant_catalog` row instead of caller-supplied fields — since #1547 that
includes the settlement-scheme selection, so on the delegation rail against an
erc7710-advertising merchant it composes `prepareX402Erc7710` with the same
context passthrough rather than `createX402Intent`), so it carries no
separate skew row: the settle leg above rehydrates a catalog-preflight-created
intent exactly like a `haven_pay_mcp_tool`-created one on either scheme, and
the `signer_compatibility` version check on the QUOTE side (table above)
applies identically to its 3009 shape (the erc7710 shape carries no
`signer_compatibility`, like `haven_pay_mcp_tool`'s — the signer's own
signing-time refusal is the guard there, as everywhere).

**The `@alpha` in that remediation is the PRODUCTION channel, and since #2422 it
is not universal (epic #2420).** The backend now derives the connector it hands
out from `HAVEN_CONNECTOR_CHANNEL` (default `alpha`; setting it on the shared dev
environment is an owner step whose ordering and verification are in
[`package-dev-channel.md`](package-dev-channel.md) § *Operator checklist* — this
doc records neither that it has been done nor that it has not), so on a
non-production deployment the correct rerun
names that backend's own channel — its setup response reports it in
`connector_package`. The strings above are unchanged and still say `@alpha`,
because they are baked into `packages/sdk` and `packages/signer` at build time
and this repository's production release channel really is `alpha`.

**#2423 has since landed, and it did NOT make those hints environment-derived** —
a published tarball cannot read a deployment's environment. It made them derive
from a build-time constant that mirrors the npm dist-tag the build was published
under, so an `alpha` build still says `@alpha` (byte-identically to the strings
above) and a build published on another channel says that channel. See
*The connector channel is a fifth bump-managed constant* earlier in this
document for the mechanism. The runtime-environment half applies only to the two
surfaces that are DEPLOYED rather than published: the backend's handout (#2422)
and the hosted MCP server (#2423).

So the reading stands, for a slightly different reason than it used to: treat the
hint as "reinstall the connector **your backend hands out**", whose spec that
backend reports in `connector_package`. That is exactly the skew this section is
about: a signer installed from one channel against a backend emitting another is
how an unknown `x402_expected_context_version` arises in the first place.

### Detecting skew before a payment (#1155)

Every row above is a *post-quote* symptom: the agent found out by trying to pay.
The same skew is now detectable at connection time, from two surfaces that cost
nothing to read.

| Surface | What it states | Where |
|---|---|---|
| Signer `initialize` result | The version sets this signer will verify — `capabilities.experimental["haven/signer-compatibility"]` (machine-readable) and the same numbers in `instructions` (what clients show the model) | `packages/signer/src/capabilities.ts`, wired in `buildSignerMcpServer` |
| Hosted quote/prepare result | `signer_compatibility.x402_expected_context_version` — the version that quote will emit — plus in-band guidance (since #1547: branch on the signer's machine-readable version-mismatch refusal, not a pre-compare). Present on the **EIP-3009 shape** of each tool; the erc7710 shape carries none, and since #2041 that now includes `haven_pay_x402_quote` | `packages/mcp-server/src/tools.ts` (`haven_pay_x402_quote`, `haven_pay_mcp_tool`, `haven_prepare_catalog_purchase`) |

**The information is agent-mediated, and cannot be otherwise.** The signer and
the hosted MCP are two separate servers connected to the same agent client. The
hosted server cannot introspect the signer, and the signer's one Haven call is
the #1263 read-only fetch of a *specific payment's* signing context — it cannot
ask what version a future quote will emit. Only the agent sees both surfaces. #1155 shipped the
information plus a prompt to COMPARE the two — and field experience (#1547)
showed that prompt was unperformable in most agent harnesses, which do not
expose an MCP `initialize` result to the model; agents "checked" by re-reading
instruction prose. The shipped guidance therefore no longer asks for a
pre-compare: it names the signer's signing-time structured refusal (#1309 —
`code` / `supported_versions` / `received_version` / `fallback`) as the branch
point, which every harness can act on because it arrives as a tool result. The
`initialize` surfaces above still advertise the sets for harnesses (and
humans) that can read them; nothing about what is ENFORCED moved.

**A mismatch warns, it does not block** (owner decision, 2026-08-07; unchanged by
#1309). No refusal was added to the payment path: a quote whose emitted version
the signer may not know still succeeds and simply reports the number. Refusing
on the strength of reported client metadata would let a false positive block a
working payment, which is strictly worse than the reactive state — and the
signing-time guard above already fails closed, so nothing is unguarded. Both
surfaces name the same fix (update `@haven_ai/signer`; rerun
`npx @haven_ai/connect@alpha`), so an agent that meets either says the same
thing to the user — and since #1309 that is not just true of the prose: the
quote's `signer_compatibility.fallback` and the signer's own structured
refusal `fallback` field are the SAME string
(`SIGNER_UPDATE_FALLBACK`, `@haven_ai/sdk`), so an agent reading either as
data gets byte-identical guidance, not merely similar wording.

**`signer_compatibility` is the stable contract this pre-payment check reads
(#1309).** Its shape — `x402_expected_context_version`, `signer_capability`,
`check` (prose), and now `fallback` (the same guidance as structured data) —
was already sufficient for the acceptance bar "hosted MCP quote/preflight
responses surface compatibility requirements in a stable field"; `fallback`
is the one field #1309 added, because it was the one piece of `check` an
agent could not previously read without parsing a sentence. See
`signerCompatibilityNotice` in `packages/mcp-server/src/tools.ts`.

The advertised set is **derived** from `SUPPORTED_X402_EXPECTED_VERSIONS` /
`SUPPORTED_SWEEP_BINDING_VERSIONS`, never a second literal — including the
rendered numbers inside `instructions`. Drift between what is advertised and what
is enforced is the one way this feature could become a lie, so tests hold them
together in both directions: a handshake assertion pins the advertised sets to
the exported constants, and a behavioural test drives the real signing path with
every advertised version and fails if the skew guard rejects any of them.

The signer advertises under `capabilities.experimental` rather than the newer
`extensions` field on purpose. Both are `Record<string, object>` in
`@modelcontextprotocol/sdk@1.29`, but a client running an older SDK parses the
`initialize` result with a `ServerCapabilities` schema that has no `extensions`
key and would strip it — and an out-of-date client is exactly the population this
feature serves.

Adding a read-only capability *tool* was the documented fallback if the SDK could
not carry this at handshake. It can (`ServerOptions.capabilities` and
`ServerOptions.instructions`, both forwarded by `McpServer` into the `initialize`
result), and a new tool would have been worse than redundant: the signer's
consent hash is computed over its registered tool names, so adding one would
invalidate every existing acknowledgement and prompt users to re-consent for a
diagnostic.

This covers the **hosted MCP + local signer** topology only. The local
`@haven_ai/mcp` runtime signs in-process with the SDK it was installed with, so
there is no second component to be out of step with.

**Both payment-brain servers set `instructions` too (agent-prompt audit, items
A/B).** `ServerOptions.instructions` above is the mechanism the signer's own
handshake reuses; `buildHostedMcpServer` and `buildMcpServer` (the local
runtime) now set it as well, with a compact critical path — deliberately free
of any version literal, since nothing there should ever need a release to stay
true (unlike the signer's compatibility numbers above, which are point-in-time
by design). See [`07-edge-signer.md`](../architecture/07-edge-signer.md) for
what each server's instructions say and why they differ in length.

## Troubleshooting

- **A stale local `dist/` masquerading as version skew (#1188).** The symptoms
  in the skew table above have a second, unrelated cause: a sibling package
  whose `dist/` is older than its `src/`. `packages/signer`'s dist once sat four
  weeks behind its source and produced
  `signX402FundingTypedData is not a function` plus a pre-#1143 schema rejecting
  `auth.version` — indistinguishable, from the error alone, from a genuinely
  outdated installed signer. The npm scripts rebuild what they depend on
  (`npm run test -w packages/mcp-server` builds sdk and signer first), so this
  only bites when vitest is invoked directly. A `globalSetup` guard now refuses
  to run those suites against a stale dist, and `npm run check:dist` reports it
  on demand. If you see a skew-shaped error locally, check this before
  reinstalling anything.
- **`This x402 binding was already used to build a merchant header` (#2291).**
  Not version skew — a mis-sequenced call, and the message says so on purpose.
  `haven_sign_x402` is a **one-shot**: it signs the funding hash *and* builds
  the merchant header, consuming its own `x402_binding` on the way. The binding
  it returns is therefore already spent, and passing it to
  `haven_x402_sign_header` can only fail. The remedy is the `payment_header`
  that same result already carried; if it is gone, re-run the quote tool with
  the same `idempotency_key`. `haven_x402_sign_header` is the successor to
  **`haven_sign`**, which records the context without consuming it.
  Until #2291 both this and an id the signer never held produced the same
  `x402 funding binding is required…` text, and Haven's own guidance named the
  impossible order — so the message an operator grepped described a caller who
  had not signed, when the caller had signed seconds earlier. The two refusals
  are now distinct: the other one names a signer **restart** as its likeliest
  cause, since bindings live in memory only. An older signer still emits the
  single generic string; that is a diagnosis difference, not a fail-closed
  combination, and no runtime/backend pairing is broken by either.
- **`mcp_transport` rejected as `Invalid arguments` on settle (#2282).** Hosted
  MCP tool arguments are **snake_case**: `mcp_transport` is
  `{ handshake_required: boolean, source: "path" | "bazaar" }`. The SDK type
  `X402McpTransport` and the HTTP API's `mcpCallContext.mcpTransport` spell the
  same value **camelCase** (`handshakeRequired`), and both spellings are
  authoritative at their own boundary — the hosted server bridges them. A
  camelCase `mcp_transport` at the tool boundary is refused, and the refusal
  now names both spellings rather than only saying `handshake_required:
  Required`. Two ways not to hit it: echo the `mcp_transport` a Haven quote tool
  returned (already snake_case), or omit `merchant_url`/`tool_name` entirely and
  let Haven rehydrate the stored context by `payment_id`. Do not "fix" it by
  dropping the field on a merchant that needs the handshake — a wrong-shaped
  transport is refused, never silently ignored, precisely so a caller can tell
  the difference between "my argument was wrong" and "my argument was fine".
- **Broken or root-owned `~/.npm`:** the MCP runtime install first tries the
  user's default npm cache with `--prefer-offline` (which `npx` just warmed, so
  the signer/sdk tarballs are reused instead of re-downloaded). If that fails —
  e.g. a corrupted or root-owned global cache — it automatically retries against
  the isolated `~/.haven/npm-cache`, so a broken global cache still cannot break
  normal agent startup.
- **Invalid Codex TOML:** the connector writes Codex config with a TOML string
  serializer and validates the generated Haven block before writing. The
  expected shape is `command = ".../bin/haven-mcp"` and `args = []`.
- **Unsupported Node.js:** the connector, signer, and MCP packages require
  Node.js `>=22.0.0`, and
  since [#1161](https://github.com/d-hinders/Haven-AI/issues/1161) setup
  **refuses** below it rather than proceeding — see
  [Where the Node floor is enforced](#where-the-node-floor-is-enforced). The
  message names your version and how to upgrade. Upgrade Node and rerun setup.
  If setup succeeded but the signer now refuses to start, the runtime launching
  it is on an older Node than the shell you upgraded.
- **Local MCP runtime install failed:** rerun the setup command. It will reuse
  local credentials and install the pinned runtime into `~/.haven/mcp-runtime`,
  falling back from the user's default npm cache to `~/.haven/npm-cache` if the
  global cache is unusable.
- **Signer runtime install failed (`signer_runtime_install_failed`, #1586):**
  the hosted+signer setup now fails CLOSED — no runtime configuration is
  written at all, because a config pointing at an uninstalled signer looks
  wired but structurally cannot start (Codex kills the multi-minute npx cold
  install at its 120s `startup_timeout_sec`, leaving corrupted `_npx` dirs).
  There is no silent npx fallback anymore. The install budget is 10 minutes
  with console heartbeats; on failure, address the cause (network, npm cache)
  and rerun the setup command your backend hands out (its `connector_package`;
  `@alpha` in production — see the version-skew section above, #2422).
- **Claude Code does not show Haven:** run `claude mcp get haven` and confirm
  it points at the wrapper path. If `add-json` is unavailable, the connector
  falls back to `claude mcp add --scope user -- <wrapper>`.
- **Tools missing after restart:** rerun the connector. It will reuse the
  existing local credentials, reinstall or reuse the pinned MCP runtime, and
  fail loudly if the wrapper handshake cannot list the required Haven tools.
- **Tool naming across runtimes (#1588, corrected by #2550):** guidance
  responses carry `next_tool` (Claude-family namespaced,
  `mcp__<server>__<tool>`, kept byte-identical for existing clients), the pair
  `next_tool_server` and `next_tool_name` (the bare tool name), and — since
  #2550 — `next_tool_server_role`, one of `hosted` or `signer`.
  **Read the role, not the server name, whenever your servers are not the
  default pair.** `next_tool` and `next_tool_server` are built from a literal
  in the hosted server, so they always say `haven` / `haven-signer`; that is
  the most the hosted server can know, because local server names are the
  client's config and never reach Haven. Two runtimes are already not the
  default: Codex names servers by config key — connect writes `haven_signer`
  (underscore; TOML) — and a connector run with `--name <slug>` wires
  `haven-<slug>` / `haven-signer-<slug>` (#1694; the slug is immutable once
  wired). On either, `next_tool` and `next_tool_server` name a server the
  client does not have, so resolve `next_tool_server_role` against your own
  configured servers and call `next_tool_name` there. The pair alone was the
  documented answer until #2550 and was wrong for the named case, which is why
  the role exists rather than a fourth spelling of the name.
- **`--doctor` / `--repair` (#1589):** a stuck setup is diagnosable without a
  hand-built MCP client: `npx @haven_ai/connect@alpha --doctor --runtime
  <runtime>` checks config, credentials, the pinned signer runtime, the hosted
  MCP, and runs the live signer handshake (reporting its compat versions),
  printing one repair action per failure and exiting non-zero. `--repair`
  reinstalls the pinned runtime and rewrites wrapper + config from STORED
  credentials — no new setup token, keys untouched. `--json` for automation.

  **`--repair` rewrites only the pair the directory owns (#1910).** It reads
  the wiring slug from that directory's own `signer-runtime.json` sidecar
  (#1696) and writes `haven-<slug>` / `haven-signer-<slug>`, so repairing a
  named agent leaves a co-wired bare agent's `haven` / `haven-signer` entries
  untouched. Before #1910 it passed no slug at all, so `serverNamesFor()`
  defaulted to the bare pair: repairing a named agent silently did nothing for
  it and overwrote a *different*, working agent's entries with this one's
  credentials. Nothing to re-type — the slug is on disk, never a flag you have
  to remember to repeat.

  **A local runtime-spec override is a doctor finding, never a silent default
  (#2424).** A developer iterating on the signer, SDK or local MCP can set
  `HAVEN_SIGNER_SPEC`, `HAVEN_SDK_SPEC` or `HAVEN_MCP_SPEC` to anything
  `npm install` accepts (`file:/abs/path`, a `.tgz`, an explicit version) and
  setup, `--repair` and `--rekey-finish` install THAT instead of the pinned
  manifest sibling — into `~/.haven/signer-runtime/override-<hash>` (or
  `mcp-runtime/override-<hash>`), keyed by a hash of the resolved specs so the
  version-named directory the pinned path reuses is never touched, and never
  reused between runs. Setup prints `RUNTIME SPEC OVERRIDE ACTIVE` first; the
  sidecar records it under `runtime_spec_override` with the versions npm
  actually installed; the wrapper carries a comment; and `--doctor` reports a
  failing `runtime_spec_override` check ("runtime spec overridden — not the
  pinned manifest") whenever the sidecar says so OR a variable is set in the
  doctor's own shell. The handshake probe still requires every manifest tool,
  a malformed value is refused before npm runs, and with no variable set the
  install is byte-for-byte the pinned one. The manifest table above is the
  pin; an override is installed beside it and does not move it. Details:
  `packages/connect/README.md` § *Installing an unpublished signer / SDK / MCP build*.

  **`--doctor` also reports a parked re-key (#1911).** A `--rekey` that was
  started and never finished leaves `rekey-pending.json` behind (see
  **Credential safety** below); the doctor names it per agent — present or
  expired, when it started, its **public** address and its path, in both the
  human output and `--json`'s `agents[]` — and never its contents. Since
  **#1915** the pending file is also a discovery tell in its own right, so a
  directory holding nothing else is inventoried too, as `agents[]`
  `classification: "parked"` (a fifth value beside `wired` / `superseded` /
  `retired` / `orphaned`). An expired
  one is its own actionable failure rather than a generic warning, and
  `--repair` does not delete it: an expired TTL is a refusal to *use* the
  parked key, not a licence to destroy key material the owner may still be
  mid-flow on. What the doctor **can** settle is whether the backend re-key
  completed — Haven already reporting the parked address proves it did, and the
  fix is `--rekey-finish`. What it **cannot** settle is, within a re-key that
  did *not* complete, whether the owner got as far as the on-chain revoke:
  nothing local records the backend stage, and the doctor's identity probe
  reads two fields (`id`, `delegate_address`) from `GET
  /machine-payments/agent` — whose response carries `id`, `name`, `status`,
  `safe_address`, `delegate_address`, `delegate_account_address`, `chain_id`
  and `execution_rail`, **none of them a re-key stage**. Widening the probe
  would not help, because the field does not exist on that endpoint to read.
  So "never started on the agent page" and "started, revoked,
  abandoned" look identical from the machine. The second is
  [#1868](https://github.com/d-hinders/Haven-AI/issues/1868)'s wedge — old
  delegations revoked, no new ones issued, recoverable only by an owner
  re-grant — so the check points at the agent page instead of implying the
  harmless reading.
- **`--tombstone <dir>` (#1681):** retires an agent credential directory in
  place — replaces its `bin/haven-signer.mjs` with a self-contained diagnostic
  that logs a `HAVEN-TOMBSTONE`-marked retirement notice (agent id, date,
  reason, restart-every-long-lived-host guidance) to the host's MCP stderr log
  and exits 1, and records `TOMBSTONE.json` for `--doctor`. Touches NO key
  material and revokes nothing (connect reports; the user revokes). Exists
  because long-lived MCP hosts load wiring at startup: after an agent is
  recreated and its old directory removed, every stale host spawn-fails on the
  old path forever, masked as `Connection closed` — and after a chain of
  recreations each long-lived process can be parked on a DIFFERENT dead agent,
  so the remedy is restarting EVERY such host, not one. `--doctor` reads the
  tombstone: keys removed ⇒ informational "tombstoned (keys removed)"; key
  still present ⇒ the #1688 live-probe verdict stands unchanged (a tombstone
  is a marker, never a revocation). Optional `--reason` / `--replaced-by`.
  No token, no `--runtime` needed. Recreation-case only: `--rekey` rewrites
  credentials in place at a stable path and writes no tombstone (owner decision
  on epic #1694, 2026-08-21) — shipped in #1700, see the next entry.

  **Address it by DIRECTORY, never by agent id** ([#2175](https://github.com/d-hinders/Haven-AI/issues/2175)).
  A named agent's directory is its wiring **slug**, which never equals its agent
  id (#1696), so a path built from an id does not exist for it and the command
  refuses with `tombstone_directory_not_found` — retiring nothing. Enumerate
  `~/.haven/agents`, or take the `directory` values from `--doctor --json`.

  **Under `--json` the refusal is now on stdout too.** Success has always been
  one `{"tombstoned": true, …}` line; a failure used to write to **stderr
  only**, leaving stdout empty — indistinguishable, to a caller parsing stdout,
  from a run whose stream it had merely stopped reading. It now emits
  `{"tombstoned": false, "error": {"code", "next_action"}}` and still exits 1,
  with the prose mirrored to stderr: the same discipline #2091 gave the main
  connect path — including its gate on `message`, which is present **only** for
  a connector-authored `ConnectError`. The directory guard is not the only
  thing that can throw (the `mkdir`/`chmod`/`writeFile` calls after it are all
  bare), and a plain `Error`'s raw OS text can carry arbitrary local path
  detail, so that text stays on stderr and never enters the JSON record. This closed a real field failure — a `haven-reset` agent
  reported "the tombstone command did not create `TOMBSTONE.json`" with no error
  to show for it, having built the path from an agent id. The reset skill now
  enumerates directories and verifies the result before deleting key material.
  **Every subcommand does this now** ([#2184](https://github.com/d-hinders/Haven-AI/issues/2184)),
  not just `--tombstone`: `--unwire`, `--rekey` and `--doctor`/`--repair` emit
  the same record through one shared helper, so a fourth subcommand inherits
  the behaviour instead of re-deciding it. Each envelope carries its own
  branch's success discriminant **inverted** — `{"unwired": false}`,
  `{"rekey": "failed"}`, `{"doctor": "failed"}` — so a failure can never be
  read as a success payload. That distinction earns its keep twice: `--doctor`'s
  success output *is* a JSON report (a failure record carries no `checks`), and
  `--unwire` reports `{"unwired": true}` with a **non-zero exit** when some
  runtime entries were refused, which is a partial result rather than a
  failure.
- **`--unwire [<dir>]` (#2169):** removes one agent's local wiring. Address
  the target by its credential directory, or resolve it with `--name <slug>`
  (or `--credentials-dir`). The positional value is always an existing
  credential directory: named agents use their wiring slug, while unnamed
  agents normally use their agent-ID directory. It **tombstones first**, so a
  long-lived host still resolving the old wrapper receives the retirement
  diagnosis, and the #2155 mirror remains after teardown. It then removes that
  agent's hosted-MCP + local signer pair from every supported runtime config,
  removes its Hermes dotenv API-key line, and deletes the target directory's
  local signer, pending re-key, and stored API key.

  This is local teardown, **not** backend revocation: Connect reports what it
  changed, while the owner revokes the agent on the Haven agent page. Named
  pairs are uniquely addressable. For the shared bare `haven` /
  `haven-signer` pair, however, it removes entries only with positive proof
  that this directory owns the wrapper or Hermes key; otherwise it refuses
  rather than guess and unwire another agent. See the published
  [`@haven_ai/connect` unwiring guide](../../packages/connect/README.md)
  for the operator procedure and full supported-runtime list.
- **`--rekey` / `--rekey-finish` (#1700):** replaces an agent's signing key on
  the machine that runs it. **Two phases, because the owner's dashboard sits
  between them** — every backend re-key route is owner-authenticated and
  explicitly refuses an agent credential, so the connector never calls them:
  1. `npx @haven_ai/connect@alpha --rekey [--name <slug>]` reads the stored
     credentials, confirms with Haven that this agent is re-keyable (refusing a
     legacy-rail or revoked one the way the backend would), generates a fresh
     keypair **locally**, and prints its public address to paste into the agent
     page. The agent keeps working on its old key throughout — nothing else is
     touched.
  2. `--rekey-finish --api-key <key> --runtime <name>` takes the API key the
     agent page shows once, refuses unless it authenticates AND belongs to this
     agent AND Haven's recorded signing address matches the one this machine
     generated, then rewrites the credential files **in place at the unchanged
     path** and rewrites only this agent's MCP config pair.

  **Passing `--runtime` on the finish step is not optional in practice.** The
  API key is embedded in the runtime config itself (`Authorization: Bearer …`,
  or Hermes' `MCP_HAVEN[_SLUG]_API_KEY`), so without it the credential files are
  correct and every wired host still presents the retired key and 401s. The
  connector says so loudly rather than exiting quiet.

  The wiring slug does not move, so the MCP server names do not move, so no host
  needs reconfiguring — but every long-lived host does need a **restart**, since
  each holds its wiring snapshot from its own start time. The completion output
  prints the runtime's exact restart command plus that sweep instruction.
- **Signer verified by handshake (#1587):** in the hosted+signer topology the
  connector now proves the LOCAL signer with the same stdio handshake the
  hosted server gets (initialize → tools/list → required signer tools, the
  list derived from the pinned `@haven_ai/signer`). `localSignerConfigured`
  is true only after that handshake; a signer that cannot spawn, times out,
  or lacks tools reports `local_signer_probe_<status>` with a re-run
  instruction — setup can no longer exit 0 on an unstartable signer.
- **Credential safety:** private signing keys live only in the agent's own
  credential directory — `~/.haven/agents/<agent-id>/signer.json`, or
  `~/.haven/agents/<slug>/signer.json` for a `--name`d agent (#1696). During a
  re-key there is a SECOND, transient private key in that same directory:
  `rekey-pending.json` holds the newly generated key between `--rekey` and
  `--rekey-finish`, at the same `0600` mode, and is deleted once the rewrite
  lands (#1700). It expires after 24h and a fresh `--rekey` replaces it, so it
  is not a place a key accumulates — but it is a place one can be found, which
  is why it is named here rather than left to be discovered. **Expiry is a
  refusal, not a deletion (#1911):** an *abandoned* re-key — started, never
  finished — leaves the file in place past its TTL, so the bytes outlive their
  usefulness. `--doctor` now reports one when it finds one (that it exists, its
  age, its public address and its path — never its contents), and neither it
  nor `--repair` removes it; dropping key material stays the owner's call.
  **Including in a directory with nothing else left in it (#1915):** the
  doctor's directory scan used to require an `identity.json` or a
  `TOMBSTONE.json`, so a directory holding *only* `rekey-pending.json` was
  never inventoried and its key never named. It now counts as a third tell,
  and such a directory is classified `parked` — no agent, just the key a
  re-key generated. No shipped flow produces that shape (`--rekey` writes
  beside an `identity.json` that stays put), so expect it only after an
  out-of-band deletion, a hand-copied file, or a restore that recovered one
  file. Its abandoned-key handling is the ordinary one: an expired or
  unreadable parked key outside the reported agent fails `--doctor` through
  the existing `rekey_pending_elsewhere` check, an open one stays
  informational, and nothing is deleted for you. Do not paste
  signer files, pending-rekey files, wrapper sidecars, or command output into
  public issues without redacting secrets.
