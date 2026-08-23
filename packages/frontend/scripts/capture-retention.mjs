/**
 * Capture retention: keep the PREVIOUS run addressable while the current one
 * exists (#1888).
 *
 * The defect this closes: `npm run screenshot` opened every run with
 * `rm -rf .screenshots/`, so the normal shape of iterating — a narrow
 * `--scenario=connect-agent` after a wide `--scenario=all` — destroyed the wider
 * run unconditionally. During #1879's `haven-design-reviewer` pass that cost the
 * review something concrete: both the candidate and the control directories were
 * overwritten in place (70 PNGs down to 24, 48 down to 16), the run's summary log
 * described a set that no longer existed on disk, and the reviewer could not
 * visually confirm the highest-stakes screen in the batch. It refused to sign off
 * by inference and returned it as an open item.
 *
 * ── Why the run keeps writing to a FLAT `.screenshots/` ──────────────────────
 * The obvious shape is `.screenshots/runs/<id>/` plus a `latest` symlink. It was
 * rejected, and the reason is the consumer list rather than taste. Every
 * instruction that reaches these artifacts names the literal path:
 * `.claude/agents/haven-design-reviewer.md`,
 * `.agents/skills/haven-agent-workflow/references/design-reviewer.md`,
 * `docs/contributing/ship-playbooks/frontend.md` (§4, four separate places),
 * `docs/contributing/pr-workflow-checklist.md` and `.github/pull_request_template.md`.
 * None of them is code, so nothing would fail when they went stale — a
 * design-reviewer agent handed a path that no longer holds PNGs reports "no
 * screenshots attached" as its first finding, which is the review failing
 * silently in the same way #1888 already failed it once.
 *
 * So the direction is inverted: the CURRENT run keeps the literal path, and the
 * PREVIOUS run is moved aside into `.screenshots/previous/<run-id>/`. Existing
 * consumers are correct without being touched, and the newest run is what they
 * see, always.
 *
 * ── A moved-aside run must SAY it is stale ───────────────────────────────────
 * Retention creates a failure mode the `rm -rf` did not have: two directories of
 * plausible PNGs, one of them wrong. Attaching last run's PNGs believing they are
 * this run's is worse than losing the files, because the provenance work of #1800
 * exists precisely to stop that. So archiving is not a bare `rename`: the
 * archived directory's `capture-manifest.json` is stamped with `stale: true`,
 * `archived_at`, `run_id` and `superseded_by` (the branch/commit that displaced
 * it), its `files` list is re-pointed at the archive, and a run that left NO
 * manifest behind — a crash, an interrupt — gets a stub that says so rather than
 * inheriting silence. The manifest is the claim that these PNGs are yours; an
 * archived one has to claim the opposite.
 *
 * The move itself is a loop of renames and is therefore NOT atomic, so the
 * directory is claimed with a `partial: true` manifest BEFORE anything is moved
 * into it and re-stamped once the move completes. A half-moved directory with no
 * manifest at all would be worse than the crashed-run case above: an unmarked
 * pile of plausible PNGs sitting next to properly stamped ones, in a scheme whose
 * whole premise is that the manifest can be trusted.
 *
 * ── Retention never RESTORES ─────────────────────────────────────────────────
 * Archiving is strictly one-directional: live → archive, never archive → live.
 * This is load-bearing, not incidental. The harness deletes its own bad evidence
 * (a `goto` failure writes no PNG; a capture blank below the fold is deleted and
 * fails the run, #1738), and the `SCROLL_SHELL_ROOT` flake is nondeterministic —
 * it hit two different viewports the same day. Any design that repopulated the
 * live directory from an archive could put a blank, or a PNG the harness had
 * already judged worthless, back on the path a reviewer reads. It cannot happen
 * here because nothing ever moves that way, and `archiveNeverRestores` in the
 * test asserts it rather than trusting the prose.
 *
 * ── Disk ─────────────────────────────────────────────────────────────────────
 * `.screenshots/` is gitignored, but the machine running this has already
 * accumulated tens of GB of agent worktrees, so retention is capped rather than
 * unbounded: DEFAULT_KEEP_RUNS previous runs, oldest pruned first. `--keep=<n>`
 * (or `SCREENSHOT_KEEP_RUNS`) overrides it, and `--keep=0` restores the old
 * `rm -rf` behaviour exactly, for a disk-pinched machine that wants it — note
 * that it prunes to zero the same way `--keep=2` prunes to two, so it discards
 * the accumulated archive and not merely this run's predecessor.
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Where displaced runs live, relative to the capture directory. */
export const ARCHIVE_DIR_NAME = 'previous'

