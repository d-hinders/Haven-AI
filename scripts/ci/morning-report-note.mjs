// Decides whether the morning-report routine's heads-up should be posted, and
// renders it. Driven by `.github/workflows/morning-report-note.yml`.
//
// ## Why this is a script and not three lines of shell
//
// The caller is a scheduled LLM. It runs every weekday, it re-reads the same
// repository state each time, and when a condition persists — a stalled
// promotion, an unreviewed PR — it will reach the same conclusion tomorrow and
// want to say it again. Unguarded, that turns the agent coordination thread
// (#1289) into a wall of near-identical notes, which is how a channel agents
// are told to read becomes a channel agents learn to skip.
//
// So the load-bearing behaviour here is REFUSAL, and refusal deserves tests.
// Each note carries a fingerprint of its own normalised text in an HTML marker;
// a note whose fingerprint already appears within the dedupe window is dropped.
//
// The gh plumbing stays in the workflow. This module is pure — comments in,
// decision out — so the decision can be tested without mocking a CLI.

import { createHash } from 'node:crypto'

/** Marker prefix. The fingerprint rides in an HTML comment so it is invisible
 *  in the rendered issue but greppable in the comment body. */
export const MARKER = 'morning-report-note'

/** Notes older than this no longer suppress a repeat: a condition that is still
 *  true a week later is worth restating once, not every morning. */
export const DEFAULT_WINDOW_DAYS = 7

/** Hard ceiling on a note. Long enough for a real heads-up, short enough that
 *  nobody can paste a whole report into the coordination thread. */
export const MAX_BODY_CHARS = 1200

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Normalise before fingerprinting so trivial rewording does not defeat dedupe:
 * collapse all whitespace, drop any marker line, trim. Case is preserved —
 * issue numbers and identifiers are case-bearing and a case-only change is not
 * a change worth re-posting.
 */
export function normalise(body) {
  return String(body ?? '')
    .replace(/<!--\s*morning-report-note[^>]*-->/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Short, stable fingerprint of a note's meaningful text. */
export function fingerprint(body) {
  return createHash('sha256').update(normalise(body)).digest('hex').slice(0, 16)
}

/** Pull the fingerprint out of an existing comment body, or null. */
export function fingerprintOf(commentBody) {
  const m = String(commentBody ?? '').match(/<!--\s*morning-report-note fp:([0-9a-f]{16})\s*-->/)
  return m ? m[1] : null
}

/**
 * Decide whether to post.
 *
 * @param {object} o
 * @param {string} o.body            the proposed note text
 * @param {Array<{body: string, created_at: string}>} o.comments  existing comments on the target
 * @param {number} o.now             epoch ms
 * @param {number} [o.windowDays]
 * @returns {{post: boolean, reason: string, fingerprint: string|null}}
 */
export function decide({ body, comments = [], now = Date.now(), windowDays = DEFAULT_WINDOW_DAYS }) {
  const text = normalise(body)

  // An empty note is the LLM having nothing to say. That is a correct outcome
  // on a quiet day, so it is a clean skip rather than an error.
  if (text === '') return { post: false, reason: 'empty note — nothing worth saying', fingerprint: null }

  if (text.length > MAX_BODY_CHARS) {
    return {
      post: false,
      reason: `note is ${text.length} chars, over the ${MAX_BODY_CHARS} limit — the thread is for heads-ups, not reports`,
      fingerprint: null,
    }
  }

  const fp = fingerprint(body)
  const cutoff = now - windowDays * DAY_MS

  for (const c of comments) {
    if (fingerprintOf(c.body) !== fp) continue
    const at = Date.parse(c.created_at ?? '')
    // An unparseable timestamp is treated as recent: when in doubt, do not
    // repeat yourself. Staying quiet costs less than duplicating a note.
    if (Number.isNaN(at) || at >= cutoff) {
      return { post: false, reason: `identical note already posted within ${windowDays}d (fp ${fp})`, fingerprint: fp }
    }
  }

  return { post: true, reason: 'new note', fingerprint: fp }
}

/**
 * Render the comment. Two things are deliberate:
 *
 * 1. The note says plainly that it is machine-written and is NOT an owner
 *    instruction. Autonomous sessions read this thread and act on it; a
 *    judgement call from a scheduled job must not be mistaken for a decision
 *    from the person whose account triggered the workflow.
 * 2. It follows the `📣 FYI` convention AGENTS.md defines for this thread,
 *    rather than inventing a shape agents have not been told to expect.
 */
export function render({ body, fp, runUrl }) {
  const provenance = runUrl
    ? `_Automated heads-up from the weekday morning report ([run](${runUrl})). Machine-written judgement, not an owner instruction — verify before acting on it._`
    : '_Automated heads-up from the weekday morning report. Machine-written judgement, not an owner instruction — verify before acting on it._'

  return [`<!-- ${MARKER} fp:${fp} -->`, `📣 **FYI** — ${String(body).trim()}`, '', provenance].join('\n')
}

// ---------------------------------------------------------------------------
// CLI — one invocation, so the workflow does not parse the same JSON three
// times. Reads the proposed note and the target's existing comments, writes the
// rendered comment when it decides to post, and reports the decision on stdout
// as `post=<bool>` / `reason=<text>` for the shell to read.
//
//   node scripts/ci/morning-report-note.mjs \
//     --note note.txt --comments comments.json --out rendered.md [--window-days 7]
//
// Exit code is 0 for BOTH post and skip: a refusal is a normal outcome, not a
// failure. Only a genuine error (missing file, bad JSON) exits non-zero.
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`

if (isMain) {
  const { readFileSync, writeFileSync } = await import('node:fs')

  const arg = (name, fallback = null) => {
    const i = process.argv.indexOf(`--${name}`)
    return i === -1 ? fallback : process.argv[i + 1]
  }

  const notePath = arg('note')
  const commentsPath = arg('comments')
  const outPath = arg('out')
  if (!notePath || !commentsPath || !outPath) {
    console.error('usage: morning-report-note.mjs --note <file> --comments <file> --out <file> [--window-days N]')
    process.exit(2)
  }

  const body = readFileSync(notePath, 'utf8')
  const comments = JSON.parse(readFileSync(commentsPath, 'utf8'))
  const windowDays = Number(arg('window-days', String(DEFAULT_WINDOW_DAYS)))

  const d = decide({ body, comments, now: Date.now(), windowDays })
  if (d.post) {
    writeFileSync(outPath, render({ body, fp: d.fingerprint, runUrl: process.env.RUN_URL || null }))
  }

  // One line per field, so the shell can read them without a JSON parser.
  process.stdout.write(`post=${d.post}\nreason=${d.reason}\n`)
}
