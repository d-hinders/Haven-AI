# Haven release scripts

## `verify-connect-bundle.mjs` — Build-time bundle verification

Checks that `packages/connect/dist/index.cjs` resolves the correct `mcpVersion` at runtime by comparing it against the `MCP_VERSION` literal in `packages/mcp/src/server.ts`.

Runs automatically as part of `npm run build -w packages/connect` (chained after `tsup` in connect's `build` script), and explicitly by `release-bump.mjs` after it builds connect. Also runnable manually:

```sh
node scripts/verify-connect-bundle.mjs
```

This catches the build-order bug (hit twice in production): if `packages/mcp/dist/` is stale when connect's tsup runs, the bundle loads the old MCP dist via the workspace symlink and resolves the wrong `mcpVersion` at runtime.

If it fails, the error message points at the fix: `npm run release:bump -- <type>`, which wipes all `dist/` directories and rebuilds in the correct order.

---

## `release-bump.mjs` — Atomic version bump for all published packages

### Problem it solves

A version bump for the five published packages (`@haven_ai/sdk`, `@haven_ai/signer`, `@haven_ai/mcp`, `@haven_ai/connect`, `@haven_ai/cli`) previously required 8+ surgical edits across 5 files:

| File | What to change |
|---|---|
| `packages/sdk/package.json` | `version` |
| `packages/signer/package.json` | `version` |
| `packages/mcp/package.json` | `version` + `@haven_ai/sdk` dep pin |
| `packages/connect/package.json` | `version` + `@haven_ai/sdk` / `@haven_ai/mcp` / `@haven_ai/signer` dep pins |
| `packages/mcp/src/server.ts` | `MCP_VERSION` constant |
| `packages/connect/src/runtime-manifest.ts` | `sdkVersion` + `signerVersion` literals |

Missing any edit caused bugs in production — e.g. connect shipping a stale runtime manifest or mcp loading the wrong SDK version via npm's nested-resolution rules.

`release-bump.mjs` atomically applies all of these in one command.

That table is the **original inventory** (`3f6e9959c`), kept because it is what
motivated the script — not a description of today's surface, which has grown
since: `@haven_ai/cli` became a published package, `mcp-server`'s version joined
the lockstep set, four more source constants appeared
(`SIGNER_VERSION`, `HOSTED_SERVER_VERSION`, `CONNECTOR_VERSION`, `CLI_VERSION`),
and the lockfile is rewritten too. *What the script does (in order)* below is the
current list. The authoritative published set is not written down in prose at
all: it is **derived from each workspace's `private` flag** — the same test
`release-bump.mjs` and `scripts/workspace-pin-lint.mjs` apply — and
`npm run release:bump:test` fails if an enumeration in this file drifts from it.

**Private workspace consumers are intentionally NOT in this table.** `backend`,
`qa-agent`, `frontend` and `mcp-server` depend on `@haven_ai/*` with `"*"` so
npm always links the workspace package — they must test dev's code, not a
published tarball. Never "tidy" them to an exact version: the pin holds only
until the next bump moves the workspace version past it, after which `npm ci`
silently resolves the stale npm registry tarball instead (this broke the
scheduled money-flow QA on 2026-07-13).

#### Which side of the rule each package is on

The test is **not** "is it on npm" but **"does its artifact resolve
`@haven_ai/*` from outside this workspace?"** `private` in `package.json` is
the marker, and `scripts/workspace-pin-lint.mjs` enforces both directions on
every PR (`npm run lint:workspace-pins`).

| Package | `private` | Internal deps | Why |
|---|---|---|---|
| `sdk`, `signer`, `mcp`, `connect`, `cli` | no | **exact pin** | `npx`-installed on someone else's machine; `*` would resolve to whatever the registry serves |
| `mcp-server` | **yes** | **`"*"`** | Docker-deployed, but its Dockerfile runs `npm ci --workspace=packages/mcp-server --workspace=packages/sdk --include-workspace-root` and builds the SDK from source — it resolves from *inside* the workspace |
| `backend`, `frontend`, `qa-agent`, `core` | yes | **`"*"`** | never leave the workspace |
| `demo-merchant-mcp` | yes | — | Railway-deployed test fixture, not published |

`mcp-server` was on the wrong side until [#1526](https://github.com/d-hinders/Haven-AI/issues/1526). It was classified as published purely because it lacked `private: true`, and `release-bump.mjs` rewrote its pins on every release — so resolution was correct only by *coincidence*, holding just as long as every bump touched both, and as long as the Dockerfile kept naming every internal dep in its `--workspace=` list.

**What an out-of-step pin actually costs**, measured on npm 10.9.7 while fixing #1526 rather than taken on faith:

| Situation | Exact pin | `"*"` |
|---|---|---|
| dependency's workspace in the install scope | links the workspace (even on a mismatched range) | links the workspace |
| dependency's workspace **outside** the scope | **not installed at all** | links the workspace |
| range nothing can satisfy | install fails outright | n/a |

The stronger claim this rule is usually told with — that `npm ci` silently substitutes the stale registry tarball — is what the 2026-07-13 money-flow QA breakage was attributed to, but it **did not reproduce**: npm 10.9.7 links the workspace even when the pinned range does not match. Treat that mechanism as unconfirmed and npm-version-dependent. The scope-sensitivity in the table is the part that reproduces, and it is reason enough — an exact pin on a private consumer buys nothing under any of these outcomes.

`mcp-server`'s **version** is still bumped in lockstep, for coherence with its `HOSTED_SERVER_VERSION` constant; only its dep pins are hands-off.

### Usage

```sh
# From the repo root:
npm run release:bump -- <bump-type>

# Or directly:
node scripts/release-bump.mjs <bump-type>
```

**Bump types:**

| Argument | Example (current: `0.1.9`) | Result |
|---|---|---|
| `patch` | `0.1.9` → `0.1.10` |
| `minor` | `0.1.9` → `0.2.0` |
| `major` | `0.1.9` → `1.0.0` |
| `prerelease` | `0.1.9` → `0.1.10-alpha.0` |
| `prerelease` (if already pre) | `0.1.9-alpha.0` → `0.1.9-alpha.1` |
| `0.2.0-rc.1` | Any explicit semver string |

Add `--yes` to skip the interactive confirmation prompt (useful in automated contexts):
```sh
npm run release:bump -- prerelease --yes
```

### What the script does (in order)

1. **Read** current version from `packages/sdk/package.json`.
2. **Compute** the new version from the bump type.
3. **Show** a preview of all changes; prompt for confirmation (unless `--yes`).
4. **Update** the `version` field of every lockstep package — the five published ones (`sdk`, `signer`, `mcp`, `connect`, `cli`) **plus `mcp-server`**, which is `private: true` and never published but version-locksteps for coherence with its `HOSTED_SERVER_VERSION` constant. Six in total (`VERSIONED_PACKAGES` = `PUBLISHED_PACKAGES` + `mcp-server`); only the five published ones are pin-managed.
5. **Update** cross-package dep pins: `mcp → @haven_ai/sdk`, `connect → @haven_ai/sdk / @haven_ai/mcp / @haven_ai/signer`.
6. **Update** `packages/mcp/src/server.ts` — the `MCP_VERSION` constant.
7. **Update** `packages/connect/src/runtime-manifest.ts` — `sdkVersion` and `signerVersion` string literals.
8. **Wipe** all `packages/*/dist` directories — required to prevent tsup from bundling a stale constant from the previous build's output.
9. **`npm install` + deterministic lockfile rewrite** ([#1663](https://github.com/d-hinders/Haven-AI/issues/1663)) — the install keeps `node_modules` consistent for the builds below, but its lockfile output is **not taken**: on three consecutive cuts (0.1.26 → 0.1.28) the local npm also inserted `"dev"`/`"peer"` metadata on unrelated entries, and each release hand-repaired the diff back to its 11 version lines. Instead the version substitution is replayed **structurally** onto the pre-install lockfile (`scripts/release-lockfile.mjs` — structural rather than textual so a third-party dep coincidentally at the old version is never touched), and the bump then **fails loudly** if the final `package-lock.json` diff contains any line that is not a workspace `version` field or an `@haven_ai/*` pin. The guard reads the file on disk, so removing the rewrite makes the guard see npm's polluted output and fail. Self-tested: `npm run release:bump:test`.
10. **Build** in dependency order: `sdk → signer → mcp → connect`.
    - Connect is built directly with tsup (skipping its internal pre-build of mcp/signer) so the already-built dist from the previous step is used — the exact scenario that surfaces the build-order bug.
    - **`cli` is deliberately absent here, and this is not the count drift fixed above — do not "correct" it.** These builds exist to *verify the connect bundle*, which is the one artifact that inlines version literals at build time; `cli` inlines nothing connect depends on and nothing this step checks. Publishing does not rely on it either: `publish.yml` rebuilds every published package from a clean checkout at publish time, so a `cli` dist produced here would be discarded. Whether the bump should build `cli` anyway — as a cheap "does it still compile at the new version" signal — is a real question, but it is a **behaviour change** and belongs in its own issue rather than in a doc edit.
11. **Verify** the built `packages/connect/dist/cli.cjs` contains the new version literal, and that `server.ts` has the correct `MCP_VERSION`.

### Why the dist-wipe is mandatory

tsup resolves workspace packages from their `dist/` output. If a previous build left `packages/mcp/dist/` at version `0.1.7-alpha` and you just updated `server.ts` to `0.1.8-alpha`, tsup will still inline `0.1.7-alpha` into connect's bundle — unless `dist/` is wiped first. The build-order bug that caused `connect@0.1.4-alpha` to ship a stale `MCP_VERSION` came from exactly this scenario.

The dist-wipe ensures tsup starts from a clean slate and picks up the freshly-built output at every step.

### What the script does NOT do

- **Publish** — publishing is decoupled from the bump. Bumping only produces a reviewable version diff; the actual `npm publish` happens automatically when that diff lands on `main` (see *After the bump*, below).
- Bump `backend` or `frontend` — those are not published to npm and are not in the lockstep set. (`mcp-server` **is** bumped, per step 4: not published, but version-locked to its `HOSTED_SERVER_VERSION` constant. This line used to say otherwise, contradicting both the script and the paragraph above about `mcp-server`'s version moving in lockstep.)
- Update the dashboard's `npx` install command — that's handled by the `@alpha` dist-tag (#311).

### After the bump

Publishing is automated by the **Publish packages** workflow
(`.github/workflows/publish.yml`). You do not run `npm publish` by hand.

```sh
# 1. Review the diff. The lockfile must be ONLY version-string lines (11 at
#    time of writing: 6 workspace versions + 5 @haven_ai/* pins). If npm also
#    inserted "dev"/"peer" metadata, repair it — see *Lockfile hygiene* below.
git diff --stat

# 2. Touch the two CONTRACT DOCS. The release PR does not go green without
#    them — see *The contract-doc gate* below.

# 3. Commit on a branch and open a PR **against `dev`**.
git checkout -b release/<new-version>
git add packages/sdk/package.json packages/signer/package.json \
        packages/mcp/package.json packages/mcp/src/server.ts \
        packages/connect/package.json packages/connect/src/runtime-manifest.ts \
        packages/cli/package.json packages/cli/src/commands.ts \
        packages/signer/src/server.ts packages/mcp-server/package.json \
        packages/mcp-server/src/server.ts packages/connect/src/runtime.ts \
        docs/operations/mcp-runtime-compatibility.md \
        docs/regulatory/casp-changelog/ \
        package-lock.json
git commit -m "chore(release): bump all published packages to <new-version>"
git push -u origin release/<new-version>
gh pr create --base dev --fill

# 4. Merge to `dev`. NOTHING PUBLISHES HERE. Publishing happens on the later
#    `dev → main` promotion (a separate, human step).

# 5. Promote `dev → main`. On push to main, the Publish packages workflow
#    rebuilds dist in dependency order and publishes only the packages whose
#    package.json version is not yet on npm. The dist-tag is derived from the
#    version: a prerelease (x.y.z-alpha.N) -> --tag alpha, a stable x.y.z ->
#    --tag latest. A commit that does not change a version is a no-op.
```

> **Target `dev`, never `main`.** This block said `--base main` for as long as
> the dev-gate model has been in force. Under the branch
> model ([`docs/contributing/branch-and-release-flow.md`](../docs/contributing/branch-and-release-flow.md))
> only `dev` or `hotfix/*` may merge into `main` — the `dev-gate` workflow fails
> a `release/*` PR aimed at `main`. Following this doc literally used to produce
> a PR that could not merge.

### Which version string

The bump-type table above is a description of the script's arithmetic, not a
recommendation. **The convention for an alpha release is an explicit
`0.1.<N+1>-alpha.0`** — pass the version string, not `prerelease`.

`prerelease` against `0.1.27-alpha.0` produces `0.1.27-alpha.1`, which is
valid but is not what the last several releases did (`…25-alpha.0` →
`…26-alpha.0` → `…27-alpha.0` → `…28-alpha.0`). Reserve the `-alpha.N`
form for a second attempt at a version that failed to publish.

### The contract-doc gate

Two **contract docs** are coupled to the published packages, and the blocking
`Contract-doc coupling` check fails until a PR that touches those packages also
touches them. A version bump touches all five, so **every release PR needs
both** — this is not optional and not conditional:

1. **`docs/operations/mcp-runtime-compatibility.md`** — re-pin the *Supported
   Runtime Manifest* table to the new version (it must match
   `packages/connect/src/runtime-manifest.ts`), and prepend a note to
   `last-verified` saying what the release carries and that no tool, capability,
   or version-skew surface moved.
2. **`docs/regulatory/casp-changelog/YYYY-MM-DD-<version>-release.md`** — a new
   shard, named for the **version** and not the PR number (#1789): the gate
   blocks the PR until the shard exists, so the shard has to be written *before*
   there is a PR number to name it after. The version is known from the moment
   you choose it. Convention and an example:
   [`casp-changelog/README.md`](../docs/regulatory/casp-changelog/README.md).
   `casp-risk-guardrails.md` declares
   `satisfied-by: docs/regulatory/casp-changelog/**`, so a shard satisfies the
   gate without touching the shared parent (which is what stops concurrent PRs
   conflicting — #1366). State what changed, the authority/custody argument for
   why the CASP perimeter is unaffected, and end with `Perimeter unchanged.`

Check locally before pushing: `npm run docs:coupling` must exit 0. It will still
list ~14 **advisory** docs; those are architecture prose a version bump does not
invalidate, and prior releases have left them untouched. Only the ⚠️ contract
entries block.

### Lockfile hygiene

**Handled by the bump since [#1663](https://github.com/d-hinders/Haven-AI/issues/1663) — do not hand-repair.**

`npm install` does not promise that a version bump moves only the version lines:
on three consecutive cuts (`0.1.26` → `0.1.28`) the local npm also inserted
`"dev"`/`"peer"` metadata on unrelated entries, and each release repaired the
diff by hand at exactly the moment the repo is least able to absorb a hand-edit.

Step 9 above now replays the version substitution **structurally** onto the
pre-install lockfile (`scripts/release-lockfile.mjs`) and fails the release
loudly if the final diff holds any line that is not a workspace `version` field
or an `@haven_ai/*` pin. Self-tested by `npm run release:bump:test`.

So: if the bump completes, the lockfile is already correct — and if it doesn't,
the guard names what is wrong. **Do not "fix" the lockfile by hand**, and in
particular do not reach for a text-wide substitution of the old version string:
a third-party dependency can legitimately sit at the version the workspace is
leaving, and a textual replace would silently rewrite it. That hazard is why the
shipped rewrite parses rather than greps.

Why any of this is worth a guard: a noisy lockfile installs fine and fails
nothing, which is exactly the problem. The release diff's whole safety argument
is *"nothing here is anything but a version string"*, and the CASP shard asserts
that in writing — so churn in it is where a real change would hide.

The workflow authenticates with **npm Trusted Publishing (OIDC)** — there is no
`NPM_TOKEN` secret to manage. It grants the job `id-token: write` and upgrades
npm to ≥ 11.5.1 (the floor for OIDC support); npm exchanges the short-lived
GitHub Actions OIDC token for publish rights against a *trusted publisher*
configured per package on npm. OIDC publishes are also exempt from the 2FA
one-time-password prompt that blocks token-based publishing in CI.

Trusted Publishing additionally emits a signed **sigstore provenance**
statement. npm validates it against `package.json` and rejects the upload with
`E422` unless each package declares a `repository.url` (with the monorepo
`directory`) matching `https://github.com/d-hinders/Haven-AI`. All five
published packages carry a `repository` block for this reason.

> **Adding a new published package?** Two one-time setup steps before its first
> release, or that release fails:
> 1. Configure a trusted publisher for it on npm (package → Settings → Trusted
>    Publisher → GitHub Actions: org `d-hinders`, repo `Haven-AI`, workflow
>    `publish.yml`) — otherwise the publish fails with a misleading `E404` on
>    `PUT` ("not found or you do not have permission"), npm's shape for *this
>    credential is not authorised for this package*.
> 2. Add a `repository` block to its `package.json` (`type`/`url`/`directory`)
>    — otherwise provenance verification fails with `E422`.
>
> This is not hypothetical: `@haven_ai/cli` was added with **both** steps
> missed, which cost the 2026-08-07 release its cli publish (#1159). The gap
> stayed invisible for six weeks because nothing bumped versions in between —
> a workflow that skips already-published versions never re-exercises a
> package's first-publish path. Since #1159 one package's failure no longer
> aborts the others: every package is attempted, the run summary reports each
> outcome (published / skipped / failed), and the job fails at the end naming
> the failures.

#### Manual fallback

Only if the workflow is unavailable mid-incident and a release is urgent,
publish by hand from a clean checkout of the merged commit — the same versions
the workflow would have published. This path uses your own npm credentials
(`npm login`) and **does not produce provenance** (provenance requires the CI
OIDC flow), so prefer re-running the workflow whenever possible.

It mirrors `publish.yml`'s build-and-publish step deliberately: the same five
packages, the same dist-wipe, and the same build **order** — connect's tsup
inlines `MCP_VERSION`, so building it before a fresh `mcp` bundles a stale one.

Two things the workflow does that this path cannot, and one you must decide:
you get no per-package summary table, no provenance, and **the tag is
hardcoded below**. `publish.yml` derives it from the version (prerelease →
`alpha`, stable → `latest`). Every release to date has been a prerelease, so
`--tag alpha` is right today — but if you are hand-publishing the first
**stable** release, change it to `--tag latest`, or `npm install` keeps
resolving the old version with nothing reporting an error.

```sh
npm ci
rm -rf packages/{sdk,signer,mcp,connect,cli}/dist
npm run build -w packages/sdk
npm run build -w packages/signer
npm run build -w packages/mcp
npm run build -w packages/connect   # runs verify-connect-bundle.mjs
npm run build -w packages/cli
for pkg in sdk signer mcp connect cli; do
  npm publish -w "packages/$pkg" --tag alpha --access public
done
```

**Then verify on the registry, package by package.** This path prints no
summary and does not stop on a partial failure, so a package that did not go
out is silent:

```sh
for pkg in sdk signer mcp connect cli; do
  npm view "@haven_ai/$pkg" dist-tags --json
done
```

All five must show the new version on `alpha`, and `latest` must be unchanged
for a prerelease. Anything missing is a partial publish — the state
[#1159](https://github.com/d-hinders/Haven-AI/issues/1159) exists to surface,
which this path cannot do for you.

### If verification fails

The script exits non-zero with a clear error message pointing at the specific file and the expected value. Common causes:

- **`cli.cjs` does not contain `"<new-version>"`** — `sdkVersion` or `signerVersion` was not updated in `runtime-manifest.ts`, or tsup bundled a stale version. Check that the regex patterns in the script matched correctly (`sdkVersion:` and `signerVersion:` labels).
- **`MCP_VERSION` in `server.ts` is wrong** — the regex did not match. Check the line format: `export const MCP_VERSION = '...'`.
- **Build failed mid-way** — the relevant package's `npm run build` exited non-zero. The error output is printed before the failure message.
