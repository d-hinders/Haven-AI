/**
 * Unit cover for capture retention (#1888).
 *
 * The defect: `npm run screenshot` opened every run with `rm -rf .screenshots/`,
 * so a narrow `--scenario=X` pass after a wide one destroyed the wide one — and
 * during #1879's design review it did, twice, taking the review's largest claim
 * with it.
 *
 * A retention fix whose only test is "the file still exists" has not tested the
 * part that matters, so this file asserts BOTH directions:
 *
 *   1. the previous run survives a second run and is IDENTIFIABLE as the
 *      previous one — a stale directory that reads as fresh is worse than a
 *      deleted one, because somebody attaches it;
 *   2. nothing that consumed the literal `.screenshots/<name>.png` path is now
 *      reading a stale directory — the archived run is moved OFF that path, not
 *      left mixed in with the fresh PNGs.
 *
 * Those two are mutually exclusive under the two obvious wrong implementations
 * (keep the `rm -rf`; archive by COPY instead of MOVE), which is what makes them
 * worth writing separately. The PR body carries the mutation matrix.
 *
 * Real filesystem, real temp dir — the whole subject of the module is what is on
 * disk, and a mocked `fs` would make every assertion here a restatement of the
 * implementation.
 */
import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs, shared with the screenshot script
import {
  ARCHIVE_DIR_NAME,
  DEFAULT_KEEP_RUNS,
  MANIFEST_NAME,
  resolveKeepRuns,
  retainPreviousRun,
  runDirName,
} from '../../scripts/capture-retention.mjs'

const IDENTITY_A = {
  worktree: '/Users/dev/Haven-AI',
  branch: 'dev',
  commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  dirty: false,
}
const IDENTITY_B = {
  worktree: '/Users/dev/Haven-AI',
  branch: 'fix/1888-screenshot-run-retention',
  commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  dirty: true,
}

let outDir: string

beforeEach(async () => {
  outDir = path.join(await mkdtemp(path.join(os.tmpdir(), 'haven-retention-')), '.screenshots')
})
afterEach(async () => {
  await rm(path.dirname(outDir), { recursive: true, force: true })
})

