/**
 * The two questions a `*.visual.spec.ts` asks, and which of them can run here
 * (#2827).
 *
 * These specs assert two different things, and only one is un-runnable off
 * Linux:
 *
 *   - **the pixel comparison**, against a Linux-rendered baseline. Genuinely
 *     un-runnable on a developer's macOS — font rendering differs, so a local
 *     comparison fails for a reason unrelated to any defect. That is why these
 *     specs are excluded from the default suite at all (#897).
 *   - **the structure** it navigates to get there. Platform-independent, and
 *     the half that breaks silently. These specs are already written that way:
 *     `design-system.visual.spec.ts` finds the top bar with
 *     `//*[@id="main-content"]/preceding-sibling::header[1]` (#1820) and then
 *     asserts `toHaveCount(1)` on it — `focus-visible.visual.spec.ts` says why:
 *     that assertion "closes 'matches nothing' and 'matches several'".
 *     Every `toHaveCount(1)` in the five specs is one of these — 24 call sites
 *     at the time of writing, but the instrument is the point, not the count:
 *     `grep -cE '\)\.toHaveCount\(1\)' e2e/*.visual.spec.ts` — five per-file
 *     counts summing to 24. Anchor on `).`, or the count picks up the
 *     docstrings that merely name the matcher.
 *
 *     So the structural coverage was never missing. It was unreachable: nesting
 *     `<header>` in a wrapper makes that xpath match nothing, #2819 did exactly
 *     that, and `test:e2e:gate:built` — the loop an author runs before pushing
 *     — could not see these specs at all. This mode does not add assertions; it
 *     lets the ones already written run somewhere other than CI.
 *
 * So there are three modes and one refused combination, and the predicate is
 * HERE rather than repeated in each spec: the same condition written five times is five chances for the
 * next mode to be added to four of them.
 *
 *   | mode                      | specs run | pixels compared |
 *   |---------------------------|-----------|-----------------|
 *   | default                   | no        | —               |
 *   | `VISUAL_REGRESSION=1`     | yes       | yes (CI, Linux) |
 *   | `VISUAL_STRUCTURE_ONLY=1` | yes       | **no**          |
 *   | both                      | REFUSED   | —               |
 *
 * Both together would run the pixel gate comparing nothing and report all
 * green — the exact catastrophe this file warns about, reachable by an
 * exported shell variable rather than by editing any script. So it is refused
 * loudly in `playwright.config.ts` rather than resolved silently either way.
 *
 * Two further refusals share that reasoning: `--update-snapshots` under
 * structure-only (below), and `.not.toHaveScreenshot()`, which has no truthful
 * answer when nothing is compared and is refused at the matcher.
 *
 * Structure-only is safe in the default local gate because of one property:
 * **it cannot go red because of a Linux-rendered baseline it cannot render.**
 * It compares no pixels, so what is left is the specs' own structural
 * assertions and the setup that reaches them.
 *
 * That is deliberately narrower than "it can never disagree with CI", which
 * would be false. Two residual classes remain, and both are shared with every
 * other spec in the gate rather than introduced here:
 *
 *   - **timeouts under contention.** On `next dev` this is not marginal: 12 of
 *     24 tests failed on `page.goto` alone, purely from route-by-route
 *     compilation. Both entry points build first because of it.
 *   - **two text-metric assertions**, both in `focus-visible.visual.spec.ts`:
 *     `expectRowControlsUnwrapped` (`lines === 1`) and the 390px archived-row
 *     overflow budget. That file records the asymmetry itself — Linux metrics
 *     are the wider ones — so both fail green-local/red-CI, the safe
 *     direction. They pass today; it is a class, not an observed defect.
 *
 * It is not a substitute for the pixel gate and must never be mistaken for one.
 * `test:visual` remains the only thing that compares anything, and
 * `src/__tests__/visual-gate-coverage.test.ts` asserts this mode never reaches
 * it: setting it there would leave the blocking job green while comparing
 * nothing.
 */
export const VISUAL_COMPARE = process.env.VISUAL_REGRESSION === '1'
export const VISUAL_STRUCTURE_ONLY = process.env.VISUAL_STRUCTURE_ONLY === '1'

/** Whether the visual specs run at all, in either mode. */
export const VISUAL_SPECS_ENABLED = VISUAL_COMPARE || VISUAL_STRUCTURE_ONLY

