// Shared ratcheting-baseline engine for the lint gates (code review 2026-07-13).
//
// design-lint (#855) and copy-lint (#902) each carried a near line-for-line
// copy of the same ratchet: a committed baseline of existing debt
// (file → key → count) that may only SHRINK — new occurrences, or growth of
// an existing count, fail. This module is the single implementation; a further
// ratcheting gate should import it rather than clone either script. There are
// SIX as of #2747 — design-lint, copy-lint, the wire-type ratchet, the db-mock
// ratchet, the retired-rail prose ratchet and ui-gate-wording — and the two
// that had cloned instead of imported were the two missing a `--update`
// refusal. That count is ASSERTED against the real importer list by
// `ratchet.test.mjs` rather than maintained by hand: it said FIVE here and in
// four other places until #2759 (#2747 landed at 20:12 and this at 20:58 the
// same evening -- 46 minutes, not the "week" an earlier draft of this comment
// asserted without measuring it).
//
// The `key` dimension is whatever the gate counts per file: a rule id for
// design-lint, a banned phrase for copy-lint.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

/**
 * Compare scanned counts ({file: {key: n}}) against the baseline (same
 * shape). Returns [{file, key, count, allowed}] for every count that EXCEEDS
 * what the baseline allows — a new occurrence, or growth of an existing one.
 * Equal/shrunk/removed counts pass. The baseline is per-file: the same key
 * newly appearing in a different file is NOT grandfathered.
 */
export function newViolations(counts, baseline) {
  const failures = []
  for (const [file, keys] of Object.entries(counts)) {
    for (const [key, count] of Object.entries(keys)) {
      const allowed = baseline[file]?.[key] ?? 0
      if (count > allowed) failures.push({ file, key, count, allowed })
    }
  }
  return failures
}

/** True when any baselined count is higher than what the tree now has — the
 *  signal to tighten the ratchet with --update. */
export function hasShrunk(counts, baseline) {
  for (const [file, keys] of Object.entries(baseline)) {
    for (const [key, allowed] of Object.entries(keys)) {
      if ((counts[file]?.[key] ?? 0) < allowed) return true
    }
  }
  return false
}

/** Write the baseline deterministically (files and keys sorted) so diffs stay
 *  reviewable. Returns the serialized string (also written to path). */
export function writeBaseline(path, counts) {
  const sorted = Object.fromEntries(
    Object.keys(counts)
      .sort()
      .map((f) => [f, Object.fromEntries(Object.entries(counts[f]).sort())]),
  )
  const json = JSON.stringify(sorted, null, 2) + '\n'
  writeFileSync(path, json)
  return json
}

/**
 * The `--update` guard, as a pure function so it can be tested rather than
 * only read: an update may TIGHTEN the baseline, never raise it. Returns the
 * violations that block the write ([] when the write is allowed).
 *
 * `firstRun` -- and NOT "the baseline is empty" -- is what opens the one
 * allowance, because those are different states and conflating them disables
 * the guard permanently (#2728, found by review). `writeBaseline` PRODUCES
 * `{}` whenever a gate reaches zero debt, so a gate keyed on emptiness is one
 * successful cleanup away from accepting anything forever -- and the cleanup
 * is the step every one of these gates tells you to run. It is not
 * hypothetical: `packages/frontend/design-lint-baseline.json` is `{}` today.
 * The allowance now means the baseline FILE does not exist yet, which is the
 * state it was always meant to describe. Use `loadBaseline()` to get both.
 *
 * This lives here rather than in one gate because `--update` is the command a
 * gate's own failure message sends you to, so a gate that omits the check
 * turns its remedy into a laundering step. Of the five gates on this module at
 * the time (six today), three had a line-for-line copy of this decision and
 * TWO had none at all
 * (`frontend-copy-lint`, the subject of #2728, and `design-lint`, which review
 * found by reading the importer list rather than the issue) -- exactly the
 * duplication this module's header says it exists to prevent.
 */
