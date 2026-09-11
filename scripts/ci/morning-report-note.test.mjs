// Tests for the morning-report note gate (`morning-report-note.mjs`).
//
// The behaviour worth testing here is the REFUSAL. A scheduled LLM that reaches
// the same conclusion two mornings running will try to say it twice, and the
// only thing standing between that and a useless coordination thread is
// `decide()`. Every case below is a way that guard could silently stop working.
//
// Run with: node --test scripts/ci/morning-report-note.test.mjs
// (also collected by the `ci_config_checks` job's `scripts/ci/*.test.mjs` glob)

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_BODY_CHARS,
  decide,
  fingerprint,
  fingerprintOf,
  normalise,
  render,
} from './morning-report-note.mjs'

const NOW = Date.parse('2026-09-11T08:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const agoDays = (d) => new Date(NOW - d * DAY).toISOString()

/** A previously-posted note, as GitHub would return it. */
const posted = (body, days) => ({ body: render({ body, fp: fingerprint(body), runUrl: null }), created_at: agoDays(days) })

describe('decide', () => {
  test('a fresh note posts', () => {
    const r = decide({ body: 'Promotion has been stalled since Tuesday; 75 commits pending.', comments: [], now: NOW })
    assert.equal(r.post, true)
    assert.equal(r.reason, 'new note')
  })

  test('the same note posted yesterday is suppressed', () => {
    // THE case this module exists for: a persistent condition re-observed the
    // next morning must not produce a second identical note.
    const body = 'Promotion has been stalled since Tuesday; 75 commits pending.'
    const r = decide({ body, comments: [posted(body, 1)], now: NOW })
    assert.equal(r.post, false)
    assert.match(r.reason, /identical note already posted/)
  })

  test('the same note from beyond the window posts again', () => {
    // A condition still true a week later has earned one restatement.
    const body = 'Promotion has been stalled since Tuesday; 75 commits pending.'
    const r = decide({ body, comments: [posted(body, 8)], now: NOW })
    assert.equal(r.post, true)
  })

  test('whitespace and marker differences do not defeat dedupe', () => {
    const body = 'Promotion   has been stalled since Tuesday;\n75 commits pending.'
    const prior = posted('Promotion has been stalled since Tuesday; 75 commits pending.', 1)
    const r = decide({ body, comments: [prior], now: NOW })
    assert.equal(r.post, false, 'reflowed text is the same note and must not repeat')
  })

  test('a materially different note posts even on the same day', () => {
    const prior = posted('Promotion has been stalled since Tuesday; 75 commits pending.', 0)
    const r = decide({ body: '#2851 is a migration and needs a CODEOWNERS review.', comments: [prior], now: NOW })
    assert.equal(r.post, true)
  })

  test('an empty note is a clean skip, not an error', () => {
    // A quiet morning is a correct outcome. The routine must not feel obliged
    // to manufacture something to say.
    for (const body of ['', '   ', '\n\n', null, undefined]) {
      const r = decide({ body, comments: [], now: NOW })
      assert.equal(r.post, false, `expected skip for ${JSON.stringify(body)}`)
      assert.match(r.reason, /empty note/)
    }
  })

  test('an over-long note is refused rather than truncated', () => {
    // Truncating would post a note ending mid-sentence; refusing keeps the
    // thread clean and surfaces the problem in the run log.
    const r = decide({ body: 'x'.repeat(MAX_BODY_CHARS + 1), comments: [], now: NOW })
    assert.equal(r.post, false)
    assert.match(r.reason, /over the \d+ limit/)
  })

  test('a note exactly at the limit is allowed', () => {
    const r = decide({ body: 'x'.repeat(MAX_BODY_CHARS), comments: [], now: NOW })
    assert.equal(r.post, true)
  })

  test('an unparseable timestamp suppresses — when in doubt, stay quiet', () => {
    const body = 'Promotion has been stalled since Tuesday.'
    const prior = { body: render({ body, fp: fingerprint(body), runUrl: null }), created_at: 'not-a-date' }
    const r = decide({ body, comments: [prior], now: NOW })
    assert.equal(r.post, false, 'a duplicate with an unreadable date must not be posted twice')
  })

  test('unrelated comments on the thread are ignored', () => {
    // The coordination thread carries CLAIM/RELEASE lines from other sessions.
    // They must neither suppress a note nor crash the reader.
    const comments = [
      { body: '🔒 CLAIM #2851 — branch fix/2851 — touches: migrations — session A', created_at: agoDays(0.2) },
      { body: '', created_at: agoDays(0.3) },
      { body: null, created_at: agoDays(0.4) },
    ]
    const r = decide({ body: 'Promotion has been stalled since Tuesday.', comments, now: NOW })
    assert.equal(r.post, true)
  })
})

describe('fingerprint round-trip', () => {
  test('a rendered note carries a fingerprint the reader can recover', () => {
    const body = 'Promotion has been stalled since Tuesday.'
    const fp = fingerprint(body)
    assert.equal(fingerprintOf(render({ body, fp, runUrl: 'https://example.com/run/1' })), fp)
  })

  test('a comment with no marker yields null rather than throwing', () => {
    for (const b of ['plain text', '', null, undefined, '<!-- other-marker fp:abc -->']) {
      assert.equal(fingerprintOf(b), null)
    }
  })

  test('normalise strips the marker so a note never fingerprints its own marker', () => {
    const body = 'Promotion stalled.'
    const rendered = render({ body, fp: fingerprint(body), runUrl: null })
    // Re-fingerprinting a rendered note must not drift, or dedupe breaks the
    // first time a note is compared against its own rendered form.
    assert.equal(normalise(rendered).includes('morning-report-note'), false)
  })
})

describe('render', () => {
  const body = 'Promotion has been stalled since Tuesday; 75 commits pending.'
  const out = render({ body, fp: fingerprint(body), runUrl: 'https://example.com/run/1' })

  test('follows the 📣 FYI convention AGENTS.md defines for this thread', () => {
    assert.match(out, /📣 \*\*FYI\*\* — Promotion has been stalled/)
  })

  test('states plainly that it is machine-written and not an instruction', () => {
    // Autonomous sessions read this thread and act on it. The workflow is
    // triggered by a human account, so without this line a scheduled job's
    // guess is indistinguishable from an owner's decision.
    assert.match(out, /not an owner instruction/)
    assert.match(out, /verify before acting on it/)
  })

  test('links the run that produced it', () => {
    assert.match(out, /https:\/\/example\.com\/run\/1/)
  })

  test('renders without a run url', () => {
    const bare = render({ body, fp: fingerprint(body), runUrl: null })
    assert.match(bare, /not an owner instruction/)
    assert.equal(bare.includes('undefined'), false)
    assert.equal(bare.includes('null'), false)
  })
})
