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

/**
 * The TOPIC window, deliberately shorter than the exact-match one.
 *
 * Exact fingerprinting only catches a verbatim repeat, and the caller is a
 * language model: asked the same question on two mornings it produces the same
 * FACT in different WORDS. Observed on 2026-09-11, hours after this module
 * shipped — two notes about the same stale checklist, one saying "catalog and
 * quote handlers" and the other "catalog, quote and prepare handlers", both
 * posted because their bytes differed.
 *
 * The topic key below closes that. It is windowed at two days rather than
 * seven because it is a coarser, more fallible signal: a note covering the same
 * issues might be genuinely new news about them. Two days suppresses the
 * morning-after restatement, which is the observed failure, while letting a
 * real change in the same work be reported the day after that.
 */
export const DEFAULT_TOPIC_WINDOW_DAYS = 2

/**
 * A note must reference at least this many distinct issues before the topic
 * check applies. A note about ONE issue is as likely to be a genuine update on
 * it ("#2857 is red" then "#2857 is fixed") as a restatement, so those are left
 * to exact matching alone. The observed failure referenced six.
 */
export const TOPIC_MIN_REFS = 2

/**
 * How much two notes' citation sets must overlap to count as the same topic,
 * as |intersection| / |union|.
 *
 * Set EQUALITY is too strict, and the observed failure proves it: the first
 * note cited #2806, #2810, #2811, #2812 plus the two PRs #2841 and #2854; the
 * reworded second cited only the four issues. Identical fact, different sets.
 * Their overlap is 4/6 = 0.67, comfortably over this threshold, while a note
 * about unrelated work overlaps at 0.
 */
export const TOPIC_OVERLAP = 0.5

/**
 * The comparison is STRICTLY greater, and the strictness is the safety margin.
 *
 * A set against a superset of exactly twice its size scores exactly 0.5, and
 * that shape is common here: a roundup cites six issues, and the next morning
 * brings genuinely new news about three of them. Suppressing that is the
 * failure this guard must not have — it silences a channel autonomous sessions
 * depend on. Strict `>` lets the exact-half case through while still catching
 * the observed restatement at 0.67.
 */

/**
 * Text a note may not contain. The note is machine-written from repository
 * content — issue titles, PR titles, branch names, commit subjects — all of
 * which a contributor can influence. It lands in #1289, the thread every
 * session reads for claim state, posted by a bot account.
 *
 * A forged `🔓 RELEASE` there is not cosmetic: AGENTS.md says an unreleased
 * claim blocks another session for a day, so a fake release is exactly what
 * makes two sessions build the same issue, and a fake `🔒 CLAIM` makes a
 * session skip work nobody is doing. Raw HTML is refused for the same reason
 * in a different shape — an unclosed `<details>` swallows the provenance
 * footer, hiding the one line that says this is not a human speaking.
 *
 * Refusing is cheap and fits the posture of this module: a note that cannot be
 * posted safely is a note not worth posting.
 */
export const FORBIDDEN = [
  { re: /(?:^|\s)🔒\s*CLAIM/u, why: 'contains a CLAIM marker — only a session may claim work' },
  { re: /(?:^|\s)🔓\s*RELEASE/u, why: 'contains a RELEASE marker — only a session may release its own claim' },
  { re: /<!--/, why: 'contains an HTML comment — could hide content or poison dedupe' },
  { re: /<\s*\/?\s*[a-z][a-z0-9]*(?:\s|\/?>)/i, why: 'contains raw HTML' },
]

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

/**
 * The set of issues a note is ABOUT: every `#NNNN` it references, de-duplicated
 * and sorted numerically. Two notes stating the same fact in different words
 * cite the same issues; two notes about different work do not. That makes the
 * citation set a better topic signal than the prose.
 *
 * Returns an array, possibly empty. The TOPIC_MIN_REFS floor is applied by
 * `decide`, not here, so this stays a plain accessor.
 */