/** The per-run provenance file (#1800), stamped on archive. */
export const MANIFEST_NAME = 'capture-manifest.json'

/**
 * How many previous runs survive by default.
 *
 * Three, not one: the same-code control technique compares a candidate run
 * against a control run, and diagnosing a difference routinely means holding the
 * control, the candidate, and the re-run that reproduces it. One would make the
 * second comparison destroy the first — the defect again, one run further along.
 * A `--scenario=all` run is ~70 PNGs, so three is a bounded cost on a machine
 * that is already short of disk.
 */
export const DEFAULT_KEEP_RUNS = 3

/**
 * The run identity #1800 stamps into the manifest, as much of it as retention
 * needs. Declared because `tsc --noEmit` type-checks this repo's `.mjs` scripts
 * through their JSDoc, and an `identity = null` default with no annotation infers
 * the parameter as `null | undefined` — every caller passing a real identity then
 * fails `typecheck` while `vitest` stays green, because JS execution is untyped.
 * That is a required CI check going red on code the test suite cannot see, so the
 * annotation is load-bearing rather than decorative.
 *
 * @typedef {object} RunIdentity
 * @property {string} [worktree]
 * @property {string} [branch]
 * @property {string} [commit]
 * @property {boolean} [dirty]
 */

/**
 * The run-id a capture directory is archived under: sortable timestamp + the
 * commit it rendered, so `ls previous/` reads as history without opening a
 * manifest, and lexical order IS chronological order (which is what the prune
 * below relies on).
 *
 * @param {RunIdentity | null | undefined} identity
 * @param {Date} [now]
 * @returns {string}
 */
export function runDirName(identity, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const commit = typeof identity?.commit === 'string' ? identity.commit.slice(0, 12) : 'unknown'
  return `${stamp}-${commit}${identity?.dirty ? '-dirty' : ''}`
}

/**
 * Resolve the keep count from argv and the environment.
 *
 * Returns DEFAULT_KEEP_RUNS for anything absent or unparseable rather than
 * throwing: this is an evidence CLI, and refusing to capture because a retention
 * flag was mistyped would trade a real defect for a manufactured one. A negative
 * is clamped to 0 (= the old destructive behaviour), which is the only way to ask
 * for it.
 */
export function resolveKeepRuns(argv = [], env = {}) {
  const flag = argv.filter((a) => typeof a === 'string' && a.startsWith('--keep=')).pop()
  const raw = flag ? flag.slice('--keep='.length) : env.SCREENSHOT_KEEP_RUNS
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_KEEP_RUNS
  const n = Number(String(raw).trim())
  if (!Number.isFinite(n) || !Number.isInteger(n)) return DEFAULT_KEEP_RUNS
  return Math.max(0, n)
}

async function listDir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (err && err.code === 'ENOENT') return null
    throw err
  }
}

/**
 * Stamp the archived directory's manifest so the directory is self-identifying.
 *
 * Two cases, and the second is the one that matters. A run that completed left a
 * `capture-manifest.json` describing branch/commit/dirty/port/identity — that
 * object is preserved verbatim and gains the staleness fields on top, so nothing
 * #1800 recorded is lost. A run that did NOT complete left no manifest at all,
 * and inheriting that silence would leave a directory of plausible PNGs with no
 * claim attached — indistinguishable, to a reviewer, from a fresh capture. It
 * gets a stub that says exactly what is unknown about it.
 */
