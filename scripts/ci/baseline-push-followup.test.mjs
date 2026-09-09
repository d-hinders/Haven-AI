// Tests for the baseline-regeneration follow-up (#1777, absorbing #1850).
//
// A workflow change is hard to mutation-test — inline YAML only proves itself
// in production, which is how this defect survived a comment on the checkout
// step AND a `::warning::` on the commit step. So the decision lives in a pure
// function and the YAML only wires env into it, and these tests pin the
// decision.
//
// The bias throughout is that the LOUD path must be unskippable: for every way
// the follow-up could be asked a question it cannot answer, there is a test
// asserting it takes the failing branch rather than the silent one. A green
// run that leaves a PR at "waiting for status" is the outcome this whole file
// exists to make impossible.
//
// Run: node --test scripts/ci/*.test.mjs   (already wired into ci.yml)

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  classify,
  parseHasPushToken,
  buildComment,
  findStickyCommentId,
  commentApiArgs,
  parkedRunsQueryArgs,
  selectParkedRuns,
  pollParkedRuns,
  renderParkedSection,
  STICKY_MARKER,
} from './baseline-push-followup.mjs'

const deadlock = { committed: true, hasPushToken: false, openPrCount: 1 }

describe('classify — the four outcomes', () => {
  test('nothing committed → silent pass; there is no push to strand a PR on', () => {
    const r = classify({ ...deadlock, committed: false })
    assert.equal(r.outcome, 'no-commit')
    assert.equal(r.exitCode, 0)
    assert.equal(r.shouldComment, false)
  })

  test('BASELINE_PUSH_TOKEN present → silent pass; a real actor pushed', () => {
    const r = classify({ ...deadlock, hasPushToken: true })
    assert.equal(r.outcome, 'trusted-actor')
    assert.equal(r.exitCode, 0)
    assert.equal(r.shouldComment, false)
  })

  test('bot push but NO open PR → pass; a PR opened later is attributed to its opener', () => {
    const r = classify({ ...deadlock, openPrCount: 0 })
    assert.equal(r.outcome, 'no-open-pr')
    assert.equal(r.exitCode, 0)
    assert.equal(r.shouldComment, false)
  })

  test('bot push onto a branch with an open PR → FAIL and comment', () => {
    const r = classify(deadlock)
    assert.equal(r.outcome, 'deadlocked')
    assert.equal(r.exitCode, 1)
    assert.equal(r.shouldComment, true)
  })

  test('every open PR on the branch counts, not just the first', () => {
    assert.equal(classify({ ...deadlock, openPrCount: 3 }).outcome, 'deadlocked')
  })

  test('the failure names the parking, not a missing event', () => {
    // #1850's correction: the runs ARE created, then held at action_required.
    // "the event never fired" sends the reader hunting for a missing trigger,
    // which is the wrong repair. Pin the wording.
    const r = classify(deadlock)
    assert.match(r.summary, /parked/i)
    assert.match(r.summary, /action_required/)
    assert.doesNotMatch(r.summary, /will NOT trigger|never trigger|no workflow run/i)
  })

  test('exactly one outcome exits non-zero', () => {
    const cases = [
      { committed: false, hasPushToken: false, openPrCount: 1 },
      { committed: false, hasPushToken: true, openPrCount: 0 },
      { committed: true, hasPushToken: true, openPrCount: 1 },
      { committed: true, hasPushToken: false, openPrCount: 0 },
      { committed: true, hasPushToken: false, openPrCount: 1 },
    ]
    const failing = cases.filter((c) => classify(c).exitCode !== 0)
    assert.equal(failing.length, 1)
    assert.deepEqual(failing[0], deadlock)
  })

  test('a commenting outcome always fails, and a failing outcome always comments', () => {
    // These two must not drift apart: commenting without failing reproduces the
    // silent-warning defect, failing without commenting reproduces the
    // unexplained red.
    for (const committed of [true, false]) {
      for (const hasPushToken of [true, false]) {
        for (const openPrCount of [0, 1, 2]) {
          const r = classify({ committed, hasPushToken, openPrCount })
          assert.equal(r.shouldComment, r.exitCode === 1, JSON.stringify({ committed, hasPushToken, openPrCount }))
        }
      }
    }
  })
})

