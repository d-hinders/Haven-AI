#!/usr/bin/env node
// Review-isolation guard (#2455).
//
// ## The defect this exists for
//
// The workflow tells an independent reviewer to work from a *disposable copy*
// of the tree, so the builder can keep working without invalidating the
// verdict. That instruction is prose, and prose is not a boundary. Worse, the
// obvious way to make the copy — `cp -R` of the builder's git worktree — is
// silently broken, and it broke us three times in two days (#2415, #2444,
// #2421).
//
// A linked worktree's `.git` is a **file** holding `gitdir: <parent>/.git/
// worktrees/<name>`. `cp -R` copies that pointer verbatim, so the copy's
// administrative state — HEAD, the index, and every ref — is the BUILDER's,
// still. The copy's files are frozen; its git is live. Measured on the exact
// shape the incidents had:
//
//   builder edits f.txt, then commits          → copy's HEAD moves with it
//   `cat copy/f.txt`                           → "line one"        (frozen)
//   `git -C copy diff`                         → "-LIVE EDIT"      (live)
//
// A reviewer reading that diff reports a **revert that never happened**. Read
// the other way round — the builder adding rather than removing — the same
// skew reports additions as strippings. Both directions were relayed to the
// owner as real findings.
//
// So the property to check is not "did the reviewer stay inside its path".
// A `cp -R` copy satisfies that and still reads the live repository. The
// property is:
//
//   **the reviewer's git view must match its file view.**
//
// ## How that is decided, in one fact
//
// Ask git, from inside the candidate, to list the worktrees it knows about.
// A sound checkout — `git clone`, `git worktree add`, or the main checkout
// itself — is registered at its OWN path. A `cp -R` of a worktree is not: it
// is registered at the path it was copied FROM, because that is whose gitdir
// it carries.
//
//   reviewer-cp     toplevel .../reviewer-cp     registered at own path: NO
//   reviewer-wt     toplevel .../reviewer-wt     registered at own path: YES
//   reviewer-clone  toplevel .../reviewer-clone  registered at own path: YES
//
// That is the whole discriminator, and it is a fact about the environment
// rather than about text, which is why this guard executes git instead of
// grepping instructions.
//
// ## The second half: a baseline that moves
//
// `cp -R` of a *normal clone* passes the check above — it has its own HEAD,
// index and refs. It fails differently: it carries a stale `origin/*` that
// drifts further from the truth for as long as the session runs, which is what
// turned a two-dot diff into a phantom revert in #2421. And a legitimate
// `git worktree add` SHARES refs with the parent repo, so its `origin/dev` can
// advance mid-pass when the builder fetches.
//
// Neither is fixed by copying harder. Both are fixed by refusing to let the
// reviewer name a moving ref: this guard resolves the base to a concrete SHA,
// checks that SHA against the real remote, and prints the exact three-dot diff
// command the reviewer must run. A frozen SHA cannot drift under a pass.
//
// ## What this guard is NOT
//
// It is not a sandbox. Nothing here stops a subagent `cd`-ing to the live
// worktree — that would need a boundary this repository's tooling does not
// have. What it does is make the claim *checkable*: a verdict now names a
// root, a HEAD and a base, and the captain can re-run this guard afterwards
// with `--expect-head` and find out whether the tree moved under the pass.
// #2415 caught that by luck. This turns it into a command.
//
// `evaluate()` is pure. Every git call lives in `collectFacts()` and the CLI
// wrapper at the bottom, so the decision logic is testable without a repo and
// the environment reading is testable with one.
//
// Usage:
//   node scripts/ci/review-isolation.mjs <review-root> [options]
//
//   --builder <path>     tree the reviewer must NOT be reading (default: cwd)
//   --base <ref>         baseline ref to freeze (default: origin/dev)
//   --expect-head <sha>  require the review root's HEAD to be this commit
//   --no-base-check      skip the remote freshness comparison, with a caveat
//   --json               machine-readable result

