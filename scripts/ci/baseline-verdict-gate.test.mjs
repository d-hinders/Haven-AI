// Tests for the baseline change gate (`baseline-verdict-gate.mjs`, #3232).
// Run with: node --test scripts/ci/baseline-verdict-gate.test.mjs
// (also collected by the `ci_config_checks` job's `scripts/ci/*.test.mjs` glob)
//
// The four acceptance fixtures the issue pins are in `evaluate` below:
//   1. a MODIFIED baseline with no declaration            → fail
//   2. declared but NO design-review verdict              → fail
//   3. both                                               → pass
//   4. no PNG changed                                     → pass, count printed
// Each gating branch is mutation-proven at the bottom of this file: the
// source is mutated in one place, imported fresh, and the SAME fixture that
// failed the real code must pass the mutant (or the branch is not the thing
// that fires). An assertion without its mutation is a guess about which line
// made the difference.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFileSync, readdirSync } from 'node:fs'
import {
  evaluate,
  parseDeclarations,
  parseVerdicts,
  parseNameList,
  baselineName,
  verifiedFor,
  declaredFor,
  listHasGlob,
  collect,
  MIN_REASON_CHARS,
  BASELINE_DIR,
} from './baseline-verdict-gate.mjs'

const CLI = fileURLToPath(new URL('./baseline-verdict-gate.mjs', import.meta.url))

const PNG = `${BASELINE_DIR}/design-system/topbar-desktop.png`
const PNG2 = `${BASELINE_DIR}/design-system/sidebar-desktop.png`

// A always-true ancestry relation: "a is an ancestor of (or equal to) b".
// The binding rule itself is exercised with bespoke relations below.
const ancestorOk = () => true
// An always-false one, for the fail-closed and too-old-sha cases.
const ancestorNever = () => false

const modifiedFile = (path = PNG) => ({ path, status: 'modified' })
const addedFile = (path = PNG) => ({ path, status: 'added' })

const DECL = `baseline-change: topbar-desktop.png -- sidebar copy moved 4px under the new label truncation rule`
const VERDICT = 'design-review verdict: passed @ abc1234 -- baselines: topbar-desktop.png'

describe('baselineName / parseNameList', () => {
  test('base name is the last path segment', () => {
    assert.equal(baselineName(PNG), 'topbar-desktop.png')
  })

  test('names: spaces and commas, paths, missing .png, deduped', () => {
    assert.deepEqual(
      parseNameList('a/b/topbar-desktop.png, sidebar-desktop.png topbar-desktop mobile'),
      ['topbar-desktop.png', 'sidebar-desktop.png', 'mobile.png'],
    )
  })

  test('`*` survives as the wildcard, alone or in a list', () => {
    assert.deepEqual(parseNameList('*'), ['*'])
    assert.deepEqual(parseNameList('a.png *'), ['a.png', '*'])
  })
})

describe('parseDeclarations', () => {
  test('parses names before the separator and the reason after it', () => {
    const [d] = parseDeclarations([`- ${DECL}`])
    assert.deepEqual(d.names, ['topbar-desktop.png'])
    assert.equal(d.reason, 'sidebar copy moved 4px under the new label truncation rule')
  })

  test('em-dash separator works', () => {
    const [d] = parseDeclarations(['baseline-change: a.png — font bump moved every render at once, re-blessed under the new metrics'])
    assert.deepEqual(d.names, ['a.png'])
    assert.ok(d.reason.length >= MIN_REASON_CHARS)
  })

  test('a line without the `--` separator is not a declaration', () => {
    assert.deepEqual(parseDeclarations(['baseline-change: topbar-desktop.png']), [])
  })

  test('body and commit messages are both read, in order', () => {
    const ds = parseDeclarations(['', `chore: regen\nbaseline-change: a.png -- one reason long enough to count as substance`])
    assert.equal(ds.length, 1)
    assert.deepEqual(ds[0].names, ['a.png'])
  })

  test('empty input yields nothing', () => {
    assert.deepEqual(parseDeclarations([]), [])
    assert.deepEqual(parseDeclarations([null, '']), [])
  })
})

describe('parseVerdicts', () => {
  test('passing word, sha, and names after the baselines marker', () => {
    const [v] = parseVerdicts([VERDICT])
    assert.deepEqual(v.names, ['topbar-desktop.png'])
    assert.equal(v.sha, 'abc1234')
    assert.equal(v.passing, true)
  })

  test('`skipped` and `n/a` are not passing verdicts', () => {
    for (const word of ['skipped', 'n/a', 'blocked']) {
      const [v] = parseVerdicts([`design-review verdict: ${word} @ abc1234 -- baselines: topbar-desktop.png`])
      assert.equal(v.passing, false, word)
    }
  })

  test('case-insensitive; `Passed @ SHA` reads the same', () => {
    const [v] = parseVerdicts(['Design-review verdict: Passed @ AbC1234 -- baselines: topbar-desktop.png'])
    assert.equal(v.passing, true)
    assert.equal(v.sha, 'AbC1234')
  })

  test('a verdict posted as a comment (the #2816 shape) is read the same', () => {
    const [v] = parseVerdicts(['', 'rendered pass looks right.\n\ndesign-review verdict: passed @ abc1234 -- baselines: topbar-desktop.png\n'])
    assert.equal(v.passing, true)
    assert.deepEqual(v.names, ['topbar-desktop.png'])
  })

  test('(C) the verdict word is the WHOLE head before the first `@`, `--` or `baselines:`, never a substring (#3301)', () => {
    for (const line of [
      'design-review verdict: not approved @ abc1234 -- baselines: topbar-desktop.png',
      'design-review verdict: unapproved @ abc1234 -- baselines: topbar-desktop.png',
      'design-review verdict: passed-with-nits @ abc1234 -- baselines: topbar-desktop.png',
      'design-review verdict: blocked -- was passed before @ abc1234 -- baselines: topbar-desktop.png',
      'design-review verdict: changes requested @ abc1234 -- baselines: approved-mock.png',
    ]) {
      assert.equal(parseVerdicts([line])[0].passing, false, line)
    }
    for (const word of ['passed', 'approved', 'Approved', '**passed**']) {
      assert.equal(parseVerdicts([`design-review verdict: ${word} @ abc1234 -- baselines: a.png`])[0].passing, true, word)
    }
  })

  test('a line without the `baselines:` marker never reads the verdict word as a name', () => {
    const [v] = parseVerdicts(['design-review verdict: not approved @ abc1234 topbar-desktop.png'])
    assert.deepEqual(v.names, ['topbar-desktop.png'])
    assert.equal(v.passing, false)
    const [w] = parseVerdicts(['design-review verdict: passed -- topbar-desktop.png'])
    assert.deepEqual(w.names, ['topbar-desktop.png'])
    assert.equal(w.passing, true)
  })

  test('no sha → null, and the gate must treat it as unbindable (asserted below)', () => {
    const [v] = parseVerdicts(['design-review verdict: passed -- baselines: topbar-desktop.png'])
    assert.equal(v.sha, null)
  })
})