export function updateRefusals(counts, baseline, { firstRun = false } = {}) {
  if (firstRun) return []
  return newViolations(counts, baseline)
}

/**
 * Refuse a baseline the comparison cannot use, at the READ boundary rather than
 * in the comparison (#2759).
 *
 * `newViolations` does `count > allowed`, and `1 > "x"` is `false`. So an entry
 * whose value is a string, null, an array or an object silently disables
 * itself: the gate reports a clean bill of health over a live violation, and
 * `hasShrunk` stays quiet for the same reason, so not even the "residue shrank"
 * hint fires. Measured on `scripts/docs/ui-gate-wording.mjs` with
 * `{"docs/thing.md": {"blanket-merge-pause": "x"}}` — exit 0, "1 baselined
 * occurrence(s) remain", violation live.
 *
 * Validating here rather than inside `newViolations` is deliberate: it is one
 * place for all six gates, it keeps the comparison a pure numeric predicate,
 * and it puts the error where the file is named — a comparison that throws can
 * only say WHICH key, not which file it came from.
 *
 * This does not reach `scripts/docs/covers-gaps.mjs`, whose baseline stores gap
 * FILE ARRAYS by design and which does not import this module (#2679). Audited
 * before shipping: 155 entries across the six gates on this engine, all
 * numeric, so this is a pure tightening rather than a build someone else has to
 * fix. The 40 array-valued entries in the repo all live in covers-gaps'.
 */
/**
 * Run a gate's `main` as the CLI, and present a failure the way a gate should.
 *
 * Four of the six gates on this module called `main()` bare (#2761), so an
 * operator-facing condition — a malformed baseline, an unreadable file, a
 * permissions error — arrived as Node's uncaught-exception banner:
 *
 *     node:internal/modules/run_main:107
 *         triggerUncaughtException(
 *         ^
 *     [TypeError: …/db-mock-baseline.json: "x.test.ts" [positional] is "3", …]
 *
 *     Node.js v24.17.0
 *
 * #2759 made the message the whole error TEXT; this removes the framing around
 * it. A helper rather than four copies for the reason #2728 and #2747 both
 * landed on: a decision copied N times is a decision that drifts, and each of
 * those issues was one gate that had drifted out of a set the others were in.
 *
 * ## Why it does not just print `err.message`
 *
 * A REFUSAL and a BUG want opposite treatment. `refusal()` below strips the
 * stack because its frames point inside this module and tell the operator
 * nothing. A genuine bug wants exactly those frames. So the split is made on
 * the evidence rather than on a flag: an error carrying stack FRAMES is a bug
 * and is printed whole; a frameless one is a refusal and prints as one line.
 *
 * `Promise.resolve().then(main)` rather than `main().catch(...)`, because
 * `design-lint`'s `main` is synchronous and a sync throw would escape the
 * latter before any handler existed.
 */
export function runGate(name, main) {
  Promise.resolve()
    .then(main)
    .catch((err) => {
      const hasFrames = typeof err?.stack === 'string' && /\n\s+at /.test(err.stack)
      if (hasFrames) console.error(`✗ ${name} failed:`, err)
      else console.error(`✗ ${name}: ${err?.message ?? err}`)
      process.exit(1)
    })
}

/**
 * A refusal, not a crash — so it is presented as one.
 *
 * FOUR of the six gates have no catch at their entrypoint at all -- `db-mock`,
 * `wire-types`, `retired-rail-prose` and `design-lint` call `main()` bare, so a
 * throw becomes an uncaught exception with Node's own framing. The two that do
 * catch (`frontend-copy-lint`, `ui-gate-wording`) print the message. Without
 * the replacement below the frames WOULD run `assertUsableBaseline` ->
 * `loadBaseline` -> the gate's `main`, which for a malformed baseline is noise
 * around the one line the operator needs -- and it is why the "the error can
 * name the FILE" argument landed in two gates of six until review said so
 * (#2759).
 *
 * Who it actually helps, since this paragraph is justifying the construct by
 * naming them: the four bare gates, and `frontend-copy-lint`, whose
 * `console.error(err)` would otherwise print the frames. NOT `ui-gate-wording`
 * — it wraps its own baseline read and prints `err.message` with a remedy, so
 * for this error the replacement is a no-op there.
 *
 * An earlier version of this comment said five gates inherit a
 * `main().catch(...)`, which is both the wrong number and self-contradictory.
 * The review that caught it put the number at one; measuring the six
 * entrypoints gives two. Counted here rather than restated, which is the
 * lesson this whole file is now carrying.
 *
 * Replacing `stack` is deliberate rather than clever: this error reports a bad
 * INPUT FILE, and where it was thrown from tells the reader nothing. A genuine
 * bug inside this module still throws normally and keeps its frames.
 */
