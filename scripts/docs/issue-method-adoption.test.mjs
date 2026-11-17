// The adoption of the Method-block runner in `new-task` and `review-issue`
// (#4799): what the skills, the templates and the verdict contract document
// must stay readable by `scripts/docs/issue-method.mjs` and by the registered
// re-measurement.
//
// Grammar only. CI's depth-1 checkout cannot run a checkable line against
// history, and the example's paths are illustrative, so nothing here starts
// `git`. What it does prove: the documented syntax is the syntax the runner
// parses, and the documented verdict lines are the lines the instrument reads.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { extractMethodLines, parseCheckableLine } from './issue-method.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (path) => readFileSync(join(REPO_ROOT, path), 'utf8')
/** Prose is matched with its line wraps collapsed, so a reflow is not a failure. */
const flat = (text) => text.replace(/\n> ?/g, '\n').replace(/\s+/g, ' ')

const NEW_TASK = read('.agents/skills/new-task/SKILL.md')
const REVIEW_ISSUE = read('.agents/skills/review-issue/SKILL.md')
const RUBRIC = read('.agents/skills/review-issue/references/review-rubric.md')
const COMMENTING = read('.agents/skills/review-issue/references/github-commenting.md')
const TEMPLATES = ['.github/ISSUE_TEMPLATE/loop-task.md', '.github/ISSUE_TEMPLATE/loop-epic.md']

/**
 * The example issue body inside `new-task`'s ````markdown fence. The fence is
 * cut out here, by hand: `extractMethodLines` on the skill file itself returns
 * nothing, because the example's `## Method` is text inside a fence.
 */
