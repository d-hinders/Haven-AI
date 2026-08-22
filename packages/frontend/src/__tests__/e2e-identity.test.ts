/**
 * Unit cover for the e2e server's port scheme and IDENTITY guard (#1816).
 *
 * The defect: `playwright.config.ts` took a fixed `PLAYWRIGHT_PORT ?? 3000` in
 * every worktree and set `reuseExistingServer: !CI`, so a local
 * `npm run test:e2e` adopted whatever was already on :3000 and asserted
 * against it — a pass or a failure for a branch the run never loaded.
 *
 * The refusal DECISION (`identityMismatch`) and the port arithmetic
 * (`derivePort` / `reserveFreePort`) are #1800's, proven in
 * `capture-identity.test.ts`; this file does not re-test them. What it proves
 * is the three things this surface adds and the one thing a passing e2e run
 * could never show you: that the two harnesses cannot collide, and that the
 * guard is actually WIRED IN — present, correct and called by nobody is the
 * shape this family of issues keeps finding.
 */
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs, shared with the Playwright config
import {
  ForeignServerError,
  IDENTITY_FILENAME,
  PORT_RANGE,
  buildRunIdentity,
  derivePort,
  verifyServerIdentity,
} from '../../scripts/capture-identity.mjs'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs, loaded by Playwright as `globalSetup`
import { E2E_IDENTITY_FILENAME, E2E_PORT_RANGE, E2E_REFUSAL } from '../../scripts/e2e-identity.mjs'

const FRONTEND_ROOT = path.resolve(__dirname, '..', '..')
const read = (rel: string) => readFile(path.join(FRONTEND_ROOT, rel), 'utf8')

/** Comments legitimately NAME the old fixed ports; code must not use them. */
const codeOnly = (source: string) => source.replace(/^\s*(\*|\/\/).*$/gm, '')

describe('the two harnesses cannot collide in one worktree', () => {
  // One worktree can be running `npm run screenshot` and `npm run test:e2e` at
  // the same time. Sharing either resource turns this guard's failures into
  // false positives — each run overwriting the other's marker, then refusing a
  // server that really was its own.
  it('reserves disjoint port ranges', () => {
    // Written as an overlap test rather than "e2e starts above capture", so it
    // still fails if a future edit moves EITHER range in either direction.
    const overlaps = (a: { start: number; span: number }, b: { start: number; span: number }) =>
      a.start < b.start + b.span && b.start < a.start + a.span
    expect(overlaps(PORT_RANGE, E2E_PORT_RANGE)).toBe(false)
    // …and the predicate itself is not vacuous.
    expect(overlaps(PORT_RANGE, PORT_RANGE)).toBe(true)
  })

  it('never lands on the plain `npm run dev` port a developer keeps open', () => {
    expect(E2E_PORT_RANGE.start).toBeGreaterThan(3000)
  })

  it('publishes its marker under a DIFFERENT filename', () => {
    expect(E2E_IDENTITY_FILENAME).not.toBe(IDENTITY_FILENAME)
  })

  it('gives the same worktree two different ports, one per harness', () => {
    const worktree = '/Users/dev/Haven-AI/.claude/worktrees/agent-a21cfde9894f93b3c'
    expect(derivePort(worktree, E2E_PORT_RANGE)).not.toBe(derivePort(worktree, PORT_RANGE))
  })

  it('keeps every e2e port inside the declared range', () => {
    for (const suffix of ['', '/a', '/b', '-2', '/.claude/worktrees/agent-0000000000000000']) {
      const port = derivePort(`/Users/dev/Haven-AI${suffix}`, E2E_PORT_RANGE)
      expect(port).toBeGreaterThanOrEqual(E2E_PORT_RANGE.start)
      expect(port).toBeLessThan(E2E_PORT_RANGE.start + E2E_PORT_RANGE.span)
    }
  })
})

describe('the refusal says what was NOT done', () => {
  // #1800's prose ("Nothing was captured") would be a lie here, and a refusal
  // that misdescribes itself is how someone talks themselves past it.
  it('names the e2e consequence, not the capture one', () => {
    expect(E2E_REFUSAL.consequence).toMatch(/never loaded/)
    expect(E2E_REFUSAL.consequence).toMatch(/No tests were run/)
    expect(E2E_REFUSAL.consequence).not.toMatch(/screenshot/i)
  })
})

/**
 * The retry is the one piece of NEW state-machine logic this change adds to
 * the shared probe, and #1816 is its first caller with `attempts > 1`. It is
 * small enough to read and be sure of, which is exactly the situation this
 * repo's standing lesson is about — a guard you reasoned through is not a
 * guard you proved. Both halves are asserted: that a slow server is waited
 * for, and that a foreign one is NOT.
 */