/**
 * Is this run trying to regenerate baselines?
 *
 * Playwright declares the option as `-u, --update-snapshots [mode]`, so the
 * short form has to be matched too. This took two corrections, both found the
 * same way — by running the real CLI rather than reading the predicate:
 *
 *   1. matching only `--update-snapshots` let `-u` through entirely;
 *   2. matching `-u*` still let `-xu` through, because commander CLUSTERS
 *      value-less short options and `-x` (stop after first failure) is one, so
 *      `-xu` parses as `-x --update-snapshots`.
 *
 * Hence the character class rather than a prefix test, and hence its bounds,
 * measured against Playwright 1.60's option table rather than guessed:
 * `-x` is the only value-less short that clusters (`-hu` is rejected as an
 * unknown option), while `-c`, `-g` and `-j` take a REQUIRED value — so `-gu`
 * is `grep "u"`, an ordinary run that must not be refused. A guard that matches
 * one spelling of the thing it forbids reports green on the others (#2827).
 *
 * ## What this deliberately does NOT cover
 *
 * It reads argv, so it sees CLI invocations only. Two other routes reach
 * baseline regeneration and are out of scope by choice, not oversight: the
 * `updateSnapshots` field in `playwright.config.ts` itself, and the
 * test-server `params.updateSnapshots` that UI mode and the VS Code extension
 * use. Neither can CORRUPT a baseline under structure-only — the matcher is
 * replaced wholesale, so nothing is written either way. But corruption is not
 * the hazard this guards: the hazard is a run reporting success having
 * regenerated nothing, and both routes can still produce exactly that. What
 * keeps them out of scope is reachability — getting there means editing the
 * config three lines from this refusal, or running `--ui` with the variable
 * already exported. The boundary is stated rather than
 * implied because this predicate has been corrected three times, and the next
 * correction should start by asking whether the CLASS is right.
 *
 * The enumeration is version-bound: a future Playwright that adds a value-less
 * short option would widen the cluster silently. `package.json` carries a
 * CARET range (`^1.60.0`), so that version can arrive without a diff anyone
 * re-reads — re-check this against the lockfile, not against a bump you expect
 * to see.
 */
const CLUSTERED_UPDATE_SHORT = /^-x*u/

export function isUpdatingSnapshots(argv: readonly string[]): boolean {
  return argv.some((a) => a.startsWith('--update-snapshots') || CLUSTERED_UPDATE_SHORT.test(a))
}

/**
 * The message for a mode combination that must not run, or null when the
 * combination is fine.
 *
 * A pure function rather than an `if` in the config so the suite can hold it to
 * every spelling. These are two of the three things standing between a green run
 * and a comparison that never happened — the third is the
 * `.not.toHaveScreenshot()` refusal, which lives at the matcher in
 * `playwright.config.ts` because it is about one assertion rather than the run.
 * Nothing else in the repository can see any of them (`visual-gate-coverage.test.ts` reads `package.json`
 * script text, which an exported shell variable walks straight past).
 */
export function visualModeRefusal(opts: {
  compare: boolean
  structureOnly: boolean
  argv: readonly string[]
}): string | null {
  if (!opts.structureOnly) return null

  if (opts.compare) {
    return (
      'VISUAL_REGRESSION=1 and VISUAL_STRUCTURE_ONLY=1 are mutually exclusive: the first ' +
      'compares pixels, the second replaces that comparison with a no-op. Together they ' +
      'would report a green pixel gate that compared nothing. Unset one.'
    )
  }

  if (isUpdatingSnapshots(opts.argv)) {
    // Structure-only compares nothing, so it also WRITES nothing: measured, an
    // `--update-snapshots=all` run under this mode produced zero PNGs and
    // exited 0. On the *Update visual baselines* workflow — whose entire job is
    // to regenerate them — that is a silent no-op reported as success, which is
    // worse than a corrupt baseline because nothing looks wrong.
    return (
      'VISUAL_STRUCTURE_ONLY=1 cannot regenerate baselines: it replaces the comparison ' +
      'with a no-op, so --update-snapshots would write nothing and exit 0. Use ' +
      'VISUAL_REGRESSION=1 (Linux only — see the frontend playbook §4).'
    )
  }

  return null
}

/**
 * The `test.skip` reason, so the five specs cannot drift into describing
 * different conditions for the same predicate.
 */
export const VISUAL_SKIP_REASON =
  'Linux-rendered baselines — run via the CI job (or VISUAL_REGRESSION=1 in a Linux container). ' +
  'VISUAL_STRUCTURE_ONLY=1 runs the locators without comparing pixels (#2827).'