describe('evaluate — the four acceptance fixtures', () => {
  test('1. modified PNG with no declaration → fail', () => {
    const r = evaluate({
      pr: { number: 1, base: 'dev', defaultBranch: 'dev', headSha: 'h1' },
      files: [modifiedFile()],
      declarationTexts: [''],
      verdictTexts: [''],
      lastTouch: { [PNG]: 't1' },
      isAncestor: ancestorOk,
    })
    assert.equal(r.verdict, 'fail')
    assert.equal(r.missing.length, 1)
    assert.equal(r.missing[0].declared, false)
    assert.equal(r.missing[0].verified, false)
    assert.match(r.report, new RegExp(PNG.replace(/\//g, '\\/')))
    assert.match(r.report, /baseline-change:/)
    assert.match(r.report, /design-review verdict:/)
    assert.match(r.report, /read 1 changed baseline PNG\(s\): 1 modified, 0 added/)
  })

  test('2. declared but no verdict → fail', () => {
    const r = evaluate({
      pr: { number: 1, base: 'dev', defaultBranch: 'dev', headSha: 'h1' },
      files: [modifiedFile()],
      declarationTexts: [DECL],
      verdictTexts: [''],
      lastTouch: { [PNG]: 't1' },
      isAncestor: ancestorOk,
    })
    assert.equal(r.verdict, 'fail')
    assert.equal(r.missing[0].declared, true)
    assert.equal(r.missing[0].verified, false)
  })

  test('2b. a SHORT reason is not a declaration', () => {
    const r = evaluate({
      pr: { number: 1, base: 'dev', defaultBranch: 'dev', headSha: 'h1' },
      files: [modifiedFile()],
      declarationTexts: ['baseline-change: topbar-desktop.png -- looks fine'],
      verdictTexts: [VERDICT],
      lastTouch: { [PNG]: 't1' },
      isAncestor: ancestorOk,
    })
    assert.equal(r.verdict, 'fail')
    assert.equal(r.missing[0].declared, false)
  })

  test('3. both → pass, and the provenance limit is printed', () => {
    const r = evaluate({
      pr: { number: 1, base: 'dev', defaultBranch: 'dev', headSha: 'h1' },
      files: [modifiedFile()],
      declarationTexts: [DECL],
      verdictTexts: [VERDICT],
      lastTouch: { [PNG]: 't1' },
      isAncestor: ancestorOk,
    })
    assert.equal(r.verdict, 'pass')
    assert.match(r.report, /every modified baseline carries a declared reason and a verified design-review verdict/)
    assert.match(r.report, /checks that the declaration lines EXIST, not who wrote them/)
  })

  test('4. no PNG changed → pass, with the count printed', () => {
    const r = evaluate({
      pr: { number: 1, base: 'dev', defaultBranch: 'dev', headSha: 'h1' },
      files: [{ path: 'packages/frontend/src/app/page.tsx', status: 'modified' }],
      declarationTexts: [''],
      verdictTexts: [''],
      lastTouch: {},
      isAncestor: ancestorOk,
    })
    assert.equal(r.verdict, 'pass')
    assert.match(r.report, /read 0 changed baseline PNG\(s\): 0 modified, 0 added/)
  })

  test('the count covers added baselines too', () => {
    const r = evaluate({
      pr: { number: 1, base: 'dev', defaultBranch: 'dev', headSha: 'h1' },
      files: [modifiedFile(), addedFile(PNG2)],
      declarationTexts: [DECL, `baseline-change: ${PNG2} -- new screen, first committed capture of the sidebar states`],
      verdictTexts: [VERDICT],
      lastTouch: { [PNG]: 't1' },
      isAncestor: ancestorOk,
    })
    assert.equal(r.verdict, 'pass')
    assert.match(r.report, /read 2 changed baseline PNG\(s\): 1 modified, 1 added/)
  })
})

describe('evaluate — added / removed scope', () => {
  test('an ADDED baseline needs the declaration only — no verdict required', () => {
    const r = evaluate({
      pr: { number: 1, base: 'dev', defaultBranch: 'dev', headSha: 'h1' },
      files: [addedFile()],
      declarationTexts: [DECL],
      verdictTexts: [''],
      lastTouch: {},
      isAncestor: ancestorOk,
    })
    assert.equal(r.verdict, 'pass')
  })

  test('an ADDED baseline without a declaration fails', () => {
    const r = evaluate({
      pr: { number: 1, base: 'dev', defaultBranch: 'dev', headSha: 'h1' },
      files: [addedFile()],
      declarationTexts: [''],
      verdictTexts: [VERDICT],
      lastTouch: {},
      isAncestor: ancestorOk,
    })
    assert.equal(r.verdict, 'fail')
    assert.equal(r.missing[0].needsVerdict, false)
  })

  test('a RENAMED baseline is treated as added (path move, no prior pixels at the new path)', () => {
    const r = evaluate({
      pr: { number: 1, base: 'dev', defaultBranch: 'dev', headSha: 'h1' },
      files: [{ path: PNG, status: 'renamed' }],
      declarationTexts: [DECL],
      verdictTexts: [''],
      lastTouch: {},
      isAncestor: ancestorOk,
    })
    assert.equal(r.verdict, 'pass')
  })

  test('a REMOVED baseline is out of scope (#3232)', () => {
    const r = evaluate({
      pr: { number: 1, base: 'dev', defaultBranch: 'dev', headSha: 'h1' },
      files: [{ path: PNG, status: 'removed' }],
      declarationTexts: [''],
      verdictTexts: [''],
      lastTouch: {},
      isAncestor: ancestorOk,
    })
    assert.equal(r.verdict, 'pass')
    assert.match(r.report, /read 0 changed baseline PNG\(s\)/)
  })
})

describe('evaluate — the sha binding (#3222 shape)', () => {
  test('a verdict naming a commit OLDER than the last touch does not verify', () => {
    // The review happened, then the baseline was re-committed: lastTouch (the
    // re-commit) is NOT an ancestor of the verdict sha.
    const r = evaluate({
      pr: { number: 1, base: 'dev', defaultBranch: 'dev', headSha: 'h1' },
      files: [modifiedFile()],
      declarationTexts: [DECL],
      verdictTexts: [VERDICT],
      lastTouch: { [PNG]: 't1' },
      isAncestor: ancestorNever,
    })
    assert.equal(r.verdict, 'fail')
    assert.equal(r.missing[0].verified, false)
  })

  test('a verdict with NO sha is unbindable and does not verify', () => {
    const r = evaluate({
      pr: { number: 1, base: 'dev', defaultBranch: 'dev', headSha: 'h1' },
      files: [modifiedFile()],
      declarationTexts: [DECL],
      verdictTexts: ['design-review verdict: passed -- baselines: topbar-desktop.png'],
      lastTouch: { [PNG]: 't1' },
      isAncestor: ancestorOk,
    })
    assert.equal(r.verdict, 'fail')
  })

  test('an unreadable last-touch sha fails closed', () => {
    const r = evaluate({
      pr: { number: 1, base: 'dev', defaultBranch: 'dev', headSha: 'h1' },
      files: [modifiedFile()],
      declarationTexts: [DECL],
      verdictTexts: [VERDICT],
      lastTouch: { [PNG]: null },
      isAncestor: ancestorOk,
    })
    assert.equal(r.verdict, 'fail')
    assert.match(r.report, /sha binding could not be read — fail closed/)
  })

  test('equal shas verify (ancestor-or-equal, both ends)', () => {
    // A real chain: aa00000 (last touch) ≤ bb00000 (head), and the verdict
    // names the last-touch sha itself. Shas are hex — the gate binds 7+ hex
    // chars after `@`, so a non-hex token is unbindable by construction.
    const rank = { aa00000: 1, bb00000: 2 }
    const at = (a, b) => (rank[a] ?? -1) <= (rank[b] ?? 99) ? true : false
    const r = evaluate({
      pr: { number: 1, base: 'dev', defaultBranch: 'dev', headSha: 'bb00000' },
      files: [modifiedFile()],
      declarationTexts: [DECL],
      verdictTexts: ['design-review verdict: passed @ aa00000 -- baselines: topbar-desktop.png'],
      lastTouch: { [PNG]: 'aa00000' },
      isAncestor: at,
    })
    assert.equal(r.verdict, 'pass')
  })

  test('a verdict naming a commit NEWER than the head does not verify', () => {
    // Hex shas, so the verdict IS bindable and the head check is what refuses
    // it (#3301: the earlier `@ future` was not hex, parsed as sha null, and
    // was skipped as unbindable — the test passed with the head check deleted;
    // M10 below now proves the head check is what fires).
    const at = (a, b) => (a === 'aa00000' && b === 'ff00000' ? true : false) // touch ≤ verdict, but verdict ≰ head
    const r = evaluate({
      pr: { number: 1, base: 'dev', defaultBranch: 'dev', headSha: 'cc00000' },
      files: [modifiedFile()],
      declarationTexts: [DECL],
      verdictTexts: ['design-review verdict: passed @ ff00000 -- baselines: topbar-desktop.png'],
      lastTouch: { [PNG]: 'aa00000' },
      isAncestor: at,
    })
    assert.equal(parseVerdicts(['design-review verdict: passed @ ff00000'])[0].sha, 'ff00000')
    assert.equal(r.verdict, 'fail')
  })
})

describe('verifiedFor — conflicting verdicts (#3301)', () => {
  // A linear history: aa (last touch) < bb < cc < dd (head). `rank` is the
  // ancestry relation "a is an ancestor of (or equal to) b" on that chain.
  const rank = { aa00000: 1, bb00000: 2, cc00000: 3, dd00000: 4 }
  const chain = (a, b) => (a in rank && b in rank ? rank[a] <= rank[b] : null)
  const ctx = { lastTouchSha: 'aa00000', headSha: 'dd00000', isAncestor: chain }
  const v = (line) => parseVerdicts([`design-review verdict: ${line}`])[0]

  test('(A) a later block cancels an earlier pass', () => {
    const vs = [v('passed @ bb00000 -- baselines: a.png'), v('changes requested @ cc00000 -- baselines: a.png')]
    assert.equal(verifiedFor('a.png', vs, ctx), false)
  })

  test('(A) text order does not matter — the block still wins when it comes first', () => {
    const vs = [v('changes requested @ cc00000 -- baselines: a.png'), v('passed @ bb00000 -- baselines: a.png')]
    assert.equal(verifiedFor('a.png', vs, ctx), false)
  })

  test('(A) a tie vetoes: pass and block at the same sha', () => {
    const vs = [v('passed @ cc00000 -- baselines: a.png'), v('changes requested @ cc00000 -- baselines: a.png')]
    assert.equal(verifiedFor('a.png', vs, ctx), false)
  })

  test('a re-review clears an earlier block: block @ bb, then pass @ cc', () => {
    const vs = [v('changes requested @ bb00000 -- baselines: a.png'), v('passed @ cc00000 -- baselines: a.png')]
    assert.equal(verifiedFor('a.png', vs, ctx), true)
  })

  test('(B) a named block beats a `*` pass for that name, and only that name', () => {
    const vs = [v('passed @ cc00000 -- baselines: *'), v('changes requested @ cc00000 -- baselines: a.png')]
    assert.equal(verifiedFor('a.png', vs, ctx), false)
    assert.equal(verifiedFor('b.png', vs, ctx), true)
  })

  test('(B) a `*` pass never clears a block that names the file, even when newer', () => {
    const vs = [v('changes requested @ bb00000 -- baselines: a.png'), v('passed @ cc00000 -- baselines: *')]
    assert.equal(verifiedFor('a.png', vs, ctx), false)
    assert.equal(verifiedFor('b.png', vs, ctx), true)
  })

  test('a NEWER `*` block vetoes an older named pass (fail closed)', () => {
    const vs = [v('changes requested @ cc00000 -- baselines: *'), v('passed @ bb00000 -- baselines: a.png')]
    assert.equal(verifiedFor('a.png', vs, ctx), false)
  })

  test('a newer named pass clears an older `*` block; a newer `*` pass clears an older `*` block', () => {
    assert.equal(verifiedFor('a.png', [v('changes requested @ bb00000 -- baselines: *'), v('passed @ cc00000 -- baselines: a.png')], ctx), true)
    assert.equal(verifiedFor('a.png', [v('changes requested @ bb00000 -- baselines: *'), v('passed @ cc00000 -- baselines: *')], ctx), true)
  })

  test('a block naming the file in markdown (`a.png`, (a.png), a.png., **a.png**) names the same file', () => {
    for (const nm of ['`a.png`', '(a.png)', 'a.png.', '**a.png**', '`a`']) {
      const vs = [v('passed @ bb00000 -- baselines: a.png'), v(`changes requested @ cc00000 -- baselines: ${nm}`)]
      assert.equal(verifiedFor('a.png', vs, ctx), false, nm)
    }
    assert.deepEqual(parseNameList('`*`'), ['*'])
    for (const star of ['*.', '(*).', '`*`.']) assert.deepEqual(parseNameList(star), ['*'], star)
    assert.deepEqual(parseNameList('[a.png](https://x/y.png), A.PNG'), ['a.png'])
  })

  test('a `*.` block, a case-variant name and a linked name all still block', () => {
    for (const nm of ['*.', 'A.PNG', '[a.png](https://example.com/a.png)']) {
      const vs = [v('passed @ bb00000 -- baselines: a.png'), v(`changes requested @ cc00000 -- baselines: ${nm}`)]
      assert.equal(verifiedFor('a.png', vs, ctx), false, nm)
    }
  })

  test('a block in a quote, a numbered list or with a bold label is still read', () => {
    for (const prefix of ['**design-review verdict:**', '> design-review verdict:', '1. design-review verdict:', '> - design-review verdict:', '__design-review verdict:__']) {
      const [blk] = parseVerdicts([`${prefix} changes requested @ cc00000 -- baselines: a.png`])
      assert.ok(blk, prefix)
      assert.equal(blk.passing, false, prefix)
      assert.equal(blk.sha, 'cc00000', prefix)
      const vs = [v('passed @ bb00000 -- baselines: a.png'), blk]
      assert.equal(verifiedFor('a.png', vs, ctx), false, prefix)
    }
    assert.deepEqual(parseNameList('`a.png`, (b.png).'), ['a.png', 'b.png'])
  })

  test('an unbound block (no sha) stands — fail closed', () => {
    const vs = [v('passed @ cc00000 -- baselines: a.png'), v('changes requested -- baselines: a.png')]
    assert.equal(verifiedFor('a.png', vs, ctx), false)
  })

  test('unknown ancestry between pass and block leaves the block standing', () => {
    const noVerdictPairs = (a, b) => (a === 'aa00000' || b === 'dd00000' ? chain(a, b) : null)
    const vs = [v('changes requested @ bb00000 -- baselines: a.png'), v('passed @ cc00000 -- baselines: a.png')]
    assert.equal(verifiedFor('a.png', vs, { ...ctx, isAncestor: noVerdictPairs }), false)
  })

  test('unrelated shas (neither an ancestor of the other) leave the block standing', () => {
    // bb and ee both descend from aa and reach dd, but not each other (a merge).
    const rel = (a, b) => {
      if (a === b) return true
      if (a === 'aa00000' || b === 'dd00000') return true
      return false
    }
    const vs = [v('changes requested @ ee00000 -- baselines: a.png'), v('passed @ bb00000 -- baselines: a.png')]
    assert.equal(verifiedFor('a.png', vs, { ...ctx, isAncestor: rel }), false)
  })

  test('a block bound BEFORE the last touch is about an older image and is ignored', () => {
    // Block-vs-pass ancestry is UNKNOWN here, so `clears` cannot let the pass
    // through — only the before-the-last-touch rule can (the linear-chain
    // version of this test passed with that rule deleted).
    const at = (a, b) => {
      if (a === 'aa00000' && b === '0000000') return false // last touch ≰ block: block predates the image
      if (a === '0000000' && b === 'cc00000') return null // block vs pass: unknown
      return chain(a, b) ?? true
    }
    const vs = [v('changes requested @ 0000000 -- baselines: a.png'), v('passed @ cc00000 -- baselines: a.png')]
    assert.equal(verifiedFor('a.png', vs, { ...ctx, isAncestor: at }), true)
  })

  test('a block bound to a commit off the head (rebased away) is ignored', () => {
    const at = (a, b) => (b === 'dd00000' && a === 'ab99999' ? false : chain(a, b) ?? (a === 'aa00000'))
    const vs = [v('changes requested @ ab99999 -- baselines: a.png'), v('passed @ cc00000 -- baselines: a.png')]
    assert.equal(verifiedFor('a.png', vs, { ...ctx, isAncestor: at }), true)
  })

  test('a pass with a malformed or backticked sha stays a pass — never a veto', () => {
    const tpl = v('passed @ <head-sha> -- baselines: *')
    assert.equal(tpl.passing, true)
    assert.equal(tpl.sha, null)
    const ticked = v('passed @ `cc00000` -- baselines: a.png')
    assert.equal(ticked.passing, true)
    assert.equal(ticked.sha, 'cc00000')
    const vs = [v('passed @ cc00000 -- baselines: a.png'), tpl]
    assert.equal(verifiedFor('a.png', vs, ctx), true)
  })

  test('a hex-looking email after the separator binds no sha — a block cannot be moved off the head', () => {
    // `ops@deadbeef1.io` used to bind the block to `deadbeef1`, a commit not
    // on the head, so the block was ignored and the pass verified (fail-open).
    const blk = v('changes requested -- baselines: a.png (cc ops@deadbeef1.io)')
    assert.equal(blk.sha, null)
    assert.equal(blk.passing, false)
    const offHead = (a, b) => (a === 'deadbeef1' || b === 'deadbeef1' ? false : chain(a, b))
    assert.equal(verifiedFor('a.png', [v('passed @ cc00000 -- baselines: a.png'), blk], { ...ctx, isAncestor: offHead }), false)
    const pass = v('passed -- baselines: a.png (x@cc00000.io)')
    assert.equal(pass.sha, null) // unbound: not evidence
  })

  test('an `@` AFTER the separator (an email in the line) does not turn a pass into a block', () => {
    const mail = v('passed -- baselines: a.png (ping a@b.com)')
    assert.equal(mail.passing, true)
    assert.equal(verifiedFor('a.png', [v('passed @ cc00000 -- baselines: a.png'), mail], ctx), true)
  })

  test('a single bound pass with no block still verifies (the pre-#3301 case)', () => {
    assert.equal(verifiedFor('a.png', [v('passed @ cc00000 -- baselines: a.png')], ctx), true)
  })
})

describe('block shapes and globs (#3309)', () => {
  // The same linear history as the #3301 suite: aa (last touch) < bb < cc < dd (head).
  const rank = { aa00000: 1, bb00000: 2, cc00000: 3, dd00000: 4 }
  const chain = (a, b) => (a in rank && b in rank ? rank[a] <= rank[b] : null)
  const ctx = { lastTouchSha: 'aa00000', headSha: 'dd00000', isAncestor: chain }
  const olderPass = parseVerdicts(['design-review verdict: passed @ bb00000 -- baselines: a.png'])
  const BLOCK = 'changes requested @ cc00000 -- baselines: a.png'
  const PASS = 'passed @ cc00000 -- baselines: a.png'

  // The class: any shape a human might write a block in, against an older
  // bound pass for the same file. One row per shape — the next shape found
  // is a row here, not a review round. Every row is red at cbc937e9.
  const SHAPES = [
    ['a table row', (x) => `| design-review verdict: ${x} |`],
    ['a table row with more cells', (x) => `| a.png | design-review verdict: ${x} | note |`],
    ['a table row with the label in its own cell', (x) => `| design-review verdict | ${x} |`],
    ['an emoji shortcode before the label', (x) => `:x: design-review verdict: ${x}`],
    ['a heading', (x) => `### design-review verdict: ${x}`],
    ['an open task-list item', (x) => `- [ ] design-review verdict: ${x}`],
    ['a ticked `*` task-list item', (x) => `* [x] design-review verdict: ${x}`],
    ['an underscore-italic label', (x) => `_design-review verdict:_ ${x}`],
    ['no hyphen', (x) => `design review verdict: ${x}`],
    ['a space before the colon', (x) => `design-review verdict : ${x}`],
    ['a line wrapped in backticks', (x) => `\`design-review verdict: ${x}\``],
    ['an HTML <p> line', (x) => `<p>design-review verdict: ${x}</p>`],
  ]
  const GLOBS = ['*.png', '`*.png`', '**', '*-mobile.png', 'dir/*.png', './*.png']
  // In a block, `*` itself too: it is the documented wildcard.
  const BLOCK_GLOBS = ['*', ...GLOBS]

  for (const [label, shape] of SHAPES) {
    test(`a block in ${label} vetoes an older bound pass`, () => {
      const blocks = parseVerdicts([shape(BLOCK)])
      assert.equal(blocks.length, 1, 'the block line is read')
      assert.equal(blocks[0].passing, false)
      assert.equal(blocks[0].sha, 'cc00000')
      assert.equal(verifiedFor('a.png', [...olderPass, ...blocks], ctx), false)
    })
  }

  for (const glob of GLOBS) {
    test(`a block naming ${glob} covers every baseline and vetoes an older bound pass`, () => {
      const blocks = parseVerdicts([`design-review verdict: changes requested @ cc00000 -- baselines: ${glob}`])
      assert.ok(blocks[0].names.includes('*'), JSON.stringify(blocks[0].names))
      assert.equal(verifiedFor('a.png', [...olderPass, ...blocks], ctx), false)
    })
  }

  for (const [label, shape] of SHAPES) {
    test(`a glob block in ${label} covers every baseline, \`*\` included`, () => {
      for (const glob of BLOCK_GLOBS) {
        const blocks = parseVerdicts([shape(`changes requested @ cc00000 -- baselines: ${glob}`)])
        assert.ok(blocks[0]?.names.includes('*'), `${glob}: ${JSON.stringify(blocks[0]?.names)}`)
        assert.equal(verifiedFor('a.png', [...olderPass, ...blocks], ctx), false, glob)
      }
    })
  }

  test('CRLF text (the web editor) is read like LF, and a strict line is still read once', () => {
    const blocks = parseVerdicts([`intro\r\n| design-review verdict: ${BLOCK} |\r\nmore\r\n`])
    assert.equal(blocks.length, 1)
    assert.equal(verifiedFor('a.png', [...olderPass, ...blocks], ctx), false)
    assert.equal(parseVerdicts([`intro\r\ndesign-review verdict: ${BLOCK}\r\n`]).length, 1)
  })

  test('adversarial runs parse in linear time — raw, in a strict line, in a loose line, before the label', () => {
    // Every run a regex here could go super-linear on, 60k long (a comment
    // holds 65,536): blank lines once took 28 s through `^\s*` (#3309).
    const runs = [' ', '*', '.', '](', '\n', '<', '[ ] ', '|', ':', '_', '-', '@', ',', '> ', '#']
    const t0 = performance.now()
    for (const c of runs) {
      const r = c.repeat(Math.ceil(60000 / c.length)).slice(0, 60000)
      parseVerdicts([
        r,
        `design-review verdict: changes requested @ cc00000 -- baselines: ${r}x`,
        `design-review verdict: ${r}x`,
        `### design-review verdict: changes requested @ cc00000 -- baselines: ${r}x`,
        `${r} design-review verdict: changes requested`,
      ])
      parseDeclarations([r, `baseline-change: ${r} -- ${r}`])
    }
    const ms = performance.now() - t0
    assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`)
  })

  test('a glob block in a table row is read as both at once', () => {
    const blocks = parseVerdicts(['| design-review verdict: changes requested @ cc00000 -- baselines: `*.png` |'])
    assert.equal(verifiedFor('a.png', [...olderPass, ...blocks], ctx), false)
  })

  test('a PASS in any block-only shape is dropped — never read, never verifies', () => {
    for (const [label, shape] of SHAPES) {
      assert.deepEqual(parseVerdicts([shape(PASS)]), [], label)
      assert.equal(verifiedFor('a.png', parseVerdicts([shape(PASS)]), ctx), false, label)
    }
    // Control: the same pass in the line VERDICT_RE reads verifies.
    assert.equal(verifiedFor('a.png', parseVerdicts([`design-review verdict: ${PASS}`]), ctx), true)
  })

  test('a line VERDICT_RE already reads is not read twice', () => {
    assert.equal(parseVerdicts([`design-review verdict: ${BLOCK}`]).length, 1)
    assert.equal(parseVerdicts([`> - **design-review verdict:** ${BLOCK}`]).length, 1)
  })

  test('a sentence that mentions the label is not a verdict line — nor is one before a `|`', () => {
    assert.deepEqual(parseVerdicts([`The design-review verdict: ${BLOCK}`]), [])
    assert.deepEqual(parseVerdicts([`text | design-review verdict: ${BLOCK}`]), [])
  })

  test('a bold-wrapped line blocks only the file it names; a bare `**` list stays the wildcard', () => {
    const passC = parseVerdicts(['design-review verdict: passed @ cc00000 -- baselines: c.png'])
    for (const line of [
      '**design-review verdict: changes requested @ cc00000 -- baselines: b.png**',
      '- [ ] **design-review verdict: changes requested @ cc00000 -- baselines: b.png**',
      '### **design-review verdict: changes requested @ cc00000 -- baselines: b.png**',
      '_design-review verdict: changes requested @ cc00000 -- baselines: b.png_',
    ]) {
      const blocks = parseVerdicts([line])
      assert.deepEqual(blocks[0].names, ['b.png'], line)
      assert.equal(verifiedFor('c.png', [...passC, ...blocks], ctx), true, line)
    }
    const star = parseVerdicts(['**design-review verdict:** changes requested @ cc00000 -- baselines: **'])
    assert.ok(star[0].names.includes('*'))
    // A trailing `*` after a name that is not a whole `.png` may be the glob: kept.
    for (const line of ['*design-review verdict: changes requested @ cc00000 -- baselines: topbar*', '**design-review verdict: changes requested @ cc00000 -- baselines: topbar**']) {
      const blocks = parseVerdicts([line])
      assert.ok(blocks[0].names.includes('*'), line)
      assert.equal(verifiedFor('a.png', [...olderPass, ...blocks], ctx), false, line)
    }
  })

  test('in a PASS and in a declaration the same globs cover nothing, exactly as before', () => {
    for (const glob of GLOBS) {
      const [pass] = parseVerdicts([`design-review verdict: passed @ cc00000 -- baselines: ${glob}`])
      assert.equal(pass.passing, true, glob)
      assert.ok(!pass.names.includes('*'), glob)
      assert.equal(verifiedFor('a.png', [pass], ctx), false, glob)
      const decl = parseDeclarations([`baseline-change: ${glob} -- a reason that is long enough to count`])
      assert.ok(!decl[0].names.includes('*'), glob)
      assert.equal(declaredFor('a.png', decl), false, glob)
    }
    assert.deepEqual(parseNameList('*.png'), ['png.png'])
    assert.deepEqual(parseNameList('**'), [])
  })

  test('emphasis around a whole name or the whole list is not a glob', () => {
    for (const list of ['**a.png**', '*a.png*', '**a.png, c.png**', '**a.png**, *c.png*', '*a.png*, *c.png*', '**a.png**, **c.png**', '`a.png`.']) {
      assert.equal(listHasGlob(list), false, list)
      const block = parseVerdicts([`design-review verdict: changes requested @ cc00000 -- baselines: ${list}`])
      const passB = parseVerdicts(['design-review verdict: passed @ bb00000 -- baselines: b.png'])
      assert.equal(verifiedFor('b.png', [...passB, ...block], ctx), true, list)
    }
    for (const glob of GLOBS) assert.equal(listHasGlob(glob), true, glob)
  })

  test('a `*` around anything but a whole .png name is a glob — per name, and in mixed line emphasis', () => {
    for (const list of ['*.png*', '**.png**', '*-desktop.png*', '*top*', 'a.png, *.png*', '*desktop.png', '** **']) {
      const blocks = parseVerdicts([`design-review verdict: changes requested @ cc00000 -- baselines: ${list}`])
      assert.ok(blocks[0].names.includes('*'), `${list}: ${JSON.stringify(blocks[0].names)}`)
      assert.equal(verifiedFor('a.png', [...olderPass, ...blocks], ctx), false, list)
    }
    for (const line of [
      '*_design-review verdict: changes requested @ cc00000 -- baselines: *.png_*',
      '_*design-review verdict: changes requested @ cc00000 -- baselines: *.png*_',
      '*design-review verdict:* changes requested @ cc00000 -- baselines: b.png*',
    ]) {
      const blocks = parseVerdicts([line])
      assert.ok(blocks[0].names.includes('*'), `${line}: ${JSON.stringify(blocks[0].names)}`)
      assert.equal(verifiedFor('a.png', [...olderPass, ...blocks], ctx), false, line)
    }
  })

  test('the pass side reads exactly as at base — no emphasis stripping there', () => {
    // `__…a.png__` named `a.png__.png` at base, which covers nothing.
    const [pass] = parseVerdicts(['__design-review verdict: approved @ cc00000 -- a.png__'])
    assert.equal(pass.passing, true)
    assert.equal(verifiedFor('a.png', [pass], ctx), false)
  })

  test('regression guard: every committed baseline name round-trips and is no glob', () => {
    const root = fileURLToPath(new URL(`../../${BASELINE_DIR}/`, import.meta.url))
    const names = readdirSync(root, { recursive: true }).map(String).filter((f) => f.endsWith('.png')).map(baselineName)
    assert.ok(names.length >= 80, `read ${names.length} baselines`)
    for (const n of names) {
      assert.deepEqual(parseNameList(n), [n.toLowerCase()], n)
      assert.equal(listHasGlob(n), false, n)
    }
  })
})

describe('collect — the production ancestry map answers verdict-vs-verdict (#3301)', () => {
  // `collect` is the only producer of `isAncestor` in production. A veto
  // proven against a stub relation would pass here and fail in the gate if
  // collect never asked which of two verdicts is newer — so drive the real
  // collect with a recording `gh` and evaluate what it returns.
  const HEAD = 'dd00000000000000000000000000000000000000'
  const TOUCH = 'aa00000000000000000000000000000000000000'
  const rank = { aa00000: 1, bb00000: 2, cc00000: 3, dd00000: 4 }
  const r7 = (sha) => rank[sha.slice(0, 7)]

  const ghFor = (body, calls) => async (args) => {
    const url = args[1]
    calls.push(url)
    let out
    if (url.includes('pulls/7/files?')) out = [{ path: PNG, status: 'modified' }]
    else if (url.includes('pulls/7/commits?')) out = [{ commit: { message: 'chore: re-review' } }]
    else if (url.endsWith('pulls/7')) out = { number: 7, draft: false, base: { ref: 'dev', repo: { default_branch: 'dev' } }, head: { sha: HEAD }, body }
    else if (url.includes('issues/7/comments?')) out = []
    else if (url.includes('commits?path=')) out = [{ sha: TOUCH }]
    else if (url.includes('/compare/')) {
      const [a, b] = url.split('/compare/')[1].split('...')
      out = { status: r7(a) === r7(b) ? 'identical' : r7(a) < r7(b) ? 'ahead' : 'behind' }
    } else throw new Error(`unexpected gh call ${url}`)
    return JSON.stringify(out)
  }

  const run = async (verdictLines) => {
    const calls = []
    const body = `${DECL}\n\n${verdictLines.join('\n')}\n`
    const collected = await collect({ gh: ghFor(body, calls), repo: 'o/r', prNumber: 7 })
    return { result: evaluate(collected), calls }
  }

  test('a later block, as the real gate sees it → fail', async () => {
    const { result, calls } = await run([
      'design-review verdict: passed @ bb00000 -- baselines: topbar-desktop.png',
      'design-review verdict: changes requested @ cc00000 -- baselines: topbar-desktop.png',
    ])
    assert.equal(result.verdict, 'fail')
    assert.ok(calls.some((c) => c.endsWith('compare/cc00000...bb00000')), 'collect asked whether the block is older than the pass')
  })

  test('a re-review after a block, as the real gate sees it → pass', async () => {
    const { result } = await run([
      'design-review verdict: changes requested @ bb00000 -- baselines: topbar-desktop.png',
      'design-review verdict: passed @ cc00000 -- baselines: topbar-desktop.png',
    ])
    assert.equal(result.verdict, 'pass')
  })
})

describe('evaluate — wildcards, comments, promotions, drafts', () => {
  const pr = { number: 1, base: 'dev', defaultBranch: 'dev', headSha: 'h1' }

  test('a declared `*` mass re-bless covers a modified baseline', () => {
    const r = evaluate({
      pr,
      files: [modifiedFile(), modifiedFile(PNG2)],
      declarationTexts: ['baseline-change: * -- playwright 1.61 font metrics moved every baseline at once'],
      verdictTexts: ['design-review verdict: passed @ abc1234 -- baselines: *'],
      lastTouch: { [PNG]: 't1', [PNG2]: 't1' },
      isAncestor: ancestorOk,
    })
    assert.equal(r.verdict, 'pass')
  })

  test('a wildcard DECLARATION does not cover a missing wildcard VERDICT', () => {
    const r = evaluate({
      pr,
      files: [modifiedFile()],
      declarationTexts: ['baseline-change: * -- playwright 1.61 font metrics moved every baseline at once'],
      verdictTexts: ['design-review verdict: passed @ abc1234 -- baselines: some-other-file.png'],
      lastTouch: { [PNG]: 't1' },
      isAncestor: ancestorOk,
    })
    assert.equal(r.verdict, 'fail')
  })

  test('a verdict in a COMMENT verifies (#2816 posted theirs as a comment)', () => {
    const r = evaluate({
      pr,
      files: [modifiedFile()],
      declarationTexts: [DECL],
      verdictTexts: ['looks right rendered.\n\ndesign-review verdict: passed @ abc1234 -- baselines: topbar-desktop.png'],
      lastTouch: { [PNG]: 't1' },
      isAncestor: ancestorOk,
    })
    assert.equal(r.verdict, 'pass')
  })

  test('a promotion PR (base ≠ default branch) passes with the reason stated, not judged', () => {
    const r = evaluate({
      pr: { number: 2, base: 'main', defaultBranch: 'dev', headSha: 'h1' },
      files: [modifiedFile()],
      declarationTexts: [''],
      verdictTexts: [''],
      lastTouch: { [PNG]: 't1' },
      isAncestor: ancestorOk,
    })
    assert.equal(r.verdict, 'pass')
    assert.match(r.reason, /not the default branch/)
    assert.match(r.reason, /cannot carry per-file verdicts/)
  })

  test('a draft PR passes (re-checked on ready_for_review)', () => {
    const r = evaluate({
      pr: { ...pr, draft: true },
      files: [modifiedFile()],
      declarationTexts: [''],
      verdictTexts: [''],
      lastTouch: { [PNG]: 't1' },
      isAncestor: ancestorOk,
    })
    assert.equal(r.verdict, 'pass')
  })

  test('a PNG outside the baseline directory is nobody the gate judges', () => {
    const r = evaluate({
      pr,
      files: [{ path: 'docs/img/looks-like-a-baseline.png', status: 'modified' }],
      declarationTexts: [''],
      verdictTexts: [''],
      lastTouch: {},
      isAncestor: ancestorOk,
    })
    assert.equal(r.verdict, 'pass')
    assert.match(r.report, /read 0 changed baseline PNG\(s\)/)
  })

  test('two modified baselines, one covered → the other named in the failure', () => {
    const r = evaluate({
      pr,
      files: [modifiedFile(), modifiedFile(PNG2)],
      declarationTexts: [DECL],
      verdictTexts: [VERDICT],
      lastTouch: { [PNG]: 't1', [PNG2]: 't1' },
      isAncestor: ancestorOk,
    })
    assert.equal(r.verdict, 'fail')
    assert.equal(r.missing.length, 1)
    assert.equal(r.missing[0].path, PNG2)
  })
})

// ---------------------------------------------------------------------------
// Mutation proofs. Each cell: real code fails the fixture (asserted above);
// the one-line mutant passes it. If the mutant also failed, the branch under
// test is not what made the difference and the assertion proves nothing.
// ---------------------------------------------------------------------------

describe('mutation proofs (each gating branch can fire)', () => {
  const SRC = readFileSync(new URL('./baseline-verdict-gate.mjs', import.meta.url), 'utf8')
  const pr = { number: 1, base: 'dev', defaultBranch: 'dev', headSha: 'h1' }
  const bothFixture = { pr, files: [modifiedFile()], declarationTexts: [DECL], verdictTexts: [VERDICT], lastTouch: { [PNG]: 't1' }, isAncestor: ancestorOk }

  async function mutantModule(from, to) {
    assert.ok(SRC.includes(from), `mutation anchor not found: ${JSON.stringify(from.slice(0, 60))}`)
    assert.equal(SRC.split(from).length, 2, `mutation anchor is not unique: ${JSON.stringify(from.slice(0, 60))}`)
    const dir = mkdtempSync(path.join(tmpdir(), 'baseline-verdict-mutant-'))
    const file = path.join(dir, 'mutant.mjs')
    writeFileSync(file, SRC.replace(from, to))
    try {
      return await import(pathToFileURL(file).href)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const mutant = async (from, to) => (await mutantModule(from, to)).evaluate

  test('M1: MODIFIED must keep the verdict requirement — mutant treats every change as added', async () => {
    const mutated = await mutant(
      `if (f.status === 'added' || f.status === 'renamed') pngs.added.push(f.path)\n    else pngs.modified.push(f.path)`,
      `pngs.added.push(f.path)`,
    )
    // Real code: fail (asserted in fixture 2). Mutant: the verdict requirement
    // vanishes with the modified class → pass.
    const r = await mutated(bothFixture)
    assert.equal(r.verdict, 'pass')
  })

  test('M2: the no-declaration branch fires — mutant accepts every declaration', async () => {
    const mutated = await mutant(
      `const declaredForName = (name) =>
    declarations.some((d) => (d.names.includes('*') || d.names.includes(name)) && d.reason.length >= MIN_REASON_CHARS)`,
      `const declaredForName = () => true`,
    )
    const noDecl = { ...bothFixture, declarationTexts: [''] } // verdict IS present; only the declaration is missing
    const r = await mutated(noDecl)
    assert.equal(r.verdict, 'pass')
  })

  test('M3: the no-verdict branch fires — mutant gates only on the declaration', async () => {
    const mutated = await mutant(
      `if (!declared || !verified) missing.push({ path, needsVerdict: true, declared, verified })`,
      `if (!declared) missing.push({ path, needsVerdict: true, declared, verified })`,
    )
    const noVerdict = { ...bothFixture, verdictTexts: [''] }
    const r = await mutated(noVerdict)
    assert.equal(r.verdict, 'pass')
  })

  test('M4: the sha binding is load-bearing — mutant accepts any verdict sha (#3222 shape)', async () => {
    // Re-anchored by #3301 (verifiedFor was restructured around `bound`); the
    // property is unchanged: without the binding, an old-sha verdict verifies.
    const mutated = await mutant(
      `return touchOk === true && headOk === true`,
      `return true`,
    )
    const oldSha = { ...bothFixture, isAncestor: ancestorNever } // verdict OLDER than the re-commit
    const r = await mutated(oldSha)
    assert.equal(r.verdict, 'pass')
  })

  // #3301's three rules, each against the fixture the real code fails.
  const rank = { aa00000: 1, bb00000: 2, cc00000: 3, dd00000: 4 }
  const chain = (a, b) => (a in rank && b in rank ? rank[a] <= rank[b] : null)
  const chainPr = { ...pr, headSha: 'dd00000' }
  const conflict = (lines) => ({ pr: chainPr, files: [modifiedFile()], declarationTexts: [DECL], verdictTexts: [lines.join('\n')], lastTouch: { [PNG]: 'aa00000' }, isAncestor: chain })
  const laterBlock = conflict([
    'design-review verdict: passed @ bb00000 -- baselines: topbar-desktop.png',
    'design-review verdict: changes requested @ cc00000 -- baselines: topbar-desktop.png',
  ])
  const notApproved = conflict(['design-review verdict: not approved @ cc00000 -- baselines: topbar-desktop.png'])

  test('M6: the later-block veto fires — mutant ignores every block', async () => {
    assert.equal(evaluate(laterBlock).verdict, 'fail')
    const mutated = await mutant(`blocks.every((b) => clears(v, b))`, `true`)
    assert.equal(mutated(laterBlock).verdict, 'pass')
  })

  test('M7: a `*` pass never clears a named block — mutant lets any newer pass clear', async () => {
    const newerStar = conflict([
      'design-review verdict: changes requested @ bb00000 -- baselines: topbar-desktop.png',
      'design-review verdict: passed @ cc00000 -- baselines: *',
    ])
    assert.equal(evaluate(newerStar).verdict, 'fail')
    const mutated = await mutant(`(names(pass) || !names(block))`, `true`)
    assert.equal(mutated(newerStar).verdict, 'pass')
  })

  test('M11: markdown around a name is stripped — mutant keeps the raw part', async () => {
    const ticked = conflict([
      'design-review verdict: passed @ bb00000 -- baselines: topbar-desktop.png',
      'design-review verdict: changes requested @ cc00000 -- baselines: `topbar-desktop.png`',
    ])
    assert.equal(evaluate(ticked).verdict, 'fail')
    const mutated = await mutant(`const kept = trimChars(rawPart.replace(/[^A-Za-z0-9._\\-/*]/g, ''), '.').toLowerCase()`, `const kept = rawPart`)
    assert.equal(mutated(ticked).verdict, 'pass')
  })

  test('M8: the whole-token verdict word — mutant restores the substring match', async () => {
    assert.equal(evaluate(notApproved).verdict, 'fail')
    const mutated = await mutant(
      `const passing = PASSING_VERDICTS.has(word)`,
      `const passing = [...PASSING_VERDICTS].some((w) => body.toLowerCase().includes(w))`,
    )
    assert.equal(mutated(notApproved).verdict, 'pass')
  })

  test('M9: collect probes verdict × verdict — mutant drops those probes and a re-review can never clear', async () => {
    const HEAD = 'dd00000000000000000000000000000000000000'
    const body = `${DECL}\n\ndesign-review verdict: changes requested @ bb00000 -- baselines: topbar-desktop.png\ndesign-review verdict: passed @ cc00000 -- baselines: topbar-desktop.png\n`
    const gh = async (args) => {
      const url = args[1]
      let out
      if (url.includes('pulls/7/files?')) out = [{ path: PNG, status: 'modified' }]
      else if (url.includes('pulls/7/commits?')) out = []
      else if (url.endsWith('pulls/7')) out = { base: { ref: 'dev', repo: { default_branch: 'dev' } }, head: { sha: HEAD }, body }
      else if (url.includes('issues/7/comments?')) out = []
      else if (url.includes('commits?path=')) out = [{ sha: 'aa00000' }]
      else {
        const [a, b] = url.split('/compare/')[1].split('...')
        out = { status: chain(a.slice(0, 7), b.slice(0, 7)) ? 'ahead' : 'behind' }
      }
      return JSON.stringify(out)
    }
    const real = await collect({ gh, repo: 'o/r', prNumber: 7 })
    assert.equal(evaluate(real).verdict, 'pass')
    const m = await mutantModule(
      `for (const a of verdictShas) for (const b of verdictShas) if (a !== b) await probe(a, b)`,
      ``,
    )
    const mutated = await m.collect({ gh, repo: 'o/r', prNumber: 7 })
    assert.equal(m.evaluate(mutated).verdict, 'fail')
  })

  test('M10: the head check fires — mutant accepts a verdict newer than the head', async () => {
    const at = (a, b) => (a === 'aa00000' && b === 'ff00000' ? true : false)
    const future = { pr: { ...pr, headSha: 'cc00000' }, files: [modifiedFile()], declarationTexts: [DECL], verdictTexts: ['design-review verdict: passed @ ff00000 -- baselines: topbar-desktop.png'], lastTouch: { [PNG]: 'aa00000' }, isAncestor: at }
    assert.equal(evaluate(future).verdict, 'fail')
    const mutated = await mutant(`const headOk = isAncestor(v.sha, headSha)`, `const headOk = true`)
    assert.equal(mutated(future).verdict, 'pass')
  })

  test('M5: the short-reason bar is load-bearing — mutant accepts a stub reason', async () => {
    const mutated = await mutant(
      `d.reason.length >= MIN_REASON_CHARS`,
      `d.reason.length >= 0`,
    )
    const stubReason = { ...bothFixture, declarationTexts: ['baseline-change: topbar-desktop.png -- moved'] }
    const r = await mutated(stubReason)
    assert.equal(r.verdict, 'pass')
  })

  test('M12: a block glob covers every baseline — mutant never reads a glob', async () => {
    const globBlock = conflict([
      'design-review verdict: passed @ bb00000 -- baselines: topbar-desktop.png',
      'design-review verdict: changes requested @ cc00000 -- baselines: *.png',
    ])
    assert.equal(evaluate(globBlock).verdict, 'fail')
    const mutated = await mutant(`if (!passing && !names.includes('*') && listHasGlob(listText, lineOpen))`, `if (false)`)
    assert.equal(mutated(globBlock).verdict, 'pass')
  })

  test('M13: the glob reading is blocks-only — mutant widens a pass too', async () => {
    const globPass = conflict(['design-review verdict: passed @ bb00000 -- baselines: *.png'])
    assert.equal(evaluate(globPass).verdict, 'fail')
    const mutated = await mutant(`if (!passing && !names.includes('*') && listHasGlob(listText, lineOpen))`, `if (!names.includes('*') && listHasGlob(listText, lineOpen))`)
    assert.equal(mutated(globPass).verdict, 'pass')
  })

  test('M14: the block-only line shapes are read — mutant reads none of them', async () => {
    const tableBlock = conflict([
      'design-review verdict: passed @ bb00000 -- baselines: topbar-desktop.png',
      '| design-review verdict: changes requested @ cc00000 -- baselines: topbar-desktop.png |',
    ])
    assert.equal(evaluate(tableBlock).verdict, 'fail')
    const mutated = await mutant(`const label = line.match(BLOCK_LABEL_RE)`, `const label = null`)
    assert.equal(mutated(tableBlock).verdict, 'pass')
  })

  test('M17: the trailing strip keeps a bare `*` — mutant strips it', async () => {
    const starHeading = conflict([
      'design-review verdict: passed @ bb00000 -- baselines: topbar-desktop.png',
      '### design-review verdict: changes requested @ cc00000 -- baselines: *',
    ])
    assert.equal(evaluate(starHeading).verdict, 'fail')
    const mutated = await mutant("' \\t\\r\\n\\f\\v`_').trimStart()", "' \\t\\r\\n\\f\\v`_*').trimStart()")
    assert.equal(mutated(starHeading).verdict, 'pass')
  })

  test('M15: a pass in a block-only shape is dropped — mutant keeps it', async () => {
    const tablePass = conflict(['| design-review verdict: passed @ bb00000 -- baselines: topbar-desktop.png |'])
    assert.equal(evaluate(tablePass).verdict, 'fail')
    const mutated = await mutant(`if (!v.passing) out.push(v)`, `out.push(v)`)
    assert.equal(mutated(tablePass).verdict, 'pass')
  })
})

// ---------------------------------------------------------------------------
// CLI end to end with a stub gh on PATH (the pr-ownership-gate suite's shape).
// ---------------------------------------------------------------------------

describe('CLI end to end with a stub gh on PATH', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'baseline-verdict-gate-'))
  const stub = path.join(dir, 'gh')

  const PR_BODY_OK = `Summary\n\n${DECL}\n\n${VERDICT}\n`
  const HEAD = 'h000000000000000000000000000000000000000'
  const TOUCH = 't111111111111111111111111111111111111111'

  // Argument routing: files/pulls/issues-comments/pull-commits/last-touch/compare.
  // The MORE SPECIFIC arms come first — `pulls/7/files?` and `pulls/7/commits?`
  // both CONTAIN `repos/o/r/pulls/7`, so the PR-object arm must not lead.
  // printf '%s', not echo: dash's echo EXPANDS backslash escapes, which would
  // turn the body's JSON `\n` into a raw control character and the parse
  // would (correctly) fail closed — printf's %s arguments are not
  // escape-processed. Only builtins inside the stub: the test PATH is the
  // stub dir alone.
  const stubFor = (bodyJson) => `#!/bin/sh
case "$*" in
  *"pulls/7/files?"*) echo '[{"path":"${PNG}","status":"modified"}]' ;;
  *"pulls/7/commits?"*) echo '[{"commit":{"message":"chore: regenerate baselines"}}]' ;;
  *"repos/o/r/pulls/7"*) printf '%s' '{"number":7,"draft":false,"base":{"ref":"dev","repo":{"default_branch":"dev"}},"head":{"sha":"${HEAD}"},"body":${bodyJson}}' ;;
  *"issues/7/comments?"*) echo '[]' ;;
  *"commits?path="*) echo '[{"sha":"${TOUCH}"}]' ;;
  *"compare/"*) echo '{"status":"identical"}' ;;
  *) echo "unexpected gh invocation: $*" >&2; exit 9 ;;
esac
`

  const run = (bodyJson) => {
    writeFileSync(stub, stubFor(bodyJson))
    chmodSync(stub, 0o755)
    const ev = path.join(dir, 'event.json')
    writeFileSync(ev, JSON.stringify({ number: 7, pull_request: { number: 7 } }))
    // The gate fails the process (exit 1) on purpose; read stdout rather than
    // letting execFileSync throw through.
    let out = ''
    try {
      out = execFileSync(process.execPath, [CLI, '--event', ev], {
        encoding: 'utf8',
        env: { ...process.env, PATH: path.dirname(stub), GITHUB_REPOSITORY: 'o/r' },
      })
    } catch (e) {
      out = e.stdout ?? ''
    }
    return out
  }

  test('declared + verified in the body → exit 0 with the ✅ report', () => {
    const out = run(JSON.stringify(PR_BODY_OK))
    assert.match(out, /✅ Baseline change gate/)
    assert.match(out, /1 modified, 0 added/)
  })

  test('empty body → exit 1 with the failure report naming the file', () => {
    const out = run(JSON.stringify(''))
    assert.match(out, /❌ Baseline change gate/)
    assert.match(out, new RegExp(PNG.replace(/\//g, '\\/')))
    assert.match(out, /baseline-change: <file\.png/)
  })

  test('unreadable PR (gh fails) → exit 1, fail closed', () => {
    writeFileSync(stub, '#!/bin/sh\necho "gh:boom" >&2\nexit 1\n')
    chmodSync(stub, 0o755)
    const ev = path.join(dir, 'event.json')
    writeFileSync(ev, JSON.stringify({ number: 7, pull_request: { number: 7 } }))
    let out = ''
    let code = 0
    try {
      out = execFileSync(process.execPath, [CLI, '--event', ev], {
        encoding: 'utf8',
        env: { ...process.env, PATH: path.dirname(stub), GITHUB_REPOSITORY: 'o/r' },
      })
    } catch (e) {
      out = e.stdout ?? ''
      code = e.status ?? 1
    }
    assert.equal(code, 1)
    assert.match(out, /could not read this pull request's changed baselines/)
    assert.match(out, /fails closed/)
  })

  test('missing --event → exit 2', () => {
    let code = 0
    try {
      execFileSync(process.execPath, [CLI], {
        encoding: 'utf8',
        env: { ...process.env, PATH: path.dirname(stub), GITHUB_REPOSITORY: 'o/r' },
      })
    } catch (e) {
      code = e.status
    }
    assert.equal(code, 2)
  })
})

// ---------------------------------------------------------------------------
// The workflow cannot mask the verdict — the same pins the sibling gate's
// suite makes on pr-ownership-gate.yml.
// ---------------------------------------------------------------------------

describe('the workflow cannot mask the verdict', () => {
  const yml = readFileSync(new URL('../../.github/workflows/baseline-verdict-gate.yml', import.meta.url), 'utf8')

  test('the judging step runs under bash with pipefail, so `| tee` cannot turn exit 1 green', () => {
    // Actions' default `run:` shell is `bash -e {0}` WITHOUT pipefail;
    // `bash -e -c 'false | tee /dev/null'` exits 0. Mutation: drop either line
    // and this goes red.
    const step = yml.slice(yml.indexOf('- name: Judge the changed visual baselines'))
    assert.match(step, /\n\s+shell: bash\n\s+run: \|\n\s+set -o pipefail\n\s+node scripts\/ci\/baseline-verdict-gate\.mjs --event "\$GITHUB_EVENT_PATH" \| tee -a "\$GITHUB_STEP_SUMMARY"\n/)
  })

  test('triggers include `edited` — a verdict added to the body mid-review must re-read', () => {
    const on = yml.slice(yml.indexOf('on:'), yml.indexOf('permissions:'))
    for (const t of ['opened', 'edited', 'synchronize', 'reopened', 'ready_for_review']) {
      assert.match(on, new RegExp(`\\b${t}\\b`))
    }
    // pull_request_target, so the judge is dev's copy — never the PR's.
    assert.match(on, /pull_request_target:/)
    assert.doesNotMatch(on, /^\s+pull_request:/m)
  })

  test('the checkout carries no `ref:` — the judge is the default branch, not the PR', () => {
    const checkout = yml.slice(yml.indexOf('uses: actions/checkout'))
    const step = checkout.slice(0, checkout.indexOf('\n      -') + 1)
    assert.doesNotMatch(step, /ref:/)
  })

  test('permissions are read-only — the PR-derived input is text, never code', () => {
    const perms = yml.slice(yml.indexOf('permissions:'), yml.indexOf('concurrency:'))
    assert.match(perms, /contents: read/)
    assert.match(perms, /pull-requests: read/)
    assert.doesNotMatch(perms, /contents: write/)
    assert.doesNotMatch(perms, /actions: write/)
  })

  test('one run per PR at a time (edited fires per keystroke-saved edit)', () => {
    assert.match(yml, /concurrency:\n  group: baseline-change-gate-\$\{\{ github\.event\.pull_request\.number \}\}\n  cancel-in-progress: true/)
  })

  test('the gate runs on the default-branch base only — promotions are skipped by the script, not by a missing check', () => {
    // The script (not a workflow `if`) owns the promotion pass, so the check
    // still REPORTS on a promotion with the stated reason instead of silently
    // not running — the difference between "passed" and "never judged".
    assert.match(yml, /name: Baseline change gate/)
  })
})