describe('parseHasPushToken — fail closed', () => {
  test('the literal string true is the only way to claim a token', () => {
    assert.equal(parseHasPushToken('true'), true)
    assert.equal(parseHasPushToken('TRUE'), true)
    assert.equal(parseHasPushToken(' true '), true)
  })

  test('unset, empty, and garbage all read as ABSENT, so the loud path wins', () => {
    // A typo in the workflow's env wiring must not silence the check. Every
    // value here would, under a truthy test, hand back a false "token present"
    // and restore the exact silent deadlock this ships to remove.
    for (const raw of [undefined, null, '', '   ', 'false', 'yes', '1', 'null', '***']) {
      assert.equal(parseHasPushToken(raw), false, `expected absent for ${JSON.stringify(raw)}`)
    }
  })
})

describe('buildComment — carries what a first-time reader needs', () => {
  const body = buildComment({
    repo: 'd-hinders/Haven-AI',
    branch: 'fix/1234-example',
    sha: '3100351473790332bfb150a097df13f700c51b20',
    runUrl: 'https://github.com/d-hinders/Haven-AI/actions/runs/32586643491',
  })

  test('is stickily identifiable, so re-dispatching updates rather than piles up', () => {
    assert.ok(body.startsWith(STICKY_MARKER))
  })

  test('says the baselines are FINE — the red must not read as "your images are broken"', () => {
    assert.match(body, /correct and already pushed/)
  })

  test('states the real mechanism: created then parked, not never delivered', () => {
    assert.match(body, /action_required/)
    assert.match(body, /parks them/)
  })

  test('gives a recovery the reader can paste, branch-substituted', () => {
    assert.match(body, /git commit --amend --reset-author --no-edit/)
    assert.match(body, /git push --force-with-lease origin fix\/1234-example/)
    // The tree-identity check is not decoration: an amend that silently changes
    // the tree would push a different baseline set than the one CI generated.
    assert.match(body, /git diff 310035147 HEAD --stat/)
  })

  test('names both remedies, the permanent one included', () => {
    assert.match(body, /BASELINE_PUSH_TOKEN/)
    assert.match(body, /contents: write/)
    // The approval remedy is no longer vague prose about "the Actions tab" —
    // it is the enumerated-runs section, covered in the parked-runs suite.
    assert.match(body, /Approve and run/)
  })

  test('explains why a second automated push would not help', () => {
    // Without this the next reader tries the empty-commit-from-the-workflow
    // route, which parks under the same actor.
    assert.match(body, /who pushed/)
  })

  test('carries the diagnose-before-regenerating warning where the dispatcher reads it', () => {
    // #1777's third scope bullet: the regeneration trap blessed a broken render
    // on #1772. The workflow header comment says this, and the header comment is
    // not where anyone was looking.
    //
    // #2218 narrowed the default from `all` to `changed`, which does NOT retire
    // this warning — a broken render fails comparison, so `changed` rewrites it
    // too. Both modes must stay named here, or the reader concludes the safer
    // default made diagnosis optional.
    assert.match(body, /update-snapshots=changed/)
    assert.match(body, /\ball\b/)
    assert.match(body, /horizontal cut/)
  })

  test('substitutes the run URL rather than hardcoding a link', () => {
    assert.match(body, /actions\/runs\/32586643491/)
  })

  test('never emits a token value — it is not even passed one', () => {
    assert.doesNotMatch(body, /gh[pous]_[A-Za-z0-9]{16,}/)
  })
})

