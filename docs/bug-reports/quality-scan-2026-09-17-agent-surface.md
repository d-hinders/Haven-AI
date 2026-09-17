---
owner: "@AntonioSaaranen"
status: current
covers:
  - .github/money-path-globs.json
  - packages/mcp-server/src/tools/plain-http-x402.ts
  - scripts/ci/safe-account-rename-census.mjs
  - docs/regulatory/casp-risk-guardrails.md
  - packages/demo-merchant-mcp/src/x402.ts
last-verified: "2026-09-17"
---

# Quality scan 2026-09-17 — agent surface, second pass (safe-retirement, hosted + local MCP, signer, demo merchant)

Owner mandate 2026-09-12, re-run after the marketplace epic. Measured on
`origin/dev` @ `4ed69592` (2026-09-17, after #3085). The 2026-09-13 pass over
the same four areas is in the ledger with three findings, thirteen defects and
ten proposals; this pass **excludes everything it recorded** and reports only
what is new since `c3f0eddc` or has moved. Live exercise: the `haven-qa-dev`
hosted MCP (agent `test3`, chain 84532, 1.0 USDC budget) — discovery, quotes,
allowances, receipts; no intent was created and nothing was signed (the
connected signer belongs to the mainnet agent, and `haven-signer-qa-dev` failed
to connect this session — recorded under observations).

## 0. What the 2026-09-13 report asked for, and where it stands

| item | disposition today |
|---|---|
| F1 party model | shipped — #2960 (PR `72645b44`) |
| F2 settled means verified | shipped — #2970/#2972 (`ad8a7805`, `2199891e`), #2968 (`c34620b2`) |
| F3 retry/idempotency as protocol | **still pending owner decision**; #3042/#3043 forwarded `idempotency_key` on the erc7710 branches (B2 half) |
| B1 catalog badges | shipped — #2978/#2981 (`verified=verified` → 8 of 8 today, was 0 of 6) |
| B3, B4 next_* on refusals | #2975/#2976 (cap refusals), #3001/#3010 (signer sign-context refusals) shipped |
| B5, B6, B7, B8, B9, B11, B12 | shipped — #2968, #2989, #2979, #2988, #2985, #2998, #2991/#2999 |
| B10 `vi.doMock(` outside the mock-factory net | shipped — #2997 / PR #3003 widened the guard to `vi.doMock(`; the 3 files still use it and are now inside the net (the first draft of this row read the unchanged file count as "open" — a count is not a gap once the instrument covers it) |
| B13 "five" in the routing guard's comment | fixed (the comment now records that a "five" outlived the deletion) |
| Proposals 4, 7, 8, 9 (explain-payment, signer status, dry-run, spending summary) | **undecided** |

Thirteen of thirteen defects landed in four days; the open items above are
decisions, not stalled work.

## 1. Live exercise (2026-09-17, `haven-qa-dev`)

- `haven_get_agent` → `ready` / `spend_authority_readiness: ready`, 1.0 USDC.
- `haven_discover_tools` → 8 entries (3 Ampersend `http`, 5 demo-merchant `mcp`),
  every one `verified_payable: true` with a `merchant` block (#3078 live on dev).
- `haven_quote_catalog_purchase` on the 50 GB fixture → `expected_settlement_scheme: erc7710`,
  `expected_settleable: true`, and the description now says the fixture is
  never settled on-chain (#2989 live).
- **`haven_quote_x402` with the field discovery hands out (`resource_url`) → refused**
  (`unrecognized_keys: resource_url`, `url` required). The refusal's reason
  text talks about `idempotencyKey` and request bodies — not about the alias
  the caller actually used. Same call with `url` → a v2 quote.
- **The quote echoes `resource_url: "http://services.sandbox.ampersend.ai/api/fact"`**
  for a resource requested over `https`. The merchant's `PAYMENT-REQUIRED`
  header declares `resource.url` with `http://` (decoded live); the SDK adopts
  the merchant's declaration as the canonical URL (`x402.ts:165`,
  `x402-protocol.ts:224/310`) and the hosted pay-from-quote path has no `url`
  input, so the paid retry target is the merchant's `http://` URL
  (`client.ts:1146,1165`: `input.url ?? paymentRequired.resource.url`). A live
  `GET http://…/api/fact` answers **308 → https**, so the paid request's first
  hop — carrying `PAYMENT-SIGNATURE` — travels in clear before the redirect.
  No scheme check exists on the path (`grep "https:" packages/sdk/src/x402*.ts
  packages/mcp-server/src/tools/plain-http-x402.ts` → 0 code hits). See D1.

## 2. Finding that meets the bar

### F1 — The agent's next step is named but never spelled: every `suggested_tool` ships without arguments, and the two non-hosted surfaces never name a tool at all

This is the **argument half of the 2026-09-13 F3 / proposal 1** ("response
contract v2"), re-surfaced with the delta the live run produced after the
argument-spelling "convergence" (#2366, 2026-09-01) was declared done.

**Measured** (`grep -rn <field>: packages/<p>/src --include='*.ts' | grep -v test`, camelCase builders included):

| surface | `next_action` sites | of which name a `next_tool` | of which carry `next_arguments` | `suggested_tool` sites | with `suggested_arguments` |
|---|---|---|---|---|---|
| hosted MCP (`mcp-server`) | 46 | 15 | 14 | 19 | **0** |
| signer | 4 | **0** | 0 | 2 | **0** |
| local MCP (`mcp`) | 5 | **0** | 0 | 4 | **0** |

- 25 `suggested_tool` sites across the three packages, none with arguments; the
  discovery payload hands the agent `resource_url` and points at a tool whose
  only required key is `url` (`contracts.ts`: `haven_quote_x402 → url, method,
  headers, body`; local `mcp/src/tools.ts:67` the same).
- 31 of 46 hosted `next_action` sites name no tool; the signer's four and the
  local runtime's five never do — an agent reading `stop_and_tell_user` or
  `payment_window_expired` from the signer has no machine-readable "call this".
- The strict-input refusal is generic per tool (`registry.ts:74`,
  `strictRefusalMessage`) plus one prose reason per tool from
  `STRICT_INPUT_TOOLS`; it never says which declared key the rejected one
  maps to, so the refusal for the live case explains a different mistake.

**Demonstrated cost** — the issue record names the class thirteen times in five
weeks: argument spelling #2282, #2343, #2348, #2349, #2353, #2366, #2393
(2026-08-31 → 09-01); next-step fields #1308, #1588, #2550, #2557, #2975, #3001
(2026-08-11 → 09-15). #2366 closed as "converge the local and hosted argument
spellings"; the discovery → quote hop still fails on the first field an agent
copies. The repo's own MCP instructions say "follow `next_action`,
`next_tool`, `next_arguments` first; prose is fallback" — for 34 of 55
next-step sites there is nothing structured to follow.

**Unlock, proven in-repo:** `buildAgentGuidance({ nextTool, nextArguments })`
already exists in the hosted server (14 of the 15 tool-naming sites use it) and
every hosted tool's input schema is a typed `toolSchemas[name]` (`contracts.ts`,
#2807). A `NextStep<T extends HostedToolName>` whose `arguments` type is
`z.infer<typeof toolSchemas[T]>` makes a misspelled handoff a compile error,
not a live refusal.

**Slicing (disjoint):**
1. Typed `NextStep` builder keyed on the target tool's schema; convert the 15
   hosted sites; a compile-time twin test (TS2322 on a wrong key).
2. Discovery and quotes carry `suggested_arguments` in the target tool's
   vocabulary (`{ url }`, `{ catalog_id }`, `{ merchant_url, tool_name, arguments }`).
3. Schema-derived strict refusals: name the declared keys and the nearest
   alias (`resource_url → url`), generated from the Zod diff rather than prose.
4. Signer and local runtime: `next_tool` on every `next_action` site (the
   signer's four, the local five), with the same builder.
5. Cross-surface parity test: every argument name an agent can copy from one
   response is accepted by the tool it is pointed at (local + hosted + signer).

Refused as a second finding (one-PR remedies, recorded as candidates): C1–C2 below.

## 3. Candidates (one PR each — `new-task`, not epic)

- **C1 — Two money-path perimeters, one of them hand-maintained.**
  `docs/regulatory/casp-risk-guardrails.md` `covers:` lists
  `packages/demo-merchant-mcp/src/**`, `packages/mcp/src/**`, `packages/connect/src/**`,
  `packages/cli/src/**`, `packages/sdk/src/**`; the classifier's
  `.github/money-path-globs.json` (read by `loadMoneyPathGlobs`) lists none of
  the first four and only `sdk/src/signer.ts` of the fifth. Block 6 in scope:
  `find packages/{mcp,mcp-server,signer,demo-merchant-mcp}/src -name '*.ts' ! -name '*.test.ts' | xargs grep -l -E 'sendTransaction|signTypedData|writeContract|…'`
  → 3 verb files, **1 outside every glob: `packages/demo-merchant-mcp/src/x402.ts`**
  (1,516 lines; it settles the buyer's authorization on-chain, and the prod
  instance runs on Base mainnet per #1458). Cost: #2969/#2977 (the zero-hash
  settlement sentinel) and #2979/#2980 (settlement readiness) changed that
  file's settlement semantics and carry no `money-path` label — no CASP shard
  was required, `qa-freshness` did not count them. Remedy: derive one list
  from the other (or a parity test between the doc's `covers:` and the JSON)
  and add the demo merchant glob.
- **C2 — the demo merchant's settled-cache cleanup is unguarded** (block 1
  survivor, below): the `finally` clause `!settled.has(productKey)` can be
  deleted and `x402.test.ts` stays 33/33. Diagnosis: *not load-bearing at the
  tested condition* — the dedupe test is satisfied by the in-flight `attempts`
  map; the mutated clause governs post-failure cleanup after an
  `already_settled_earlier` recovery, which no test reaches. One test.

## 4. Verified defects (new since 2026-09-13)

| id | what | evidence | severity |
|---|---|---|---|
| D1 | The paid x402 retry adopts the merchant-declared `resource.url` without a scheme check; a merchant that declares `http://` (Ampersend sandbox does, live) makes the hosted pay-from-quote path send `PAYMENT-SIGNATURE` over plaintext on the first hop (308 to https after). The SDK/local path uses the caller's URL when present (`client.ts:1165`), the hosted quote → pay path has no `url` input (`contracts.ts`: `haven_pay_x402_quote → payment_required, …`). | live quote (`resource_url: http://…`), decoded `PAYMENT-REQUIRED` header, `curl -sI http://…/fact` → 308, `x402.ts:165`, `x402-protocol.ts:224,310,398`, `client.ts:1146,1165` | **medium-high** (payment credential in clear; also a merchant can steer the retry to any host it declares) |
| D2 | Discovery hands out `resource_url`; the tool it suggests takes `url`; the strict refusal explains bodies/idempotency, not the alias. Same shape on the local runtime (`mcp/src/tools.ts:402` vs `:67`). | live refusal; F1's table | low (agent-visible dead end on the first hop) |
| D3 | `haven-signer-qa-dev` failed to connect this session (`CONNECTION_CLOSED`) while `haven-signer` (mainnet) connected — a session with two signers and one hosted server cannot tell which signer serves which agent from inside the session (the 09-13 proposal 7 `haven_signer_status` covers this; recorded as live evidence for it, not a new defect). | session connector state | note |

## 5. Safe-retirement — where it stands (read-only, 2026-09-17)

- Naming P5 landed (#3075 `6d1f3b77`, #3091 `00274249`): old request names
  are declared and refused with `replacement` as a field
  (`middleware/retired-safe-names.ts`), old paths are 410 tombstones
  (`user-accounts-retired.ts` 11, `safe-deploy.ts` 3). Mutation M1 (accept a
  disagreeing dual-send) → red.
- #2851 (drop `self_sign_*`, `owner_aliases`) CLOSED. `npm run lint:retired-rail-prose`
  → 33 hits / 31 files (was 34 / 32, shrink-only, green).
  `node scripts/ci/safe-account-rename-census.mjs origin/dev` → 752 surviving
  hits, every one in an allowed path class, no allow-listed file grew.
- Block 4 residue: 184 files carry a retired term (was 192 on 09-15), 46
  historical / 138 live (was 146); in scope 15 live files, all enforcement
  tests, drop migrations or comments describing the term as history. Nothing
  live reads the retired rail. No finding.

## 6. Proposals (ranked by evidence), beyond the 09-13 list

1. **`suggested_arguments` + typed `NextStep`** — F1's slices 1–2; the
   cheapest closure of the class the record names thirteen times.
2. **Scheme pin on the paid retry** — refuse or upgrade a non-`https`
   `resource.url`, prefer the URL the agent quoted, and say when the
   merchant's challenge disagrees with it (D1). One PR; a `qa-dev` scenario
   against the Ampersend sandbox would pin it live.
3. **Schema-derived refusals** — F1 slice 3; replaces 22 hand-written
   `STRICT_INPUT_TOOLS` reasons with one generator.
4. From 09-13, still undecided and still supported by this run's evidence:
   `haven_signer_status` (D3), dry-run prepare (F3), explain-what-I-sign.

## 7. Probed clean (block → command → number, at `4ed69592`)

- Sizing → `find packages/<p>/src -name '*.ts' ! -name '*.test.ts' ! -path '*__tests__*' | xargs wc -l`
  / tests → signer 3,042 src / 4,417 test (09-13: 2,864 / 4,091); mcp 1,863 /
  3,577 (1,762 / 3,386); mcp-server 6,830 / 13,407 (6,128 / 11,903);
  demo-merchant-mcp 3,556 / 3,746 (3,169 / 2,767). Largest: `contracts.ts`
  1,089, `paid-mcp-completion.ts` 916, demo `x402.ts` 1,516.
- block 1 **guard falsifiability** → the block's candidate script → 149
  candidate files (the P5 landing touched most of them); 5 mutations in scope
  with `cp` backups, restores byte-identical (`git diff --quiet`): M1 retired
  dual-send disagreement accepted → red; M2 signer consent refusal off → red
  (1/10); M3 local MCP missing `delegate_key` accepted → red (1/28); M4 demo
  settled-cache cleanup off → **survivor** (33/33; C2); M5 signer typed-data
  digest commitment off → red (2/30) — after `npm run build -w packages/sdk`
  (a stale dist first made the suite error, which is the recorded signer-test
  trap). **4 of 5 caught.**
- block 2 **`covers:` completeness** → the block's loop under `bash` → 8
  contract docs; in scope `mcp-runtime-compatibility.md` cites 28, covers 22,
  **17 cited-but-not-covered** (09-15: 17 of 27 — unchanged, not re-reported);
  `04-x402-payment-sequence.md` 3 of 23.
- block 3 **stale numbers** → the four package READMEs + the runtime doc carry
  **0** figure-bearing lines (nothing to re-derive); ledger re-derivations are
  the sizing deltas above.
- block 4 **retired vocabulary** → 184 files / 46 hist / 138 live, positive
  control 36 shards; code half unchanged (`failPendingX402Intent` only in its
  defining file; the other two have the qa-agent importer).
- block 5 **merge-method drift** → not taken (out of scope; 09-15 baseline
  holds).
- block 6 **nets with holes** → in scope: 3 verb files, 1 outside every glob
  (C1); doc perimeter vs JSON perimeter diverge on 5 package globs.
- block 7 **chain health** → not taken.
- incident clustering → 120 `area:mcp` issues since 2026-08-01 (69 Aug, 51
  Sep), by title class: x402 32, signer 23, settle 19, erc7710 18,
  quote/prepare 17, connect 17, next_* 12, catalog 11, demo merchant 10;
  argument-spelling 7 (Aug 31–Sep 1) + the live one. The `qa-dev` money-flow
  cluster (20 `qa-failure` issues Aug 12 → Sep 8) is **closed**: consolidated
  into one tracker (#2767) and `gh run list --workflow qa-dev.yml --limit 40`
  → 40 / 40 success.
- workflow archaeology → last 200 Actions runs: 16 with attempt > 1 (docs
  quality 4, copy lint 3, docs coupling 3, DS coupling 3 — the parked-run
  re-runs after bot baseline pushes), 4 failures; `ci.yml` last 60: 45
  success / 5 failure / 10 cancelled; 4 of 135 in-scope commits since 08-15
  mention flake/rerun.
- comment archaeology → `TODO|FIXME|HACK` in the four packages → 0; the most
  repeated warning (×4, `credentials.ts` in mcp and signer) explains why an
  undefined `expectedSafe` would skip the sweep cross-check — a reason for a
  refusal, not a workaround.

## 8. Decisions requested

1. **F1** → epic via `new-task` § Epics (five slices above), or fold into
   the still-pending 09-13 F3 decision as one "agent response contract" epic?
2. **D1** → file now as `new-task` (security-adjacent; one PR + a qa-dev
   scenario)? I recommend yes, first.
3. **C1, C2, D2** → file as `new-task`s now? (B10 turned out shipped — #2997.)
4. **Proposals 4/7/8/9 from 09-13** → still undecided; a yes/no per item
   would let the next pass stop re-listing them.
