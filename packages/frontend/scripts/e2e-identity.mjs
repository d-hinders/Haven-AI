/**
 * Per-worktree e2e server: port derivation + server IDENTITY (#1816).
 *
 * The same defect as #1800, one surface over. `playwright.config.ts` took a
 * FIXED port (`PLAYWRIGHT_PORT ?? 3000`) in every worktree and set
 * `reuseExistingServer: !process.env.CI` — so locally Playwright adopted
 * whatever was already listening on :3000 and asserted against it. Concurrent
 * sessions in separate worktrees are this repo's normal state, so the second
 * `npm run test:e2e` could exercise the OTHER worktree's app and report green
 * or red for a branch it never loaded.
 *
 * That is not a silent failure. It is a **confidently wrong** one: the suite
 * runs, the routes exist, the assertions have opinions, and nothing in the
 * output says which branch produced them. `reuseExistingServer` asks only
 * "did something answer?", and a 200 is not proof of identity.
 *
 * CI was never exposed — `reuseExistingServer` is false there and runners are
 * per-job isolated — so this closes a local-development correctness hole. The
 * identity probe still runs in CI, because a guard that only exists on the
 * path nobody watches is the shape this family of issues keeps finding.
 *
 * ## Reuse, not a second mechanism
 *
 * Everything load-bearing here comes from `capture-identity.mjs`, which #1800
 * built and mutation-proved: `derivePort` (hash the worktree path so two
 * worktrees cannot collide by construction), `reserveFreePort` (prove the port
 * bindable by BINDING it, never trusting a probe or Next's own port-hopping),
 * `buildRunIdentity` (a per-run `randomUUID()` token plus worktree/branch/
 * commit) and `identityMismatch` / `verifyServerIdentity` (the refusal
 * decision, shared verbatim). This file contributes exactly three things the
 * capture harness cannot supply: a DISJOINT port range, a DISTINCT marker
 * filename, and the Playwright wiring.
 *
 * The range and the filename both have to differ, and for the same reason: one
 * worktree can be running `npm run screenshot` and `npm run test:e2e` at the
 * same time. A shared port would make them fight for it; a shared marker file
 * would make each run overwrite the other's token, so each would refuse a
 * server that really was its own. Both facts are asserted by tests in
 * `src/__tests__/capture-identity.test.ts` rather than left to this comment.
 *
 * ## What runs when
 *
 * 1. `playwright.config.ts` (module scope, synchronous) shells out to this
 *    file's `reserve-port` command for the port, BEFORE the `webServer`
 *    command string is built. It has to be a subprocess because `defineConfig`
 *    is synchronous and binding a socket is not. Whether the port is merely
 *    derived or also PROVEN free depends on whether this run may reuse a
 *    server — see `resolveE2ePort` for why, and why that is the safe way round.
 * 2. Playwright starts (or adopts) the web server — `webServer` is a plugin,
 *    and plugin setup runs BEFORE `globalSetup`.
 * 3. `globalSetup` (this file's default export) writes the marker into
 *    `public/`, fetches it back from whatever Playwright is about to test, and
 *    THROWS unless the served token is this run's own. Next serves `public/`
 *    from disk per request, so writing the marker after the server booted is
 *    fine — and a foreign worktree's server serves its own `public/`, which is
 *    exactly what makes the probe an identity check.
 * 4. The teardown returned from `globalSetup` removes the marker again, as do
 *    `exit`/`SIGINT`/`SIGTERM` handlers, because a marker left in `public/` is
 *    a worktree path and commit hash that `next build` would ship at the site
 *    root.
 *
 * ## What this proves, and what it does NOT — stated rather than discovered
 *
 * The marker is written to this worktree's `public/` and served from disk, so
 * what the probe proves is **"the server is serving THIS WORKTREE's files"**.
 * That is the whole of the #1816 defect (the adopted server belonged to
 * another worktree) and it is a strictly stronger claim than `reuseExistingServer`'s
 * "something answered".
 *
 * It is weaker than the capture harness's guarantee in one specific way. There
 * the marker proves "this RUN's own server", because `npm run screenshot`
 * always spawns the server it captures, so a stale one from an earlier run is
 * a real hazard and is refused. Here reuse is the point, so any server serving
 * this worktree passes — including one somebody left running. For `next dev`
 * that is harmless: it compiles from disk, so it always reflects the current
 * working tree, which is exactly what the tests should run against. It would
 * NOT hold for a stale `next start` over an old `next build`, which serves a
 * frozen bundle while happily serving the fresh marker beside it. If a
 * standalone/production server ever becomes something local runs adopt, that
 * gap has to close — the honest fix is for the server to carry its build's
 * identity, not for the probe to try harder.
 *
 * Two smaller residuals, named by review rather than left to be rediscovered:
 *
 * - **A non-HTTP squatter on the derived port.** If some unrelated process
 *   holds it without speaking HTTP, Playwright's reuse health-check fails, it
 *   spawns `next dev` on that port anyway, and Next hops — the narrow tail of
 *   the very defect this closes. The probe only rules out a server that
 *   *answers*. Rare enough not to justify reintroducing the unconditional walk
 *   (whose cost is measured and constant); the busy-port warning is the hint.
 * - **A run that never becomes readable waits out the retry budget** — up to
 *   ~130s with the settings below — before refusing. That is a slow refusal,
 *   not a hang, and it is deliberate: the alternative is refusing a server that
 *   was merely slow, which is how a guard trains people to reach for the
 *   escape hatch.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import {
  buildRunIdentity,
  derivePort,
  isPortFree,
  removeIdentityMarkerSync,
  reserveFreePort,
  verifyServerIdentity,
  worktreeIdentity,
  writeIdentityMarker,
} from './capture-identity.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND_ROOT = path.resolve(HERE, '..')
const PUBLIC_DIR = path.join(FRONTEND_ROOT, 'public')

/**
 * Where the Next standalone build serves `public/` from in CI. The CI
 * `webServer` command copies `public/.` in there before booting `server.js`,
 * and that copy has already happened by the time `globalSetup` runs — so the
 * marker is written to BOTH locations rather than only the source one. Without
 * this the probe would 404 in CI and the run would refuse its own server.
 */
