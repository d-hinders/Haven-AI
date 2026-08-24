/**
 * Per-worktree capture server: port derivation + server IDENTITY (#1800).
 *
 * The defect this exists to close: `npm run screenshot` bound a FIXED port
 * (3111) in every worktree. Concurrent sessions are the normal state of this
 * repo, so the second one found 3111 already bound — Next dev quietly hops to
 * the next free port when its own port is taken, while the harness kept
 * polling 3111 — got a 200 OK from the OTHER worktree's app, and captured it.
 * The PNGs render, have plausible dimensions and show the right routes. They
 * are of a different branch, and nothing about them says so.
 *
 * That is worse than the silent-success guards this repo keeps finding: it
 * produces POSITIVE evidence that is confidently wrong, and
 * `haven-design-reviewer` reasons from exactly these artifacts (#900), so a
 * cross-contaminated capture becomes a design approval for code nobody looked
 * at.
 *
 * Two halves, and the second is the one that matters:
 *
 * 1. **A per-worktree port.** `derivePort` hashes the worktree path into a
 *    stable port, so two worktrees do not collide by construction, and
 *    `reserveFreePort` proves the port is actually bindable before the dev
 *    server is spawned (never trusting Next's own port-hopping).
 *
 * 2. **An identity probe. A 200 is not proof of identity.** Every run writes a
 *    marker into `public/` — served by the app itself at
 *    `/capture-identity.json` — carrying a per-run random token plus the
 *    worktree, branch and commit. Before a single PNG is written, the harness
 *    fetches that path from whatever it is about to capture and refuses unless
 *    the token matches. A foreign worktree's server serves ITS marker (or 404s)
 *    and the run fails loudly.
 *
 * The identity check is what makes the port scheme durable. A future change
 * that reintroduces a fixed port, or an operator pointing
 * `SCREENSHOT_BASE_URL` at the wrong server, cannot silently restore the
 * defect — it fails at the probe instead of producing plausible evidence.
 */
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import net from 'node:net'
import { writeFile, rm } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import path from 'node:path'

/** Served at `${BASE_URL}/capture-identity.json` out of the app's `public/`. */
export const IDENTITY_FILENAME = 'capture-identity.json'

/**
 * Ports the capture server may use. Starts at the historical 3111 so a single
 * -worktree setup keeps the port it always had, and is wide enough that the
 * derived ports of concurrent worktrees are very unlikely to coincide (and if
 * they do, `reserveFreePort` walks forward — identity is what makes the
 * outcome safe either way, not the arithmetic).
 */
export const PORT_RANGE = { start: 3111, span: 120 }

/** Stable, collision-resistant port for a worktree path. Pure. */
export function derivePort(worktreePath, range = PORT_RANGE) {
  const digest = createHash('sha256').update(String(worktreePath)).digest()
  return range.start + (digest.readUInt32BE(0) % range.span)
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/**
 * Where this capture is being taken FROM: the worktree root, its branch, its
 * commit, and whether it is dirty. Degrades to the given directory outside a
 * git checkout rather than failing the run — the port is still per-directory
 * and the token still identifies the run.
 */
export function worktreeIdentity(cwd) {
  const worktree = git(['rev-parse', '--show-toplevel'], cwd) ?? path.resolve(cwd)
  return {
    worktree,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd) ?? 'unknown',
    commit: git(['rev-parse', 'HEAD'], cwd) ?? 'unknown',
    dirty: (git(['status', '--porcelain'], cwd) ?? '') !== '',
  }
}

/**
 * The marker one capture run publishes about itself. The `token` is random per
 * run, which is what makes the probe a real identity check rather than a
 * "looks like Haven" check: two servers from the SAME worktree started by
 * different runs still do not match, so a stale server left behind by an
 * earlier run cannot be captured as if it were this one's.
 */
export function buildRunIdentity(base, { token = randomUUID(), now = () => new Date() } = {}) {
  return {
    token,
    worktree: base.worktree,
    branch: base.branch,
    commit: base.commit,
    dirty: base.dirty,
    pid: process.pid,
    started_at: now().toISOString(),
  }
}

/**
 * Every marker function takes the FILENAME as a parameter (#1816).
 *
 * Two harnesses now publish a marker out of the same `public/` directory — the
 * capture run (`npm run screenshot`) and the e2e run (`npm run test:e2e`) — and
 * a single worktree can be running both at once. Sharing one filename would
 * make each run's marker overwrite the other's, so each would then refuse a
 * server that really was its own: a guard whose false positives arrive exactly
 * when you are working hardest. The default keeps every existing call site
 * unchanged; the e2e harness passes `E2E_IDENTITY_FILENAME`.
 *
 * The two names must stay distinct and the two PORT RANGES must stay disjoint —
 * both are asserted by tests rather than left to the reader.
 */
export function identityMarkerPath(publicDir, filename = IDENTITY_FILENAME) {
  return path.join(publicDir, filename)
}

export async function writeIdentityMarker(publicDir, identity, filename = IDENTITY_FILENAME) {
  await writeFile(identityMarkerPath(publicDir, filename), `${JSON.stringify(identity, null, 2)}\n`, 'utf8')
}

export async function removeIdentityMarker(publicDir, filename = IDENTITY_FILENAME) {
  await rm(identityMarkerPath(publicDir, filename), { force: true })
}

