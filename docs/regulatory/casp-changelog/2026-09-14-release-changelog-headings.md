- **Release machinery — the bump now owns the package CHANGELOG release
  heading, and the release skill is taught to read state directly.** No custody,
  signing or execution boundary moves; nothing published changes; no route,
  credential or caveat enforcer is touched.

  This shard exists because `scripts/release-bump.mjs` is a **covered** file and
  the change is an edit to it. `casp-risk-guardrails.md` § *Release plumbing is
  in scope* is explicit about why that is the gated event: `covers:` gates
  *edits to a file*, never *runs of it*, so what this gates is a change **to the
  release machinery** — which decides which artifact reaches a user's machine.

  **What changed in the machinery, and what did not.** The bump gains one
  responsibility: rewriting `## Unreleased` to `## <version> — <date>` in each
  published package's `CHANGELOG.md`. It gains nothing else. The four things the
  script decides that matter to a consumer — the five published versions, the
  cross-package dep pins, connect's pinned `sdkVersion`/`signerVersion` (which
  *signer* a newly connected agent installs), and the release-time re-check of
  the wildcard-pin rule — are **untouched**, and that is the claim this shard
  exists to make. `verifyPrivateConsumersUnpinned`, `verifyNoWildcardInternalDeps`,
  `verifyConnectBundle` and `verifyManifestDoc` are byte-identical.

  Taking the § *Release plumbing is in scope* enumeration item by item, because
  that section requires a shard to state which of them moved: **version fields**
  — unchanged; **cross-package dep pins** — unchanged; **connect's pinned
  `sdkVersion`/`signerVersion`** — unchanged; **dist-tag selection** — unchanged,
  and untouchable from here, since it lives in `release-channel.mjs` and
  `publish.yml`, neither of which this diff opens; **the publish trigger and the
  ref it builds from** — unchanged, `publish.yml` is not in this diff;
  **build order** — unchanged; **the credential path** — unchanged, no token,
  OIDC claim or environment binding is read or written differently; **the
  wildcard-pin re-check** — intact and byte-identical. The one thing that moved
  is a write to five `CHANGELOG.md` files, none of which reaches a tarball.

  **The parent's "a CASP shard is never generated" blockquote was re-read and
  deliberately NOT edited.** It says the #1790 precedent — that a bump may write
  a contract doc — "stops at the manifest table", and this change extends what a
  bump writes. The rule it states is nevertheless untouched: it forbids a
  *generated perimeter argument*, and it forbids it because `satisfied-by:` is
  cleared by file **presence**. No `satisfied-by:` glob anywhere in the repo
  matches a package `CHANGELOG.md` — the changelogs appear in the coupling graph
  only as *covered code* under `docs/contributing/ship-playbooks/sdk.md`, which
  is the opposite direction — so nothing this change generates can excuse a gate,
  and no shard becomes generable. Read against `scripts/release-bump.mjs` and
  `packages/signer/CHANGELOG.md` as changed on this branch, which are the two
  files the coupling gate named for the re-read. Scope: that blockquote and the
  § *Release plumbing is in scope* enumeration above; `last-verified` deliberately
  not bumped, because the document was not re-verified as a whole.

  **No CHANGELOG reaches a tarball.** Every published package's `files` field is
  `dist` + `README.md` (+ `examples` on the sdk), asserted by a new test rather
  than stated — so nothing this change writes can reach a user's disk. It is a
  repository-record defect being fixed, not a published-artifact one.

  **The defect, stated correctly — because the first draft of this shard did
  not.** All five changelogs asserted "Release headers are written by the release
  bump (`npm run release:bump`), never by hand" while the bump did not touch
  them: a file asserting behaviour the code does not have, instructing the next
  reader not to fix it.

  **No release shipped a stale heading.** The files were created by #2933 on
  2026-09-13 00:38, and the next release (0.2.0-alpha.0, 2026-09-14)
  hand-stamped the heading and hand-corrected the prose in the same commit — so
  the false assertion stood for about one day and zero releases.

  This shard's first draft claimed "the recorded instance is the 0.1.37-alpha.0
  release commit, where all five read `## Unreleased`". That is **false**, and
  independent review caught it: `git show 6e3ea1dc:packages/sdk/CHANGELOG.md`
  fails — the files were created ten hours AFTER that release and did not exist
  at it. The claim was inferred from seeing the files stale at 0.2.0 rather than
  checked against history, and it was propagated into six places including this
  regulatory record. It is corrected here rather than quietly dropped because
  the change it accompanies is *about* documents asserting what code does not
  do, and the same habit produced both.

  **Pure logic in its own module, and a guard that can fail.**
  `scripts/release-changelog.mjs` follows the house split that
  `release-manifest-doc.mjs` states at length: `releaseChangelog()`
  produces the text, `changelogHeadingViolations()` compares files on disk
  against a version and never against what a bump run computed — so a script
  that writes a value cannot pass by verifying its own write. Nine new tests,
  three mutation-proven: removing the `updateChangelogs` call fails the
  call-site test, rewriting every `## Unreleased` rather than the first fails
  the history-preservation test, and dropping the `## Unreleased` re-seed fails
  the repeated-release test.

  **One consequence accepted rather than fixed, recorded here for the decision
  it is.** `packages/signer/**` is a money-path glob, so the signer's CHANGELOG
  is a money-path file, and `#2164`'s version-string exemption does not recognise
  a heading line — its model pairs a removed line against an added one, and a
  release heading is an insertion with no counterpart. So a release commit that
  writes headings always needs a freshly dispatched `money-flow` run. The release
  skill already instructs exactly that dispatch on every release, so this adds no
  step; what it removes is the option of skipping one. The alternative — excluding
  `**/CHANGELOG.md` from the money-path globs — is a narrowing of a safety gate's
  scope requiring a new mechanism in the matcher and agreement across its three
  consumers (`money-path-globs.json`, `labeler.yml`, the skill's Merge Gate), and
  belongs in its own change with its own review rather than riding this one.

  **The rest of the change is skill text**, `.agents/skills/release/SKILL.md`,
  carrying no executable weight: read PR state field-by-field rather than off
  `mergeable_state`; a green *run* is not a green *check*; check for an open
  promotion PR before merging to `dev`; ruleset config is a hypothesis and
  observed behaviour is evidence; a CHANGELOG edit is a money-path change under
  `packages/signer/**`; and compare published declarations by name with an
  instrument that admits `type` and `interface`. Each is a lesson from the
  0.2.0-alpha.0 release, recorded so the next one does not re-derive it.

  **Tested:** `node --test scripts/release-bump.test.mjs` → **76 passed / 0
  failed**, against **67** on `origin/dev` — nine new tests, in the suite CI runs
  on every pull request. One of them is the drift guard: it runs
  `changelogHeadingViolations` against the real repository files at the real
  released version, on every PR, with no release in sight. The first draft of
  this shard said "six tests … 73 passed (67 before)" and claimed the checker
  "runs in CI" while nothing called it outside its own unit test — both caught by
  review, and both the same defect class as the one this change fixes.

  Perimeter unchanged — a release-machinery change that adds a documentation
  write and alters no version, pin, channel or published artifact. Nothing about
  who may spend, sign, or execute.
