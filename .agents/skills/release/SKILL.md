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

**4. Start the money-flow QA run NOW if the freshness signal is stale.** The
gate's semantics, the #2164 version-bump exemption and the `qa-override` escape
hatch are all documented in
[`docs/operations/agent-qa.md`](../../../docs/operations/agent-qa.md) §
*Automation & gating* — read them there, not here. What that doc cannot tell you
is *when* to act, and that is this step.

`qa-freshness` is a required check on the **promotion** PR, so it only surfaces
*after* the release PR has already merged to `dev`. The run takes about three
minutes. Discovering you need it at the end costs a cycle; starting it here
costs nothing, because it finishes while you write the contract docs.

Check whether a green run has actually **covered** the money-path files now on
`dev` — recency alone does not, which is the half that fails. Ask the real
matcher rather than approximating it:

```sh
# The newest green qa-dev runs and the commits they ran at. This is a local
# APPROXIMATION of the gate's selector (#2404): the gate admits a run only if
# its event is deployment_status/schedule/workflow_dispatch, its commit is an
# ancestor of `dev`'s tip, and its `money-flow` JOB concluded success — so
# take the newest row whose event is one of those three and whose SHA is on
# `dev`. There is deliberately no `--branch` filter: the gate does not use one
# (a post-deploy run does report `headBranch=dev` — measured, #2427 — but a
# branch name says nothing about which commit the harness exercised).
# `gh` is unavailable in the remote Claude Code environment — use the Actions UI
# or the GitHub MCP (list workflow runs for qa-dev.yml) there.
gh run list --workflow=qa-dev.yml --status=success --limit=10 \
  --json headSha,createdAt,event,headBranch

# Money-path files changed since that commit. Any output means the gate blocks.
git diff --name-only <that-sha>..origin/dev | node --input-type=module -e '
import { readFileSync } from "node:fs"
import { loadMoneyPathGlobs, moneyPathFiles } from "./scripts/ci/qa-freshness.mjs"
const f = readFileSync(0, "utf8").split("\n").filter(Boolean)
console.log(moneyPathFiles(f, loadMoneyPathGlobs()).join("\n"))
'
```

This imports the gate's own `moneyPathFiles`/`loadMoneyPathGlobs`, so it cannot
drift from the gate. **Do not hand-roll this with `grep`.** An earlier draft of
this step did, piping the globs through `sed 's#/\*\*#/#'`, and review found it
silently missed 14 tracked files: `grep` reads the mid-string `*` in
`infra/delegate-*.ts`, `infra/outbound-*.ts`, `infra/relayer*.ts`,
`rails/delegation-*.ts` and `modules/agents/rekey-*.ts` as a BRE quantifier
rather than a wildcard, hiding the entire delegation-rail, rekey, relayer and
outbound-queue surfaces. A checker that under-reports here is worse than no
checker, because an empty result is what tells you to skip the run.

If the output is non-empty, dispatch **Actions → "QA — money-flow (dev)" → Run
workflow** on `dev` before you run the bump. It must be dispatched on `dev`:
the gate admits a `workflow_dispatch` run only when its branch label is `dev`
AND its commit is an ancestor of the promotion head (#2404 — `selectGreenRun`
in `scripts/ci/qa-freshness.mjs`), so a run on any other ref does not satisfy
the gate.

## Choose The Version

Pass an explicit version string, never a bump type. `scripts/README.md`
§ *Which version string* has the convention and the one case that departs from
it — including when you are retrying a failed publish rather than releasing.
Read it there; nothing about the choice lives here.

## Cut The Bump

```sh
npm run release:bump -- <version> --yes
```

Never hand-edit a version field, a cross-package pin, or a source version
constant — the script owns all of them atomically, and a missed one ships a
package that lies about itself. Never run `npm publish`.

The lockfile needs no attention from you: since #1663 the bump rewrites it
structurally and fails loudly if the diff holds anything but version lines
(`scripts/README.md` § *Lockfile hygiene*). **Do not hand-repair it** — a
text-wide substitution can silently rewrite a third-party dep that happens to
sit at the version you are leaving, which is why the shipped rewrite parses
rather than greps. If the guard fires, read what it names.

## Satisfy The Contract-Doc Gate