export function exampleBody(skill) {
  const blocks = [...skill.matchAll(/^````markdown\n([\s\S]*?)\n````$/gm)].map((m) => m[1])
  return blocks.filter((b) => /^## Method$/m.test(b))
}

describe('new-task’s example Method block', () => {
  const bodies = exampleBody(NEW_TASK)

  it('is found: exactly one ````markdown block with a Method heading', () => {
    assert.equal(bodies.length, 1)
    assert.deepEqual(extractMethodLines(NEW_TASK), [], 'the skill file itself now has a readable Method block; this test reads the wrong thing')
  })

  const lines = bodies.length === 1 ? extractMethodLines(bodies[0]) : []
  const checkable = lines.filter((l) => l.checkable)

  it('has checkable lines and at least one free-form line', () => {
    assert.ok(checkable.length >= 4, `only ${checkable.length} checkable lines`)
    assert.ok(lines.some((l) => !l.checkable && !l.text.trim().startsWith('#')), 'no free-form command line')
  })

  it('parses, every line, by the runner’s own grammar', () => {
    for (const line of checkable) {
      assert.doesNotThrow(() => parseCheckableLine(line.text), `refused by the runner: ${line.text}`)
    }
  })

  it('shows each of the three kinds', () => {
    const kinds = new Set(checkable.map((l) => parseCheckableLine(l.text).command.kind))
    assert.ok(kinds.has('grep-lines') || kinds.has('grep-files'), 'no git grep count')
    assert.ok(kinds.has('show'), 'no git show range')
    assert.ok(kinds.has('ls-tree'), 'no git ls-tree existence')
  })

  it('shows a zero, and every zero names a control that is a line in the block, over its SHA and pathspecs', () => {
    const parsed = checkable.map((l) => parseCheckableLine(l.text))
    const controlLines = parsed.filter((p) => p.expectation.type === 'control')
    const controls = new Map(controlLines.map((p) => [p.expectation.name, p.command]))
    // The runner refuses a control name used twice, and every zero that cites it.
    assert.equal(controls.size, controlLines.length, 'a control name is used twice in the example')
    const zeros = parsed.filter((p) => p.expectation.type === 'count' && p.expectation.expected === 0)
    assert.ok(zeros.length >= 1, 'the example shows no zero')
    for (const zero of zeros) {
      const control = controls.get(zero.expectation.control)
      assert.ok(control, `the zero names control "${zero.expectation.control}", which is not a line in the block`)
      assert.equal(control.sha, zero.command.sha)
      assert.deepEqual(control.pathspecs, zero.command.pathspecs)
    }
  })

  it('writes every SHA in hex', () => {
    for (const line of lines) assert.doesNotMatch(line.text, /\$\{?SHA/, line.text)
  })
})

describe('where the skills tell a filer and a reviewer to run the runner', () => {
  it('new-task: the three kinds in step 1, and the run on the draft before the create call', () => {
    assert.ok(flat(NEW_TASK).includes('**A claim a command can re-check is written so that it can (#4799).**'))
    const step6 = NEW_TASK.indexOf('\n6. **Run the runner on the draft')
    const step7 = NEW_TASK.indexOf('\n7. Apply every inferred')
    assert.ok(step6 > NEW_TASK.indexOf('\n5. Check GitHub') && step6 < step7, 'the run is not between steps 5 and 7')
    const text = flat(NEW_TASK.slice(step6, step7))
    assert.ok(text.includes('`node scripts/docs/issue-method.mjs --body-file <draft>`'), 'step 6 lost the command')
    assert.ok(text.includes('Do not create the issue while any line is `differs`, `refused` or `unproven zero`'), 'step 6 lost the refusal to file')
    assert.ok(text.indexOf('--body-file <draft>') < text.indexOf('Then create the issue'), 'the run comes after the create call')
  })

  it('review-issue: the fixed brief, the rubric and the section all start with the runner', () => {
    const brief = flat(/^> Work through[\s\S]*?\n\n/m.exec(REVIEW_ISSUE)?.[0] ?? '')
    assert.ok(brief.includes('Start by running `node scripts/docs/issue-method.mjs --body-file <snapshot>` on each body and paste its output.'), 'the fixed brief lost the runner')
    assert.match(REVIEW_ISSUE, /^## The runner \(#4799\)$/m)
    const section = flat(/^## The runner \(#4799\)\n([\s\S]*?)^## /m.exec(REVIEW_ISSUE)?.[1] ?? '')
    for (const needle of [
      "**The root's `origin/dev` must be GitHub's ref.**",
      'dev:refs/remotes/origin/dev',
      '**`differs` is a wrong claim.**',
      '**A claim left free-form that fits one of the three kinds is a should-fix finding**',
    ]) {
      assert.ok(section.includes(needle), `§ The runner lost: ${needle}`)
    }
    const first = flat(/^## 1\. Measured claims\n\n([\s\S]*?)\n\n/m.exec(RUBRIC)?.[1] ?? '')
    assert.ok(first.startsWith('**Start with the runner (#4799).** Run `node scripts/docs/issue-method.mjs --body-file <snapshot>`'), 'rubric § 1 does not start with the runner')
  })

  it('the templates have a Method section and no fence under it for the runner to read', () => {
    for (const path of TEMPLATES) {
      const template = read(path)
      assert.match(template, /^## Method$/m, path)
      assert.match(template, /scripts\/docs\/issue-method\.mjs/, path)
      assert.deepEqual(extractMethodLines(template), [], `${path}: a fence under ## Method would be live lines in every issue filed from it`)
    }
  })

  it('nothing still says the runner is not wired in', () => {
    for (const path of ['docs/contributing/docs-quality-system.md', 'scripts/docs/issue-method.mjs']) {
      assert.doesNotMatch(read(path), /Not wired into|calls it yet|adoption is a later slice/, path)
    }
  })
})

describe('the verdict contract', () => {
  // The patterns the two registered instruments use, as written in review-issue/SKILL.md.
  const CORRECTIONS = /Corrections: ([0-9]+)/g
  const CLAIMS = /Claims: ([0-9]+) checked, ([0-9]+) wrong/g
  const RUNNER = /Runner: ([0-9]+) checkable/g
  const last = (text, re) => [...text.matchAll(re)].at(-1)

  it('review-issue defines the three closing lines in order', () => {
    const order = 'ends with three lines, in this order: `Claims: <checked> checked, <wrong> wrong.`, `Runner: <checkable> checkable, <failed> not reproducing.`, `Corrections: <n>.`'
    assert.ok(flat(REVIEW_ISSUE).includes(order), 'review-issue lost the order of the closing lines')
    assert.ok(flat(COMMENTING).includes(order.replace('ends with', '**ends** with').replace('order: ', 'order: ')), 'github-commenting.md states another order')
    assert.ok(flat(REVIEW_ISSUE).includes('**`Claims` counts claims, not lines**'))
  })

  it('the instruments’ patterns in the skill are the ones tested here', () => {
    assert.ok(REVIEW_ISSUE.includes('scan("Corrections: ([0-9]+)")'))
    assert.ok(REVIEW_ISSUE.includes('scan("Claims: ([0-9]+) checked, ([0-9]+) wrong")'))
    assert.ok(REVIEW_ISSUE.includes('scan("Runner: ([0-9]+) checkable")'))
  })

  it('the documented verdict shape ends with the three lines, and both instruments read it', () => {
    const shape = /````markdown\n(Spec-review verdict on[\s\S]*?)\n````/.exec(COMMENTING)?.[1]
    assert.ok(shape, 'no verdict shape in github-commenting.md')
    assert.deepEqual(shape.split('\n').slice(-3), ['Claims: 9 checked, 1 wrong.', 'Runner: 4 checkable, 0 not reproducing.', 'Corrections: 1.'])
    assert.equal(last(shape, CORRECTIONS)[1], '1')
    assert.deepEqual(last(shape, CLAIMS).slice(1, 3), ['9', '1'])
    assert.equal(last(shape, RUNNER)[1], '4')
    assert.match(shape, /^Spec-review verdict/)
  })

  it('the re-measurement is registered with its window, population, both arms and the baseline', () => {
    const raw = /^## Re-measure: checkable Method lines \(registered 2026-11-10, #4799\)\n([\s\S]*?)^## /m.exec(REVIEW_ISSUE)?.[1]
    assert.ok(raw, 'no registered re-measurement for #4799')
    const section = flat(raw)
    for (const needle of ['**Window:**', '**Population:**', '**Followed:**', '**Moved:**', '**Decision rule:**', '**Instrument**', 'Fewer than **1 in 2**', 'fewer than 8 verdicts', 'At or above **2.25**', '27 wrong in 12']) {
      assert.ok(section.includes(needle), `the registration lost: ${needle}`)
    }
  })

  it('the instrument keeps the parts that define the figure: first verdict per issue, the window, the followed test', () => {
    const raw = /^## Re-measure: checkable Method lines \(registered 2026-11-10, #4799\)\n([\s\S]*?)^## /m.exec(REVIEW_ISSUE)?.[1] ?? ''
    const instrument = /```bash\n([\s\S]*?)\n```/.exec(raw)?.[1]
    assert.ok(instrument, 'no instrument block')
    for (const needle of [
      "awk -F'\\t' '!seen[$1]++'", // the earliest verdict on each issue
      'sort -t "$(printf \'\\t\')" -k1,1 -k2,2', // …earliest by created_at
      "created=$(gh api \"$url\" --jq '.created_at[0:10]')", // the window is the issue's creation date
      '"$FROM" "$created" | sort | head -1)" = "$FROM" ]', // created on or after FROM
      '[ "$created" != "$END" ]', // END itself is out
      '"$created" "$END" | sort | head -1)" = "$created" ]', // created before END
      'if ($1 != "missing" && $1 > 0) f++', // followed: at least one checkable line
      'if ($3 == "missing") m++; else {v++; w += $3; k += $2}', // a verdict with no Claims line is left out
    ]) {
      assert.ok(instrument.includes(needle), `the instrument lost: ${needle}`)
    }
  })
})
