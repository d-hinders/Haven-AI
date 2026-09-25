---
owner: "@d-hinders"
status: current
contract: true
covers:
  - .github/workflows/publish.yml
  - scripts/release-snapshot-version.mjs
  - scripts/release-channel.mjs
  - scripts/release-bump.mjs
  - scripts/release-version-order.mjs
  - packages/sdk/src/connector-channel.ts
  - packages/mcp-server/src/connector-channel.ts
  - packages/backend/src/config.ts
  - packages/backend/src/routes/agent-connection-setups.ts
  - packages/connect/src/runtime-spec-override.ts
  - packages/connect/src/doctor.ts
  - packages/connect/src/cli.ts
  - packages/connect/src/args.ts
  - packages/connect/src/runtime.ts
  - packages/connect/src/wiring-collision.ts
  - packages/connect/src/prune-runtimes.ts
  - packages/connect/src/storage.ts
  - packages/signer/src/credentials.ts
  - packages/signer/src/file-mode.ts
  - packages/mcp/src/credentials.ts
  - packages/backend/src/middleware/retired-safe-names.ts
  - packages/core/src/client-compat.ts
last-verified: "2026-09-24"
---

# Package dev channel (`@haven_ai/*@dev`)

The five npx-installed packages have a **dev channel**: every package-touching
push to `dev` publishes a throwaway snapshot of all five under the npm
dist-tag **`dev`**, so a package change can be installed and exercised against
the shared dev backend **without a production release**. This doc is the loop
for doing that, the operator steps that make it work, and the order those steps
have to happen in — the order was learned the hard way on the first day (see
[the checklist](#operator-checklist-owner-only)).

It documents epic [#2420](https://github.com/d-hinders/Haven-AI/issues/2420) as
it merged: [#2421](https://github.com/d-hinders/Haven-AI/issues/2421) (the
publish job), [#2422](https://github.com/d-hinders/Haven-AI/issues/2422) (the
backend's connector handout), [#2423](https://github.com/d-hinders/Haven-AI/issues/2423)
(the re-run hints) and [#2424](https://github.com/d-hinders/Haven-AI/issues/2424)
(the local runtime-spec override). The **production** release path is
unchanged and is not described here — see
[`../contributing/branch-and-release-flow.md`](../contributing/branch-and-release-flow.md)
and the `release` skill.

> **Re-verified unchanged (#3267, 2026-09-24, the Safe-era identifier rename):**
> this doc is coupled through `routes/agent-connection-setups.ts` and
> `middleware/retired-safe-names.ts`. The route's change is one internal
> identifier: the `ApprovalStateInput.safeTxHash` field becomes
> `accountTxHash` — a value the repo layer writes to the `account_tx_hash`
> column it always wrote, not the wire input (`safe_id` stays DECLARED and
> REFUSED with a 400 exactly as #2914 left it). The refusal machinery this
> document depends on in `retired-safe-names.ts` is untouched (the file is not
> in the diff). Verified against the diff: `CONNECTOR_PACKAGE`, `CLI_PACKAGE`,
> `config.connectorChannel` and the `/discovery` response shape are unchanged,
> and no channel, dist-tag, version-order or publish behaviour moves. Scope of
> this note: that identifier rename — nothing else in this document was
> re-verified.
>
> **Re-verification (#3271, direct sign-context, 2026-09-24):** this doc is
> coupled through `packages/signer/src/credentials.ts`, where the only change
> is JSDoc: it now names the signer's second read-only fetch
> (`GET /payments/:payment_id/sign-context`, for a direct payment via
> `haven_sign`). Credential resolution, file modes and the `identity.json`
> lookup are unchanged, and no version, dist-tag, channel or publish behaviour
> moves. `last-verified` re-stamped to 2026-09-24 for this note only; nothing
> else in this document was re-verified.
>
> **Re-verification (#3032, connector request fields and owner-route auth
> order, 2026-09-24):** this doc is coupled through
> `packages/backend/src/routes/agent-connection-setups.ts`. The change moves
> the four owner routes' auth hook from `preHandler` to `onRequest`, and
> declares in the OpenAPI request schemas the fields the connector and
> dashboard already send (`local_mcp`, `mcp_server_name`, `skill_installed`,
> `superseded_agent_ids`). The setup, register and install-status flow this
> document describes for the dev channel is unchanged, and no channel,
> dist-tag, version-order or publish behaviour moves. Scope of this note: that
> file — nothing else in this document was re-verified.
>
> **Re-verification (#3259, failed tombstone mirror, 2026-09-23):** this doc is
> coupled through `packages/connect/src/{cli,runtime}.ts`. The change: a failed
> ledger mirror no longer aborts a retirement, so `--replace` still removes the
> superseded directory's key files and logs a warning, and `--tombstone` /
> `--unwire` report the failure additively. Re-read against the diff: the
> `--replace` guidance in step 2 ("it retires that agent's local key files") is
> now true in the one case where it used to be false, and no channel,
> dist-tag, version-order or publish behaviour moves. `last-verified` already
> reads 2026-09-23. Scope of this note: that passage — nothing else in this
> document was re-verified.

> **Re-verification (#3251, tombstone ledger follows the credential root,
> 2026-09-23):** this doc is coupled through `packages/connect/src/{cli,
> runtime,doctor}.ts`. The change: the retirement record that `--tombstone`,
> `--unwire` and `--replace` mirror now lands in the ledger of the credential
> root that held the retired directory, and `--doctor` reads the ledger of the
> root it scans. For the default root that is `~/.haven/tombstones`, as
> before; any other root keeps it at `<root>/.tombstones/`. Re-read against the diff: the `--replace`
> guidance in step 2 (it retires that agent's local key files; `--doctor`
> enumerates every agent regardless of name) and the override passage
> (`~/.haven/signer-runtime/override-<hash>`) are unchanged, and no channel,
> dist-tag, version-order or publish behaviour moves. Scope of this note: those
> passages — nothing else in this document was re-verified.

> **Re-verification (0.2.1-alpha.0 release, 2026-09-16):** this doc is coupled
> to the release because the bump rewrites `CONNECTOR_VERSION`
> (`packages/connect/src/runtime.ts`), which is in this doc's `covers:` list.
> **In THIS release the coupling is carried by that file alone**: an earlier
> draft of this note also claimed `HAVEN_CONNECTOR_CHANNEL`
> (`packages/sdk/src/connector-channel.ts`) was "re-pinned", and independent
> review found that file is not in the commit at all — the channel was already
> `alpha`, so the bump's write produced no diff. Verified rather than asserted:
> channel `alpha` (unchanged, no diff),
> version `0.2.1-alpha.0`, agreeing across the source, the built connect bundle,
> and the SDK that bundle resolves. **No channel behaviour changed** — nothing in
> this release touches `publish.yml`, `release-channel.mjs`,
> `release-snapshot-version.mjs` or `release-version-order.mjs`, so the
> `0.0.0-dev.*` snapshot path and the rule that the two channels cannot cross are
> untouched. `last-verified` is deliberately NOT bumped: it already reads
> 2026-09-16 from an earlier change today, and re-stamping it would assert a
> whole-document re-verification this release did not perform. Scope of this
> note: `CONNECTOR_VERSION` and the channel constant's unchanged value — nothing
> else in this document was re-verified.

> **Re-verification (#3172, signer audit sidecar, 2026-09-19):** this doc is
> coupled through `packages/signer/src/credentials.ts`, where the only change
> is that `warnIfCredentialFilePermissive` now delegates to a shared
> `file-mode.ts` helper (same message, same `chmod 600` hint, same Windows
> carve-out, and still `stat` — a symlinked credential path is judged by its
> target as before; only the sidecar check uses `lstat`) so the audit sidecar
> can reuse it. `file-mode.ts` is added to this doc's `covers:` because that
> claim now lives there. The credential's NAME
> resolution — `account_address` first, the two pre-#2908 names read
> permanently — is untouched, so the `credentials` check this document describes
> reports exactly what it did. No channel, version-order or publish behaviour
> is touched. `last-verified` is not re-stamped: it already reads 2026-09-19.
> Scope of this note: that one function — nothing else in this document was
> re-verified.

> **Re-verification (#3135, request-validation flip re-key, 2026-09-18):** this
> doc is coupled again through the same `covers:` entry on
> `packages/backend/src/config.ts`, and again only a JSDoc block and the
> boot-refusal error string changed: the per-module override is now keyed on
> the route FILE (`enforcedModules: ['routes/contacts.ts', …]`) rather than the
> mount prefix. The accepted values, the default, the restart semantics and the
> variable's irrelevance to package selection are all untouched, so **nothing in
> this document was made false or stale by that edit** — step 5's claim was
> re-read against the merged tree and holds. `last-verified` is deliberately
> NOT bumped: the re-read confirmed the existing claims rather than adding or
> changing one, and a date moved for that is a rubber stamp the staleness audit
> would then rank on.

> **Re-verification (#3082, request-validation body restore, 2026-09-17):** this
> doc is coupled because `packages/backend/src/config.ts` is in its `covers:` and
> that file was edited. Only a JSDoc block and the boot-refusal error string
> changed, both describing `HAVEN_REQUEST_VALIDATION`: `off` does not disable an
> `enforcedPrefixes` module, and shadow's "changes nothing" was true of the
> handler's view only after #3082 restored the request body. No parse shape, no
> default, no accepted value and no restart semantics moved.
> **Nothing in this document was made false or stale by that edit.** Its own
> claim at step 5 — `off`/`shadow`/`enforce`, default `shadow`, a mode change is
> a restart, and the variable does not affect the package-selection path — was
> re-read against `config.ts` and `openapi/request-validation.ts` at this
> commit and is true in every clause, which is why it needed no content change.

> **Re-verification (contract-doc count correction, 2026-09-17):** this doc is
> coupled because `scripts/release-bump.mjs` is in its `covers:` and that script
> was edited — its *printed* next-steps block said "the two contract docs" and
> enumerated two, while the docs had been corrected to three. Only operator-facing
> log strings and comments changed; no version, pin, channel, dist-tag, build
> order or credential path moves, and `release-bump.test.mjs` is 76/76.
> **Nothing in this document was made false or stale by that edit** — it carries
> no contract-doc count of its own, which is why it needed no content change.
> `last-verified` deliberately NOT bumped: this is a scoped check of one script
> edit, not a re-verification of the document, and #1366 rates a rubber-stamped
> date worse than a stale one.

> **Re-verification (0.3.0-alpha.0 release, 2026-09-17):** coupled because the
> bump rewrites `CONNECTOR_VERSION` (`packages/connect/src/runtime.ts`), which
> is in this doc's `covers:`. Verified rather than asserted: the bump's own
> checks report channel `alpha` and version `0.3.0-alpha.0` agreeing across the
> source, the built connect bundle and the SDK that bundle resolves. **No
> channel behaviour changed** — nothing in this release touches `publish.yml`,
> `release-channel.mjs`, `release-snapshot-version.mjs` or
> `release-version-order.mjs`, so the `0.0.0-dev.*` snapshot path and the rule
> that the two channels cannot cross are untouched. Worth noting for this
> release specifically: `0.0.0-` still sorts below every real version, so the
> MINOR bump to 0.3.0 changes nothing about channel ordering. `last-verified`
> deliberately NOT bumped — **it already reads 2026-09-17 from an earlier change
> today**, and a scoped check of one constant is not a re-verification of this
> document; #1366 rates a rubber stamp worse than a stale date. Scope: `CONNECTOR_VERSION` and the channel constant's value.

> **Re-verification (0.5.0-alpha.1 release, 2026-09-25):** coupled because the
> bump rewrites `CONNECTOR_VERSION` (`packages/connect/src/runtime.ts`), now
> `0.5.0-alpha.0` → `0.5.0-alpha.1`, with channel `alpha` agreeing across
> source, bundle and resolved SDK. Re-measured at `origin/dev` `20176679`:
> `git log origin/main..origin/dev` over `publish.yml`, `release-channel.mjs`,
> `release-snapshot-version.mjs` and `release-version-order.mjs` returns **0**
> commits, and the bump's own diff touches **0** of them. Live dist-tags read
> during this release: `dev` = `0.0.0-dev.202609251409.98ed67a` on all five
> packages, below `alpha`/`latest` = `0.4.0-alpha.0`. `0.5.0-alpha.0` never
> reached npm (see the runtime-compatibility note), so the next `alpha`/`latest`
> is `0.5.0-alpha.1`. `last-verified` is not bumped.
>
> **Re-verification (0.5.0-alpha.0 release, 2026-09-25):** coupled because the
> bump rewrites `CONNECTOR_VERSION` (`packages/connect/src/runtime.ts`), which
> is in this doc's `covers:`. Verified rather than asserted: the constant moved
> `0.4.0-alpha.0` → `0.5.0-alpha.0`, and the bump's own checks report channel
> `alpha` agreeing across the source, the built connect bundle and the SDK that
> bundle resolves. **No channel behaviour changed** — re-measured, not carried
> over from the 0.4.0 note: `git log origin/main..origin/dev` over
> `publish.yml`, `release-channel.mjs`, `release-snapshot-version.mjs` and
> `release-version-order.mjs` returns **0** commits, and this bump's own diff
> touches **0** of them, so the `0.0.0-dev.*` snapshot path and the rule that the
> two channels cannot cross are untouched. The `dev` tag observed during this
> release, `0.0.0-dev.202609250737.3bd5a51`, sits below `alpha`/`latest` at
> `0.4.0-alpha.0` exactly as the ordering rule requires; a MINOR step changes
> nothing about that. `last-verified` deliberately NOT bumped — it already
> reads 2026-09-24 from an earlier change, and this note re-reads only
> `CONNECTOR_VERSION` and the channel constant's value.

> **Re-verification (0.4.0-alpha.0 release, 2026-09-19):** coupled because the
> bump rewrites `CONNECTOR_VERSION` (`packages/connect/src/runtime.ts`), which
> is in this doc's `covers:`. Verified rather than asserted: the constant moved
> `0.3.0-alpha.0` → `0.4.0-alpha.0`, and the bump's own checks report channel
> `alpha` agreeing across the source, the built connect bundle and the SDK that
> bundle resolves. **No channel behaviour changed** — measured over the whole
> promotion range and over this bump's own diff, neither touches
> `publish.yml`, `release-channel.mjs`, `release-snapshot-version.mjs` or
> `release-version-order.mjs`
> (`git log origin/main..origin/dev -- <those four>` is empty, as is
> `git diff --name-only` for them here), so the `0.0.0-dev.*` snapshot path and
> the rule that the two channels cannot cross are untouched. Specific to this
> release: a MINOR step changes nothing about channel ordering — `0.0.0-` still
> sorts below every real version, and the `dev` tag observed during this release
> (`0.0.0-dev.202609190936.6937e31`) sits below `alpha`/`latest` at
> `0.3.0-alpha.0` exactly as the ordering rule requires. `last-verified`
> deliberately NOT bumped — **it already reads 2026-09-19 from an earlier change
> today** (#3122) — and a scoped check of one constant is not a re-verification
> of this document; #1366 rates a rubber stamp worse than a stale date. Scope:
> `CONNECTOR_VERSION`, the channel constant's value, and the four
> channel-machinery files named above.

## What `@dev` is, and is not

- **Which packages.** The five the publish loop names — `sdk`, `signer`, `mcp`,
  `connect`, `cli` (`for pkg in sdk signer mcp connect cli` in
  `.github/workflows/publish.yml`). `mcp-server`, `backend` and `frontend` are
  not on npm; they deploy from `dev` to the dev environment on their own
  ([`dev-environment.md`](dev-environment.md)).
- **What a snapshot version looks like.** `0.0.0-dev.<YYYYMMDDHHMM>.<shortsha>`
  — a 12-digit UTC timestamp and the 7-character short SHA of the `dev` commit
  the workflow ran on (`scripts/release-snapshot-version.mjs`, which both
  produces the string in CI and validates it in `release-bump.mjs`). `0.0.0-`
  sorts below every real version, so no `^0.1.x` range can resolve to a snapshot
  by accident and nobody has to reason about `dev` vs `alpha` prerelease
  ordering.
  The same property is why the backend's client-version signal (#3303)
  **exempts** a snapshot: a `0.0.0-dev.*` version in `X-Haven-Client` is never
  hinted or refused, whatever minimum the deployment sets
  (`isSnapshotVersion` in `packages/core/src/client-compat.ts`), so a dev-channel
  install keeps working against dev after a minimum is set.
- **All five carry the same version.** The job runs the ordinary
  `scripts/release-bump.mjs` with `--snapshot` over the CI checkout, so the
  cross-package pins, connect's `runtime-manifest.ts`, the baked version
  constants and the connector-channel constant are rewritten together, then the
  tree is discarded. **Nothing is committed to `dev`.** The committed
  *Supported Runtime Manifest* table in
  [`mcp-runtime-compatibility.md`](mcp-runtime-compatibility.md) therefore keeps
  naming the production versions; that is not drift.
- **A snapshot can never reach `alpha` or `latest`, and `main` can never publish
  a `0.0.0-dev.*` version.** **Five** independent guards enforce it — a
  ref/channel refusal in the *Resolve the publish channel* step, an assertion
  immediately before every `npm publish`, `release-bump.mjs` refusing a
  snapshot version without `--snapshot`, (since #2536) the nomination helper
  refusing to nominate a snapshot for `latest`, and (since #2647) the
  `promote-tags` job that performs the tag move being `main`-only twice over —
  by its `if:`, and by the `npm-production-tags` environment, whose
  deployment-branch policy withholds the npm token from any other ref. They are
  written once, in the header comment of `.github/workflows/publish.yml`; read
  them there. This said "three" until #2580 — #2536 added the fourth and
  updated neither this bullet nor the header sentence it cites.
- **`release-bump.mjs` has a SECOND rule, and snapshots are exempt from it
  (#2580).** Separately from the snapshot wall above, the bump script refuses a
  version that does not move **forward** — so a backwards or unchanged release
  is caught at the release PR rather than after publication, where it would drag
  the `latest` dist-tag down (#2536). A `0.0.0-dev.*` snapshot sorts below every
  real version by construction, so `--snapshot` is exempt: applying a
  forward-only rule to this channel would close it.
- **It is not a release.** No version bump PR, no CASP shard, no contract-doc
  re-pin, no `prod-*` GitHub Release. The dist-tag is `dev`, not
  `next`/`beta`/`canary`: `alpha` is the production channel while the product
  is pre-1.0, and the separate question of moving `latest` was
  [#2310](https://github.com/d-hinders/Haven-AI/issues/2310), settled by
  [#2536](https://github.com/d-hinders/Haven-AI/issues/2536): the PROD channel
  now moves `latest` onto each version it publishes. This channel still does
  not touch it — a snapshot reaches only `dev`, `record_latest_promotion()`
  refuses to nominate a `0.0.0-dev.*` version at all, and since #2647 the job
  that would perform the move does not run on `dev` and could not authenticate
  if it did (the token lives on a `main`-only environment).

  Two names changed there and the distinction matters when reading the
  workflow: the publish job now only **nominates** what it published, in
  `record_latest_promotion()` — the `npm dist-tag add` call it used to make
  inline was moved into the `promote-tags` job, because npm Trusted Publishing
  authorises `npm publish` and nothing else and every tag move on the
  0.1.35-alpha.0 release failed E401 ([#2647](https://github.com/d-hinders/Haven-AI/issues/2647)).

## The loop: test a package change on dev without a prod release

> **Re-verification (changelog-heading gap, 2026-09-14):** `release-bump.mjs`
> gained one responsibility — rewriting `## Unreleased` to
> `## <version> — <date>` in each published package's CHANGELOG — and the
> snapshot path deliberately does **not** take it. A `0.0.0-dev.*` snapshot is
> not a release, so stamping a release heading for one would be false even
> though the tree is throwaway and no CHANGELOG reaches a tarball; the bump
> logs `CHANGELOG headings: skipped — a dev snapshot is not a release` instead,
> and a test pins the `!snapshot` guard. Nothing about the snapshot version
> format, the five guards, `HAVEN_CONNECTOR_CHANNEL` or the publish job moved.

> **Re-verification (#2908, naming epic #2906 phase 1):** the connector's
> covered files changed in what they WRITE and READ, not in how the channel
> works — `runtime.ts` hands `writeCredentials` an `accountAddress` (written to
> disk as `account_address`, no `safe_address`), and `doctor.ts`'s
> `credentials` check reports which name a stored set carries. Nothing about
> `HAVEN_CONNECTOR_CHANNEL`, the re-run hint, the runtime-spec override or the
> publish job moved. The epic's O3 proof is exactly this loop: after the
> release carrying #2908 lands on `@dev`, re-run `npx @haven_ai/connect@dev`
> on one founder machine whose credential files and `~/.haven` env still
> carry the OLD names (`safe_address`, `HAVEN_SAFE_ADDRESS`), confirm
> `--doctor` says `stored under the pre-#2908 name safe_address — still read`,
> pay one x402 call, and confirm the receipt's `payer` field is populated —
> recorded on #2906 before promotion.
>
> **Half of that proof expires with #2914 and half does not, and the
> difference is the whole point.** The credential-FILE half stands: a file on
> disk never rewrites itself, so `safe_address` is read permanently and
> `--doctor` still says so. The ENV half does not: `HAVEN_SAFE_ADDRESS` and
> `HAVEN_WALLET_ADDRESS` are no longer read at all, so that machine now needs
> `HAVEN_ACCOUNT_ADDRESS` set. Re-running the O3 proof after the contraction
> without that change tests a machine that cannot resolve its account, and
> would read as a regression in the connector rather than the intended
> retirement.

Prerequisite: the [operator checklist](#operator-checklist-owner-only) below
has been completed once for the dev environment. If step 5 there is not done,
the dev dashboard hands out the production connector and step 4 here will show
it.

**Checking which channel a deployment hands out, without creating a setup
(#2531).** `GET /discovery` on the backend is public and unauthenticated and
returns `connector_package` — the same `CONNECTOR_PACKAGE` constant the setup
handout uses, so the two cannot disagree. Since
[#2617](https://github.com/d-hinders/Haven-AI/issues/2617) it also returns
`cli_package`, derived from the same `config.connectorChannel` at the same
import (`CLI_PACKAGE`, beside `CONNECTOR_PACKAGE` in
`agent-connection-setups.ts`), so one read names the channel under both
package names. Re-verified 2026-09-12 against #2909 (naming epic #2906 phase
2a): that PR renames `infra/repositories/agent-connection-setups.ts`'s
`UserSafeRow` import to `SmartAccountRow` and its `findUserSafe` call to
`findAccountForSetup` — identifiers only, no change to `CONNECTOR_PACKAGE`,
`CLI_PACKAGE`, `config.connectorChannel`, or the `/discovery` response shape
this section describes. Re-verified again 2026-09-12 against #2910 (phase
2b): that PR renames `routes/agent-connection-setups.ts`'s local
`resolveUserSafe` helper to `resolveAccountForSetup` and the `safeId` field
it constructs on the `NewSetup`/`insertPendingAgent` inputs to `accountId` —
again identifiers only, nowhere near `CONNECTOR_PACKAGE`, `CLI_PACKAGE`,
`config.connectorChannel`, or `/discovery`. Re-verified again 2026-09-13
against #2911 (phase 3, the schema rename): that PR's only touch to
`routes/agent-connection-setups.ts` is a one-line fix keeping
`request.body.safe_id` reading the wire INPUT field name it always read
(a stray mechanical rename briefly turned it into `.account_id`, which
`CreateSetupBody` does not declare — caught by `tsc`, reverted before
merge) — no change to `CONNECTOR_PACKAGE`, `CLI_PACKAGE`,
`config.connectorChannel`, or `/discovery`. Re-verified again 2026-09-17
against #2914 (phase 5, the contraction), and this one is **not** identifiers
only — it changes the WIRE INPUT the sentence above describes.
`POST /agent-connection-setups` now takes `account_id`; `safe_id` is still
DECLARED on `CreateSetupBody`, but only so the handler can REFUSE it with a
400 naming the replacement. Deleting the field instead would have made
Fastify drop it in silence and create a setup with no account behind it,
which looks successful until the agent tries to spend. Still no change to
`CONNECTOR_PACKAGE`, `CLI_PACKAGE`, `config.connectorChannel` or the
`/discovery` response shape — this section's subject is untouched; the input
field it happens to cite is not.

Re-verified again 2026-09-17 against the #2914 FOLLOW-UP (the release that
removes the two response twins and the third retired response name). That
change is RESPONSE-side only: `GET /user/accounts` drops the `safes` envelope
twin, the `GET /transactions` feed drops `safeName`, and
`GET /transactions/filters` renames `safes` to `accounts`. The paragraph
above is about a REQUEST field on `POST /agent-connection-setups`, and that
field's behaviour is unchanged — `safe_id` stays declared and stays refused
with a 400, for the reason the paragraph gives. `CONNECTOR_PACKAGE`,
`CLI_PACKAGE`, `config.connectorChannel` and the `/discovery` shape are again
untouched. The doc is a contract doc for this change because
`middleware/retired-safe-names.ts` is in its `covers:` list; what changed
there is the deletion of the two twin helpers, not the refusal machinery this
document depends on.

Re-verified again 2026-09-21 against PR #3207 (#3030, request validation
slice 2): the only `config.ts` change is the JSDoc above
`requestValidationMode`, whose example list of `enforcedModules` had been
stale since #3167 and now points at `index.ts` as the list's one home; the
key's parser, its three values and the boot refusal on any other value are
untouched, `connectorChannel` and `/discovery` are untouched, so no claim in
this document moved and `last-verified` is left where it is — the
comment-only rule above.

Re-verified again 2026-09-23 against #3255 (backend RPC failover):
`config.ts` gains `PUBLIC_RPC_BASE` / `PUBLIC_RPC_BASE_SEPOLIA` (the two
public-node literals `warnPublicRpc` already used, now named once) and
`rpcUrlBaseFallback` / `rpcUrlBaseSepoliaFallback` (the optional
`RPC_URL_BASE*_FALLBACK` second provider, trimmed by `parseRpcFallbackUrl`).
`connectorChannel`, its parser and `/discovery` are untouched, so no claim in
this document moved and `last-verified` is left where it is.

Re-verified again 2026-09-20 against PR #3202 (epic #3077 decision 14):
the only `config.ts` change is the comment above `marketplaceProspectsEnabled`,
which now states the prospects gate as "the explicit marketplace list names a
testnet" instead of "no mainnet listed"; the key's parser (`parseBooleanFlag`,
the #3015 shape this document holds up), `connectorChannel` and `/discovery`
are untouched, so no claim in this document moved and `last-verified` is left
where it is — the comment-only rule above.

Re-verified again 2026-09-17 against #3078
(the marketplace's slice 1): `config.ts` gains `marketplaceChainIds` and
`marketplaceProspectsEnabled` (the latter through the same `parseBooleanFlag`
this document holds up as the #3015 shape) — two read-side keys beside
`connectorChannel`, which is not touched, and `/discovery` is not touched
either. Identifiers only for this section:

```bash
curl -s "$BACKEND/discovery" | jq -r '.connector_package, .cli_package'
```

That answers step 5's question directly rather than by inference. It is a read
of what the running deployment computes, not of a Railway variable this
repository can see, so it is evidence about the handout and not about the
environment's configuration — the same distinction the operator checklist draws
throughout.

1. **Merge the change to `dev`** through the normal PR route. Nothing about
   the PR changes; there is no version to bump.

2. **Wait for `publish.yml` on `dev`, and check that it actually ran.** The
   workflow's `paths:` filter lists `packages/sdk/**`, `packages/signer/**`, `packages/mcp/**`, `packages/connect/**` and `packages/cli/**` as five separate entries (written here as `packages/{sdk,signer,mcp,connect,cli}/**` for short), so a
   merge that touches only scripts, docs or other packages publishes nothing —
   PR #2463, which added the dev channel, published nothing itself for exactly
   that reason.

   ```sh
   gh run list --workflow=publish.yml --branch dev --limit 3
   ```

   In the run, the *Resolve the publish channel* step logs
   `Publishing on the 'dev' channel (ref 'dev', requested 'auto')`, the bump
   step prints `Snapshot version: 0.0.0-dev.…`, and the run summary carries a
   per-package table with `published under `dev`` on each row. Read the table:
   one package can fail while the others publish (#1159), so a green summary
   glance is not enough.

3. **Confirm on the registry, and poll before concluding.**

   ```sh
   for p in sdk signer mcp connect cli; do
     printf '%-8s ' "$p"; npm view "@haven_ai/$p" dist-tags --json | tr -d '\n'; echo
   done
   npx -y @haven_ai/connect@dev --version
   ```

   Expect a `dev` tag on **all five** pointing at the **same** snapshot version,
   `alpha` unchanged everywhere, and `--version` printing that snapshot.

   **npm's read replicas lag the publish.** On the first dev publish (run
   33772207035, 2026-09-03, recorded in the #2420 thread) four packages showed
   their `dev` tag within seconds, and `@haven_ai/cli` — published last at
   15:24:15Z — did not show it on `npm view` until 15:27:14Z, about three
   minutes later. A check taken 60 seconds after the run would have reported
   four of five. A missing tag right after a green run is lag, not a partial
   publish; re-run the loop until all five agree, and only then treat a gap as
   real (then read the run's per-package table).

4. **Install it against the dev backend.** Open the dev dashboard
   ([`dev-environment.md`](dev-environment.md) has the URL), connect an agent,
   and run the command it hands you **verbatim**. Since #2422 the backend
   decides the channel: its setup response carries the exact package it used in
   `connector_package`, and the command reads `npx -y @haven_ai/connect@dev …`
   only when the dev backend has `HAVEN_CONNECTOR_CHANNEL=dev`. If the command
   names `@alpha`, stop — that installs the production signer against a backend
   running `dev` code, which is the skew this channel exists to catch — and go
   to step 5 of the operator checklist.

   **On a machine that already has a production agent wired** — the normal
   case for a developer laptop — the bare command now stops instead of
   silently re-pointing `haven` / `haven-signer` at the dev agent
   ([#2551](https://github.com/d-hinders/Haven-AI/issues/2551)): a terminal is
   asked, a non-interactive run refuses with `wiring_collision`. Take the
   **alongside** answer here — add `--name <slug>` (the 2026-09-04 rollout
   used `--name devtest`, by hand, for exactly this reason) so the dev agent
   gets its own `haven-<slug>` / `haven-signer-<slug>` pair and the production
   wiring is untouched. Do **not** answer `--replace` on a machine whose
   production wiring you want to keep: it retires that agent's local key files.
   `--doctor` enumerates every agent on the machine regardless of name, so
   step 5 is unchanged. Since #3122 the run also says, BEFORE it writes
   anything, which other directories on the machine still hold a stored key
   and the account each spends from (a warning, never a refusal), and records
   the server name it bound in a non-secret `mcp-server-binding.json` beside
   `last-connect-outcome.json` — so a later run that repoints `haven` at a
   different backend (the channel switch this page describes) names the
   previous binding and flags the backend change before the write; the doctor
   reports two records claiming one name as the `mcp_server_name_rebound`
   advisory. The backend's own record stays the authority for the same
   backend; the local one is a reporting aid.

5. **Verify the install.**

   ```sh
   npx -y @haven_ai/connect@dev --doctor --runtime <claude-code|codex-desktop|codex-cli>
   ```

   `--runtime` is optional here since #3210 — a flagless `--doctor` checks the
   runtime the setup recorded — and stays required for `--repair`, which
   rewrites that config. The doctor reports the installed signer and SDK
   versions (the snapshot),
   starts the local signer for a real stdio handshake and prints its advertised
   compat versions. On the dev channel the pinned build moves often: an install
   that is intact but behind the connector's current pin is reported as an
   **advisory** (`!` marker, "intact, but outdated", both versions named) and
   exits 0 — only a real failure exits 1 (#3121). Run
   `--doctor --repair --runtime <runtime>` to catch up when you want the newer
   snapshot. Its hosted MCP row proves endpoint reachability; the
   `identity_match` row is the authenticated stored-credential check. Every
   "re-run `npx @haven_ai/connect@<tag>`" hint the
   snapshot's packages print names **`@dev`**, because the tag is a build-time
   constant (`HAVEN_CONNECTOR_CHANNEL` in `packages/sdk/src/connector-channel.ts`)
   that the snapshot bump rewrote from the version — a snapshot telling its
   tester to re-run `@alpha` would silently replace the build under test (#2423).

6. **Exercise the change** through the agent. The thing the channel makes
   testable that nothing else did: the dev signer and the dev backend now move
   together, so a backend that emits a new `x402_expected_context_version` can
   be paired with the signer that knows it *before* a production release rather
   than after one. The pairing rules themselves are unchanged and live in
   [`mcp-runtime-compatibility.md`](mcp-runtime-compatibility.md) § *Signer /
   hosted-MCP version skew*.

The hosted MCP server is deployed, not published, so it has no snapshot. It
reads the same `HAVEN_CONNECTOR_CHANNEL` variable at boot for the channel its
own hints name (`packages/mcp-server/src/connector-channel.ts`; operator step 6
below), and deploys from `dev` like the backend.

## Single-developer loop: an unpublished build, no merge at all

For iterating on the signer, SDK or local MCP faster than a merge cycle, the
connector accepts a **local runtime-spec override** (#2424): set
`HAVEN_SIGNER_SPEC`, `HAVEN_SDK_SPEC` or `HAVEN_MCP_SPEC` in the shell that runs
the connector command to anything `npm install` accepts for that package — a
checkout (`file:/abs/path/to/packages/signer`), an `npm pack` tarball, or an
explicit version — and setup, `--doctor --repair` and `--rekey-finish` install
*that* instead of the pinned manifest sibling. The dashboard's command is
unchanged; the variable sits beside it:

```sh
HAVEN_SIGNER_SPEC=file:$PWD/packages/signer  npx -y @haven_ai/connect@dev --setup <token> … --runtime claude-code
```

What to expect, from `packages/connect/src/runtime-spec-override.ts`: setup
prints `RUNTIME SPEC OVERRIDE ACTIVE …` first; the install lands in
`~/.haven/signer-runtime/override-<hash>` (keyed by the resolved specs, never
the pinned directory) and is never reused between runs; and `--doctor` reports
a **failing** `runtime_spec_override` check — that is the record of the override,
not a defect. A malformed value is refused before npm runs. To return to the
pinned manifest, unset the variables and run
`--doctor --repair --runtime <runtime>`. The full contract — the three
variables, what each replaces, the sidecar and wrapper records — is in the
connector's own README:
[`packages/connect/README.md` § *Installing an unpublished signer / SDK / MCP build*](../../packages/connect/README.md#installing-an-unpublished-signer--sdk--mcp-build-haven_signer_spec-2424).

Every pin and every override key leaves its directory behind when you move
on; nothing reclaimed them before #3123. `--prune-signer-runtimes --dry-run`
lists the directories no credential directory's sidecar or wrapper names (the
current pin is always kept), and without `--dry-run` removes them; `--doctor` reports them
as the `signer_runtime_unused` advisory. It never removes a directory any
credential directory names, so switching channels back and forth costs disk
only until you prune.

> **Re-verified #2963:** for a *pinned* (non-override) install `--doctor`'s
> `signer_runtime` check compares intactness against the sidecar and currency
> against the manifest — a dev-channel snapshot that is intact but behind the
> pin now reads as version drift, not `stale or empty`; the override path
> described above is unchanged (it already compared against the sidecar).

> **Re-verified #3120:** the doctor/repair surfaces this loop uses keep their
> contracts. `--doctor` now resolves the runtime from the agent directory's
> `last-connect-outcome.json` when the `--runtime` flag is absent; `--repair`
> is refused by the parser without `--runtime` (#3210), so it never inherits a
> runtime — the override flow above always names its runtime, so it never
> enters either path. The section's commands keep explicit `--runtime <name>`
> flags and behave exactly as written; the snapshot channel rules, the five
> guards and `HAVEN_CONNECTOR_CHANNEL` did not move.


The two loops compose: `@dev` picks the connector, the override picks the
signer/SDK/MCP it installs. The connector package itself has no override — it
is the process running — so a change to `packages/connect` takes the merge
route above.

## Operator checklist (owner-only)

These are owner actions on npmjs.com and Railway; agents never perform them.
**The order is the content.** On 2026-09-03 step 5 was done before step 4
existed: the dev dashboard handed out `npx -y @haven_ai/connect@dev …` and npm
answered `ETARGET` until run 33772207035 created the tag (#2420 thread). The
boxes below are deliberately unticked — this doc describes the mechanism, and
the live state of an environment is read from the environment, not from prose.

- [ ] **1. npm Trusted Publisher entries.** For each of the five packages,
      npmjs.com → package → *Settings* → *Trusted Publisher* references
      repository `d-hinders/Haven-AI` and workflow file `publish.yml`. npm's
      trusted-publisher config has no branch restriction, so a dev publish
      needs no change here — this is a check, not an edit. It is also why the
      dev channel lives in the *same* workflow file: a second file would need
      five new entries before it could authenticate.
- [ ] **2. The publishing slice is on `dev`.**
      `git merge-base --is-ancestor 709f87f3 origin/dev && echo yes` (PR #2463).
- [ ] **3. A package-touching push has run the workflow on `dev`.**
      `gh run list --workflow=publish.yml --branch dev --status success --limit 1`
      shows a run whose *Resolve the publish channel* step says `dev`. If there
      is none, the `paths:` filter has simply not been hit yet: either merge a
      change under `packages/{sdk,signer,mcp,connect,cli}/**`, or run
      *Actions → Publish packages → Run workflow* on the **`dev`** ref with
      channel `auto` (an explicit `prod` on `dev` is refused by the workflow).
- [ ] **4. The registry shows `dev` on all five**, polled past replication lag
      (step 3 of the loop above, with the same expected output).
- [ ] **5. `HAVEN_CONNECTOR_CHANNEL=dev` on the dev Railway *backend*
      service — only now.** Set earlier, the dashboard hands out a tag npm
      cannot resolve. The value must match `/^[a-z][a-z0-9-]{0,31}$/`
      (`parseConnectorChannel`, `packages/backend/src/config.ts`); unrelated
      backend configuration such as `HAVEN_OPS_TOKEN` or the accounting feed's
      `HAVEN_ACCOUNTING_ENTITLEMENT_MODE` (#2861, the same refuse-the-boot
      shape for its own two values), the boolean flags `HAVEN_HOSTED` /
      `HAVEN_FEE_ENABLED` / `HAVEN_LEGACY_BOOKKEEPING_ENABLED` /
      `CATALOG_DISCOVERY_ENABLED` (#3015, that shape again — exactly `true` or
      `false`, lower-case, anything else refuses the boot),
      `HAVEN_ACCOUNTING_RETRY_SWEEP_INTERVAL_MS` (#2866, a plain
      `Number(...) || default`) and `HAVEN_REQUEST_VALIDATION` (#3029, that
      shape a third time — `off`/`shadow`/`enforce`, default `shadow`, a mode
      change is a restart) does not affect this
      package-selection path; anything else
      makes the backend **refuse to boot**, naming the variable, rather than
      fall back to `alpha`. Verify by creating a setup in the dev dashboard and
      reading `connector_package` in the response — `@haven_ai/connect@dev`.
- [ ] **6. The same variable on the dev Railway *hosted MCP* service.** It
      selects the channel that service's own "re-run the connector" hints name;
      unset means the SDK's build-time constant, i.e. production
      ([`hosted-mcp.md`](hosted-mcp.md) § *Railway setup*, step 3). A malformed
      value refuses the boot there too — check the deploy logs after setting it.
- [ ] **7. Vercel: nothing.** Slice 2 (PR #2467) added no frontend variable —
      its only `process.env` additions are the backend read and its tests — so
      the *Preview* scope that sets `NEXT_PUBLIC_HAVEN_ENV=dev` needs no change.
- [ ] **8. Production stays unset**, everywhere the variable exists. Unset (or
      empty) means `alpha`, byte-for-byte the pre-#2422 handout.

## First rollout — 2026-09-04 (history, not live state)

The checklist above stays unticked on purpose, for the reason its own preamble
gives: it describes the mechanism, and an environment's live state is read from
the environment. This section is the complementary thing — a **dated record of
one rollout**, which cannot go stale because it does not claim to be current. If
you are asking "is the dev environment on `@dev` right now", the answer is not
here; run step 5's verification against the environment.

**Two kinds of evidence below, deliberately not merged.** *Measured* means a
command was run and its output read. *Owner-reported* means the repository
cannot see it — a Railway variable and an npmjs.com settings page are both
outside anything a check can reach — and the line records who said so, not a
fact the repo verified. Rolling the second into the first is how a doc starts
asserting an environment it has never observed.

| # | Step | 2026-09-04 | Evidence |
|---|---|---|---|
| 1 | Trusted Publisher entries | done | **Owner-reported.** All five checked on npmjs.com: repository `d-hinders/Haven-AI`, workflow `publish.yml`, environment field empty. The entries are immutable once created ("to change them, delete it and create a new one"), so this should not need rechecking. **The empty environment field is load-bearing** (#2647): the OIDC publish job must therefore stay outside any GitHub Environment, which is why the `main`-only token for the `latest` move had to become a *separate* job rather than an `environment:` on this one. |
| 2 | Publishing slice on `dev` | done | **Measured.** `git merge-base --is-ancestor 709f87f3 origin/dev` → yes (PR #2463). |
| 3 | A package-touching push ran the workflow | done | **Measured.** Four successful `publish.yml` runs on `dev`, 2026-09-03: `fd49e1a` (#2423), `fceb089` (#2424), `2309084` (#2494), `893d74f` (#2425). |
| 4 | Registry shows `dev` on all five | done | **Measured.** `dev` → `0.0.0-dev.202609031827.893d74f` on sdk, signer, mcp, connect and cli — one version across all five. `alpha` unchanged at `0.1.34-alpha.0`, i.e. the prod channel was not touched. |
| 5 | `HAVEN_CONNECTOR_CHANNEL=dev` on the dev **backend** | done | **Owner-reported**, from the Railway variables pane. |
| 6 | Same variable on the dev **hosted MCP** | done | **Owner-reported**, added and redeployed 2026-09-04. It was absent until then, so between step 5 and this the environment was split — the dashboard handed out `@dev` while the hosted MCP's own re-run hints still named `@alpha`. |
| 7 | Vercel: nothing | n/a | No frontend variable exists to set. |
| 8 | Production stays unset | holds | **Owner-reported.** The prod backend service's variable list was read out and contains no `HAVEN_CONNECTOR_CHANNEL` (the `HAVEN_*` entries there are `API_URL`, `DEPLOY_CHAIN_IDS`, `HOSTED`, `HOSTED_MCP_URL`, `REPORTING_FEED_ENABLED`, `X402_BINDING_SIGNER`). Still an ongoing invariant rather than a completed step — nothing in this repository can observe it, so this records one reading on one day, not a guarantee. |

**One thing the rollout proved that no checklist step asks for.** The published
`@haven_ai/sdk@dev` tarball carries `HAVEN_CONNECTOR_CHANNEL = "dev"` in its
built bundle — read out of the tarball, not inferred from the source. That is
the whole of #2423 demonstrated through the real release path: `release-bump.mjs`
derived the channel, rewrote the constant, and the artifact shipped naming the
channel it was published under. The corresponding `dist/` contains **no**
hard-coded `@haven_ai/connect@<tag>` string at all, because the spec is
assembled at runtime from that constant — which is also why
`verify-connect-bundle.mjs` executes the bundle rather than grepping it.

**A gap this rollout surfaced, and closed the same day
([#2515](https://github.com/d-hinders/Haven-AI/issues/2515)).** The package
READMEs were not channel-aware: `packages/connect/README.md` wrote
`npx @haven_ai/connect@alpha` in ten command examples and
`packages/signer/README.md` in one, and `README.md` ships inside each tarball,
so a `@dev` package's npm landing page told its reader to install the
production connector. Fixed in `f4467bb` by making the examples
channel-neutral rather than by teaching the release script to rewrite prose —
connect is down to a single deliberate production example, signer to none.

**End-to-end verification, 2026-09-04.** The chain was exercised with a real
agent on dev rather than argued from source. A setup created in the dev
dashboard handed out `@haven_ai/connect@dev` — the backend choosing the channel
on its own, which is step 5 observed from the outside. Running that connector
installed `@haven_ai/signer@0.0.0-dev.202609040858.f4467bb`, and every re-run
hint it and `--doctor` printed named `@dev`: the connector's own next-steps, the
tombstone advice, the repair advice. That is #2423 confirmed in the shipped
artifact rather than in the source it was built from. `--doctor` additionally
reported the hosted MCP endpoint reachable at the dev URL, the stored API key
authenticating as the agent whose signing key is in that directory, and a
signer stdio handshake at that same snapshot version.

Two checks are deliberately NOT claimed here, because they need a fresh client
session that loads the new MCP entries: the agent's `chainId` reading 84532,
and a quote or refusal from the hosted MCP naming `@dev` (which is what would
observe step 6 from the outside rather than from the Railway pane).

**The channel moved during this rollout, which is the mechanism rather than a
problem.** Step 4 above measured `0.0.0-dev.202609031827.893d74f`; by 08:57 UTC
the same day the `dev` tag on all five packages had advanced to
`0.0.0-dev.202609040858.f4467bb`, because the #2515 fix touched
`packages/connect/**` and `packages/signer/**` and so hit the workflow's
`paths:` filter. Nobody published anything by hand. A row in this table names
the snapshot that was current when it was written; the tag always points at the
newest.

## Ongoing: what accumulates, and what to leave alone

- **Snapshots accumulate.** Each package-touching `dev` merge adds one version
  to each of the five packages (one `npm publish` per package per run, from
  the loop above). Nothing routine follows from that: the `dev` tag always
  points at the newest, and old snapshots are inert below every real version.
- **Cleanup is deprecation, and it is optional.** npm's
  [unpublish policy](https://docs.npmjs.com/policies/unpublish) allows
  unpublishing only inside a 72-hour window; after that
  `npm deprecate "@haven_ai/<p>@0.0.0-dev.<ts>.<sha>" "superseded dev snapshot"`
  is the only lever, and there is no reason to pull it on a schedule.
- **`latest` is not moved by THIS channel, and since #2536 it is moved by the
  prod one.** The dist-tag listing shows `latest` behind `alpha` on every
  package: that is the state #2536 exists to end, and it ends in two steps. The
  mechanism is merged — a prod publish now moves `latest` onto what it just
  published — but the workflow only acts on a *future* publish, so the stale
  tags persist until an owner moves them once by hand. That one-off is the
  `operator-verify` checklist on #2536; until it is done, this listing keeps
  showing the old state and that is expected rather than a defect.
- **A stray `alpha~` tag on `@haven_ai/mcp`** appears in the same listing —
  noted once in the #2420 thread as a historical typo'd publish. Harmless;
  unrelated to the dev channel, and removed by the same #2536 operator step.

## Failure modes

| Symptom | Cause | What to do |
|---|---|---|
| `npx @haven_ai/connect@dev` → `ETARGET` / `No matching version found` | The `dev` tag does not exist on the registry yet — the workflow has never published on `dev`, or you checked inside the replication lag | Checklist steps 3–4. If the dev backend already hands out `@dev`, step 5 was done early; the handout becomes correct the moment the tag exists |
| The merge produced no `publish.yml` run | The diff touched nothing under `packages/{sdk,signer,mcp,connect,cli}/**` | Expected. Merge a package-touching change, or dispatch the workflow on `dev` (checklist step 3) |
| Four of five packages show `dev`; the fifth does not | Registry read-replication lag (about three minutes for `cli` on the first publish) | Poll. Only a gap that survives polling is a partial publish — then read the run's per-package table |
| The run fails in the bump step with `short sha "0…" is all digits with a leading zero` | Semver forbids a leading zero in a numeric prerelease identifier, and that commit's 7-hex short SHA happens to be all digits (`release-snapshot-version.mjs`) | Nothing is wrong with the commit. Re-run the workflow on a later commit |
| The dev dashboard's command names `@alpha` | `HAVEN_CONNECTOR_CHANNEL` is unset or empty on the dev backend | Checklist step 5 — after step 4 |
| The dev backend or hosted MCP will not boot after setting the variable | The value is not a well-formed dist-tag | Fix or unset it; the boot log names the variable and the pattern |
| `--doctor` fails on `runtime_spec_override` | A `HAVEN_*_SPEC` variable is set in the shell, or the last install ran under one | By design — the finding is the record. Unset and `--doctor --repair --runtime <runtime>` to return to the pin |
| A `0.0.0-dev.*` version shows up on `alpha` or `latest` | Should be impossible: five guards in `publish.yml` / `release-bump.mjs` | Treat as an incident in the workflow itself, not as a bad publish; the guards are named in the workflow header |

## Not covered here

The production path (bump PR → `dev → main` promotion → `publish.yml` on
`main`): [`../contributing/branch-and-release-flow.md`](../contributing/branch-and-release-flow.md),
[`promoting-dev-to-main.md`](promoting-dev-to-main.md), the `release` skill and
[`../../scripts/README.md`](../../scripts/README.md) (`release-bump.mjs`, its
`--snapshot` mode, and why a snapshot is not a release). The runtime
compatibility contract — the manifest table, version skew, `--doctor`'s checks:
[`mcp-runtime-compatibility.md`](mcp-runtime-compatibility.md).
