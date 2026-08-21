---
name: release
description: Cut and ship one npm release of Haven's five published packages — decide the version, run the bump, satisfy the contract-doc gate, open the release PR to dev, drive the promotion to main, and verify what actually landed on npm. Use when a user asks to cut, publish, or ship a release, bump package versions, or get recent work onto npm.
---

# Release

Cut exactly one release and see it onto npm, then stop.

The mechanics live in [`scripts/README.md`](../../../scripts/README.md); the
branch model lives in
[`docs/contributing/branch-and-release-flow.md`](../../../docs/contributing/branch-and-release-flow.md).
This skill routes between them and adds the judgement they do not encode. When
the two disagree with each other, the branch-and-release doc wins on branch
questions and `scripts/README.md` wins on script questions.

## Preflight

Establish facts before touching anything. Each of these has cost a real release.

**1. Confirm the checkout is complete.** In a shallow clone, `git rev-list`,
`git merge-base` and every ancestry question return confidently wrong answers —
truncated history makes genuine ancestors look missing. Trees and diffs stay
trustworthy; topology does not.

```sh
git rev-parse --is-shallow-repository   # must print false
git fetch --unshallow                   # if it printed true
```

Never reason about how far apart two branches are without doing this first.

**2. Decide whether a release is needed.** Compare the repo's version against
what is actually published, and look for unreleased work in the published set:

```sh
node -p "require('./packages/sdk/package.json').version"
npm view @haven_ai/sdk dist-tags --json
git log --oneline <last-bump-commit>..origin/dev -- \
  packages/sdk packages/signer packages/mcp packages/connect packages/cli
```

If the repo version is already on npm and those packages have commits since the
bump, a release is needed: `publish.yml` skips versions already published, so
without a bump the same version string holds different code in npm and in-repo.
If nothing touched the published packages, say so and stop — a bump with nothing
to carry is noise.

**3. Write down what it carries.** That commit list becomes the PR body and the
CASP shard. Name the issues.

## Choose The Version

Pass an explicit version string, never a bump type — `scripts/README.md`
§ *Which version string* has the convention and the one case that departs from
it. The judgement it does not make for you: if the last attempt at this version
failed to publish, you are retrying, not releasing.

## Cut The Bump

```sh
npm run release:bump -- <version> --yes
```

Never hand-edit a version field, a cross-package pin, or a source version
constant — the script owns all of them atomically, and a missed one ships a
package that lies about itself. Never run `npm publish`.

Then check the lockfile before anything else: every changed line must be a
version string or an `@haven_ai/*` pin. If npm also inserted `dev`/`peer`
metadata, repair it per *Lockfile hygiene* in `scripts/README.md`. A polluted
lockfile installs fine and fails no check, which is why it has survived three
releases — and why the release diff, whose entire safety argument is *"nothing
here is anything but a version string"*, is the wrong place to let it slide.

## Satisfy The Contract-Doc Gate

**Every release PR needs both of these.** The blocking `Contract-doc coupling`
check fails without them, and forgetting is the single most common way a
release PR goes red:

1. `docs/operations/mcp-runtime-compatibility.md` — re-pin the *Supported
   Runtime Manifest* table and prepend a `last-verified` note.
2. `docs/regulatory/casp-changelog/YYYY-MM-DD-<pr>-release.md` — a new shard
   ending in a perimeter verdict.

`scripts/README.md` § *The contract-doc gate* has the required content of each.

## Verify Before Pushing

```sh
npm run lint:workspace-pins   # published exact-pinned, private consumers on "*"
npm run typecheck
npm run check:dist
npm run docs:check
npm run docs:coupling         # must exit 0
npm run test:unit             # all five published packages
```

A data-layer test that cannot reach Postgres is an environment limit, not a
result — say so explicitly rather than reporting a clean run.

**When the release carries a refactor of a published surface**, prove
compatibility against what consumers actually have rather than trusting the
word "refactor". Diff the built types against the published tarball:

```sh
npm pack @haven_ai/sdk@<currently-published-version>
tar xzf haven_ai-sdk-*.tgz
diff package/dist/index.d.ts packages/sdk/dist/index.d.ts
```

Zero declarations added or removed is the bar. Changed lines should be private
members and comments only. This is cheap and it is the only check that would
catch a facade that quietly dropped an export.

## The Release PR

Target **`dev`**, never `main` — `dev-gate` fails a `release/*` branch aimed at
`main`. Fill the repository pull-request template. State plainly that nothing
publishes on this merge.

## Promotion To Production

Publishing happens on the `dev → main` promotion. **Follow
`branch-and-release-flow.md` § *Promotion to production*** — it owns the
sequence, the BEHIND/sync-back rule, and why both merge with a merge commit
rather than a squash. Do not restate it; read it.

Three things that section does not say, because they only show up while doing it:

- The promotion is a deliberate human step. **Confirm the user wants it** before
  opening it — cutting the release and shipping it to production are two
  decisions, not one.
- A sync-back claims zero content change, so **prove it**: the merged tree hash
  must equal `dev`'s, and `git diff origin/dev` must be empty, before you push.
  Test the merge in a throwaway worktree rather than on a shared branch.
- **If the promotion merges while a sync PR is still open, that sync is stale.**
  It carries the superseded `main` and will leave `dev` behind by the newest
  promotion merge. Re-point it at current `main` before merging it.

## Closeout

A green workflow is not proof that five packages published. Verify both ends:

```sh
for p in sdk signer mcp connect cli; do npm view @haven_ai/$p dist-tags --json; done
```

Every package must show the new version on `alpha`, and `latest` must be
unchanged for a prerelease. Also read the publish run's **per-package table** —
since #1159 one package can fail without aborting the others, so a summary
glance is not enough.

Report what published, and name anything that did not.

## Guardrails

- **Never `npm publish` by hand**, and never hand-edit versions or pins.
- **A release commit is the wrong place to fix anything else.** Defects noticed
  while cutting — a lockfile bug, a mispinned dependency — get filed, not folded
  in; mixing them makes a bad bisect if either turns out wrong. Precedent:
  #1526, #1663.
- **Do not claim a package published without checking the registry.** The
  workflow's own logs and npm's dist-tags are the evidence; a merged PR is not.