/** Simulate a completed capture run: PNGs plus the #1800 provenance manifest. */
async function seedRun(files: string[], manifest: Record<string, unknown> | null) {
  await mkdir(outDir, { recursive: true })
  for (const f of files) await writeFile(path.join(outDir, f), `png:${f}`, 'utf8')
  if (manifest) {
    await writeFile(path.join(outDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }
}

async function listNames(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort()
}

async function readJson(file: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(file, 'utf8'))
}

/**
 * The archive directory a result names, asserting it exists first.
 *
 * `archived` is legitimately `string | null` — a first-ever run displaces
 * nothing — so every use here would otherwise need its own narrowing. Asserting
 * once, here, keeps `expect(result.archived).toBeTruthy()` as a real assertion in
 * the tests that are about retention happening, instead of a type ceremony
 * repeated in tests that are about something else.
 */
function archiveOf(result: { archived: string | null }): string {
  expect(result.archived).toBeTruthy()
  return path.join(outDir, ARCHIVE_DIR_NAME, result.archived as string)
}

describe('retainPreviousRun — direction 1: the previous run survives and says so', () => {
  it('keeps the previous run addressable while the current one exists', async () => {
    await seedRun(['design-system-desktop.png', 'agents-mobile.png'], {
      branch: 'dev',
      commit: IDENTITY_A.commit,
      files: ['.screenshots/design-system-desktop.png'],
    })

    const result = await retainPreviousRun(outDir, { identity: IDENTITY_B })

    // THE assertion for acceptance criterion 1. If retention regresses to
    // `rm -rf`, this is the line that fires.
    expect(result.archived).toBeTruthy()
    const archived = archiveOf(result)
    expect(await listNames(archived)).toEqual([
      MANIFEST_NAME,
      'agents-mobile.png',
      'design-system-desktop.png',
    ].sort())
    expect(await readFile(path.join(archived, 'design-system-desktop.png'), 'utf8')).toBe(
      'png:design-system-desktop.png',
    )
  })

  it('names the archived run by timestamp + the commit it rendered, dirty flagged', () => {
    const at = new Date('2026-08-23T12:34:56.789Z')
    expect(runDirName(IDENTITY_A, at)).toBe('20260823T123456Z-aaaaaaaaaaaa')
    expect(runDirName(IDENTITY_B, at)).toBe('20260823T123456Z-bbbbbbbbbbbb-dirty')
    // Lexical order is chronological order — the prune depends on it.
    expect(runDirName(IDENTITY_A, new Date('2026-08-23T12:34:55.000Z')) < runDirName(IDENTITY_A, at)).toBe(true)
  })

  it('stamps the archived manifest stale and names what displaced it', async () => {
    await seedRun(['agents-desktop.png'], {
      branch: 'dev',
      commit: IDENTITY_A.commit,
      identity_verified: true,
      port: 3117,
    })

    const result = await retainPreviousRun(outDir, { identity: IDENTITY_B })
    const manifest = await readJson(
      path.join(archiveOf(result), MANIFEST_NAME),
    )

    // Self-identifying, in the manifest that is "the claim that they are yours".
    expect(manifest.stale).toBe(true)
    expect(manifest.superseded_by).toEqual({
      branch: IDENTITY_B.branch,
      commit: IDENTITY_B.commit,
      dirty: true,
    })
    expect(manifest.archived_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(manifest.run_id).toBe(result.archived)
    expect(String(manifest.stale_note)).toContain('NOT the current run')
    // #1800's provenance is preserved, not replaced — an archived run must
    // still be traceable to the commit it actually rendered.
    expect(manifest.commit).toBe(IDENTITY_A.commit)
    expect(manifest.identity_verified).toBe(true)
    expect(manifest.port).toBe(3117)
  })

  it("re-points the archived manifest's own file list at the archive, not the live run", async () => {
    // Found on the first real two-run proof, not by reasoning. The manifest
    // records repo-root-relative paths, so after the move they resolve into the
    // CURRENT run's directory — and `design-system-mobile.png` existed in both
    // runs, so following the archived manifest's `files` landed on a different
    // run's PNG under the same name. The provenance record reintroducing the
    // provenance defect is the worst version of this bug.
    await seedRun(['design-system-mobile.png'], {
      commit: IDENTITY_A.commit,
      files: ['.screenshots/design-system-mobile.png', '.screenshots/agents-desktop.png'],
    })

    const result = await retainPreviousRun(outDir, { identity: IDENTITY_B })
    const manifest = await readJson(
      path.join(archiveOf(result), MANIFEST_NAME),
    )

    expect(manifest.files).toEqual([
      `.screenshots/${ARCHIVE_DIR_NAME}/${result.archived}/design-system-mobile.png`,
      `.screenshots/${ARCHIVE_DIR_NAME}/${result.archived}/agents-desktop.png`,
    ])
    // The original list is not lost — it is what the run itself claimed.
    expect(manifest.files_at_capture).toEqual([
      '.screenshots/design-system-mobile.png',
      '.screenshots/agents-desktop.png',
    ])
    // And no relocated path may collide with the live directory.
    for (const f of manifest.files) {
      expect(f.startsWith(`.screenshots/${ARCHIVE_DIR_NAME}/`)).toBe(true)
    }
  })

  it('leaves no `partial` claim behind once the move completes', async () => {
    // The directory is claimed with `partial: true` BEFORE the rename loop, so a
    // half-moved archive is never unmarked. A completed move must clear it —
    // otherwise every archive would read as a failure and the marker would mean
    // nothing, which is the same "gate that is always red" trap #1879 avoided.
    await seedRun(['a.png'], { commit: IDENTITY_A.commit })
    const r1 = await retainPreviousRun(outDir, { identity: IDENTITY_B })
    const withManifest = await readJson(
      path.join(archiveOf(r1), MANIFEST_NAME),
    )
    expect(withManifest.partial).toBeUndefined()
    expect(withManifest.claim).toBeUndefined()
    expect(withManifest.commit).toBe(IDENTITY_A.commit)

    // Same for the manifest-less run: the claim must not be mistaken for the
    // previous run's own record and carry `partial` onto a completed move.
    await writeFile(path.join(outDir, 'b.png'), 'png:b', 'utf8')
    const r2 = await retainPreviousRun(outDir, { identity: IDENTITY_B })
    const noManifest = await readJson(
      path.join(archiveOf(r2), MANIFEST_NAME),
    )
    expect(noManifest.partial).toBeUndefined()
    expect(noManifest.claim).toBeUndefined()
    expect(noManifest.provenance).toBe('unknown')
    expect(String(noManifest.provenance_note)).toContain('UNKNOWN')
  })

  it('leaves a `files` entry alone when it has no directory to re-point', async () => {
    // The relocation assumes `.screenshots/x.png`. A bare filename would make
    // `dirname` return '.' and silently yield a path missing its top segment —
    // a mangled path that looks authoritative. An untouched original is better.
    await seedRun(['a.png'], { commit: IDENTITY_A.commit, files: ['a.png'] })
    const result = await retainPreviousRun(outDir, { identity: IDENTITY_B })
    const manifest = await readJson(
      path.join(archiveOf(result), MANIFEST_NAME),
    )
    expect(manifest.files).toEqual(['a.png'])
  })

  it('does not let a crashed run inherit silence: no manifest means an explicit unknown', async () => {
    // A run interrupted before `main()` wrote its manifest. Bare `rename` would
    // leave a directory of plausible PNGs making NO claim — indistinguishable
    // from a fresh capture to a reviewer who opens it.
    await seedRun(['connect-agent-waiting-slow-mobile.png'], null)

    const result = await retainPreviousRun(outDir, { identity: IDENTITY_B })
    const manifest = await readJson(
      path.join(archiveOf(result), MANIFEST_NAME),
    )

    expect(manifest.stale).toBe(true)
    expect(manifest.provenance).toBe('unknown')
    expect(String(manifest.provenance_note)).toContain('UNKNOWN')
    expect(manifest.commit).toBeUndefined()
  })
})

describe('retainPreviousRun — direction 2: the literal path still means the NEWEST run', () => {
  it('leaves no stale PNG on the path every consumer reads', async () => {
    // `.claude/agents/haven-design-reviewer.md`, the design-reviewer role, the
    // frontend playbook and the PR template all name `.screenshots/<name>.png`.
    // Archiving by COPY rather than MOVE would satisfy every direction-1
    // assertion above and mix a previous commit's PNGs into that glob — the
    // #1800 provenance failure in a new costume. This is the line that fires.
    await seedRun(['design-system-desktop.png', 'agents-mobile.png'], { commit: IDENTITY_A.commit })

    await retainPreviousRun(outDir, { identity: IDENTITY_B })

    expect(await listNames(outDir)).toEqual([ARCHIVE_DIR_NAME])
    const stray = (await listNames(outDir)).filter((n) => n.endsWith('.png'))
    expect(stray).toEqual([])
  })

  it('leaves the capture directory itself in place and writable for the flat run', async () => {
    await seedRun(['agents-desktop.png'], { commit: IDENTITY_A.commit })
    await retainPreviousRun(outDir, { identity: IDENTITY_B })
    // The current run writes here, unchanged, so `.screenshots/x.png` resolves.
    await writeFile(path.join(outDir, 'agents-desktop.png'), 'fresh', 'utf8')
    expect(await readFile(path.join(outDir, 'agents-desktop.png'), 'utf8')).toBe('fresh')
  })

  it('archiveNeverRestores: nothing moves archive → live', async () => {
    // Load-bearing for the `SCROLL_SHELL_ROOT` flake. The harness DELETES its own
    // blank captures (#1738) and a nondeterministic blank hit two viewports in one
    // day; any design that repopulated the live directory from an archive could put
    // a blank back on the path a reviewer reads.
    await seedRun(['a-desktop.png'], { commit: IDENTITY_A.commit })
    await retainPreviousRun(outDir, { identity: IDENTITY_B })
    // Run 2 captured only ONE scenario and the blank was deleted mid-run.
    await writeFile(path.join(outDir, 'b-desktop.png'), 'png:b', 'utf8')
    await retainPreviousRun(outDir, { identity: IDENTITY_A })

    expect(await listNames(outDir)).toEqual([ARCHIVE_DIR_NAME])
    // `a-desktop.png` is in an archive, and stayed there.
    const runs = await listNames(path.join(outDir, ARCHIVE_DIR_NAME))
    expect(runs).toHaveLength(2)
    const all = (
      await Promise.all(runs.map((r) => listNames(path.join(outDir, ARCHIVE_DIR_NAME, r))))
    ).flat()
    expect(all.filter((n) => n === 'a-desktop.png')).toHaveLength(1)
  })

  it('does not nest the archive inside itself on every run', async () => {
    await seedRun(['a.png'], { commit: IDENTITY_A.commit })
    await retainPreviousRun(outDir, { identity: IDENTITY_B })
    await writeFile(path.join(outDir, 'b.png'), 'png:b', 'utf8')
    await retainPreviousRun(outDir, { identity: IDENTITY_A })

    const runs = await listNames(path.join(outDir, ARCHIVE_DIR_NAME))
    for (const r of runs) {
      expect(await listNames(path.join(outDir, ARCHIVE_DIR_NAME, r))).not.toContain(ARCHIVE_DIR_NAME)
    }
  })
})

describe('retainPreviousRun — the disk cap', () => {
  async function runN(n: number, keep?: number) {
    for (let i = 0; i < n; i += 1) {
      await mkdir(outDir, { recursive: true })
      await writeFile(path.join(outDir, `run-${i}.png`), `png:${i}`, 'utf8')
      await retainPreviousRun(outDir, {
        identity: { ...IDENTITY_A, commit: `${i}`.repeat(40) },
        keep,
        // Distinct, ordered stamps — the prune sorts by name.
        now: () => new Date(Date.parse('2026-08-23T00:00:00.000Z') + i * 60_000),
      })
    }
  }

  it('retains at most `keep` previous runs, pruning oldest first', async () => {
    await runN(6, 2)
    const runs = await listNames(path.join(outDir, ARCHIVE_DIR_NAME))
    expect(runs).toHaveLength(2)
    // The two most recent survive; runs 0-3 are gone.
    expect(runs[0]).toContain('444444444444')
    expect(runs[1]).toContain('555555555555')
  })

  it('defaults to three, which is what a control + candidate + re-run needs', async () => {
    expect(DEFAULT_KEEP_RUNS).toBe(3)
    await runN(6)
    expect(await listNames(path.join(outDir, ARCHIVE_DIR_NAME))).toHaveLength(3)
  })

  it('--keep=0 restores the pre-#1888 destructive behaviour exactly', async () => {
    await runN(3)
    expect(await listNames(path.join(outDir, ARCHIVE_DIR_NAME))).not.toHaveLength(0)
    await mkdir(outDir, { recursive: true })
    await writeFile(path.join(outDir, 'x.png'), 'x', 'utf8')

    const result = await retainPreviousRun(outDir, { identity: IDENTITY_A, keep: 0 })

    expect(result.archived).toBeNull()
    expect(await listNames(outDir)).toEqual([])
  })

  it('is a no-op on a first-ever run', async () => {
    const result = await retainPreviousRun(outDir, { identity: IDENTITY_A })
    expect(result).toMatchObject({ archived: null, files: [], pruned: [] })
    expect(await listNames(outDir)).toEqual([])
  })

  it('does not interleave two runs that land in the same second on the same commit', async () => {
    const now = () => new Date('2026-08-23T12:00:00.000Z')
    await seedRun(['a.png'], null)
    await retainPreviousRun(outDir, { identity: IDENTITY_A, now })
    await writeFile(path.join(outDir, 'b.png'), 'png:b', 'utf8')
    await retainPreviousRun(outDir, { identity: IDENTITY_A, now })

    const runs = await listNames(path.join(outDir, ARCHIVE_DIR_NAME))
    expect(runs).toHaveLength(2)
    for (const r of runs) {
      const files = (await listNames(path.join(outDir, ARCHIVE_DIR_NAME, r))).filter((f) =>
        f.endsWith('.png'),
      )
      expect(files).toHaveLength(1) // never {a.png, b.png} in one directory
    }
  })
})

describe('resolveKeepRuns', () => {
  it('reads --keep=, then SCREENSHOT_KEEP_RUNS, then the default', () => {
    expect(resolveKeepRuns(['--keep=7'], {})).toBe(7)
    expect(resolveKeepRuns([], { SCREENSHOT_KEEP_RUNS: '1' })).toBe(1)
    expect(resolveKeepRuns(['--keep=7'], { SCREENSHOT_KEEP_RUNS: '1' })).toBe(7)
    expect(resolveKeepRuns([], {})).toBe(DEFAULT_KEEP_RUNS)
  })

  it('never throws on a mistyped flag — an evidence CLI must still capture', () => {
    // Trading a real defect for a manufactured one is not an improvement.
    expect(resolveKeepRuns(['--keep=lots'], {})).toBe(DEFAULT_KEEP_RUNS)
    expect(resolveKeepRuns(['--keep='], {})).toBe(DEFAULT_KEEP_RUNS)
    expect(resolveKeepRuns(['--keep=2.5'], {})).toBe(DEFAULT_KEEP_RUNS)
    expect(resolveKeepRuns(['--keep=-3'], {})).toBe(0)
  })

  it('is not confused by a route argument', () => {
    expect(resolveKeepRuns(['/agents', '--scenario=all'], {})).toBe(DEFAULT_KEEP_RUNS)
  })
})

describe('the capture directory itself is unchanged (the consumer contract)', () => {
  it('screenshot.mjs still writes flat into `.screenshots/`', async () => {
    // Every consumer of this evidence names the literal path and NONE of them is
    // code, so nothing else in this repo fails when they go stale:
    //   .claude/agents/haven-design-reviewer.md
    //   .agents/skills/haven-agent-workflow/references/design-reviewer.md
    //   docs/contributing/ship-playbooks/frontend.md  (§4)
    //   docs/contributing/pr-workflow-checklist.md
    //   .github/pull_request_template.md
    // This is a source assertion and its limit is honest: it proves the output
    // root was not moved under a `latest` indirection, not that any individual
    // PNG name is unchanged.
    const here = path.dirname(fileURLToPath(import.meta.url))
    const src = await readFile(path.join(here, '..', '..', 'scripts', 'screenshot.mjs'), 'utf8')
    expect(src).toContain("const OUT_DIR = path.join(ROOT, '.screenshots')")
    expect(src).toContain('const MANIFEST = path.join(OUT_DIR, ')
    // And the destructive open is gone.
    expect(src).not.toContain('await rm(OUT_DIR, { recursive: true, force: true })')
  })
})
