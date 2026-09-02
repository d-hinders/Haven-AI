import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  OPERATOR_VERIFY_LABEL,
  allClosingRefs,
  assemblePullRequest,
  assertsStaysOpen,
  commitsFromGraphQL,
  findViolations,
  isPromotion,
  logicalLines,
  parseClosingRefs,
  pullRequestSources,
  renderReport,
  staysOpenEvidence,
} from './operator-verify-close-guard.mjs'

// ─────────────────────────────────────────────────────────────────────────────
// The three real artifacts. Every one of them is prose a human reads correctly
// and an early version of this guard read backwards, which is the whole
// difficulty — a hand-written `Closes #123` proves far less. They are quoted
// VERBATIM from the sources named, not paraphrased.
// ─────────────────────────────────────────────────────────────────────────────

// (1) The case this guard exists for, quoted VERBATIM from the body of PR #2272
// as it merged on 2026-08-31 (`gh pr view 2272 --json body`). Two lines out of a
// long body: the one that promised the issue survives the merge, and the one
// that closed it. GitHub's own parse of that same body still reports
// `closingIssuesReferences: [#2268]`, which is what actually closed the issue.
const PR_2272_EXCERPT = [
  '## Intentionally excluded',
  '',
  'Repairing the webhook (operator action, #2268 stays open for it); `deployment_status` (#2273); the manual/real dispatch discriminator (#2271); the six advisory docs, none of which describes the trigger.',
  '',
  'Closes #2268',
].join('\n')

// The same body with the one-word fix the skill now prescribes.
const PR_2272_FIXED = PR_2272_EXCERPT.replace('Closes #2268', 'Refs #2268')

// (2) #2320 — the FALSE NEGATIVE, and the reason the commit half exists.
//
// Verbatim from `git log -1 --format=%B 7f7102ff`, the first commit of PR #2314
// — the pull request that introduced this guard. It is a narrative paragraph
// DESCRIBING the original incident, with the keyword quoted inside a code span
// so a reader understands it is being discussed rather than invoked. GitHub does
// not make that distinction. `dev` is the default branch, PR #2314 landed as a
// merge commit (`4a1f3114`), the message reached `dev` verbatim, and #2268 was
// closed for the SECOND time — by the change written to prevent it — while this
// guard reported green. Green because the body it read never named #2268 with a
// keyword: the merged pull request's `closingIssuesReferences` is `[#2276]`
// alone, its own issue, correctly closed. The guard had a true answer about the
// surface it looked at and no answer about the one that mattered.
//
// Trimmed to the subject, the paragraph carrying the keyword, and the trailer;
// the omitted middle is a bullet list about SKILL.md and the hooks.
const COMMIT_7F7102FF = [
  'fix(ship-next): make `Closes #<issue>` conditional and enforce it (#2276)',
  '',
  '`Closes #<n>` is a GitHub keyword, not prose: on merge it closes the issue',
  "whatever the pull-request body says elsewhere. ship-next's operator-verify",
  'mode — ship the code, keep the issue OPEN because a human still has a live',
  'step — therefore instructed authors to do the exact thing it forbids one',
  'section later, and the mechanism wins over the prose every time. It did:',
  'PR #2272 said the issue stays open three times, in the operator checklist on',
  '#2268, in its RELEASE comment and in its own body, then ended with',
  '`Closes #2268`. The merge closed it.',
  '',
  'Refs #2276',
].join('\n')

// (3) #2327 — the FALSE POSITIVE.
//
// Verbatim from PR #2326's body as it was when the guard failed it, recovered
// from GitHub's own edit history (`userContentEdits`, revision of
// 2026-08-31T20:35:49Z; the author then rewrote the sentence to get past the
// check, which is the workaround this fix removes). The line ticks the template's
// `Closes` option and, in the same breath, says the operator-verify option is
// NOT the one — and the guard failed the pull request BECAUSE of that denial.
// Cost: one red required check and one CI round trip on a compliant PR.
const PR_2326_ISSUE_LINK = [
  '## Issue Link',
  '',
  '- [x] `Closes #2295` — the merge closes the issue. Not operator-verify mode; no outstanding human step.',
  '',
  'Closes #2295',
].join('\n')

