/**
 * The two mode refusals, held to every spelling (#2827).
 *
 * ## Why these are tested at all
 *
 * `VISUAL_STRUCTURE_ONLY=1` replaces the pixel comparison with a no-op. Two
 * combinations turn that from useful into dangerous, and both fail SILENTLY —
 * a green run that compared nothing, which is this repo's #1863 lesson ("a
 * capture that nothing runs is indistinguishable from a capture that always
 * passes") with the failure moved one layer in:
 *
 *   - with `VISUAL_REGRESSION=1`, the blocking *Design visual regression* job
 *     would pass while comparing nothing;
 *   - with `--update-snapshots`, the *Update visual baselines* workflow would
 *     report success having regenerated nothing. Measured before the refusal
 *     existed: zero PNGs written, exit 0.
 *
 * `visual-gate-coverage.test.ts` guards the npm scripts, but a script assertion
 * cannot see an exported shell variable or a workflow-level `env:`. These
 * refusals fire from `playwright.config.ts`, which runs wherever the run does;
 * their logic is here, in `e2e/support/visual-mode.ts`. Nothing protected them:
 * delete either branch and every check stayed green. Hence this file.
 *
 * A third refusal — `.not.toHaveScreenshot()` — stays at the matcher in
 * `playwright.config.ts`, because it is about one assertion rather than the
 * run, and is not reachable from here.
 *
 * ## Why the flag spellings get their own cases
 *
 * The first version of the `--update-snapshots` refusal matched only the long
 * form. Playwright declares `-u, --update-snapshots [mode]`, so `-u` bypassed
 * it entirely — `playwright test -u --list` exited 0 and listed every test,
 * the guard silent on precisely the case it exists for. Each spelling below is
 * one that was, or could have been, missed.
 */
import { describe, expect, it } from 'vitest'
import { isUpdatingSnapshots, visualModeRefusal } from '../../e2e/support/visual-mode'

// Imported directly, with no `as` casts: the frontend tsconfig covers `e2e/`
// too, so a signature change in visual-mode.ts reddens HERE rather than
// compiling against a re-declared shape.
const updating = isUpdatingSnapshots
const refusal = visualModeRefusal

const ARGV = ['node', 'playwright', 'test']

describe('isUpdatingSnapshots covers every spelling Playwright accepts (#2827)', () => {
  it.each([
    ['-u', ['-u']],
    ['-u all', ['-u', 'all']],
    ['-uall', ['-uall']],
    ['--update-snapshots', ['--update-snapshots']],
    ['--update-snapshots=all', ['--update-snapshots=all']],
    ['--update-snapshots changed', ['--update-snapshots', 'changed']],
    // commander clusters value-less shorts: -x is "stop after first failure",
    // so -xu parses as `-x --update-snapshots`. Measured bypassing the guard.
    ['-xu (clustered behind -x)', ['-xu']],
    ['-xuall', ['-xuall']],
  ])('detects %s', (_label, args) => {
    expect(updating([...ARGV, ...(args as string[])])).toBe(true)
  })

  it.each([
    ['no flags', []],
    ['--ui, which merely starts with a dash-u-ish prefix', ['--ui']],
    ['--updates', ['--updates']],
    ['a spec filter', ['design-system.visual.spec.ts']],
    // -g takes a REQUIRED value, so this is grep "u" — an ordinary run.
    ['-gu, which is grep "u" and not an update', ['-gu']],
    ['-ju, which is workers "u"', ['-ju']],
  ])('does not fire on %s', (_label, args) => {
    expect(updating([...ARGV, ...(args as string[])])).toBe(false)
  })
})

describe('visualModeRefusal (#2827)', () => {
  it('refuses structure-only together with the pixel gate', () => {
    expect(refusal({ compare: true, structureOnly: true, argv: ARGV })).toMatch(/mutually exclusive/)
  })

  it('refuses baseline regeneration under structure-only, in every spelling', () => {
    for (const flag of ['-u', '-uall', '--update-snapshots', '--update-snapshots=all']) {
      expect(
        refusal({ compare: false, structureOnly: true, argv: [...ARGV, flag] }),
        `${flag} was not refused`,
      ).toMatch(/cannot regenerate baselines/)
    }
  })

  it('allows the pixel gate to regenerate — the workflow this must not break', () => {
    expect(
      refusal({ compare: true, structureOnly: false, argv: [...ARGV, '--update-snapshots=all'] }),
    ).toBeNull()
  })

  it('allows each mode on its own, and the default', () => {
    expect(refusal({ compare: false, structureOnly: true, argv: ARGV })).toBeNull()
    expect(refusal({ compare: true, structureOnly: false, argv: ARGV })).toBeNull()
    expect(refusal({ compare: false, structureOnly: false, argv: ARGV })).toBeNull()
  })
})
