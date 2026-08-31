import test from 'node:test'
import assert from 'node:assert/strict'
import {
  OPERATOR_VERIFY_LABEL,
  findViolations,
  logicalLines,
  parseClosingRefs,
  renderReport,
  staysOpenEvidence,
} from './operator-verify-close-guard.mjs'

// The case this guard exists for, quoted VERBATIM from the body of PR #2272 as
// it merged on 2026-08-31 (`gh pr view 2272 --json body`). Two lines out of a
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

test('POSITIVE CONTROL: the real PR #2272 body is a violation', () => {
  // If this ever goes green the instrument has stopped being able to say yes,
  // and every clean result below stops meaning anything.
  const violations = findViolations({ body: PR_2272_EXCERPT })
  assert.equal(violations.length, 1)
  assert.equal(violations[0].issue, 2268)
  assert.equal(violations[0].signal, 'self-contradiction')
  assert.match(violations[0].evidence, /#2268 stays open for it/)
})

test('the prescribed fix clears it — `Refs` is not a closing keyword', () => {
  assert.deepEqual(parseClosingRefs(PR_2272_FIXED), [])
  assert.deepEqual(findViolations({ body: PR_2272_FIXED }), [])
})

test('an ordinary pull request is untouched — `Closes` stays the default', () => {
  const body = [
    '## Summary',
    '',
    '- Rename a variable.',
    '',
    'Closes #1234',
  ].join('\n')
  assert.deepEqual(parseClosingRefs(body), [1234])
  assert.deepEqual(findViolations({ body }), [])
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
    '#5 ships in operator-verify mode.',
  ]) {
    const violations = findViolations({ body: `${line}\n\nCloses #5` })
    assert.equal(violations.length, 1, `expected a violation for: ${line}`)
  }
})

test('a HARD-WRAPPED declaration still registers (haven-reviewer, #2276)', () => {
  // Markdown wraps at ~80 columns, so the issue number and the assertion often
  // land on different physical lines. Line scoping missed this, and it is the
  // backstop signal — the one that catches an author who declared the mode in
  // writing and forgot the label, which is precisely what happened on #2268.
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

test('negation is not read — "does not close #N" still counts as a closing ref', () => {
  // Neither this parser nor (as far as any of it is observable) GitHub's reads
  // the "not". Counting it is the SAFE direction: the cost of a false positive
  // here is one word changed in a pull-request body; the cost of a false zero
  // is a silently closed issue.
  assert.deepEqual(parseClosingRefs('This pull request does not close #5.'), [5])
})

test('a body with no closing keyword at all is clean, not an error', () => {
  assert.deepEqual(findViolations({ body: 'No issue reference here.' }), [])
})

test('the report names the concrete replacement, not just the prohibition', () => {
  const report = renderReport(findViolations({ body: PR_2272_EXCERPT }))
  assert.match(report, /Closes #2268\s+->\s+Refs #2268/)
  assert.match(report, /\.agents\/skills\/ship-next\/SKILL\.md/)
})