export function issueRefs(body) {
  return [...new Set((String(body ?? '').match(/#\d{1,6}\b/g) || []))].sort(
    (a, b) => Number(a.slice(1)) - Number(b.slice(1)),
  )
}

/**
 * Jaccard overlap of two citation sets: |intersection| / |union|, 0 when either
 * is empty. Chosen over set equality because a restatement routinely drops or
 * adds an incidental reference while making the same point.
 */
export function refOverlap(a, b) {
  if (!a.length || !b.length) return 0
  const A = new Set(a)
  const B = new Set(b)
  let shared = 0
  for (const r of A) if (B.has(r)) shared++
  return shared / (A.size + B.size - shared)
}

/** Pull the fingerprint out of an existing comment body, or null. */
export function fingerprintOf(commentBody) {
  const m = String(commentBody ?? '').match(/<!--\s*morning-report-note fp:([0-9a-f]{16})\s*-->/)
  return m ? m[1] : null
}

/**
 * The citation set of an existing comment. Prefers the marker, and falls back
 * to reading `#NNNN` out of the comment text itself.
 *
 * The fallback is what makes this guard work on day one rather than in a week:
 * every note already on the thread was rendered before the marker carried a
 * citation set, and those are exactly the notes a restatement would duplicate.
 * The quoted note text is right there in the body, so the references can be
 * recovered without it. The marker stays the preferred source because it
 * records what the author actually cited, not what the rendering happens to
 * contain.
 */
export function refsOf(commentBody) {
  const text = String(commentBody ?? '')
  const m = text.match(/<!--\s*morning-report-note fp:[0-9a-f]{16}(?: refs:([#\d,]+))?\s*-->/)
  if (m && m[1]) return m[1].split(',').filter(Boolean)
  // Only fall back for OUR OWN notes: an arbitrary comment on the thread is not
  // a note and its issue mentions must not suppress anything.
  if (!m) return []
  return issueRefs(text)
}

/**
 * Decide whether to post.
 *
 * @param {object} o
 * @param {string} o.body            the proposed note text
 * @param {Array<{body: string, created_at: string}>} o.comments  existing comments on the target
 * @param {number} o.now             epoch ms
 * @param {number} [o.windowDays]       exact-match suppression window
 * @param {number} [o.topicWindowDays]  citation-overlap suppression window
 * @returns {{post: boolean, reason: string, fingerprint: string|null, refs: string[]}}
 */
export function decide({
  body,
  comments = [],
  now = Date.now(),
  windowDays = DEFAULT_WINDOW_DAYS,
  topicWindowDays = DEFAULT_TOPIC_WINDOW_DAYS,
}) {
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

  for (const { re, why } of FORBIDDEN) {
    if (re.test(String(body ?? ''))) return { post: false, reason: `refused: ${why}`, fingerprint: null }
  }

  // A window that is not a positive number must NOT silently disable dedupe:
  // `Number('abc')` is NaN, and every comparison against NaN is false, which
  // would let every duplicate through while the run still reported success.
  // Fall back to the default so the guard stays on.
  const days = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : DEFAULT_WINDOW_DAYS

  const fp = fingerprint(body)
  const cutoff = now - days * DAY_MS

  const topicDays =
    Number.isFinite(topicWindowDays) && topicWindowDays > 0 ? topicWindowDays : DEFAULT_TOPIC_WINDOW_DAYS
  const refs = issueRefs(body)
  const topicCutoff = now - topicDays * DAY_MS

  for (const c of comments) {
    const at = Date.parse(c.created_at ?? '')
    // An unparseable timestamp is treated as recent: when in doubt, do not
    // repeat yourself. Staying quiet costs less than duplicating a note.
    const recent = (edge) => Number.isNaN(at) || at >= edge

    if (fingerprintOf(c.body) === fp && recent(cutoff)) {
      return {
        post: false,
        reason: `identical note already posted within ${days}d (fp ${fp})`,
        fingerprint: fp,
        refs,
      }
    }

    // The reworded-restatement case: different bytes, overlapping citations.
    // BOTH notes must clear the ref floor. A one-issue note as the PRIOR could
    // otherwise suppress: {#2857} against {#2857,#2900} overlaps at exactly 0.5,
    // so "#2857 is red and now blocks #2900" would vanish behind "#2857 landed".
    const priorRefs = refsOf(c.body)
    if (refs.length >= TOPIC_MIN_REFS && priorRefs.length >= TOPIC_MIN_REFS && recent(topicCutoff)) {
      const overlap = refOverlap(refs, priorRefs)
      if (overlap > TOPIC_OVERLAP) {
        return {
          post: false,
          reason: `a note covering the same issues was posted within ${topicDays}d (overlap ${overlap.toFixed(2)})`,
          fingerprint: fp,
          refs,
        }
      }
    }
  }

  return { post: true, reason: 'new note', fingerprint: fp, refs }
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
export function render({ body, fp, refs, runUrl, actor }) {
  // The body is quoted, one `> ` per line. Quoting is structural, not
  // decorative: it stops any line of machine-written text from being a
  // top-level construct in the thread, so even if something slipped past
  // FORBIDDEN it reads as quoted material rather than as a coordination
  // directive standing on its own.
  const quoted = String(body)
    .trim()
    .split('\n')
    // Escape leading markdown structure before quoting. Quoting alone contains
    // a construct but does not quieten it: a `#` heading inside a blockquote
    // still renders large and bold — louder than the real provenance footer
    // below it — which is exactly the emphasis a forged line wants. Seen in a
    // live rehearsal on a scratch issue, not in a unit test.
    .map((line) => `> ${line.replace(/^(\s*)([#>])/, '$1\\$2')}`)
    .join('\n')

  // Say who dispatched this. The workflow cannot verify that a run came from
  // the scheduled report — anyone with write access can dispatch it — so
  // claiming that origin outright would be an assertion the run cannot back.
  // Naming the actor is something it can.
  const origin = actor ? `Dispatched by @${actor}` : 'Dispatched via workflow_dispatch'
  const link = runUrl ? ` ([run](${runUrl}))` : ''

  return [
    `<!-- ${MARKER} fp:${fp}${refs && refs.length ? ` refs:${refs.join(',')}` : ''} -->`,
    '📣 **FYI** — automated note from the weekday morning report',
    '',
    quoted,
    '',
    `_${origin}${link}. Machine-written judgement, not an owner instruction — verify before acting on it._`,
  ].join('\n')
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
    console.error(
      'usage: morning-report-note.mjs --note <file> --comments <file> --out <file> [--window-days N] [--topic-window-days N]',
    )
    process.exit(2)
  }

  const body = readFileSync(notePath, 'utf8')
  const comments = JSON.parse(readFileSync(commentsPath, 'utf8'))
  const windowDays = Number(arg('window-days', String(DEFAULT_WINDOW_DAYS)))
  // A guard whose failure mode is SILENCE needs a way to turn it down without a
  // code change, the same way --window-days exists for the exact check.
  const topicWindowDays = Number(arg('topic-window-days', String(DEFAULT_TOPIC_WINDOW_DAYS)))

  const d = decide({ body, comments, now: Date.now(), windowDays, topicWindowDays })
  if (d.post) {
    writeFileSync(
      outPath,
      render({
        body,
        fp: d.fingerprint,
        refs: d.refs,
        runUrl: process.env.RUN_URL || null,
        actor: process.env.ACTOR || null,
      }),
    )
  }

  // One line per field, so the shell can read them without a JSON parser.
  process.stdout.write(`post=${d.post}\nreason=${d.reason}\n`)
}