**Every release PR needs both of these.** The blocking `Contract-doc coupling`
check fails without them, and forgetting is the single most common way a
release PR goes red:

1. `docs/operations/mcp-runtime-compatibility.md` — the *Supported Runtime
   Manifest* table is re-pinned by the bump (#1790); update its
   `last-verified` date only after reading the table. Record the release's
   verification evidence in the PR and release shard rather than front matter.
2. `docs/regulatory/casp-changelog/YYYY-MM-DD-<version>-release.md` — a new
   shard ending in a perimeter verdict. The **version**, not the PR number
   (#1789): the shard must exist before the PR is opened, because the gate blocks
   the PR without it, so a PR-numbered name cannot be written when it is needed.

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

## Independent Review

**A release PR gets a reviewer pass, like any other.** Use the reviewer role from
[haven-agent-workflow](../haven-agent-workflow/SKILL.md) — delegate to an
independent reviewer where the client supports it, otherwise run a distinct
findings-first pass. Apply blocking and should-fix findings and rerun the
affected checks; ask the user before applying anything ambiguous.

**"The diff is script-generated" is not a reason to skip this**, and it is the
rationalisation to watch for, because it is half true: the *lines* are
mechanical, so reading them proves little. What needs an independent eye is the
judgement around them, none of which the bump script has any opinion about —
whether a release is warranted at all, whether the contract docs say something
true, whether the compatibility claim was tested or assumed, and whether
anything in the release notes is asserted rather than verified.

Self-review does not substitute. The author is the one person who cannot see
the assumption they already made, which is exactly the class of defect a
release carries into production.

## The Release PR

Target **`dev`**, never `main` — `dev-gate` fails a `release/*` branch aimed at
`main`. Fill the repository pull-request template. State plainly that nothing
publishes on this merge.

## Promotion To Production

Publishing happens on the `dev → main` promotion. **Follow
`branch-and-release-flow.md` § *Promotion to production*** — it owns the
sequence, the BEHIND/sync-back rule, and why both merge with a merge commit
rather than a squash. Do not restate it; read it.

Since #2165 the merge-method half is enforced by the `Dev gate` ruleset rather
than by you remembering it: a PR based on `main` can only be merge-merged. Treat
a squash or rebase button appearing there as a sign the rule has been dropped,
not as permission.

What it leaves to you:

- **Re-measure the scope at the door, and amend the record if it moved.** The
  tarballs are built from `main`'s tree **at promotion time**; the shard and the
  Supported Runtime Manifest note were written back at *Satisfy The Contract-Doc
  Gate*, against a different tree. Anything merged to `dev` in between publishes
  inside this release without appearing in its record.

  ```sh
  npm run build                # the shipped set is read out of dist/
  npm run release:scope        # origin/main..origin/dev
  ```

  Build first — it refuses outright on an unbuilt package rather than guessing.
  Compare its shipped delta against what the shard claims and amend the shard
  when they disagree. **Never hand-count the diff** — that is the judgement this
  step exists to enforce, and on 0.1.36-alpha.0 hand-counting got the scope wrong
  four separate ways. The script's semantics, its exit codes and what it refuses
  are `scripts/README.md` § *`release-scope.mjs`*; the operator checklist is
  `promoting-dev-to-main.md`. Read them there rather than from here (#2724).

- It calls the promotion a human step; it does not say whose. **Confirm the user
  wants it** before opening one — cutting the release and shipping it to
  production are two decisions, and only the first is yours.
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

Every package must show the new version on **both** `alpha` and `latest`.

**Poll it; never diagnose off a single read.** The registry lags a successful
publish by *minutes*, not seconds — on the 0.1.36-alpha.0 release `@haven_ai/mcp`
did not appear until ~4.5 minutes after `npm publish` returned its `+ …` line
([#2660](https://github.com/d-hinders/Haven-AI/issues/2660)). The npm CLI makes
this worse: #2660's measurement had to be taken over HTTP because the CLI's own
metadata cache served a stale dist-tags document, reporting the *previous*
release's tags long after the registry itself was current. Read it over HTTP, or
force the CLI past its cache, and repeat for several minutes before concluding
anything is wrong:

```sh
for p in sdk signer mcp connect cli; do
  curl -s "https://registry.npmjs.org/-/package/@haven_ai/$p/dist-tags"; echo
done
# or, through the CLI: npm view @haven_ai/<pkg> dist-tags --json --prefer-online
```

A single early read looks exactly like a stranded tag. An operator who "heals"
on that reading moves a tag that was about to be correct on its own.

**`latest` moving onto a prerelease is correct, and this line used to say the
opposite.** It read "`latest` must be unchanged for a prerelease", which was
true until [#2536](https://github.com/d-hinders/Haven-AI/issues/2536) and has
been wrong since: npm resolves a bare `npm install` / `npx` through the `latest`
dist-tag and never through the highest version number, so leaving it behind is
how `npx @haven_ai/connect` came to install a build 34 releases old. The
prerelease tag stays as well, so `@alpha` keeps resolving. The owner decision
and the mechanism are recorded in
[`docs/operations/agent-discovery-listings.md`](../../../docs/operations/agent-discovery-listings.md)
§ *The `latest` dist-tag*.

Also read the publish run's **per-package table** — since #1159 one package can
fail without aborting the others, so a summary glance is not enough.

**And read the SECOND job.** Since
[#2647](https://github.com/d-hinders/Haven-AI/issues/2647) the `latest` move is
its own `main`-only job, `promote-tags`, so a promotion can be **half green** —
every package live under `alpha`, `latest` unmoved. If it is red: the versions
ARE published, so the remedy is usually to re-run that one job, **never** to cut
another version (the subsection below covers the cases where the re-run cannot
heal). The job names its own likely cause in its error output; the mechanism
and why it had to be a separate job are in `.github/workflows/publish.yml`'s
header comment, which is where they stay current.

Report what published, and name anything that did not.

### When the `promote-tags` re-run cannot heal `latest`

Re-running that one job works because GitHub's *re-run failed jobs* reuses the
successful `publish` job's outputs, so the nomination list the tag move needs is
still there. That makes the remedy exact on a **current** run and wrong on two
other paths, which are easy to reach for and which the buttons do not
distinguish:

- **Re-running the WHOLE workflow heals nothing.** Every version is already on
  npm, so the publish job takes its "already published" branch and `continue`s
  before nominating; `promote-tags` gets an empty list and is skipped outright
  (`if: needs.publish.outputs.promote != ''`). That is deliberate, not a bug to
  work around — tying the move to a publish *this run performed* is what stops a
  re-run dragging `latest` backwards.
- **Re-running the failed job on a SUPERSEDED run moves `latest` backwards.**
  The property that makes the remedy work is the same one that makes it
  dangerous here: the preserved nomination list names *that run's* versions, so
  if a later promotion has since published and promoted a newer release, the
  re-run points `latest` at the older one. Do not use it on a superseded run,
  whether or not GitHub still offers the button.

In those cases the move is a hand-run operator step, using the same
`npm dist-tag add` command documented in
[`scripts/README.md`](../../../scripts/README.md) § *Manual fallback* — including
the credential note that it needs a granular npm token, not the OIDC identity
`publish.yml` publishes with. Do not duplicate the command here; read it there.

**The move is forward-only.** Read the live dist-tags first (with the polling
discipline above) and advance `latest` only to a version *higher* than the one it
currently holds. Moving it backwards ships users an older build with nothing
reporting an error, and unlike the workflow path nothing checks this for you.

**There is deliberately no mechanical heal, and that is an owner decision** —
option 1 on [#2660](https://github.com/d-hinders/Haven-AI/issues/2660)
(2026-09-08): a dispatch-only job that could move `latest` without a publish
would reintroduce exactly the surface #2656 removed, so a stranded tag catches up
at the next release that publishes, and an operator moves it by hand when that
window matters.

## Guardrails

- **Never `npm publish` by hand**, and never hand-edit versions or pins.
- **A release commit is the wrong place to fix anything else.** Defects noticed
  while cutting — a lockfile bug, a mispinned dependency — get filed, not folded
  in; mixing them makes a bad bisect if either turns out wrong. Precedent:
  #1526, #1663.
- **Do not claim a package published without checking the registry.** The
  workflow's own logs and npm's dist-tags are the evidence; a merged PR is not.
