# @haven_ai/cli

Release headers are written by the release bump (`npm run release:bump`), never by
hand — true since the changelog-heading gap, and stated here only because it was asserted for a long
time while being false. The bump rewrites the `## Unreleased` heading below into
`## <version> — <date>`; add entries under `## Unreleased` and leave the heading
alone.

Mark a bullet `**Update required**` when a client must update to keep paying.
The bump then flags that release `action_required` in the public release data
(`/releases`, `GET /discovery`, `/.well-known/haven.json`; #3305). It is not
`**BREAKING**`, which means updating may break you, not that you must update.
Write it exactly: "update required" in any other form (including "no update
required") is refused — reword to "no update needed", or quote it in a code span.

## Unreleased

### Added

- **`haven feedback submit "<text>"` (#3597).** A one-way feedback/bug-report channel to Haven for a signed-in user and the agent working in their terminal — needs `haven login`, 4000 characters (code points) or fewer, several unquoted words are joined into one text like `contacts add`'s own free-text argument. A local secret check refuses to send text that looks like a secret — a labelled credential, a secret this machine itself holds (read with `node:fs`, never `@haven_ai/connect`), a 64-hex token whose derived address is one of your own agents' or accounts', or a BIP-39 recovery phrase — before any request carrying the text is made, and the backend re-runs the labelled, address and recovery-phrase checks as a backstop. Retention is 7 days; there is no reader yet (that is a separate, founders-only console issue). `@noble/hashes` and `@scure/bip39` join as devDependencies, bundled into `dist/*` — the `dependencies: {}` guard is unchanged.

### Fixed

- **`haven guide`'s bundled runbook reworded three cross-references for the new agent-skills step files (#3596).** The canonical runbook (`packages/sdk/src/agent-guidance.ts`) is now also served, split into small linked files, at `/agent-skills/<step>.md` — one `## ` section's cross-reference to another ("in that prompt (below)") assumed proximity it no longer has once split, a "Steps 1-3" reference gained a short gloss of what those steps are (and lost a trailing ", as above"), and "the setup above" now names "The sequence". Regenerated with `sync-agent-guidance.mjs`; no command, flag or output shape changed. No update needed.

## 0.7.0-alpha.0 — 2026-09-29

### Fixed

- **The bundled agent runbook runs the CLI command the manifest serves (#3430, #3455).** It had told an agent to build `npx @haven_ai/cli@<channel>` from `packages.cli.channel`, which serves the full spec, so the command came out as `npx @haven_ai/cli@@haven_ai/cli@dev`. It now runs `packages.cli.one_liner` as given. The README's two quick-start lines say the same.

- **The bundled agent runbook's `client_update` line promises `upgrade_command` runs as given (#3412).** It now says to run `upgrade_command` as given, then any repair line it prints, then retry — the connector-installed packages' command became the connector doctor, which works on an existing install. Text only; no command or flag changed.

## 0.6.0-alpha.0 — 2026-09-26

- **`haven guide`: "If something breaks" (#3304, epic #3302).** The bundled agent runbook (a copy of `@haven_ai/sdk`'s) gains the section that sends an agent to a result's `client_update.upgrade_command` and to the `/releases` page. Text only; no command changes.

- **`wallets balances` renders the balance-freshness marker (#3318).** Since
  the backend started serving last-known balances marked `stale` on a failed
  read (#3295), and `'0'` marked `unavailable` only when nothing was ever
  read (#3317), the CLI printed those entries as if they were current. A
  stale entry now prints with a hint — `≈ 25 ETH (as of 45m ago)` — because
  the figure is real but not fresh; an unavailable entry prints
  `unavailable` instead of the filler zero. A clean entry prints exactly as
  before, and `--json` is unchanged: the marker passes through verbatim
  where the server sent it and stays absent where it did not. The registry
  reads (budget grants, connect) are untouched — address, decimals and
  symbol are byte-identical either way.

## 0.5.0-alpha.1 — 2026-09-25

- **Client identity (#3303, epic #3302).** Every Haven API request the CLI makes carries `X-Haven-Client: @haven_ai/cli/<version>` (`CLI_CLIENT_IDENTITY`), so the backend can tell an outdated CLI what to run. No command output changes.

## 0.5.0-alpha.0 — 2026-09-25

- `activity list` rows carry `scope` (`{ source: 'wallet', filter }` — `--agent` / `--safe` narrow the wallet feed, they do not make it the receipts view), `timestampSource` (which column produced `timestamp`) and, on x402-synthesized rows, the recorded nullable `confirmedAt`; a confirmed payment with no evidence row reports `paymentProofStatus: null` instead of a placeholder (#3132) — the dashboard's transaction detail "Proof" row, which renders only a present value, disappears for such a payment rather than reading `payment_confirmed`; that is the fabricated field going away, not a regression. The usage line says the feed is wallet-scoped.

## 0.4.0-alpha.0 — 2026-09-19

## 0.3.0-alpha.0 — 2026-09-17

### Fixed

- **BREAKING for older backends, and a fix against current ones (#2914).**
  `GET /user/accounts` returns an `accounts` envelope; this package still read
  `safes`, which broke `wallets list`, `wallets balances`, `wallets funding`,
  `activity list --safe`, `activity export --safe` and `agents connect` with a
  `TypeError`. The envelope is now read through one function that fails with a
  sentence naming the cause instead of a stack trace.

### Removed

- The dual-name emission promised by 0.2.0-alpha.0 is gone, one release later
  as stated there: `--json` and the CSV header carry `account_id` /
  `account_address` only (the `safe_address` CSV column is dropped, shifting
  column indexes for an importer keyed on position), `/transactions` is
  queried with `?accountId=` only, and the connection-setup body sends
  `account_id` only.

### Compatibility note

- **Requests.** The server accepts `safeId` / `safe_id` **beside** the new name
  when both agree, so the dual-sending 0.2.x CLI keeps working against a
  contracted backend; sending only the retired name is refused with a typed
  400.
- **Responses.** A published client cannot dual-READ, so two names it depends
  on are not contracted in this release: the `safes` envelope key on
  `GET /user/accounts` (0.2.1-alpha.0 destructures it at five call sites and
  would throw) and `safeName` on the `GET /transactions` feed (it renders the
  ACCOUNT column from that name and would print every row blank). Both are
  emitted alongside `accounts` / `accountName` for one more release and are
  removed in the release after this one, by which time `latest` reads the new
  names.
- Together those mean **there is no release-ordering constraint** — neither
  side has to ship first. An earlier draft of this entry claimed that on the
  strength of the request half alone; review caught that the response half
  imposed exactly such a constraint, and the fix was to remove the constraint
  rather than to document it.

## 0.2.1-alpha.0 — 2026-09-16

- **No source change in this release.** `@haven_ai/cli` is republished so its version and
  its internal `@haven_ai/*` pins stay in lockstep with the other four packages; the CLI
  behaves identically to 0.2.0-alpha.0.

## 0.2.0-alpha.0 — 2026-09-14

### Naming epic #2906, phase 1 (#2908) — new paths, dual-emit on stdout

- Calls the account-vocabulary paths: `GET /user/accounts`,
  `GET /user/accounts/:id/funding`, `PUT /user/accounts/:id`
  (`/balances/{address}` is a single dynamic segment and needs no twin).
  **Release-ordering constraint:** the CLI does NOT fall back to `/user/safes*`
  on a 404 — a backend carrying #2907 (PR #2930, the `/user/accounts*` twin)
  must be LIVE on the environment the CLI targets before the release carrying
  this CLI is promoted to `latest`; otherwise `wallets list|balances|funding|
  rename`, `activity --safe`, `agents connect` and wallet resolution in
  `send`/`pay` 404 at once. (The query key and the request body are dual-sent
  and have no such constraint.)
- `activity list` / `activity export` send `?accountId=` AND `?safeId=` (same
  value; `accountId` wins on the server; the old key keeps a pre-#2907 server
  filtering, because an unknown query key is silently ignored).
- `agents connect` sends `account_id` AND `safe_id` (same value) in the
  setup request body.
- Reads the account address from either `account_address` or `safe_address`
  on every server response it consumes (new first).
- `--json` dual-emit for the window (no negotiation exists for stdout):
  `wallets rename` → `account_id` + `safe_id`; `wallets balances` →
  `account` + `safe` (wallet name). **`safe_id` / `safe` removed at #2914.**
- CSV export: `account_address` column **appended** after `chain_id` (same
  value as `safe_address`; append-only, never reorder). **`safe_address`
  column removed at #2914.**
- The `--safe <id|address>` flag is unchanged in this release.