describe('the identity probe retries slowness but never a foreign server', () => {
  const own = buildRunIdentity(
    { worktree: '/Users/dev/Haven-AI', branch: 'fix/1816', commit: 'c'.repeat(40), dirty: false },
    { token: 'run-token-1816-aaaa-bbbb-cccc' },
  )
  const marker = (token: string, worktree = '/Users/dev/Haven-AI') => ({
    ok: true,
    status: 200,
    json: async () => ({ token, worktree, branch: 'other', commit: 'd'.repeat(40) }),
  })
  const probe = (impl: () => Promise<unknown>) => impl as unknown as typeof fetch

  it('waits out a server that is merely slow, then accepts it', async () => {
    // The measured case: `next dev` under load took 14.5s to serve a static
    // file, which one 10s attempt reports as a foreign server.
    let call = 0
    const served = await verifyServerIdentity('http://127.0.0.1:3402', own, {
      fetchImpl: probe(async () => {
        call += 1
        if (call < 3) throw new Error('The operation was aborted due to timeout')
        return marker(own.token)
      }),
      attempts: 5,
      retryDelayMs: 1,
    })
    expect(call).toBe(3)
    expect((served as { token: string }).token).toBe(own.token)
  })

  it('still refuses when every attempt is unreadable — patience is not a pass', async () => {
    let call = 0
    await expect(
      verifyServerIdentity('http://127.0.0.1:3402', own, {
        fetchImpl: probe(async () => {
          call += 1
          return { ok: false, status: 404, json: async () => null }
        }),
        attempts: 4,
        retryDelayMs: 1,
      }),
    ).rejects.toThrow(ForeignServerError)
    expect(call).toBe(4)
  })

  it('refuses ANOTHER worktree on the first read, without spending the budget', async () => {
    // No amount of waiting turns somebody else's token into this run's, and a
    // guard that retries a decided refusal just delays it — and would report
    // the LAST attempt's reason rather than the real one.
    let call = 0
    let message = ''
    try {
      await verifyServerIdentity('http://127.0.0.1:3402', own, {
        fetchImpl: probe(async () => {
          call += 1
          return marker('run-token-other-aaaa-bbbb-dddd', '/Users/dev/Haven-AI/.claude/worktrees/agent-other')
        }),
        attempts: 6,
        retryDelayMs: 10_000,
      })
    } catch (err) {
      message = String((err as Error).message)
    }
    expect(call).toBe(1)
    expect(message).toMatch(/DIFFERENT capture run/)
    expect(message).toMatch(/agent-other/)
    // The refusal names the e2e consequence only when the caller asked for it;
    // here the default is fine — what matters is that no stale "could not be
    // read" detail from a retry leaked into a decided verdict.
    expect(message).not.toMatch(/could not be read/)
  })
})

describe('the Playwright config wires the guard in', () => {
  it('derives and reserves the port instead of hardcoding one', async () => {
    const source = await read('playwright.config.ts')
    expect(source).toMatch(/globalSetup:\s*'\.\/scripts\/e2e-identity\.mjs'/)
    expect(source).toMatch(/'e2e-identity\.mjs'\),\s*'reserve-port'/)
    // The old fixed default. `PLAYWRIGHT_PORT` survives as a PREFERENCE that
    // still goes through the bind proof, so what must not come back is the
    // literal fallback.
    expect(codeOnly(source)).not.toMatch(/PLAYWRIGHT_PORT\s*\?\?\s*3000/)
  })

  it('reserves exactly once per run, so workers agree with the running server', async () => {
    // A worker re-loading the config would otherwise reserve a DIFFERENT port
    // — this run's server holds the first — and point `baseURL` at nothing.
    const source = await read('playwright.config.ts')
    expect(source).toMatch(/const stamped = process\.env\[RESOLVED_PORT_ENV\]\s*\n\s*if \(stamped\) return/)
    expect(source).toMatch(/process\.env\[RESOLVED_PORT_ENV\] = String\(port\)/)
  })
})

describe('the e2e global setup wires the guard in', () => {
  it('verifies identity under its own filename and refusal', async () => {
    const source = await read('scripts/e2e-identity.mjs')
    expect(source).toMatch(/verifyServerIdentity\(baseURL, identity, \{/)
    expect(source).toMatch(/filename: E2E_IDENTITY_FILENAME/)
    expect(source).toMatch(/refusal: E2E_REFUSAL/)
    expect(source).toMatch(/derivePort\(identity\.worktree, E2E_PORT_RANGE\)/)
    expect(source).toMatch(/reserveFreePort\(preferred/)
  })

  it('cleans the marker up on every exit path', async () => {
    // Both halves of #1800's review finding: the teardown must exist, and the
    // handlers must be registered AFTER the binding they close over. A handler
    // registered above `publicDirs` closes over a variable it can never see —
    // a cleanup path that cannot clean up.
    const source = await read('scripts/e2e-identity.mjs')
    expect(source).toMatch(
      /const publicDirs = [\s\S]*?const teardown = \(\) => \{[\s\S]*?removeIdentityMarkerSync[\s\S]*?process\.on\('exit', teardown\)/,
    )
    expect(source).toMatch(/process\.once\('SIGINT'/)
    expect(source).toMatch(/process\.once\('SIGTERM'/)
    // A throw from the probe leaves the marker behind unless the catch cleans
    // up — `globalSetup` never reaches its returned teardown in that case.
    expect(source).toMatch(/\} catch \(err\) \{\s*\n\s*teardown\(\)\s*\n\s*throw err/)
  })

  it('writes the marker where the CI standalone server serves it from too', async () => {
    // In CI the webServer command copies `public/.` into the standalone tree
    // BEFORE booting `server.js`, and that copy is finished by the time global
    // setup runs — so a marker written only to the source `public/` would 404
    // and the run would refuse its own server.
    const source = await read('scripts/e2e-identity.mjs')
    expect(source).toMatch(/\.next\/standalone\/packages\/frontend\/public/)
  })

  it('keeps stdout clean for the port handshake', async () => {
    // `playwright.config.ts` parses stdout. A progress line on the same stream
    // makes `Number(out)` NaN and the whole suite unrunnable.
    const source = await read('scripts/e2e-identity.mjs')
    expect(source).toMatch(/reserveFreePort\(preferred, \{ label: 'e2e', log: \(m\) => console\.warn\(m\) \}\)/)
    // …and nothing on the busy-port path writes to stdout either.
    expect(source).not.toMatch(/console\.log\([\s\S]{0,80}already listening/)
  })
})