import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'

export const DEFAULT_BASE = 'origin/dev'

/**
 * Decide whether a candidate review root is sound, from already-collected
 * facts. Pure: no filesystem, no git, no clock.
 *
 * @param {object} facts
 * @returns {{ok: boolean, checks: Array<{id: string, ok: boolean|null, detail: string}>, caveats: string[]}}
 */
export function evaluate(facts) {
  const checks = []
  const caveats = []
  const add = (id, ok, detail) => checks.push({ id, ok, detail })

  if (!facts.rootExists) {
    add('root-exists', false, `${facts.root} is not an existing directory`)
    return { ok: false, checks, caveats }
  }
  add('root-exists', true, facts.root)

  if (!facts.isRepo) {
    add('is-repo', false, `${facts.root} is not inside a git repository`)
    return { ok: false, checks, caveats }
  }
  add('is-repo', true, 'git answers inside this path')

  // 1. File view == git view. A handoff pointing at a subdirectory, or at a
  //    copy dropped inside some other repository, fails here.
  const topMatches = facts.toplevel === facts.root
  add(
    'toplevel-is-root',
    topMatches,
    topMatches
      ? facts.toplevel
      : `git's working tree for this path is ${facts.toplevel}, not ${facts.root}`,
  )

  // 2. THE discriminator. A `cp -R` of a worktree is registered at the path it
  //    was copied from, so its own path is absent from git's own list.
  const registered = facts.registeredWorktrees.includes(facts.toplevel)
  add(
    'registered-at-own-path',
    registered,
    registered
      ? 'git lists this path as one of its own worktrees'
      : `git does not know a worktree at ${facts.toplevel}. Its gitdir (${facts.gitDir}) belongs to another checkout — ` +
        'this is a copy of a worktree, whose files are frozen while every git command answers from the live repository. ' +
        'Re-make it with `git worktree add` or `git clone`, never `cp -R`.',
  )

  // 3. Not the builder's own tree. Prose told the reviewer to use a copy;
  //    this asks whether it did. With no builder to compare against the answer
  //    is INCONCLUSIVE, never a pass — the same shape as an unasserted head
  //    below. A `[PASS] distinct-from-builder` that never saw the builder is a
  //    check that cannot fail, which is the defect this file exists to remove
  //    (found in review of this very change).
  if (facts.builderToplevel === null) {
    const why = facts.builderGiven
      ? `--builder ${facts.builderGiven} was given but git could not read a working tree there`
      : 'no builder tree was given'
    add('distinct-from-builder', null, `not asserted; ${why}`)
    caveats.push(
      `"The reviewer is not reading the builder's live tree" was NOT verified — ${why}. Pass --builder <builder-tree> to check it.`,
    )
  } else {
    const distinct = facts.builderToplevel !== facts.toplevel
    add(
      'distinct-from-builder',
      distinct,
      distinct
        ? `builder tree is ${facts.builderToplevel}`
        : `review root IS the builder's live working tree (${facts.builderToplevel}) — a verdict from it describes a moving target`,
    )
  }

  // 4. HEAD binding, when the caller states what it expects.
  if (facts.expectHead) {
    const headOk = facts.head === facts.expectHead
    add(
      'head-matches-expected',
      headOk,
      headOk ? facts.head : `review root HEAD is ${facts.head}, expected ${facts.expectHead}`,
    )
  } else {
    add('head-matches-expected', null, `not asserted; HEAD is ${facts.head}`)
    caveats.push(
      `--expect-head was not given, so this run did not verify WHICH commit was reviewed. Bind the verdict to ${facts.head} and re-run with --expect-head to prove the tree did not move.`,
    )
  }

  // 5. Baseline freshness. Skipped explicitly, or unreachable — never silently
  //    green. An offline remote is INCONCLUSIVE, which is a failure here,
  //    because a check that quietly passes when it cannot look is the defect
  //    this file exists to remove, one layer up.
  if (facts.baseCheck === 'skipped') {
    add('base-is-fresh', null, 'skipped by --no-base-check')
    caveats.push(
      `Base freshness was NOT checked. The reviewer's ${facts.baseRef} may lag the real remote, which makes a two-dot diff report phantom reverts (#2421).`,
    )
  } else if (facts.baseCheck === 'unreachable') {
    add('base-is-fresh', false, `could not read ${facts.baseRef} from the remote: ${facts.baseError}`)
  } else if (!facts.baseLocal) {
    add('base-is-fresh', false, `${facts.baseRef} does not resolve inside the review root`)
  } else {
    const fresh = facts.baseLocal === facts.baseRemote
    add(
      'base-is-fresh',
      fresh,
      fresh
        ? `${facts.baseRef} == remote (${facts.baseLocal})`
        : `${facts.baseRef} is ${facts.baseLocal} but the remote is at ${facts.baseRemote} — fetch, or re-make the copy`,
    )
  }

  // A shared ref store is legitimate but worth saying out loud: it is the one
  // way a `git worktree add` copy can still move under a pass.
  if (facts.refsSharedWithBuilder) {
    caveats.push(
      'This root shares its ref store with the builder, so a fetch by the builder can advance ' +
        `${facts.baseRef} mid-pass. Diff against the frozen SHA below, never against the ref name.`,
    )
  }

  return { ok: checks.every((c) => c.ok !== false), checks, caveats }
}