describe('parked runs — the approve-don\'t-push recovery', () => {
  // These exist because the mechanism is "triggered then parked", NOT "never
  // triggered". Under the wrong model there is nothing to enumerate and the
  // only escape is another push. Under the right one the recovery is a click,
  // so the comment has to name the runs.
  const payload = {
    workflow_runs: [
      { name: 'CI', id: 32586761757, conclusion: 'action_required', html_url: 'https://gh/runs/32586761757' },
      { name: 'Docs quality', id: 32586761737, conclusion: 'action_required', html_url: 'https://gh/runs/32586761737' },
      { name: 'Something green', id: 1, conclusion: 'success', html_url: 'https://gh/runs/1' },
    ],
  }

  test('the query asks for the parked status explicitly', () => {
    const [verb, path] = parkedRunsQueryArgs('o/r', 'deadbeef')
    assert.equal(verb, 'api')
    assert.match(path, /head_sha=deadbeef/)
    assert.match(path, /status=action_required/)
  })

  test('selects only the parked runs, never a completed one', () => {
    const got = selectParkedRuns(payload)
    assert.equal(got.length, 2)
    assert.deepEqual(got.map((r) => r.id), [32586761757, 32586761737])
  })

  test('tolerates an empty or malformed payload rather than throwing', () => {
    assert.deepEqual(selectParkedRuns({}), [])
    assert.deepEqual(selectParkedRuns(undefined), [])
  })

  test('polls again when the runs are not visible yet — they appear ~6s AFTER the push', () => {
    // Measured: push 17:06:59Z, runs 17:07:05Z. A single immediate query races
    // and loses, which would silently degrade every comment to the fallback.
    let calls = 0
    const slept = []
    return pollParkedRuns({
      fetchParked: () => (++calls < 3 ? [] : [{ name: 'CI', id: 7, url: 'u' }]),
      sleep: (ms) => { slept.push(ms); return Promise.resolve() },
      attempts: 5,
      delayMs: 10,
    }).then((found) => {
      assert.equal(calls, 3)
      assert.equal(found.length, 1)
      assert.deepEqual(slept, [10, 10])
    })
  })

  test('stops polling the moment it finds them — no wasted minute on the happy path', () => {
    let slept = 0
    return pollParkedRuns({
      fetchParked: () => [{ name: 'CI', id: 7, url: 'u' }],
      sleep: () => { slept += 1; return Promise.resolve() },
      attempts: 6,
      delayMs: 10,
    }).then(() => assert.equal(slept, 0))
  })

  test('gives up after the attempt budget instead of hanging the job forever', () => {
    let calls = 0
    return pollParkedRuns({
      fetchParked: () => { calls += 1; return [] },
      sleep: () => Promise.resolve(),
      attempts: 4,
      delayMs: 1,
    }).then((found) => {
      assert.equal(calls, 4)
      assert.deepEqual(found, [])
    })
  })

  test('the wait budget is (attempts - 1) x delayMs — no trailing sleep after the last fetch', () => {
    // Pins the arithmetic the docstring states (6 x 10s = 50s, NOT 60s). A
    // trailing sleep after the final fetch would add delayMs of dead time to
    // every deadlocked run and quietly falsify the documented budget — and the
    // first version of these tests did NOT catch that mutation.
    const slept = []
    return pollParkedRuns({
      fetchParked: () => [],
      sleep: (ms) => { slept.push(ms); return Promise.resolve() },
      attempts: 6,
      delayMs: 10_000,
    }).then(() => {
      assert.equal(slept.length, 5)
      assert.equal(slept.reduce((a, b) => a + b, 0), 50_000)
    })
  })

  test('renders each parked run as a clickable link with its id', () => {
    const md = renderParkedSection({ repo: 'o/r', sha: 'abc', parked: selectParkedRuns(payload) })
    assert.match(md, /\[CI\]\(https:\/\/gh\/runs\/32586761757\)/)
    assert.match(md, /\[Docs quality\]\(https:\/\/gh\/runs\/32586761737\)/)
    assert.match(md, /Approve and run/)
    assert.match(md, /without any push/)
  })

  test('when it could not enumerate them, it says how to find them — it does not fake a list', () => {
    const md = renderParkedSection({ repo: 'o/r', sha: 'abc', parked: [] })
    assert.match(md, /status=action_required/)
    assert.match(md, /Approve and run/)
    assert.doesNotMatch(md, /^- \[/m) // no invented bullet list of runs
  })

  test('the comment leads with approval and demotes the push escape to a fallback', () => {
    const body = buildComment({
      repo: 'o/r', branch: 'b', sha: 'abc123', runUrl: 'u',
      parked: selectParkedRuns(payload),
    })
    assert.match(body, /Recovery — approve, don't push/)
    assert.ok(
      body.indexOf('Approve and run') < body.indexOf('--force-with-lease'),
      'the one-click recovery must appear before the push-based fallback',
    )
    assert.match(body, /<details><summary>If you cannot approve them/)
  })

  test('the comment refutes the "never triggered" model in so many words', () => {
    // Four sessions reasoned from that model. The comment is where it gets
    // corrected, because the comment is what people read.
    const body = buildComment({ repo: 'o/r', branch: 'b', sha: 'abc123', runUrl: 'u', parked: [] })
    assert.match(body, /not\*{0,2} that the push failed to trigger anything/i)
    assert.match(body, /conclusion: ?`?action_required/)
  })

  test('tells the dispatcher NOT to re-dispatch — the baselines are already pushed', () => {
    const body = buildComment({ repo: 'o/r', branch: 'b', sha: 'abc123', runUrl: 'u', parked: [] })
    assert.match(body, /Do not re-dispatch/)
  })
})

describe('commentApiArgs — POST vs PATCH', () => {
  const base = { repo: 'o/r', prNumber: 42, body: 'hello' }

  test('no existing comment → POST to the PR\'s comment collection', () => {
    const a = commentApiArgs({ ...base, existingId: null })
    assert.deepEqual(a, ['api', '--method', 'POST', 'repos/o/r/issues/42/comments', '-f', 'body=hello'])
  })

  test('existing comment → PATCH that comment, so re-dispatching updates in place', () => {
    const a = commentApiArgs({ ...base, existingId: 77 })
    assert.deepEqual(a, ['api', '--method', 'PATCH', 'repos/o/r/issues/comments/77', '-f', 'body=hello'])
  })

  test('uses -f, never -F — -F would read a leading @ as a filename', () => {
    assert.ok(commentApiArgs({ ...base, existingId: null }).includes('-f'))
    assert.ok(!commentApiArgs({ ...base, existingId: null }).includes('-F'))
  })

  test('the body is one argv element, so shell metacharacters stay literal', () => {
    const nasty = '`whoami` $(id) \n && rm -rf /'
    const a = commentApiArgs({ ...base, existingId: null, body: nasty })
    assert.equal(a.at(-1), `body=${nasty}`)
    assert.equal(a.length, 6)
  })
})

describe('#2599 — the re-run remedy, and the approval-entitlement correction', () => {
  // The comment used to offer exactly two ways out — approve, or push from your
  // own credentials — and asserted that a dispatcher can "almost certainly"
  // approve. Both halves were incomplete, and the second was flatly wrong for
  // the caller most likely to be stuck here:
  //
  //   - A third recovery needs no push at all. Re-running a parked run is a
  //     fresh attempt attributed to whoever triggers it, so it re-attributes
  //     the run away from the bot and the approval gate lets it through.
  //     Measured on PR #2598: five `action_required` runs came back
  //     `run_attempt: 2` / `triggering_actor: d-hinders` after
  //     `POST .../actions/runs/:id/rerun`, and CI went green with no push.
  //   - A GitHub App installation token that just dispatched the workflow is
  //     refused the approval it caused to be parked: the approve endpoint
  //     answers `403 Resource not accessible by integration`.
  //
  // These are prose pins, which is the whole point: an unasserted sentence in
  // this comment has already cost four sessions once (#1777), and a sentence
  // nobody pins is a sentence that quietly reverts. Every assertion here is
  // red against the pre-#2599 text — the re-run block did not exist, the 403
  // was unnamed, and the over-assertion was the sentence being deleted.
  const parked = [
    { name: 'CI', id: 32586761757, url: 'https://gh/runs/32586761757' },
    { name: 'Docs quality', id: 32586761737, url: 'https://gh/runs/32586761737' },
  ]
  const build = (p) =>
    buildComment({ repo: 'o/r', branch: 'b', sha: 'abc123def456', runUrl: 'https://gh/runs/9', parked: p })

  test('names the re-run remedy with a pasteable call, against the run ids it enumerates', () => {
    const body = build(parked)
    assert.match(body, /re-run each parked run/i)
    assert.match(body, /gh api --method POST "repos\/o\/r\/actions\/runs\/\$id\/rerun"/)
    assert.match(body, /gh run rerun/)
    // The invocation is meant to be used WITH the ids the comment already lists,
    // so it must not read as a third enumeration the reader has to go find.
    assert.match(body, /run ids (listed )?above/i)
  })

  test('the re-run sits ahead of the force-push / empty-commit fallback', () => {
    const body = build(parked)
    const rerun = body.indexOf('actions/runs/$id/rerun')
    assert.ok(rerun > 0, 'the re-run invocation must be present to be ordered')
    assert.ok(rerun < body.indexOf('--force-with-lease'), 're-run before the force-push block')
    assert.ok(rerun < body.indexOf('--allow-empty'), 're-run before the empty-commit alternative')
    // Ordering is "ahead of the push routes", NOT "ahead of approval": the
    // enumerated one-click approve list is still what the reader is offered
    // first, because when it is available it is the least-effort route.
    assert.ok(body.indexOf('Approve and run') < rerun, 'approval stays the lead remedy')
    assert.ok(body.indexOf('#### Recovery') < rerun)
  })

  test('the approval sentence stops asserting that a dispatcher can almost certainly approve', () => {
    const body = build(parked)
    assert.doesNotMatch(body, /almost certainly/)
    assert.doesNotMatch(body, /the same write access dispatching this workflow already needed/i)
    assert.doesNotMatch(body, /anyone who could dispatch .* already has the write access/i)
  })

  test('the App-token exception is named as a known exception, with the observed status', () => {
    const body = build(parked)
    assert.match(body, /403/)
    assert.match(body, /App installation token/)
    assert.match(body, /Resource not accessible by integration/)
    // Naming the status is not decoration: "dispatch succeeded, therefore approve
    // will work" is exactly the inference that strands an automated caller.
    assert.match(body, /dispatch(ing)? (does not imply|is not) /i)
  })

  test('the mechanism is cited to a measurement, not asserted', () => {
    const body = build(parked)
    assert.match(body, /#2598/)
    assert.match(body, /run_attempt: 2/)
    assert.match(body, /triggering_actor: d-hinders/)
  })

  test('the not-enumerable fallback offers the re-run too', () => {
    // The fallback is the branch an automated caller on an App token will
    // actually land in — the runs often appear after the poll window, and that
    // same caller cannot approve. Leaving it approve-only would give the reader
    // one remedy and it is the one they cannot perform.
    const md = renderParkedSection({ repo: 'o/r', sha: 'abc123def456', parked: [] })
    assert.match(md, /run rerun/)
    assert.match(md, /Approve and run/) // still offered, not replaced
  })

  test('BASELINE_PUSH_TOKEN stays the permanent fix — this shortens recovery, it does not replace the secret', () => {
    const body = build(parked)
    assert.match(body, /The permanent fix\*{0,2} is setting the `BASELINE_PUSH_TOKEN` secret/)
    assert.match(body, /#1777/)
    // The re-run prose must not creep into competing with the secret.
    assert.doesNotMatch(body, /permanent fix\*{0,2} is (the )?re-?run/i)
  })

  test('both branches carry the recovery — neither collapses to push-only advice', () => {
    for (const p of [parked, []]) {
      const body = build(p)
      assert.match(body, /rerun/i)
      assert.match(body, /without any push/)
    }
  })
})

describe('findStickyCommentId', () => {
  test('finds our marker among unrelated comments', () => {
    const found = findStickyCommentId([
      { id: 1, body: 'nice work' },
      { id: 2, body: `${STICKY_MARKER}\nolder run` },
      { id: 3, body: 'lgtm' },
    ])
    assert.equal(found, 2)
  })

  test('returns null when we have not commented yet — so we POST instead of PATCH', () => {
    assert.equal(findStickyCommentId([{ id: 1, body: 'unrelated' }]), null)
    assert.equal(findStickyCommentId([]), null)
    assert.equal(findStickyCommentId(undefined), null)
  })

  test('does not mistake another gate\'s sticky comment for ours', () => {
    // The advisory gates use the same convention with different keys; matching
    // one of theirs would overwrite it.
    assert.equal(findStickyCommentId([{ id: 9, body: '<!-- haven:docs-coupling -->' }]), null)
  })
})

// --- The CLI path (#2722, epic #2720) ---------------------------------------
//
// The file's own header concedes it: "the thin IO wrappers below it … and
// `main`'s sequencing are NOT unit-tested". `main()` is what the workflow runs,
// and its one refusal is the exit: classify() returning `deadlocked` must
// reach the process as `process.exitCode = 1` plus the `::error::` line. A
// `main()` that dropped that assignment — the #2690/#2704 shape — would leave
// every pure test above green while the workflow step went permanently green
// on a deadlocked PR, which is precisely the outcome this file exists to make
// impossible ("a green run that leaves a PR unmergeable is the least useful of
// the three possible outcomes").
//
// Driven through the shared slice-1 harness, with a stub `gh` on PATH: the
// deadlocked path needs `openPullRequests` to answer, and a real `gh` would
// query d-hinders/Haven-AI. The stub also serves the parked-runs query, so the
// deadlock path runs to its comment POST inside the 6×10s poll budget
// (pollParkedRuns' own header warns a single immediate query usually loses —
// an empty answer is the no-comment fallback shape, a different line with a
// different meaning, and the stub's instant answer never races it).

import { runGuard } from '../test-support/guard-cli.mjs'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'

// Stub `gh`, dispatched on argv shape. POSTs are appended to posts.log so a
// test can assert the guard's WRITE, not only its print. An unhandled shape
// exits 99, which openPullRequests turns into the worst-case `[{number:null}]`
// — a fixture mistake therefore looks like a refused lookup, never like an
// accept, and the POST assertions below cannot be satisfied by accident.
const GH_STUB = `#!${process.execPath}
const fs = require('node:fs')
const a = process.argv.slice(2).join(' ')
const dir = process.env.GH_STUB_DIR
const out = (f) => process.stdout.write(fs.readFileSync(dir + '/' + f, 'utf8'))
if (a.startsWith('api --method POST')) {
  fs.appendFileSync(dir + '/posts.log', a + '\\n')
  return process.stdout.write('')
}
if (a.startsWith('pr list')) return out('prs.json')
if (a.includes('actions/runs?')) return out('parked.json')
console.error('gh-stub: unhandled argv: ' + a)
process.exit(99)
`

const PRS_OPEN = JSON.stringify([{ number: 12 }])
const PRS_NONE = JSON.stringify([])
const PARKED = JSON.stringify({
  workflow_runs: [
    { name: 'Backend checks', id: 42, conclusion: 'action_required', html_url: 'https://example/run/42' },
  ],
})

/**
 * Run the follow-up with the stub `gh` first on PATH. Returns
 * `{ status, out, posts }` — posts is the log of every `gh api --method POST`
 * the guard made (empty string when it made none).
 */
function runFollowupCli({ prs = PRS_OPEN, parked = PARKED, env = {} } = {}) {
  const stubDir = realpathSync(mkdtempSync(join(tmpdir(), 'push-followup-gh-')))
  try {
    const binDir = join(stubDir, 'bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'gh'), GH_STUB, { mode: 0o755 })
    writeFileSync(join(stubDir, 'prs.json'), prs)
    writeFileSync(join(stubDir, 'parked.json'), parked)
    writeFileSync(join(stubDir, 'posts.log'), '')
    const { status, out } = runGuard('ci/baseline-push-followup.mjs', {
      env: {
        GITHUB_REPOSITORY: 'haven/haven',
        GITHUB_REF_NAME: 'update-visual-baselines',
        PUSHED_SHA: 'abc123def4567890',
        BASELINES_COMMITTED: 'true',
        HAS_PUSH_TOKEN: 'false',
        GH_STUB_DIR: stubDir,
        PATH: `${binDir}${delimiter}${process.env.PATH}`,
        ...env,
      },
    })
    const posts = readFileSync(join(stubDir, 'posts.log'), 'utf8')
    return { status, out, posts }
  } finally {
    rmSync(stubDir, { recursive: true, force: true })
  }
}

test('CLI refusal: bot push + open PR exits 1, posts the sticky comment, and says so', () => {
  // The deadlock. classify() says exitCode 1 + shouldComment; `main()` must
  // (a) enumerate parked runs, (b) POST the comment, (c) set the exit. posts
  // is the comment asserted at its transport, not just its log line: the
  // comment carries the approve/re-run recovery, and it must be a sticky
  // POST keyed on our marker (an update would mean a stale-comment mixup,
  // a missing POST means the recovery never reached the PR).
  const { status, out, posts } = runFollowupCli()
  assert.equal(status, 1)
  assert.match(out, /::error::\[deadlocked\] Pushed with GITHUB_TOKEN onto a branch with an open pull request\./)
  assert.match(out, /Parked runs found: 1/)
  assert.match(out, /Sticky comment created on #12\./)
  assert.match(posts, /^api --method POST repos\/haven\/haven\/issues\/12\/comments -f body=/m)
  assert.match(posts, /haven:baseline-push-followup/)
  assert.match(posts, /Approve these 1 parked runs/)
})

test('CLI accept: no open PR is not a deadlock — exit 0 and no comment attempted', () => {
  // The positive control for the refusal above: same bot push, same committed
  // baselines, but the PR lookup answers empty. The documented reasoning: a
  // PR opened LATER is attributed to its human opener, so the checks run
  // normally. The empty posts log is the negative half of the assertion —
  // nothing was commented anywhere.
  const { status, out, posts } = runFollowupCli({ prs: PRS_NONE })
  assert.equal(status, 0)
  assert.match(out, /\[no-open-pr\] Pushed with GITHUB_TOKEN, but no pull request is open on this branch\./)
  assert.doesNotMatch(out, /::error::/)
  assert.equal(posts, '')
})
