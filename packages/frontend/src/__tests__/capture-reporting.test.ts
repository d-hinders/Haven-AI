/**
 * The REPORTING half of the capture harness (#1936 / #1939 / #1943).
 *
 * The three issues in this family look like three selector bugs and are not.
 * What they share is that the harness produced no output and could not say
 * why: one cause deleted its own evidence, one named the wrong cause, and the
 * third (a cold `next dev` compile) had no name at all. An absence of a result
 * then reads exactly like a clean result — the same defect class this repo
 * keeps finding in guards that cannot fail.
 *
 * So the deletion record is tested as behaviour, not as a console detail. If
 * these assertions can be satisfied by a run that deletes a PNG and says
 * nothing, they are worth nothing.
 */
import { describe, expect, it } from 'vitest'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs, the capture harness
import { describeDeletedCapture, formatDeletionReport } from '../../scripts/screenshot.mjs'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs
import { ContentNotSettledError, ScrollShellError } from '../../scripts/full-page-capture.mjs'

const at = { route: '/how-it-works', viewport: 'desktop', file: '.screenshots/x-desktop.png' }

describe('describeDeletedCapture', () => {
  it('records WHICH PNG was deleted, not just that something failed', () => {
    // #1939's actual harm: the run deleted the file and reported a sentence
    // about a selector, so the reader was left with an empty directory and no
    // way to tell it from "there was nothing to capture".
    const record = describeDeletedCapture(new Error('capture is BLANK below the fold'), at)

    expect(record.file, 'the deleted path must be on the record').toBe(
      '.screenshots/x-desktop.png',
    )
    expect(record.route).toBe('/how-it-works')
    expect(record.text, 'the measurement in the message must survive the record').toMatch(
      /BLANK below the fold/,
    )
  })

  it('separates a PNG that was deleted from one that was never written', () => {
    // A shell verdict throws BEFORE `page.screenshot`, so nothing existed to
    // remove. Reporting that as "DELETED" would be a small lie in the middle
    // of a change whose entire subject is saying precisely what happened.
    const deleted = describeDeletedCapture(new Error('blank'), { ...at, written: true })
    const never = describeDeletedCapture(
      new ScrollShellError('root gone', { cause: 'missing-scroll-root' }),
      { ...at, written: false },
    )

    expect(deleted.disposition).toBe('deleted')
    expect(never.disposition).toBe('never written')
    expect(formatDeletionReport([never]).join('\n')).toMatch(/NEVER WRITTEN/)
    expect(formatDeletionReport([deleted]).join('\n')).toMatch(/DELETED/)
  })

  it('keeps a missing scroll root distinct from a page that never rendered', () => {
    // The two causes that used to print the same sentence. If this collapses,
    // a cold-compile timeout sends the next reader to edit SCROLL_SHELL_ROOT.
    const missing = describeDeletedCapture(
      new ScrollShellError('root gone', { cause: 'missing-scroll-root' }),
      at,
    )
    const cold = describeDeletedCapture(
      new ScrollShellError('rendered almost nothing', { cause: 'not-rendered' }),
      at,
    )

    expect(missing.cause).toBe('missing-scroll-root')
    expect(cold.cause).toBe('not-rendered')
    expect(missing.cause, 'these two must never be the same cause').not.toBe(cold.cause)
  })

  it('keeps the blank-capture guard as its own named cause', () => {
    // The guard tags its own failure (`captureCause`), so 'blank-below-fold'
    // is a fact reported by the code that measured it, never a default the
    // reporter fell back to.
    const blank = Object.assign(new Error('capture is BLANK below the fold'), {
      captureCause: 'blank-below-fold',
    })
    expect(describeDeletedCapture(blank, at).cause).toBe('blank-below-fold')
  })

  it('does not call a loaded machine a blank capture', () => {
    // Observed while building this change: `page.screenshot` timed out at 30s
    // on a 2560×36340 image while the box was compiling another route for 315
    // seconds. Reported as 'blank-below-fold' — which is the #1936 mistake in
    // miniature, one level up from where it was fixed.
    const record = describeDeletedCapture(new Error('page.screenshot: Timeout 30000ms exceeded.'), at)

    expect(record.cause, 'a timeout is a machine-load symptom, not an empty PNG').toBe(
      'capture-timeout',
    )
  })

  it('gives a still-loading capture a cause of its own (#2036)', () => {
    // The cause that most needs its own name: a `still-loading` capture is the
    // only one in this list whose PNG comes out looking entirely healthy, so
    // folding it into 'unknown' would leave the reader with a well-formed image
    // and a shrug. The error carries `captureCause` rather than `shellCause`
    // because the shell was fine — that is precisely the point.
    const record = describeDeletedCapture(
      new ContentNotSettledError('the shell mounted but "#main-content" never filled with content', {
        waitedMs: 30_000,
      }),
      { ...at, route: '/dashboard', written: false },
    )

    expect(record.cause).toBe('still-loading')
    expect(record.disposition, 'the throw precedes page.screenshot').toBe('never written')
    expect(record.waited_ms).toBe(30_000)
    expect(record.text).toMatch(/never filled with content/)
  })

  it('records an unrecognised failure as unknown instead of guessing', () => {
    const record = describeDeletedCapture(new Error('something else broke'), at)
    expect(record.cause).toBe('unknown')
    expect(record.text).toMatch(/something else broke/)
  })
})

describe('formatDeletionReport', () => {
  it('prints nothing when nothing was deleted', () => {
    expect(formatDeletionReport([])).toEqual([])
  })

  it('names every deleted file and its cause on the console', () => {
    const lines = formatDeletionReport([
      describeDeletedCapture(new ScrollShellError('root gone', { cause: 'missing-scroll-root' }), at),
    ]).join('\n')

    expect(lines, 'the word DELETED must appear — this is a destructive act').toMatch(/DELETED/)
    expect(lines).toMatch(/\.screenshots\/x-desktop\.png/)
    expect(lines).toMatch(/cause: missing-scroll-root/)
    expect(
      lines,
      'the report must point at the manifest, which is where the absence is durable',
    ).toMatch(/capture-manifest\.json/)
  })
})
