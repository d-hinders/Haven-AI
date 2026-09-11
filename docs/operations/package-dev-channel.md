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
last-verified: "2026-09-11"
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
package names:

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
   step 5 is unchanged.

5. **Verify the install.**

   ```sh
   npx -y @haven_ai/connect@dev --doctor --runtime <claude-code|codex-desktop|codex-cli>
   ```

   The doctor reports the installed signer and SDK versions (the snapshot),
   starts the local signer for a real stdio handshake and prints its advertised
   compat versions. Every "re-run `npx @haven_ai/connect@<tag>`" hint the
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
pinned manifest, unset the variables and run `--doctor --repair`. The full
contract — the three variables, what each replaces, the sidecar and wrapper
records — is in the connector's own README:
[`packages/connect/README.md` § *Installing an unpublished signer / SDK / MCP build*](../../packages/connect/README.md#installing-an-unpublished-signer--sdk--mcp-build-haven_signer_spec-2424).

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
      shape for its own two values) and
      `HAVEN_ACCOUNTING_RETRY_SWEEP_INTERVAL_MS` (#2866, a plain
      `Number(...) || default`) does not affect this
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
reported the hosted MCP reachable and authorized at the dev URL, the stored API
key authenticating as the agent whose signing key is in that directory, and a
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
| `--doctor` fails on `runtime_spec_override` | A `HAVEN_*_SPEC` variable is set in the shell, or the last install ran under one | By design — the finding is the record. Unset and `--doctor --repair` to return to the pin |
| A `0.0.0-dev.*` version shows up on `alpha` or `latest` | Should be impossible: five guards in `publish.yml` / `release-bump.mjs` | Treat as an incident in the workflow itself, not as a bad publish; the guards are named in the workflow header |

## Not covered here

The production path (bump PR → `dev → main` promotion → `publish.yml` on
`main`): [`../contributing/branch-and-release-flow.md`](../contributing/branch-and-release-flow.md),
[`promoting-dev-to-main.md`](promoting-dev-to-main.md), the `release` skill and
[`../../scripts/README.md`](../../scripts/README.md) (`release-bump.mjs`, its
`--snapshot` mode, and why a snapshot is not a release). The runtime
compatibility contract — the manifest table, version skew, `--doctor`'s checks:
[`mcp-runtime-compatibility.md`](mcp-runtime-compatibility.md).