async function stampArchivedManifest(archiveDir, { runId, archivedAt, supersededBy }) {
  const manifestPath = path.join(archiveDir, MANIFEST_NAME)
  let base = null
  try {
    base = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch {
    base = null
  }
  // A leftover CLAIM is not a manifest. The claim written before the move is
  // overwritten by the real manifest when the previous run had one; when it did
  // not, the claim is what is still sitting here, and treating it as `base`
  // would carry `partial: true` onto a move that in fact completed. Drop it and
  // fall through to the crashed-run stub, which is the honest description.
  if (base && base.claim === true) base = null
  // Re-point `files` at where the PNGs actually ARE now. This is not tidiness:
  // the manifest records paths relative to the repo root (`.screenshots/x.png`),
  // and after the move those paths resolve to the CURRENT run's directory. A
  // reader following the archived manifest's own file list would land on a
  // different run's PNG under the same name — measured on the first real
  // two-run proof, where `design-system-mobile.png` existed in both. That is the
  // precise failure this change exists to prevent, reintroduced by the record
  // that is supposed to prevent it, so the original list is kept verbatim under
  // `files_at_capture` and `files` is rewritten.
  //
  // The rewrite assumes each entry is a repo-root-relative path with a directory
  // part (`.screenshots/x.png`), which is what `screenshot.mjs` records. A bare
  // filename would make `path.posix.dirname` return `'.'` and silently produce
  // `previous/<id>/x.png` — a path missing its top segment, which resolves
  // nowhere and reports nothing. An entry that is not a rooted path is therefore
  // left ALONE rather than half-rewritten: an untouched path that is obviously
  // the original beats a mangled one that looks authoritative.
  const relocated =
    Array.isArray(base?.files) && base.files.length > 0
      ? base.files.map((f) => {
          if (typeof f !== 'string') return f
          const dir = path.posix.dirname(f)
          if (dir === '.' || dir === '/' || dir === '') return f
          return path.posix.join(dir, ARCHIVE_DIR_NAME, runId, path.posix.basename(f))
        })
      : null

  const stale = {
    ...(base ?? {}),
    ...(relocated ? { files: relocated, files_at_capture: base.files } : {}),
    stale: true,
    run_id: runId,
    archived_at: archivedAt,
    superseded_by: supersededBy,
    ...(base
      ? {}
      : {
          provenance: 'unknown',
          provenance_note:
            'This run left no capture-manifest.json, so the branch, commit and server ' +
            'identity behind these PNGs are UNKNOWN — the run did not reach the end of ' +
            'main() (a crash, an interrupt, or a failed capture). Do not attach them as ' +
            'evidence for any commit; re-run the capture instead.',
        }),
    stale_note:
      'ARCHIVED by a later capture run (#1888). These PNGs are NOT the current run. ' +
      `The run that displaced them is described by ../../${MANIFEST_NAME}.`,
  }
  await writeFile(manifestPath, `${JSON.stringify(stale, null, 2)}\n`, 'utf8')
  return stale
}

/**
 * Prune archived runs to `keep`, oldest first.
 *
 * Sorts by directory NAME, which `runDirName` makes chronological. Deliberately
 * not by mtime: a `rename` carries the source directory's mtime on some
 * filesystems and not others, and a retention policy that depends on which one
 * you are on is a policy that behaves differently on CI than on a laptop.
 */
async function pruneArchive(archiveRoot, keep) {
  const entries = await listDir(archiveRoot)
  if (!entries) return []
  const runs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
  // `keep` is always >= 1 here — `retainPreviousRun` returns before this on
  // `keep <= 0`. The branch that handled 0 was unreachable through the public
  // API and untested, so it read as load-bearing while proving nothing; removed
  // rather than left as decoration a later reader has to re-derive.
  const doomed = runs.slice(0, Math.max(0, runs.length - keep))
  for (const name of doomed) {
    await rm(path.join(archiveRoot, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
  return doomed
}

/**
 * Move whatever is currently in `outDir` aside, then leave `outDir` empty and
 * ready for this run to write into it FLAT.
 *
 * `keep === 0` means "retain zero previous runs", which is the pre-#1888
 * behaviour: the whole capture directory goes, accumulated archive included.
 * That is the same rule every other value obeys — `keep === 2` also prunes down
 * to two — but it is worth stating out loud, because it destroys history a
 * teammate may be holding under the default policy, and "just this once, disk is
 * tight" is exactly when someone reaches for it.
 *
 * Returns `{ archived, files, pruned, keep }`, where `archived` is the run-id
 * directory name or `null` when there was nothing to displace.
 *
 * @param {string} outDir
 * @param {{ identity?: RunIdentity | null, keep?: number, now?: () => Date }} [options]
 * @returns {Promise<{ archived: string | null, files: string[], pruned: string[], keep: number }>}
 */
export async function retainPreviousRun(
  outDir,
  { identity = null, keep = DEFAULT_KEEP_RUNS, now = () => new Date() } = {},
) {
  const archiveRoot = path.join(outDir, ARCHIVE_DIR_NAME)

  if (keep <= 0) {
    await rm(outDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    await mkdir(outDir, { recursive: true })
    return { archived: null, files: [], pruned: [], keep }
  }

  const entries = await listDir(outDir)
  if (!entries) {
    await mkdir(outDir, { recursive: true })
    return { archived: null, files: [], pruned: [], keep }
  }

  // Everything except the archive itself. Excluding it by name is what stops the
  // archive being nested inside itself one level deeper on every run.
  const live = entries.filter((e) => e.name !== ARCHIVE_DIR_NAME)

  let archived = null
  let files = []
  if (live.length > 0) {
    const at = now()
    let runId = runDirName(identity, at)
    // Two runs inside the same second on the same commit is rare and not
    // impossible; a collision would `rename` into an existing directory and
    // interleave two runs' PNGs, which is the mixed-provenance failure this
    // change exists to prevent, not a tidiness problem.
    const existing = new Set(((await listDir(archiveRoot)) ?? []).map((e) => e.name))
    if (existing.has(runId)) {
      let n = 2
      while (existing.has(`${runId}.${n}`)) n += 1
      runId = `${runId}.${n}`
    }
    const archiveDir = path.join(archiveRoot, runId)
    await mkdir(archiveRoot, { recursive: true })
    // `recursive: false` on the run directory itself, deliberately: the name
    // check above is a TOCTOU snapshot, and a second writer in this worktree
    // (a stuck earlier run, a re-triggered agent) could pass it for the same
    // second and commit. `recursive: true` would silently succeed for both and
    // interleave two runs' PNGs under one manifest — mixed provenance, which is
    // the failure this whole change exists to prevent. EEXIST here fails the run
    // loudly instead, which is the right trade for an evidence tool. The
    // one-server-per-worktree guard (#1800) would also catch this, but it runs
    // AFTER retention, so it cannot be what protects this step.
    await mkdir(archiveDir)

    const supersededBy = {
      branch: identity?.branch ?? null,
      commit: identity?.commit ?? null,
      dirty: identity?.dirty ?? null,
    }

    // Claim the directory BEFORE moving anything into it. The move is a loop of
    // renames and is not atomic: an EPERM, a full disk, or a file locked by an
    // editor part-way through leaves a SUBSET of the previous run in a directory
    // that — if the stamp only happened afterwards — would carry no manifest at
    // all. That is worse than the crashed-run case this module already handles,
    // because it is an unmarked directory of plausible PNGs sitting beside
    // properly stamped ones that reviewers are told to trust the manifest of.
    // The claim is overwritten by the real stamp once the move completes, so the
    // `partial: true` state is only ever observed on a genuine failure.
    await writeFile(
      path.join(archiveDir, MANIFEST_NAME),
      `${JSON.stringify(
        {
          stale: true,
          partial: true,
          claim: true,
          run_id: runId,
          archived_at: at.toISOString(),
          superseded_by: supersededBy,
          provenance: 'unknown',
          provenance_note:
            'ARCHIVING WAS INTERRUPTED. This directory holds only PART of the run it ' +
            'names, and the run\'s own capture-manifest.json — the record of which ' +
            'branch, commit and server produced these PNGs — may not have been moved ' +
            'with them. Do not attach anything here as evidence; re-run the capture.',
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    for (const entry of live) {
      await rename(path.join(outDir, entry.name), path.join(archiveDir, entry.name))
    }
    files = live.map((e) => e.name).sort()
    await stampArchivedManifest(archiveDir, {
      runId,
      archivedAt: at.toISOString(),
      supersededBy,
    })
    archived = runId
  }

  const pruned = await pruneArchive(archiveRoot, keep)
  await mkdir(outDir, { recursive: true })
  return { archived, files, pruned, keep }
}
