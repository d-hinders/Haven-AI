---
owner: "@d-hinders"
status: current
covers:
  - packages/cli/src/commands.ts
  - packages/cli/src/output.ts
  - packages/connect/src/doctor.ts
  - packages/backend/src/openapi/spec.ts
  - scripts/ci/vocabulary-map.json
  - scripts/ci/vocabulary-divergence.mjs
last-verified: "2026-09-19"
---

# CLI `--json` conventions

`npx @haven_ai/cli --json` does not use one casing convention. It uses several,
and **that is a decision, not an accident** (#3133, owner decision 2026-09-18).
This page says which command returns which, so the next reader finds the
decision instead of the inconsistency.

## The short version

| you are reading | you get |
|---|---|
| a **list** command | whatever the backend sent — the CLI forwards it |
| a **result** envelope (`{ "ok": true, … }`) | the CLI's own shape, snake_case identifiers beside a bare `ok` |
| **`wallets balances`** | camelCase — the one command that re-maps |
| a **prepared-action** result (grant, revoke) | CLI-chosen snake keys spread over the backend's object |
| **`activity export`** | the body inside an `{ "ok": true, … }` wrapper under `--json` — snake_case headers for csv, a verifikat file for sie |
| **any failure** | `{ "ok": false, "error": { "code", "message", "hint"? } }` |
| the **on-disk credential file** | `account_address`, possibly still `safe_address` on an old install |

## Why the split stays

`/user/accounts` already took one breaking rename this quarter — `safes` →
`accounts`, `safe_address` → `account_address` (#2914, #3091) — and it cost a
dual-emit, a release boundary and a `dist-tags` verification. A second breaking
rename to the same surface inside two epics is not worth the tidiness.

There is a second, sharper reason. The CLI is **mostly a pass-through**:
`emit()` forwards its argument straight to the output layer with no re-mapping,
so a list command's casing *is* the backend's. Normalising would make the CLI
start owning a presentation contract that diverges from the OpenAPI response
schema — which is exactly what `interface Txn` already does badly (see below).

"Mostly", because there is one exception and it is worth knowing about:
**`wallets balances` re-maps.** It reads `chain_id` from the backend and emits
`chainId`. That is the single place the CLI today makes a casing decision of its
own on a forwarded value, and it is declared as such rather than tidied away.

And a rename could never be complete. The credential file on disk carries
`account_address` with a **permanent** `safe_address` fallback (#2906 decision
2a): moving a dist-tag does not rewrite a file that is already on someone's
machine, so an un-rekeyed install keeps the old spelling indefinitely.

The full rationale for the branch *not* taken is recorded on
[#3133](https://github.com/d-hinders/Haven-AI/issues/3133), so the decision can
be audited rather than re-litigated.

## What is authoritative

**The OpenAPI response schema is the authoritative `--json` shape.** Not
`interface Safe` and not `interface Txn` in `commands.ts`: those are a
**non-exhaustive subset the CLI happens to read**. The emitted JSON carries
every key the backend sends, including several that appear in no interface —
`paymentProofStatus`, `x402MerchantAddress`, `amountSek`, `settlementScheme`,
`initiatedBy` among them.

So: to know what `activity list --json` can contain, read the `Transaction`
schema, not `interface Txn`. Scripting against the interface will miss fields
that are already being emitted.

Since #3132 every `activity list` row also carries `scope: { source: 'wallet',
filter }` — the feed is wallet-scoped, and `--agent` / `--safe` NARROW it
(`filter: 'agent' | 'account' | 'account+agent' | null`; `--direction` is
applied client-side after the response and is not part of `scope`) rather than turning it
into the agent-scoped receipts view the MCP's `haven_list_receipts` returns
(`{ source: 'agent', filter: null }`). Rows also carry `timestampSource`
(`'block'` | `'confirmed_at'` | `'created_at'`), naming the column behind
`timestamp`, and x402-synthesized rows carry the recorded, nullable
`confirmedAt`; their `paymentProofStatus` is `null` when no evidence row
exists, never a placeholder.

## Per command

### Pass-through — the backend's casing

| command | convention | keys you will see |
|---|---|---|
| `wallets list` | snake | `account_address`, `chain_id`, `is_default` |
| `activity list` | camel | `accountAddress`, `chainId`, `tokenSymbol` |

The two differ because the two **backend** surfaces differ. That divergence is
the subject of epic
[#3130](https://github.com/d-hinders/Haven-AI/issues/3130); this page only
records that the CLI faithfully reproduces it.

### Envelopes — the CLI's own shape

Result commands emit `{ "ok": true, … }` with snake_case identifiers:

```json
{ "ok": true, "agent_id": "…", "status": "revoked" }
{ "ok": true, "account_id": "…", "name": "…" }
{ "ok": true, "contact_id": "…", "removed": true }
{ "ok": true, "signed_out": true }
```

**The auth envelopes mix conventions inside one object** — `expires_at` beside
`apiBaseUrl`:

```json
{ "ok": true, "email": "…", "expires_at": "…", "user": {…}, "apiBaseUrl": "…" }
```

Three code paths emit that literal, all of them under `haven login` — the bare
form, the device flow it falls back to without `--email`, and `--poll`. If you
are destructuring it, you need both conventions.

`haven login --no-wait` returns a **different** envelope, pure snake:

```json
{ "ok": true, "verification_url": "…", "user_code": "…", "device_code": "…",
  "interval": 5, "expires_at": "…" }
```

### Prepared actions — snake keys over a backend object

`budget grant` and the revoke preparation spread the backend's response
and add their own snake_case keys. **They add different ones**, so the two are
not interchangeable when you destructure:

```json
// haven budget grant — the CLI adds agent_id and status
{ "…backend fields…": "…", "agent_id": "…", "status": "pending" }

// the revoke preparation — the CLI adds all three
{ "…backend fields…": "…", "agent_id": "…", "delegation_hash": "…", "status": "…" }
```

`delegation_hash` reaches a grant result too, but as one of the spread backend
fields rather than a key the CLI chose — which is why the map records only
`agent_id, status` for it.

Neither is a pass-through and neither is a plain envelope — which is why the
census keys on "an object literal the CLI builds itself", not on a
`{ "ok": true` prefix.

### Two more the census covers, easy to miss

`haven guide` emits `{ "ok": true, "format": "markdown", "content": … }` — the
agent runbook, with no session and no network needed. No multi-word key, so it
exhibits no casing at all; it is declared so the census covers every emitter
rather than only the interesting ones.

`agents connect --run` builds its whole result into a local `const` and hands it
to a helper, which is why an inline-only census could not see it:

```json
{ "setup_id": "…", "approval_url": "…", "connector_command": "…",
  "connector_exit_code": 0, "outcome": {…}, "relay": "…" }
```

Pure snake, and `connector_exit_code` and `relay` are invented by the CLI — no
backend sends them under those names. `outcome` is a nested object; its own keys
are outside the census the way every nested literal is.

### CSV export — a third convention

`activity export --format csv` writes **snake_case headers** over a camelCase
JSON source. Under `--json` the CSV body is wrapped, so you parse an envelope
first and the headers are inside `content`:

```json
{ "ok": true, "format": "csv", "rows": 12, "content": "date,type,status,…" }
```

The SIE export uses the same wrapper with `"format": "sie"` and **no `rows`**,
and its `content` is a verifikat file rather than CSV.

The headers themselves:

```
date,type,status,direction,amount,token_symbol,token_address,
counterparty_address,agent_name,tx_hash,chain_id,account_address
```

Headers are a file-format contract read by spreadsheets and importers, so they
do not follow the payload they were derived from.

### On disk

The credential/signer file stores the account address as `account_address`, and
the connector's doctor — `npx -y @haven_ai/connect@alpha --doctor --runtime
<your runtime>`, a different binary from this CLI — reads `safe_address` too,
permanently. An install that has not been through a `--rekey` or a fresh setup
since #2908 still holds the old spelling; the next one rewrites it.

## How this stays true

Every entry above is declared in `scripts/ci/vocabulary-map.json` under
`cliConventions`, and `npm run lint:vocabulary` (`ci_config_checks`) enforces
the two that are read out of code: a CLI function that hands an **object
literal it built itself** to `emit()`, any `emit*` helper, `d.o.data()` or
`d.o.text()` fails the build until the map records which convention it chose
and why, and the **CSV headers** are compared name for name and in order.
**A new envelope cannot pick a convention by copying its neighbour.**

`d.o.text()` is the one that is easy to miss: its wrapper is assembled in
`output.ts`, but the `meta` argument is a literal in `commands.ts` and its keys
become top-level `--json` keys, which is why `format` and `rows` are censused.

The **pass-through** rows above are a different kind of entry. Their casing is
the backend's, so there is nothing in the CLI for a guard to hold — they are
recorded so the split is legible, not enforced. (The map files the CSV headers
in that same section, because they are not an envelope either; they are the one
entry there that *is* enforced, and the section says so.)

Three things make that claim hold rather than merely sound right:

- The census keys on the **literal**, not on a `{ "ok": true` prefix. Seven of
  the seventeen emitters carry no `ok` key at all — `wallets balances`,
  `whoami`, both prepared-action emits, `agents connect --run` and the two
  `activity export` branches — so a prefix-keyed census could not see them, and
  it could not see a literal wrapped across lines either, which is how the
  larger ones are written.
- It compares **key sets**, not only function names. A key added to an
  already-declared envelope is a convention choice too, and comparing names
  alone let one land green while the map went on describing the old shape.
- It anchors on the **enclosing function**, not a line number. #3133's own line
  anchors were wrong three times across two correction passes, and a guard keyed
  on them goes red on an unrelated edit above, which trains people to update the
  anchor rather than read it. "Function" is the nearest enclosing declaration,
  which is not always the command: `budget grant` and the revoke
  preparation emit through the local arrow consts `emitGrant` / `emitRevoke`,
  and those are the names the map carries.

What is outside it is narrower than it first looks. The **failure envelope**
below is built in `output.ts` rather than `commands.ts` — the one file the
census reads — so it is outside by construction, and recorded here and in the
map's prose instead. The **export wrapper** is only half outside: `ok` and
`content` are added in `output.ts`, but `format` and `rows` come from the `meta`
literal in `commands.ts` and **are** censused, under `cmdActivityExport` and
`exportSie`. Calling the whole wrapper "built in `output.ts`" is what hid them.

### Failures

Every command that fails returns the same shape, whatever it was doing:

```json
{ "ok": false, "error": { "code": "…", "message": "…", "hint": "…" } }
```

`hint` is optional. This is the shape an agent parses most often, so it is worth
branching on `ok` before anything else.
