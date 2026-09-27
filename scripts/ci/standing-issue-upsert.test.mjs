// Drives scripts/ci/standing-issue-upsert.mjs — the bot-ownership upsert both
// digest workflows use to find the standing issue they rewrite (#3341).
//
// The defect this pins: promotion-digest.yml selected the first open issue
// carrying the `promotion` label and docs-audit.yml the first hit of a
// tokenised `in:title` search — both attributes a human can also set — and
// then overwrote the body. #3262 (the prod RPC swap procedure, labelled
// `promotion` by its author) was overwritten by `github-actions` 33+ times.
// The fix selects by the one attribute a human cannot set, the author, plus
// an exact title comparison in this script, and fails CLOSED: a failed
// `gh issue list` must fail the step rather than fall through to `create`
// (the old `|| true` filed duplicates).
//
// Two layers, like the sibling suites:
//   - unit: `selectDigestIssue` against JSON arrays directly;
//   - CLI end to end with a stub `gh` on PATH (claim-assignee.test.mjs's
//     pattern): the exact entry point the workflows call, asserting which
//     calls were REACHED — presence in source is not reachability.
//
// Dependency-free (no js-yaml), matching the directory's rule.
//
// Run with: node --test scripts/ci/standing-issue-upsert.test.mjs
// (also collected by the `ci_config_checks` job's `scripts/ci/*.test.mjs` glob)

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { selectDigestIssue } from './standing-issue-upsert.mjs'

const SCRIPT = fileURLToPath(new URL('./standing-issue-upsert.mjs', import.meta.url))
const DIGEST_TITLE = '📦 Pending promotion: dev → main'
const BOT = 'app/github-actions'

// ── Unit: selectDigestIssue ──────────────────────────────────────────────────

describe('selectDigestIssue', () => {
  const base = { number: 666, title: DIGEST_TITLE, author: { login: BOT } }

  test('finds the bot-authored exact-title issue', () => {
    assert.equal(selectDigestIssue([base], { author: BOT, title: DIGEST_TITLE }), 666)
  })

  test('a HUMAN issue with the same exact title and label is NOT adopted', () => {
    // The #3262 shape: everything a human can set matches; only the author
    // differs — and the author is the one attribute that must decide.
    const human = { number: 3262, title: DIGEST_TITLE, author: { login: 'somehuman' } }
    assert.equal(selectDigestIssue([human], { author: BOT, title: DIGEST_TITLE }), null)
  })

  test('a substring title is NOT a match — `in:title` is tokenised, this is not', () => {
    const near = { number: 3000, title: `Docs staleness audit (weekly) follow-up`, author: { login: BOT } }
    assert.equal(selectDigestIssue([near], { author: BOT, title: 'Docs staleness audit (weekly)' }), null)
  })

  test('an issue without an author field is never a match', () => {
    assert.equal(selectDigestIssue([{ number: 1, title: DIGEST_TITLE }], { author: BOT, title: DIGEST_TITLE }), null)
  })

  test('several matches resolve to the LOWEST number — the original digest keeps identity', () => {
    assert.equal(
      selectDigestIssue([base, { ...base, number: 42 }, { ...base, number: 700 }],
        { author: BOT, title: DIGEST_TITLE }),
      42,
    )
  })

  test('nothing matches → null (the caller may then create)', () => {
    assert.equal(selectDigestIssue([], { author: BOT, title: DIGEST_TITLE }), null)
  })
})

// ── CLI end to end, with a stub gh on PATH ───────────────────────────────────

