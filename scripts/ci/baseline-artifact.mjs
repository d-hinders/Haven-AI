#!/usr/bin/env node
/**
 * Before/after images of every baseline a regeneration rewrote (#3234, epic
 * #3231 slice 3).
 *
 * Why: after a re-bless the visual comparison PASSES, and CI keeps its diff
 * artifact only `if: failure()` — so a reviewer asked to judge a regenerated
 * baseline had no image to look at. #3222's regressed baselines went through
 * exactly that gap. This collects, for each baseline the audit reports as
 * moved:
 *
 *   before/<path>  the branch tip's version — what `baseline-audit.mjs`
 *                  compares against (`blobInHead`), read BEFORE the commit
 *                  step moves HEAD
 *   after/<path>   the regenerated file on disk
 *   base/<path>    `dev`'s version, only when it differs from `before`
 *                  (a branch that already moved the baseline once)
 *   diff/<path>    a pixel diff, when ImageMagick's `compare` is available
 *                  and both sides exist with the same dimensions
 *
 * No new npm dependency: the workflow installs ImageMagick with apt only when
 * a baseline moved (`ubuntu-latest` does not ship it — measured on the #3234
 * probe run), and a missing `compare` or a size mismatch is reported, never
 * fatal. A PNG library would have changed package-lock.json and with it the
 * Playwright cache key both visual workflows share.
 *
 * Input: `MOVED_BASELINES`, the audit step's `moved` output
 * (`[{ name, path, status }]`). It is written even when the audit REFUSES
 * the commit — the run whose images matter most — so the workflow runs this
 * step `if: always()`.
 *
 * Output (GITHUB_OUTPUT): `count` (files collected for) and `dir`. A run that
 * rewrote nothing collects nothing and says so.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Parse the audit's `moved` output; null when it cannot be read. */
export function parseMovedWithPaths(raw) {
  try {
    const list = JSON.parse(String(raw ?? ''))
    if (!Array.isArray(list)) return null
    return list.filter((m) => m && typeof m.path === 'string' && m.path.endsWith('.png'))
  } catch {
    return null
  }
}

/** Which sides exist for a status. Pure. */
export function plan(moved) {
  return moved.map((m) => ({
    path: m.path,
    status: m.status,
    before: m.status !== 'added',
    after: m.status !== 'deleted',
  }))
}

/** The manifest, readable in the artifact and in the run summary. Pure. */
export function renderManifest(entries) {
  if (entries.length === 0) return 'No baseline was rewritten, so no before/after images were collected.'
  const lines = [
    `Before/after images for ${entries.length} rewritten baseline(s). Regenerated is not reviewed:`,
    'open each pair before approving (frontend playbook §4).',
    '',
    '| baseline | status | before | after | base (dev) | diff |',
    '|---|---|---|---|---|---|',
  ]
  for (const e of entries) {
    lines.push(
      `| \`${e.path.split('/').pop()}\` | ${e.status} | ${e.before ? 'yes' : '—'} | ${e.after ? 'yes' : '—'} | ${e.base ? 'differs, included' : '—'} | ${e.diff ?? '—'} |`,
    )
  }
  return lines.join('\n')
}

function git(args) {
  return execFileSync('git', args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
}

function blobId(ref, file) {
  try {
    return git(['rev-parse', `${ref}:${file}`]).toString().trim()
  } catch {
    return null
  }
}

function writeFrom(ref, file, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, git(['show', `${ref}:${file}`]))
}

function hasCompare() {
  try {
    execFileSync('compare', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function main() {
  const out = process.env.OUT_DIR || path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'baseline-artifact')
  const moved = parseMovedWithPaths(process.env.MOVED_BASELINES)
  const setOutput = (count) => {
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `count=${count}\ndir=${out}\n`)
  }
  if (moved === null) {
    console.log('::warning::The audit step wrote no readable `moved` list, so no before/after images were collected.')
    setOutput(0)
    return
  }
  const entries = plan(moved)
  if (entries.length === 0) {
    console.log(renderManifest(entries))
    setOutput(0)
    return
  }

  // `dev`'s version is context, not the comparison: fetch it shallowly and
  // carry on without it if that fails (a fork, a missing ref).
  let haveDev = false
  try {
    execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', 'dev:refs/remotes/origin/dev'], { stdio: 'ignore' })
    haveDev = true
  } catch {
    console.log('::notice::Could not fetch origin/dev; base versions are not included.')
  }
  const compareOk = hasCompare()
  if (!compareOk) console.log('::notice::ImageMagick `compare` is not on this runner; no diff images.')

  fs.rmSync(out, { recursive: true, force: true })
  for (const e of entries) {
    if (e.before) writeFrom('HEAD', e.path, path.join(out, 'before', e.path))
    if (e.after) {
      fs.mkdirSync(path.dirname(path.join(out, 'after', e.path)), { recursive: true })
      fs.copyFileSync(e.path, path.join(out, 'after', e.path))
    }
    if (haveDev && e.before) {
      const devBlob = blobId('origin/dev', e.path)
      if (devBlob && devBlob !== blobId('HEAD', e.path)) {
        writeFrom('origin/dev', e.path, path.join(out, 'base', e.path))
        e.base = true
      }
    }
    if (e.before && e.after && compareOk) {
      const dest = path.join(out, 'diff', e.path)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      try {
        // `compare` exits 1 when the images differ — the normal case here.
        execFileSync('compare', ['-metric', 'AE', path.join(out, 'before', e.path), path.join(out, 'after', e.path), dest], {
          stdio: 'ignore',
        })
        e.diff = 'identical pixels'
      } catch (err) {
        e.diff = err.status === 1 && fs.existsSync(dest) ? 'yes' : 'not computed (sizes differ?)'
      }
    }
  }
  const manifest = renderManifest(entries)
  fs.writeFileSync(path.join(out, 'README.md'), `${manifest}\n`)
  console.log(manifest)
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${manifest}\n`)
  setOutput(entries.length)
}

if (process.argv[1] && process.argv[1].endsWith('baseline-artifact.mjs')) {
  try {
    main()
  } catch (err) {
    // The images are a convenience for the reviewer; losing them must never
    // cost the baseline push that follows (#3234 review). Say so and move on.
    console.log(`::warning::Could not collect before/after images: ${err.message}`)
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'count=0\n')
  }
}