/**
 * Synchronous twin, for the paths that cannot await: a signal handler, and any
 * exit that follows a throw. The async version's promise does not settle
 * before the process goes away, which left the marker behind in `public/` on
 * the very first refusal this guard produced.
 */
export function removeIdentityMarkerSync(publicDir, filename = IDENTITY_FILENAME) {
  rmSync(identityMarkerPath(publicDir, filename), { force: true })
}

/**
 * The heart of the guard, kept pure so it can be tested — and mutated — without
 * a server. Returns null when `served` proves it is this run's own app, or a
 * human-readable reason to REFUSE.
 */
export function identityMismatch(expected, served) {
  if (served === null || served === undefined || typeof served !== 'object') {
    return 'the server did not serve an identity marker (a 200 is not proof of identity)'
  }
  if (typeof served.token !== 'string' || served.token.length === 0) {
    return 'the served identity marker carries no token'
  }
  if (served.token !== expected.token) {
    const where = [
      served.worktree ? `worktree ${served.worktree}` : null,
      served.branch ? `branch ${served.branch}` : null,
      served.commit ? `commit ${String(served.commit).slice(0, 12)}` : null,
    ]
      .filter(Boolean)
      .join(', ')
    return `the server belongs to a DIFFERENT capture run${where ? ` (${where})` : ''} — expected worktree ${expected.worktree}, branch ${expected.branch}, commit ${String(expected.commit).slice(0, 12)}`
  }
  // Belt and suspenders, and deliberately unreachable through
  // `verifyServerIdentity` today: a token match already implies the same run,
  // because the token is a per-run `randomUUID()`. It is here for any future
  // caller that compares against a token it did not generate itself (a shared
  // or persisted one), where a replay from a different worktree becomes real.
  if (served.worktree !== expected.worktree) {
    return `the served marker's token matches but its worktree does not (served ${served.worktree}, expected ${expected.worktree})`
  }
  return null
}

export class ForeignServerError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ForeignServerError'
  }
}

/**
 * What a refusal is ABOUT, so the guard can be reused by a harness that is not
 * taking screenshots (#1816) without either lying about what it was doing or
 * growing a second copy of the probe. Prose only — the decision itself is
 * `identityMismatch`, and it is shared verbatim.
 */
export const CAPTURE_REFUSAL = {
  verb: 'capture',
  consequence: 'its screenshots would be evidence for a branch nobody reviewed. Nothing was captured.',
  fix: 'stop the other server, or let this run start its own (unset SCREENSHOT_BASE_URL).',
}

/**
 * Fetch the marker from the server about to be captured and refuse anything
 * that is not provably this run's own app. Never returns "probably ours".
 *
 * `attempts` retries ONLY the unreadable cases — a timeout, a connection
 * error, a 404, a non-JSON body (#1816). A marker that was served and belongs
 * to somebody else is refused on the first read, because no amount of waiting
 * turns another worktree's token into this run's. The retry exists because
 * "could not read it" and "it is not ours" are different facts and only the
 * first one is about timing: on a loaded machine `next dev` took **14.5s** to
 * serve a static file out of `public/`, which a single 10s attempt reports as
 * a foreign server. A guard that cries wolf under load is a guard people
 * learn to pass with the escape hatch.
 */
export async function verifyServerIdentity(
  baseUrl,
  expected,
  {
    fetchImpl = fetch,
    timeoutMs = 10_000,
    filename = IDENTITY_FILENAME,
    refusal = CAPTURE_REFUSAL,
    attempts = 1,
    retryDelayMs = 1_000,
  } = {},
) {
  const url = `${baseUrl.replace(/\/$/, '')}/${filename}`
  let served = null
  let detail = null
  let reason = null

  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    served = null
    detail = null
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) {
        detail = `${url} responded ${res.status}`
      } else {
        served = await res.json().catch(() => {
          detail = `${url} did not return JSON`
          return null
        })
      }
    } catch (err) {
      detail = `${url} could not be read: ${String(err?.message ?? err)}`
    }

    reason = identityMismatch(expected, served)
    // Answered with SOMETHING parseable — the verdict is final either way.
    if (reason === null || served !== null) break
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
  }

  if (reason === null) return served

  throw new ForeignServerError(
    [
      `REFUSING to ${refusal.verb}: ${reason}.`,
      detail ? `  (${detail})` : null,
      `  The server at ${baseUrl} is NOT provably this worktree's app, so ${refusal.consequence}`,
      `  Fix: ${refusal.fix}`,
    ]
      .filter(Boolean)
      .join('\n'),
  )
}

/** Is `port` bindable on `host` right now? Proven by binding it, not by a probe. */
export function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, host)
  })
}

/**
 * The port this run's dev server will own. Starts at the worktree's derived
 * port and walks forward past anything already bound — a busy port is never
 * assumed to be ours, it is simply skipped, and the chosen port is PRINTED so
 * the run is reproducible by hand.
 */
export async function reserveFreePort(
  preferred,
  { host = '127.0.0.1', attempts = 40, log = console.log, label = 'screenshot' } = {},
) {
  for (let i = 0; i < attempts; i += 1) {
    const port = preferred + i
    if (await isPortFree(port, host)) {
      if (i > 0) {
        log(
          `${label}: port ${preferred} is already bound by something else — using :${port} instead ` +
            '(never reusing a server this run did not start)',
        )
      }
      return port
    }
  }
  throw new Error(
    `no free port for the ${label} server in ${preferred}..${preferred + attempts - 1} — stop some servers and retry`,
  )
}