describe('standing-issue-upsert CLI end to end, with a stub gh on PATH (#3341)', () => {
  // The stub records every invocation's args to calls.txt, answers `issue
  // list` from $LIST_FILE (or fails with $LIST_EXIT), passes the edit/create
  // body through, and mirrors `gh issue create`'s URL line on success.
  function makeStub(listJson, listExit = '0') {
    const dir = mkdtempSync(path.join(tmpdir(), 'standing-upsert-'))
    const ghStub = path.join(dir, 'gh')
    writeFileSync(
      ghStub,
      [
        '#!/bin/sh',
        'printf \'%s\\n\' "$*" >> "$DIR/calls.txt"',
        'case " $* " in *" issue list "*) cat "$LIST_FILE" 2>/dev/null; exit "$LIST_EXIT";; esac',
        'case " $* " in *" issue create "*) cat > "$DIR/stdin-seen.txt"; echo "https://github.com/o/r/issues/700"; exit 0;; esac',
        'cat > "$DIR/stdin-seen.txt"; exit 0',
        '',
      ].join('\n'),
    )
    execFileSync('chmod', ['+x', ghStub])
    writeFileSync(path.join(dir, 'list.json'), listJson)
    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      DIR: dir,
      LIST_FILE: path.join(dir, 'list.json'),
      LIST_EXIT: listExit,
    }
    const calls = () =>
      existsSync(path.join(dir, 'calls.txt'))
        ? readFileSync(path.join(dir, 'calls.txt'), 'utf8').trim().split('\n').filter(Boolean)
        : []
    return { dir, env, calls }
  }

  const BODY = '_Updated by the promotion-digest workflow._'
  const run = ({ env, input = BODY }) =>
    execFileSync(
      process.execPath,
      [SCRIPT, '--title', DIGEST_TITLE, '--author', BOT,
        '--list-args', '--label promotion --state open --json',
        '--label', 'promotion', '--repo', 'o/r'],
      { encoding: 'utf8', env, input },
    )
  const fails = ({ env, input = BODY }) => {
    try {
      run({ env, input })
    } catch (e) {
      return e
    }
    return null // the call must have thrown
  }

  test('acceptance 1 — digest open + a human promotion issue open: ONLY the digest is edited', () => {
    const { env, calls } = makeStub(
      JSON.stringify([
        { number: 666, title: DIGEST_TITLE, author: { login: BOT } },
        { number: 3262, title: 'Prod RPC swap procedure', author: { login: 'somehuman' } },
      ]),
    )
    const out = run({ env })
    const list = calls()
    assert.equal(list.filter((c) => /issue list /.test(c)).length, 1)
    assert.equal(list.filter((c) => /issue edit /.test(c)).length, 1)
    assert.match(list.join('\n'), /issue edit 666 /, 'the bot-owned digest is the issue edited')
    assert.ok(!list.some((c) => /issue create /.test(c)), 'no duplicate digest created')
    assert.ok(!list.some((c) => /3262/.test(c)), 'the human issue is never touched')
    assert.match(out.trim(), /\{"action":"updated","number":666\}/)
  })

  test('acceptance 2 — only a HUMAN issue open (same exact title): a new digest is created, the human issue untouched', () => {
    const { env, calls } = makeStub(
      JSON.stringify([{ number: 3262, title: DIGEST_TITLE, author: { login: 'somehuman' } }]),
    )
    run({ env })
    const list = calls()
    assert.equal(list.filter((c) => /issue edit /.test(c)).length, 0, 'no human issue is edited')
    assert.equal(list.filter((c) => /issue create /.test(c)).length, 1, 'the workflow creates its own digest')
    assert.ok(!list.some((c) => /3262/.test(c)))
  })

  test('acceptance 3 — neither open: a new digest is created', () => {
    const { env, calls } = makeStub('[]')
    run({ env })
    const list = calls()
    assert.equal(list.filter((c) => /issue edit /.test(c)).length, 0)
    assert.equal(list.filter((c) => /issue create /.test(c)).length, 1)
  })

  test('the body reaches gh on STDIN (--body-file -), not argv', () => {
    const { env, calls, dir } = makeStub(JSON.stringify([{ number: 666, title: DIGEST_TITLE, author: { login: BOT } }]))
    run({ env })
    assert.match(calls().join('\n'), /--body-file -/)
    assert.equal(readFileSync(path.join(dir, 'stdin-seen.txt'), 'utf8'), BODY)
  })

  test('the list call filters server-side by author and lets the script own --json', () => {
    const { env, calls } = makeStub('[]')
    run({ env })
    const listCall = calls().find((c) => /issue list /.test(c))
    assert.ok(listCall, 'a list call was made')
    assert.match(listCall, /--author app\/github-actions/)
    assert.match(listCall, /--json number,title,author/)
    assert.ok(!listCall.includes('in:title'), 'selection must never use tokenised in:title search')
  })

  test('a FAILED gh issue list exits 1 and reaches NO write — no fall-through to create', () => {
    const { env, calls } = makeStub('', '1')
    const e = fails({ env })
    assert.ok(e, 'the CLI must exit non-zero')
    assert.equal(e.status, 1)
    assert.equal(calls().length, 1, 'only the list ran; no edit, no create')
  })

  test('a MALFORMED list payload exits 1 and reaches NO write', () => {
    const { env, calls } = makeStub('<html>rate limited</html>')
    const e = fails({ env })
    assert.ok(e, 'the CLI must exit non-zero')
    assert.equal(e.status, 1)
    assert.equal(calls().length, 1)
  })

  test('an empty body on stdin exits 2 before touching gh', () => {
    const { env, calls } = makeStub('[]')
    const e = fails({ env, input: '  \n ' })
    assert.ok(e, 'the CLI must exit non-zero')
    assert.equal(e.status, 2)
    assert.equal(calls().length, 0)
  })

  test('--label for create without the same label in --list-args exits 2 (the halves must agree)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'standing-upsert-args-'))
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, DIR: dir }
    let e = null
    try {
      execFileSync(
        process.execPath,
        [SCRIPT, '--title', DIGEST_TITLE, '--author', BOT,
          '--list-args', '--state open --json', '--label', 'promotion', '--repo', 'o/r'],
        { encoding: 'utf8', env, input: BODY },
      )
    } catch (err) {
      e = err
    }
    assert.ok(e, 'the CLI must exit non-zero')
    assert.equal(e.status, 2)
  })

  test('missing --list-args exits 2 with usage', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'standing-upsert-args-'))
    let e = null
    try {
      execFileSync(process.execPath, [SCRIPT, '--title', DIGEST_TITLE], { encoding: 'utf8', input: BODY, env: process.env })
    } catch (err) {
      e = err
    }
    assert.ok(e, 'the CLI must exit non-zero')
    assert.equal(e.status, 2)
  })
})