const STANDALONE_PUBLIC_DIR = path.join(FRONTEND_ROOT, '.next/standalone/packages/frontend/public')

/** Served at `${baseURL}/e2e-identity.json` out of the app's `public/`. */
export const E2E_IDENTITY_FILENAME = 'e2e-identity.json'

/**
 * Disjoint from `PORT_RANGE` (3111–3230, the capture server) on purpose — see
 * the docblock. Starts above 3000 so the plain `npm run dev` a developer keeps
 * open is never a candidate either.
 */
export const E2E_PORT_RANGE = { start: 3300, span: 120 }

/** Escape hatch for a genuinely remote target. Loud, and it is not a default. */
const ALLOW_UNVERIFIED_ENV = 'PLAYWRIGHT_ALLOW_UNVERIFIED_SERVER'

export const E2E_REFUSAL = {
  verb: 'run the e2e suite against',
  consequence:
    'its results would be a pass or a failure for a branch this run never loaded. No tests were run.',
  // Three fixes because there are three ways to get here, and the right one
  // depends on which. Review found the first draft offering only "unset
  // PLAYWRIGHT_BASE_URL", which is precisely backwards for the developer who
  // set it on purpose to test a deployed environment — that target can NEVER
  // serve this run's token, so the escape hatch is their only honest route and
  // it went unmentioned. Likewise "unset PLAYWRIGHT_PORT" re-derives the same
  // port on a genuine hash collision, where SETTING it is the answer.
  fix: [
    'stop the other server and let this run start its own;',
    '    or set PLAYWRIGHT_PORT to a free port if two worktrees derived the same one;',
    `    or, for a deliberately remote target that cannot serve this run's token, ${ALLOW_UNVERIFIED_ENV}=1`,
    '    — which means the result may belong to a different branch, so say so wherever you report it.',
  ].join('\n'),
}

/**
 * The port this run's app server will use: derived from the worktree path,
 * and — when this run may not reuse anything — PROVEN bindable by binding it.
 *
 * ## Why the bind-and-walk is conditional, unlike the capture harness's
 *
 * `npm run screenshot` always starts its own server, so walking forward past a
 * busy port is unambiguously right there. Playwright is different: locally it
 * MAY adopt an existing server, and a warm `next dev` is worth minutes on a
 * loaded machine. Walking forward unconditionally would step over this
 * worktree's own already-running dev server and cold-start a second one on
 * every single run — measured here, not predicted: with a warm server on the
 * derived port the first draft of this file spawned a second Next on the next
 * port up and then failed on `webServer` timeout while it compiled.
 *
 * So when reuse is allowed, the derived port is returned AS IS and whatever is
 * listening there has to prove who it is. That is the right division of
 * labour, and it is the one #1800 already states: the port arithmetic only
 * makes the happy path likely, and "identity is what makes the outcome safe
 * either way, not the arithmetic". A foreign worktree derives a different port
 * in the first place, so the busy-port case is normally our own server; if it
 * ever is not, the probe refuses instead of guessing.
 *
 * `--exclusive` (passed when `reuseExistingServer` is off — i.e. CI) restores
 * the walk, because there a busy port cannot be adopted: Next would hop to
 * another port while Playwright kept polling this one, which is the other half
 * of the #1800 defect.
 *
 * `PLAYWRIGHT_PORT` overrides the derived value and gets identical treatment,
 * so an explicit port cannot reintroduce the collision either — it is a
 * preference, not an assertion that the port is free.
 */