function refusal(message) {
  const err = new TypeError(message)
  err.stack = `TypeError: ${message}`
  return err
}

export function assertUsableBaseline(baseline, path = 'baseline') {
  if (baseline === null || typeof baseline !== 'object' || Array.isArray(baseline)) {
    const shape = Array.isArray(baseline) ? 'an array' : baseline === null ? 'null' : typeof baseline
    throw refusal(`${path}: expected a JSON object, got ${shape}`)
  }
  for (const [file, keys] of Object.entries(baseline)) {
    if (keys === null || typeof keys !== 'object' || Array.isArray(keys)) {
      const shape = Array.isArray(keys) ? 'an array' : keys === null ? 'null' : typeof keys
      throw refusal(`${path}: entry "${file}" should map keys to counts, got ${shape}`)
    }
    for (const [key, allowed] of Object.entries(keys)) {
      if (typeof allowed !== 'number' || !Number.isFinite(allowed)) {
        // `JSON.stringify(NaN)` is the string "null", which would report a
        // NaN entry as null and send the reader looking for the wrong thing.
        // Every non-finite number stringifies to "null", not just NaN — the
        // first version of this line special-cased NaN and left `1e400`
        // reporting as null, sending the reader after a JSON null that is not
        // in the file (review finding).
        const shown =
          typeof allowed === 'number' && !Number.isFinite(allowed)
            ? String(allowed)
            : JSON.stringify(allowed)
        throw refusal(
          `${path}: "${file}" [${key}] is ${shown}, not a number — ` +
            'the comparison is `count > allowed`, so a non-numeric entry silently allows ' +
            'everything for that key rather than failing loudly',
        )
      }
    }
  }
  return baseline
}

/**
 * Read a baseline and say whether the file existed. The pair matters: `{}` is
 * both what an absent file reads as and what a fully-cleaned gate writes, and
 * only one of those may accept growth. See `updateRefusals`.
 */
export function loadBaseline(path) {
  // ONE `existsSync`, feeding both halves. Calling `readBaseline(path)` (which
  // does its own) and then `!existsSync(path)` leaves a window in which the two
  // disagree, and one direction of that disagreement is unsafe: a file deleted
  // between the calls yields a parsed, non-empty baseline paired with
  // `firstRun: true`, so `updateRefusals` returns [] and growth is accepted.
  // Narrow, but this is a guard whose entire job is to refuse -- and the defect
  // it was written for was also "two states that look alike" (review nit).
  const exists = existsSync(path)
  return {
    baseline: exists ? assertUsableBaseline(JSON.parse(readFileSync(path, 'utf8')), path) : {},
    firstRun: !exists,
  }
}

/**
 * Read the baseline, or {} when none exists yet.
 *
 * Validated like `loadBaseline`, because leaving one unvalidated read path
 * exported reopens #2759 for whichever gate reaches for it next — and none of
 * that gate's mutations would redden, since the hole would be in a function no
 * current caller uses. No gate uses this today (all six call `loadBaseline`);
 * it stays for callers that need the object without the `firstRun` flag.
 */
export function readBaseline(path) {
  return existsSync(path) ? assertUsableBaseline(JSON.parse(readFileSync(path, 'utf8')), path) : {}
}