/** The review contract a verdict has to quote back. */
export function contract(facts) {
  const base = facts.baseLocal ?? facts.baseRef
  return {
    root: facts.root,
    head: facts.head,
    base,
    diffCommand: `git -C ${facts.root} diff ${base}...${facts.head}`,
  }
}

const git = (cwd, args) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const gitOrNull = (cwd, args) => {
  try {
    return git(cwd, args)
  } catch {
    return null
  }
}

/** Read every fact `evaluate` needs out of a real filesystem and repository. */
export function collectFacts(rootArg, opts = {}) {
  const baseRef = opts.base ?? DEFAULT_BASE
  const rootExists = existsSync(rootArg) && statSync(rootArg).isDirectory()
  const facts = {
    root: rootExists ? realpathSync(rootArg) : rootArg,
    rootExists,
    isRepo: false,
    toplevel: null,
    gitDir: null,
    gitCommonDir: null,
    registeredWorktrees: [],
    builderGiven: opts.builder ?? null,
    builderToplevel: null,
    head: null,
    expectHead: opts.expectHead ?? null,
    baseRef,
    baseLocal: null,
    baseRemote: null,
    baseCheck: opts.baseCheck === false ? 'skipped' : 'compared',
    baseError: null,
    refsSharedWithBuilder: false,
  }
  if (!rootExists) return facts

  const toplevel = gitOrNull(facts.root, ['rev-parse', '--path-format=absolute', '--show-toplevel'])
  if (toplevel === null) return facts
  facts.isRepo = true
  facts.toplevel = existsSync(toplevel) ? realpathSync(toplevel) : toplevel
  facts.gitDir = gitOrNull(facts.root, ['rev-parse', '--path-format=absolute', '--git-dir'])
  facts.gitCommonDir = gitOrNull(facts.root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  facts.head = gitOrNull(facts.root, ['rev-parse', 'HEAD'])

  const listed = gitOrNull(facts.root, ['worktree', 'list', '--porcelain']) ?? ''
  facts.registeredWorktrees = listed
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length))
    .map((p) => (existsSync(p) ? realpathSync(p) : p))

  // An absent or explicitly null `builder` means "none given", and must NOT
  // fall back to the process cwd — that would silently compare the review root
  // against whatever directory the guard happened to run in and call it a pass.
  const builderArg = opts.builder ?? null
  if (builderArg) {
    const bt = gitOrNull(builderArg, ['rev-parse', '--path-format=absolute', '--show-toplevel'])
    if (bt) {
      facts.builderToplevel = existsSync(bt) ? realpathSync(bt) : bt
      const builderCommon = gitOrNull(builderArg, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
      facts.refsSharedWithBuilder =
        builderCommon !== null && facts.gitCommonDir !== null && realpathish(builderCommon) === realpathish(facts.gitCommonDir)
    }
  }

  facts.baseLocal = gitOrNull(facts.root, ['rev-parse', '--verify', `${baseRef}^{commit}`])
  if (facts.baseCheck === 'compared') {
    const [remote, branch] = splitRef(baseRef)
    try {
      const out = git(facts.root, ['ls-remote', remote, `refs/heads/${branch}`])
      const sha = out.split(/\s+/)[0]
      if (!sha) throw new Error(`remote ${remote} has no branch ${branch}`)
      facts.baseRemote = sha
    } catch (err) {
      facts.baseCheck = 'unreachable'
      facts.baseError = String(err.message ?? err).split('\n')[0]
    }
  }
  return facts
}