// ─────────────────────────────────────────────────────────────────────────────
// Positive controls. If either of these goes green the instrument has stopped
// being able to say yes, and every clean result below stops meaning anything.
// ─────────────────────────────────────────────────────────────────────────────

test('POSITIVE CONTROL: the real PR #2272 body is a violation', () => {
  const violations = findViolations({ body: PR_2272_EXCERPT })
  assert.equal(violations.length, 1)
  assert.equal(violations[0].issue, 2268)
  assert.equal(violations[0].signal, 'self-contradiction')
  assert.match(violations[0].evidence, /#2268 stays open for it/)
})

test('POSITIVE CONTROL (#2320): the real commit 7f7102ff is a violation', () => {
  // The regression that started #2320. The guard used to read only the body, so
  // this text was invisible to it while GitHub acted on it.
  const violations = findViolations({
    commits: [{ oid: '7f7102ff754f1aec62b4dc2a1c45ab8786cb70ce', message: COMMIT_7F7102FF }],
  })
  assert.equal(violations.length, 1, 'the commit message must be read')
  assert.equal(violations[0].issue, 2268)
  assert.equal(violations[0].signal, 'self-contradiction')
  // The report has to name the COMMIT, not "this pull request": on #2314 the
  // body was correct and only the commit was wrong, so a report naming the body
  // would have sent the author to rewrite the wrong surface.
  assert.match(violations[0].evidence, /^commit 7f7102ff's message says:/)
  assert.match(violations[0].evidence, /stays open/)
})

test('POSITIVE CONTROL (#2320): the same commit also fails on the label alone', () => {
  // #2268 carries `operator-verify` today (applied after #2315 created the
  // label). The primary signal must reach the commit source too, independently
  // of any sentence in it.
  const violations = findViolations({
    commits: [{ oid: '7f7102ff', message: COMMIT_7F7102FF }],
    labelsByIssue: { 2268: [OPERATOR_VERIFY_LABEL] },
  })
  assert.equal(violations.length, 1)
  assert.equal(violations[0].signal, 'label')
})

test('POSITIVE CONTROL (#2320): the body being correct does not excuse the commit', () => {
  // PR #2314's actual shape: a body that closed only its OWN issue, #2276 —
  // legitimately, with no label and no promise attached to it — and a commit
  // that closed #2268 as well. This is the exact green-CI-plus-closed-issue
  // combination the guard has to stop, and note that the body here is not
  // merely innocent, it is a passing `Closes` that the guard must keep passing.
  const violations = findViolations({
    body: 'Ships the guard.\n\nCloses #2276',
    commits: [{ oid: '7f7102ff', message: COMMIT_7F7102FF }],
  })
  assert.equal(violations.length, 1)
  assert.equal(violations[0].issue, 2268)
})

test('REGRESSION (#2327): PR #2326’s real body passes — denying the mode is not declaring it', () => {
  // The false positive. Nothing about this body asks for an issue to survive the
  // merge; it says the opposite, on the line the template invites it on.
  assert.deepEqual(parseClosingRefs(PR_2326_ISSUE_LINK), [2295])
  assert.deepEqual(
    findViolations({ body: PR_2326_ISSUE_LINK }),
    [],
    'a body declaring the mode does NOT apply must not fail the guard',
  )
  assert.deepEqual(staysOpenEvidence(PR_2326_ISSUE_LINK, 2295), [])
})

test('REGRESSION (#2327): the label still wins over any phrasing of that same body', () => {
  // The narrowing must not reach the primary signal. If #2295 really were an
  // operator-verify issue, `Closes #2295` still fails however the body reads.
  const violations = findViolations({
    body: PR_2326_ISSUE_LINK,
    labelsByIssue: { 2295: [OPERATOR_VERIFY_LABEL] },
  })
  assert.equal(violations.length, 1)
  assert.equal(violations[0].signal, 'label')
})

test('REGRESSION (#2327): naming the mode is not asserting a state, in either direction', () => {
  // The phrase `operator-verify mode` was removed from the assertion list, and
  // the asymmetry is deliberate — see the file’s negation-asymmetry block.
  // It earned nothing: a sentence that genuinely declares the mode reaches for a
  // state word too (the next assertion), and what it uniquely matched was
  // authors saying the mode does not apply.
  assert.equal(assertsStaysOpen('#5 ships in operator-verify mode.'), false)
  assert.equal(assertsStaysOpen('Not operator-verify mode; no outstanding human step.'), false)
  assert.deepEqual(findViolations({ body: '#5 ships in operator-verify mode.\n\nCloses #5' }), [])

  // …and the real declaration is still caught, because it asserts the STATE.
  assert.equal(
    findViolations({ body: '#5 stays OPEN in operator-verify mode for the checklist above.\n\nCloses #5' })
      .length,
    1,
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// The escape hatch, decided rather than implied (#2320/#2327).
// ─────────────────────────────────────────────────────────────────────────────

test('there is NO escape from the keyword — a fence or a quote does not help', () => {
  // Measured for the surfaces that matter most: `7f7102ff` wrote the keyword
  // inside a code span in a COMMIT MESSAGE — which nothing renders as Markdown —
  // purely descriptively, and #2268 closed. GitHub's BODY parse is now known to
  // behave the other way (a code span there parses as nothing — #2382, measured
  // on PR #2364; see the source's escape-hatch note), and this guard still reads
  // a fenced body keyword as live ON PURPOSE: it reads all three surfaces
  // together, and a guard that stayed quiet over a fence would be GREEN on bytes
  // GitHub acts on in the other two, which is the false-GREEN direction of the
  // defect it guards. Over-firing costs a reworded sentence.
  for (const quoted of [
    '```\nCloses #2268\n```',
    '> Closes #2268',
    'the line `Closes #2268` in its message',
    '    Closes #2268',
  ]) {
    assert.deepEqual(parseClosingRefs(quoted), [2268], `expected a closing ref in: ${quoted}`)
  }
})

test('HTML entities are NOT an escape — the regex misses them and GitHub does not', () => {
  // Measured on the pull request that shipped this change. Writing the verb as
  // `clos&#101;d #2268` left this parser reporting the body clean; GitHub
  // decoded the entity and its own `closingIssuesReferences` named #2268, so
  // the pull request was about to shut an `operator-verify` issue on merge
  // while the local parse said it was fine.
  //
  // The non-decoding is pinned as DELIBERATE, not fixed: adding an entity
  // decoder would be re-implementing more of GitHub's pipeline, and the CLI
  // already prefers GitHub's own parse for the body precisely so it does not
  // have to. Commits and the title, where the regex IS the only reading, are
  // not HTML and nothing decodes entities in them.
  const encoded = 'the commit that clos&#101;d #2268'
  assert.deepEqual(parseClosingRefs(encoded), [], 'the regex matches raw text, by design')
  assert.deepEqual(
    parseClosingRefs(encoded.replace('&#101;', 'e')),
    [2268],
    'and GitHub sees THIS — decoded — which is why the CLI asks GitHub about the body',
  )

  // The guard still fails such a body in CI, because `closingIssuesReferences`
  // is passed in as `closingRefs` and is authoritative over the local scan.
  assert.equal(
    findViolations({
      body: encoded,
      closingRefs: [2268],
      labelsByIssue: { 2268: [OPERATOR_VERIFY_LABEL] },
    }).length,
    1,
  )
})

test('the escape is to write what GitHub does not parse, and these forms do not', () => {
  // The forms the report recommends, and the ones this file, its docs and the
  // pull request that shipped it all had to use. If any of these starts
  // registering, the guard has become unusable in the pull requests that touch
  // it — including its own.
  for (const safe of [
    'Refs #2268',
    'Closes #<n>',
    'Closes #<issue>',
    '#2268 was closed a second time',
    'the closing keyword, aimed at #2268',
    'It closes issues. #2268 is one.',
  ]) {
    assert.deepEqual(parseClosingRefs(safe), [], `expected NO closing ref in: ${safe}`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// The emitters (#2320).
// ─────────────────────────────────────────────────────────────────────────────

test('every emitter whose text can reach the default branch is scanned', () => {
  const kinds = pullRequestSources({
    body: 'b',
    title: 't',
    commits: [{ oid: 'abc12345', message: 'm' }],
  }).map((s) => s.kind)
  assert.deepEqual(kinds, ['title', 'body', 'commit'])

  // Each one alone produces the reference.
  assert.deepEqual(allClosingRefs({ body: 'Closes #1' }), [1])
  assert.deepEqual(allClosingRefs({ title: 'fix: closes #2 for good' }), [2])
  assert.deepEqual(allClosingRefs({ commits: [{ oid: 'a', message: 'x\n\nCloses #3' }] }), [3])
})

test('the title is scanned because a squash makes it a commit subject on dev', () => {
  // `squash_merge_commit_title` is `COMMIT_OR_PR_TITLE`, so on a multi-commit
  // squash the pull-request title becomes the subject line of a commit on the
  // default branch — where GitHub parses it. Indirect, but an emitter.
  const violations = findViolations({
    title: 'fix(ci): resolves #42',
    body: '#42 stays open until the operator runs the live step.',
  })
  assert.equal(violations.length, 1)
  assert.equal(violations[0].issue, 42)
})

// A subject line long enough that GitHub's `messageHeadline` truncates it, with
// the closing keyword straddling the cut. 74 characters before `Closes`, so the
// 70-character boundary lands inside the keyword itself.
const STRADDLING_SUBJECT =
  'fix(ci): stop the retry loop from doubling background sync requests Closes #1234'

test('commit messages are read UNTRUNCATED — the headline+body rejoin loses keywords', () => {
  // haven-reviewer, blocking, on this change. `gh pr view --json commits` gives
  // only `messageHeadline` (cut at 70 characters, ellipsised) and `messageBody`
  // (carrying the ellipsised remainder). Rejoining them splits the subject
  // mid-token, so a keyword GitHub WILL act on disappears — a silent false
  // GREEN that no error handling catches, because the `gh` call succeeded.
  //
  // First: the defect itself, pinned. If this assertion ever flips, `gh` has
  // changed and the workaround below can be reconsidered.
  const cut = 70
  const truncated = {
    messageHeadline: `${STRADDLING_SUBJECT.slice(0, cut - 1)}…`,
    messageBody: `…${STRADDLING_SUBJECT.slice(cut - 1)}`,
  }
  const rejoined = [truncated.messageHeadline, truncated.messageBody].join('\n\n')
  assert.deepEqual(
    parseClosingRefs(rejoined),
    [],
    'the rejoin must be shown to LOSE the reference — that is why the source changed',
  )

  // Second: the source actually used. `commit { message }` over GraphQL is the
  // original bytes, and the reference survives.
  const commits = commitsFromGraphQL({
    nodes: [{ commit: { oid: 'abc1234567', message: `${STRADDLING_SUBJECT}\n\nSome body.` } }],
  })
  assert.deepEqual(commits, [
    { oid: 'abc1234567', message: `${STRADDLING_SUBJECT}\n\nSome body.` },
  ])
  assert.deepEqual(allClosingRefs({ commits }), [1234])
  assert.equal(
    findViolations({ commits, labelsByIssue: { 1234: [OPERATOR_VERIFY_LABEL] } }).length,
    1,
  )
})

test('commitsFromGraphQL survives an empty, absent or holey connection', () => {
  assert.deepEqual(commitsFromGraphQL(undefined), [])
  assert.deepEqual(commitsFromGraphQL({ nodes: [] }), [])
  assert.deepEqual(commitsFromGraphQL({ nodes: [null, { commit: null }] }), [])
  assert.deepEqual(commitsFromGraphQL({ nodes: [{ commit: { oid: 'a' } }] }), [
    { oid: 'a', message: '' },
  ])
})

test('the bare mode name being dropped is a RECORDED trade, not an oversight', () => {
  // haven-reviewer, should-fix: the file used to claim the removed phrase
  // "earned nothing". It did earn this one case, and the case is pinned here so
  // nobody re-adds the phrase believing they found a hole. In this shape the
  // `operator-verify` LABEL — which the skill requires in this mode — is the
  // only remaining signal.
  const body = '#5 ships in operator-verify mode.\n\nCloses #5'
  assert.deepEqual(findViolations({ body }), [], 'not caught by the self-contradiction signal')
  assert.equal(
    findViolations({ body, labelsByIssue: { 5: [OPERATOR_VERIFY_LABEL] } }).length,
    1,
    'and the label still catches it',
  )
})

test('refs are deduplicated across emitters and keep first-seen order', () => {
  assert.deepEqual(
    allClosingRefs({
      body: 'Closes #10\nFixes #4',
      commits: [{ oid: 'a', message: 'Closes #10' }, { oid: 'b', message: 'Closes #7' }],
    }),
    [10, 4, 7],
  )
})

test('a stays-open promise in ONE emitter binds a keyword in ANOTHER', () => {
  // The cross-source case, which is the shape #2320 produced in the wild: the
  // author declares the issue survives in one place and emits the keyword in
  // another. Neither surface is self-contradictory on its own.
  const violations = findViolations({
    body: 'Ships the code. #77 stays open for the vendor-dashboard step.',
    commits: [{ oid: 'deadbeef', message: 'feat: ship it\n\nCloses #77' }],
  })
  assert.equal(violations.length, 1)
  assert.equal(violations[0].signal, 'self-contradiction')
  assert.match(violations[0].evidence, /^this pull-request body says:/)
})

test('an ordinary pull request is untouched by the new emitters', () => {
  // Every surface populated, ordinary content, no label and no promise: silent.
  assert.deepEqual(
    findViolations({
      title: 'fix(agents): rename a variable',
      body: '## Summary\n\n- Rename a variable.\n\nCloses #1234',
      commits: [{ oid: 'c0ffee00', message: 'fix(agents): rename a variable\n\nCloses #1234' }],
    }),
    [],
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// Behaviour carried over from #2276, still pinned.
// ─────────────────────────────────────────────────────────────────────────────

test('the prescribed fix clears it — `Refs` is not a closing keyword', () => {
  assert.deepEqual(parseClosingRefs(PR_2272_FIXED), [])
  assert.deepEqual(findViolations({ body: PR_2272_FIXED }), [])
})

test('the label signal holds regardless of how the body is phrased', () => {
  const body = 'Ships the code half.\n\nCloses #99'
  assert.deepEqual(findViolations({ body }), [], 'no label, no sentence: clean')

  const violations = findViolations({ body, labelsByIssue: { 99: ['code-quality', OPERATOR_VERIFY_LABEL] } })
  assert.equal(violations.length, 1)
  assert.equal(violations[0].signal, 'label')

  // …and the same label with the non-closing reference is clean. This pair is
  // the whole claim: the label does not forbid shipping, it forbids the keyword.
  assert.deepEqual(
    findViolations({ body: 'Ships the code half.\n\nRefs #99', labelsByIssue: { 99: [OPERATOR_VERIFY_LABEL] } }),
    [],
  )
})

test('every keyword GitHub honours is caught, and nothing else is', () => {
  for (const form of [
    'Closes #7',
    'closes #7',
    'Closed #7',
    'Fix #7',
    'Fixes #7',
    'Fixed #7',
    'Resolve #7',
    'Resolves #7',
    'Resolved #7',
    'Closes: #7',
    'Closes d-hinders/Haven-AI#7',
    'Closes https://github.com/d-hinders/Haven-AI/issues/7',
  ]) {
    assert.deepEqual(parseClosingRefs(form), [7], `expected a closing ref in: ${form}`)
  }
  for (const form of ['Refs #7', 'refs #7', 'part of #7', 'See #7', 'as in #7', '#7']) {
    assert.deepEqual(parseClosingRefs(form), [], `expected NO closing ref in: ${form}`)
  }
})

test('closing refs are deduplicated and keep body order', () => {
  assert.deepEqual(parseClosingRefs('Closes #10\nFixes #4\nCloses #10'), [10, 4])
})

test('the "stays open" evidence is scoped to the line naming the issue', () => {
  // A pull request may legitimately DISCUSS operator-verify mode — this one
  // does — while closing an unrelated issue of its own. A body-wide keyword
  // scan would flag it, and a check that fires on its own documentation gets
  // muted, which is worse than no check.
  const body = [
    'Documents operator-verify mode, where #2268 stays open for an operator step.',
    '',
    'Closes #2276',
  ].join('\n')
  assert.deepEqual(staysOpenEvidence(body, 2276), [])
  assert.deepEqual(findViolations({ body }), [])

  // Move the number into that same sentence and it flips. Same file, same
  // phrase list: the discriminator is the line scope, not the wording.
  const mutated = body.replace('#2268 stays open', '#2276 stays open')
  assert.equal(findViolations({ body: mutated }).length, 1)
})

test('the phrasings a real operator-verify author reaches for all register', () => {
  for (const line of [
    'The issue #5 stays open until the operator runs it.',
    '#5 stays OPEN in operator-verify mode for the webhook checklist above.',
    'Issue #5 remains open for the live step.',
    'Leaving this issue #5 open until it is done.',
    '#5 is kept open for the dashboard step.',
    '#5 must outlive the merge.',
    'This pull request does not close #5 — an operator still has to run it.',
  ]) {
    const violations = findViolations({ body: `${line}\n\nCloses #5` })
    assert.equal(violations.length, 1, `expected a violation for: ${line}`)
  }
})

test('a HARD-WRAPPED declaration still registers (haven-reviewer, #2276)', () => {
  // Markdown wraps at ~80 columns and commit messages at 72, so the issue number
  // and the assertion often land on different physical lines. Line scoping
  // missed this, and it is the backstop signal — the one that catches an author
  // who declared the mode in writing and forgot the label, which is precisely
  // what happened on #2268. It is also what makes the real `7f7102ff` fixture
  // above register: its keyword and its "stays open" are three lines apart.
  const body = [
    'Issue #2268 will not be closed by this merge; it',
    'stays open until an operator finishes the vendor dashboard step.',
    '',
    'Closes #2268',
  ].join('\n')
  const violations = findViolations({ body })
  assert.equal(violations.length, 1)
  assert.equal(violations[0].signal, 'self-contradiction')
})

test('unwrapping never joins across a new Markdown block or a finished sentence', () => {
  // The opposite failure. Two neighbouring bullets, or two finished sentences,
  // must stay separate — otherwise a body that mentions an issue in one bullet
  // and says "stays open" about something else in the next starts failing PRs.
  const bullets = ['- ships the code for #2276', '- #2268 stays open for an operator step'].join('\n')
  assert.deepEqual(logicalLines(bullets), ['- ships the code for #2276', '- #2268 stays open for an operator step'])
  assert.deepEqual(findViolations({ body: `${bullets}\n\nCloses #2276` }), [])

  const finished = ['This closes out #2276.', 'A separate issue stays open for the operator.'].join('\n')
  assert.equal(logicalLines(finished).length, 2)
  assert.deepEqual(findViolations({ body: `${finished}\n\nCloses #2276` }), [])

  // Table rows are their own blocks too.
  const table = ['| #2276 | shipped |', '| #2268 | stays open |'].join('\n')
  assert.equal(logicalLines(table).length, 2)
  assert.deepEqual(findViolations({ body: `${table}\n\nCloses #2276` }), [])
})

test('negation is not read on the KEYWORD half — "does not close #N" still closes it', () => {
  // Neither this parser nor (as far as any of it is observable) GitHub's reads
  // the "not". Counting it is the SAFE direction: the cost of a false positive
  // here is one word changed in a pull-request body; the cost of a false zero
  // is a silently closed issue.
  //
  // This is the deliberate ASYMMETRY with the stays-open half above, which was
  // narrowed by #2327 precisely because it is a claim about intent rather than a
  // prediction of GitHub's behaviour. Do not "fix" them into agreement.
  assert.deepEqual(parseClosingRefs('This pull request does not close #5.'), [5])
})

test('a pull request with no closing keyword at all is clean, not an error', () => {
  assert.deepEqual(
    findViolations({ title: 'chore: tidy', body: 'No issue reference here.', commits: [{ oid: 'a', message: 'chore: tidy' }] }),
    [],
  )
})

test('the report names the concrete replacement and the emitter that carried it', () => {
  const bodyReport = renderReport(findViolations({ body: PR_2272_EXCERPT }))
  assert.match(bodyReport, /Closes #2268\s+->\s+Refs #2268/)
  assert.match(bodyReport, /\.agents\/skills\/ship-next\/SKILL\.md/)
  // The escape-hatch answer is in the report, not only in the source comments:
  // an author who trips this needs to be told how to write about it.
  assert.match(bodyReport, /code fence does NOT help/)

  const commitReport = renderReport(
    findViolations({ commits: [{ oid: '7f7102ff', message: COMMIT_7F7102FF }] }),
  )
  assert.match(commitReport, /commit 7f7102ff's message/)
  assert.match(commitReport, /every commit message/)
})

// ─────────────────────────────────────────────────────────────────────────────
// #2346 — the PROMOTION carve-out.
//
// Found by the 0.1.33-alpha.0 promotion, which this guard blocked on
// `Closes #2268` carried by `dfe7d8ff` — a commit that merged into `dev` days
// earlier and closed the issue then. The closure had already happened and been
// reversed; the promotion could not repeat it, because `main` is not the
// default branch. Every promotion carries historical commits by construction,
// so this was a standing block on releases rather than a one-off.
//
// The carve-out is deliberately keyed on head === default branch rather than
// base !== default branch. Those are different sets, and the difference is
// `hotfix/* → main`, whose commits have NOT reached `dev` and whose keywords
// fire for the first time on the sync-back.
// ─────────────────────────────────────────────────────────────────────────────

test('#2346: a promotion (dev → main) is recognised — its commits are already on the default branch', () => {
  assert.equal(
    isPromotion({ headRefName: 'dev', baseRefName: 'main', defaultBranch: 'dev' }),
    true,
  )
})

test('#2346: a hotfix into main is NOT a promotion — its commits reach dev later, on the sync-back', () => {
  // The case the narrower "base !== default branch" rule would have got wrong.
  // A hotfix branch is based on `main`; its keyword has never reached `dev`,
  // so it must still be scanned.
  assert.equal(
    isPromotion({ headRefName: 'hotfix/2299-sweep-floor', baseRefName: 'main', defaultBranch: 'dev' }),
    false,
  )
})

test('#2346: an ordinary feature PR into dev is NOT a promotion', () => {
  assert.equal(
    isPromotion({ headRefName: 'fix/2343-mcp-transport', baseRefName: 'dev', defaultBranch: 'dev' }),
    false,
  )
})

test('#2346: a sync-back (main → dev) is NOT a promotion — it lands ON the default branch', () => {
  // Base IS the default branch here, so keywords fire; this must stay scanned.
  assert.equal(
    isPromotion({ headRefName: 'main', baseRefName: 'dev', defaultBranch: 'dev' }),
    false,
  )
})

test('#2346: an unreadable default branch is NOT treated as a promotion — fail closed', () => {
  // If `defaultBranchRef` comes back empty the guard must keep scanning rather
  // than quietly exempt the pull request. A guard that stops looking when it
  // cannot tell is the false-GREEN direction this file exists to refuse.
  //
  // The THIRD case is the one that earns this test. Mutation-checked: dropping
  // the `Boolean(defaultBranch)` conjunct leaves the first two green, because
  // `'dev' === undefined` is already false — they pass whether the guard is
  // there or not. Only an unreadable branch on BOTH sides distinguishes them:
  // `undefined === undefined` is true, so without the conjunct a pull request
  // whose refs could not be read would be silently exempted, which is the
  // worst possible direction for this to fail.
  assert.equal(isPromotion({ headRefName: 'dev', baseRefName: 'main', defaultBranch: undefined }), false)
  assert.equal(isPromotion({ headRefName: 'dev', baseRefName: 'main', defaultBranch: '' }), false)
  assert.equal(
    isPromotion({ headRefName: undefined, baseRefName: 'main', defaultBranch: undefined }),
    false,
  )
})

test('#2346: head === base === default branch is NOT a promotion — the shape the guard exists for', () => {
  // haven-reviewer constructed this: dropping the `baseRefName !== defaultBranch`
  // conjunct left all 35 tests green, because no case exercised head and base
  // both equal to the default branch. It is reachable — `headRefName` is an
  // unqualified branch name, so a fork branch coincidentally named `dev`
  // targeting this repo's `dev` is exactly this shape. Under the mutant its
  // commits would be dropped on a merge INTO the default branch, where keywords
  // DO fire. That is the guard blinding itself on its own reason to exist.
  assert.equal(isPromotion({ headRefName: 'dev', baseRefName: 'dev', defaultBranch: 'dev' }), false)
})

test('#2346: assemblePullRequest keeps body and title on a promotion, dropping only commits', () => {
  // Closes the gap the shard previously only DECLARED. `readPullRequest` shells
  // out to `gh`, so its wiring was untestable; the assembly is now a pure
  // function, following `commitsFromGraphQL`'s precedent in this same file.
  // Without this, a mutant that blanked body and title on a promotion passed
  // the entire suite.
  const view = {
    body: 'Promote dev → main.\n\nCloses #2268',
    title: 'Promote dev → main',
    closingIssuesReferences: [],
  }
  const commits = [{ oid: 'dfe7d8ff', message: 'ci: something\n\nCloses #2268' }]

  const promoted = assemblePullRequest({ view, commits, promotion: true })
  assert.deepEqual(promoted.commits, [], 'commits are dropped on a promotion')
  assert.equal(promoted.body, view.body, 'body survives — it is new text on this pull request')
  assert.equal(promoted.title, view.title, 'title survives for the same reason')

  const ordinary = assemblePullRequest({ view, commits, promotion: false })
  assert.equal(ordinary.commits.length, 1, 'an ordinary pull request keeps its commits')
})

test('#2346: the carve-out drops ONLY the commit source — a promotion body still gets read', () => {
  // Skipping commits must not become skipping the pull request. The body and
  // title of a promotion are newly written text that no earlier merge carried,
  // so a promotion whose body closes a held-open issue is still a violation.
  const violations = findViolations({
    body: 'Promote dev → main.\n\nCloses #2268',
    title: 'Promote dev → main',
    commits: [],
    labelsByIssue: { 2268: [OPERATOR_VERIFY_LABEL] },
  })
  assert.equal(violations.length, 1)
  assert.equal(violations[0].issue, 2268)
})


// ─────────────────────────────────────────────────────────────────────────────
// The pull-request template's own placeholders (#2382).
// ─────────────────────────────────────────────────────────────────────────────

const TEMPLATE_PATH = fileURLToPath(
  new URL('../../.github/pull_request_template.md', import.meta.url),
)

test('the Issue Link checklist items write the keyword BARE', () => {
  // The placeholders used to be backticked. GitHub does not parse a closing
  // keyword inside a code span in a pull-request BODY, so an author who ticked
  // the box and replaced the placeholder in place — the natural way to fill a
  // template — shipped a body that looked right and closed nothing. Measured on
  // PR #2364: body backticked, `closingIssuesReferences` empty on the merged
  // pull request, and #2361 closed by hand 109 seconds after the merge.
  //
  // Scoped to the CHECKLIST ITEMS on purpose. The section's prose and its hidden
  // comment write ABOUT the keyword and must keep an unparsed form, so a blanket
  // assertion over the whole file would forbid the very thing that file needs.
  const template = readFileSync(TEMPLATE_PATH, 'utf8')
  const section = template.split('## Issue Link')[1]?.split('\n## ')[0]
  assert.ok(section, 'the template still has an "Issue Link" section')

  const items = section.split('\n').filter((line) => /^- \[[ x]\] /.test(line))
  assert.equal(items.length, 2, `expected the Closes and Refs items, got ${items.length}`)
  for (const item of items) {
    assert.match(
      item,
      /^- \[[ x]\] (?:Closes|Refs) #NNN\b/,
      `the keyword must be bare — no backticks, no code span — in: ${item}`,
    )
    // And the placeholder must SURVIVE rendering. Taking the keyword out of its
    // code span exposed the token to GitHub-flavoured Markdown, which strips
    // `<n>` as an unrecognised inline HTML tag — an unfilled line rendered as
    // "Closes #", placeholder and all. Measured against `gh api /markdown` in
    // mode `gfm`. `NNN` has nothing for GFM to misparse; anything in angle
    // brackets does, so the token must not contain them.
    assert.doesNotMatch(
      item,
      /#\s*<[^>]*>/,
      `an angle-bracket placeholder is stripped by GFM once the keyword is bare: ${item}`,
    )
  }
})

test('the template as shipped closes nothing, and closes the issue once filled in', () => {
  // Both halves matter. An UNFILLED template is pasted into every pull request
  // body in the repository, so its placeholder must stay inert; and the point of
  // the change is that filling it in place now actually parses.
  const template = readFileSync(TEMPLATE_PATH, 'utf8')
  assert.deepEqual(parseClosingRefs(template), [], 'an unfilled template must name no issue')
  assert.deepEqual(
    parseClosingRefs(template.replace('- [ ] Closes #NNN', '- [x] Closes #2382')),
    [2382],
    'filling the placeholder in place must produce a real closing reference',
  )
})