export async function resolveE2ePort({ cwd = FRONTEND_ROOT, exclusive = false } = {}) {
  const identity = worktreeIdentity(cwd)
  const preferred = process.env.PLAYWRIGHT_PORT
    ? Number(process.env.PLAYWRIGHT_PORT)
    : derivePort(identity.worktree, E2E_PORT_RANGE)

  // `console.warn`, not `console.error`: both go to stderr — which is what
  // keeps the stdout port handshake clean — but this is the ordinary case
  // (reusing a warm dev server is the point of this branch), and dressing the
  // common path in red is how a notice stops being read.
  if (exclusive) return reserveFreePort(preferred, { label: 'e2e', log: (m) => console.warn(m) })

  if (!(await isPortFree(preferred))) {
    console.warn(
      `e2e: something is already listening on :${preferred} — it will be used ONLY if it can ` +
        "prove it is this worktree's app (a 200 is not proof of identity).",
    )
  }
  return preferred
}

/**
 * Playwright `globalSetup`. Returns its own teardown — Playwright calls a
 * returned function after the run (`runner/tasks.js`), which keeps the write
 * and the removal in one place instead of in two files that can drift.
 */
export default async function globalSetup(config) {
  const baseURL =
    process.env.PLAYWRIGHT_RESOLVED_BASE_URL ??
    config?.projects?.[0]?.use?.baseURL ??
    process.env.PLAYWRIGHT_BASE_URL
  if (!baseURL) {
    throw new Error('e2e identity: no baseURL on the Playwright config — cannot verify the server under test')
  }

  const identity = buildRunIdentity(worktreeIdentity(FRONTEND_ROOT))
  console.log(`e2e: worktree ${identity.worktree}`)
  console.log(
    `e2e: branch ${identity.branch} @ ${identity.commit.slice(0, 12)}${identity.dirty ? ' (dirty working tree)' : ''}`,
  )

  // Every directory this run published a marker into. Collected BEFORE the
  // handlers that have to reach it are registered — a handler closing over a
  // binding declared after it is a handler that can never do its job, which is
  // the bug review caught in #1800's first draft.
  const publicDirs = [PUBLIC_DIR, ...(existsSync(STANDALONE_PUBLIC_DIR) ? [STANDALONE_PUBLIC_DIR] : [])]
  for (const dir of publicDirs) {
    await writeIdentityMarker(dir, identity, E2E_IDENTITY_FILENAME)
  }

  // Sync on purpose: an awaited promise does not settle before the process
  // leaves on a throw or a signal, and `public/` is copied verbatim into a
  // production build — a marker that outlives its run is this worktree's path
  // and commit hash served at the site root.
  const teardown = () => {
    for (const dir of publicDirs) {
      try {
        removeIdentityMarkerSync(dir, E2E_IDENTITY_FILENAME)
      } catch {
        /* nothing to clean up */
      }
    }
  }
  process.on('exit', teardown)
  process.once('SIGINT', () => {
    teardown()
    process.exit(130)
  })
  process.once('SIGTERM', () => {
    teardown()
    process.exit(143)
  })

  try {
    if (process.env[ALLOW_UNVERIFIED_ENV] === '1') {
      console.warn(
        `\n⚠ ${ALLOW_UNVERIFIED_ENV}=1 — testing ${baseURL} WITHOUT proving it is this worktree's app.\n` +
          '  A pass or a failure from this run may belong to a different branch. Say so wherever you report it.\n',
      )
    } else {
      await verifyServerIdentity(baseURL, identity, {
        filename: E2E_IDENTITY_FILENAME,
        refusal: E2E_REFUSAL,
        // Generous, because this probe runs the instant Playwright's own
        // `webServer` wait returned and a `next dev` under load can take
        // double-digit seconds to serve a static file. Only the UNREADABLE
        // cases retry — a foreign marker is refused on the first read.
        timeoutMs: 20_000,
        attempts: 6,
        retryDelayMs: 2_000,
      })
      console.log(`e2e: server identity verified — ${baseURL} is this worktree's app`)
    }
  } catch (err) {
    teardown()
    throw err
  }

  return teardown
}

// `reserve-port`: the synchronous seam `playwright.config.ts` needs. The port
// goes to stdout and NOTHING else does — the caller parses stdout — so
// `reserveFreePort`'s progress line is routed to stderr above.
if (process.argv[2] === 'reserve-port') {
  resolveE2ePort({ exclusive: process.argv.includes('--exclusive') })
    .then((port) => {
      process.stdout.write(`${port}\n`)
    })
    .catch((err) => {
      console.error(String(err?.message ?? err))
      process.exit(1)
    })
}