const realpathish = (p) => (p && existsSync(p) ? realpathSync(p) : p)

/** `origin/dev` -> ['origin', 'dev']; a bare `dev` -> ['origin', 'dev']. */
export function splitRef(ref) {
  const i = ref.indexOf('/')
  if (i === -1) return ['origin', ref]
  return [ref.slice(0, i), ref.slice(i + 1)]
}

export function parseArgs(argv) {
  // `builder: null` by default. It is NOT filled from `process.cwd()`: doing so
  // compares the review root against whatever directory the guard happened to
  // run in and reports that as a pass, which is a false assurance on exactly
  // the property this guard exists to establish.
  const opts = { root: null, builder: null, base: DEFAULT_BASE, expectHead: null, baseCheck: true, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--builder') opts.builder = argv[++i]
    else if (a === '--base') opts.base = argv[++i]
    else if (a === '--expect-head') opts.expectHead = argv[++i]
    else if (a === '--no-base-check') opts.baseCheck = false
    else if (a === '--json') opts.json = true
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`)
    else if (opts.root === null) opts.root = a
    else throw new Error(`unexpected argument ${a}`)
  }
  if (opts.root === null) throw new Error('a review root path is required')
  return opts
}

export function render(result, facts) {
  const mark = (ok) => (ok === null ? '–' : ok ? 'PASS' : 'FAIL')
  const lines = [`review-isolation: ${result.ok ? 'ACCEPTED' : 'REFUSED'} — ${facts.root}`]
  for (const c of result.checks) lines.push(`  [${mark(c.ok)}] ${c.id}: ${c.detail}`)
  if (result.ok) {
    const ct = contract(facts)
    lines.push('', 'Review contract — quote these three in the verdict:')
    lines.push(`  root: ${ct.root}`)
    lines.push(`  head: ${ct.head}`)
    lines.push(`  base: ${ct.base}`)
    lines.push(`  diff: ${ct.diffCommand}`)
  }
  if (result.caveats.length) {
    lines.push('', 'Caveats the verdict must carry:')
    for (const c of result.caveats) lines.push(`  - ${c}`)
  }
  return lines.join('\n')
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('review-isolation.mjs')
if (invokedDirectly) {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`review-isolation: ${err.message}`)
    console.error('usage: node scripts/ci/review-isolation.mjs <review-root> [--builder <path>] [--base <ref>] [--expect-head <sha>] [--no-base-check] [--json]')
    process.exit(2)
  }
  const facts = collectFacts(opts.root, opts)
  const result = evaluate(facts)
  if (opts.json) console.log(JSON.stringify({ ok: result.ok, checks: result.checks, caveats: result.caveats, contract: contract(facts) }, null, 2))
  else console.log(render(result, facts))
  process.exit(result.ok ? 0 : 1)
}
