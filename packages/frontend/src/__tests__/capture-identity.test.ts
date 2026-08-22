/**
 * Unit cover for the capture server's port scheme and IDENTITY guard (#1800).
 *
 * The defect: `npm run screenshot` bound a fixed 3111 in every worktree, so a
 * second concurrent session got a 200 OK from the OTHER worktree's app and
 * captured it — plausible PNGs of a branch nobody reviewed, which
 * `haven-design-reviewer` then reasons from (#900).
 *
 * The cross-worktree refusal is proven end to end against real servers (see
 * the PR's mutation evidence). This file proves the two mechanisms
 * DISCRIMINATE, which is the part a real run cannot show cheaply: that the
 * derived port actually differs per worktree, and that the identity check
 * fires on every shape a foreign server presents — including the dangerous
 * one, a healthy 200 serving somebody else's marker.
 */
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs, shared with the screenshot script
import {
  ForeignServerError,
  IDENTITY_FILENAME,
  PORT_RANGE,
  buildRunIdentity,
  derivePort,
  identityMarkerPath,
  identityMismatch,
  isPortFree,
  removeIdentityMarker,
  reserveFreePort,
  verifyServerIdentity,
  worktreeIdentity,
  writeIdentityMarker,
} from '../../scripts/capture-identity.mjs'

const WORKTREE_A = '/Users/dev/Haven-AI'
const WORKTREE_B = '/Users/dev/Haven-AI/.claude/worktrees/agent-a691bfd09f440ffbb'

const identityFor = (worktree: string) =>
  buildRunIdentity(
    { worktree, branch: 'fix/1800', commit: 'a'.repeat(40), dirty: false },
    // Dash-segmented like the real `randomUUID()` token it stands in for.
    { token: `run-token-for-the-worktree-${worktree}` },
  ) as Record<string, unknown> & { token: string; worktree: string }

const okResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
})

/** A stub standing in for `fetch` — only `ok`/`status`/`json` are ever read. */
const stubFetch = (impl: (url: string) => Promise<unknown>) => impl as unknown as typeof fetch

describe('derivePort', () => {
  it('is deterministic for a worktree path', () => {
    expect(derivePort(WORKTREE_B)).toBe(derivePort(WORKTREE_B))
  })

  it('stays inside the declared range', () => {
    for (const p of ['/a', '/b', WORKTREE_A, WORKTREE_B, os.tmpdir()]) {
      const port = derivePort(p)
      expect(port).toBeGreaterThanOrEqual(PORT_RANGE.start)
      expect(port).toBeLessThan(PORT_RANGE.start + PORT_RANGE.span)
    }
  })

  it('separates worktrees — including sibling agent worktrees that differ by one character', () => {
    expect(derivePort(WORKTREE_A)).not.toBe(derivePort(WORKTREE_B))
    expect(derivePort(`${WORKTREE_B}0`)).not.toBe(derivePort(`${WORKTREE_B}1`))
  })

  it('gives the concurrent worktrees of a real session distinct ports', () => {
    // The shape this repo actually creates: `.claude/worktrees/agent-<hex>`.
    const siblings = [
      'a691bfd09f440ffbb',
      'a98368d82f0a5fb6d',
      'b17c4e0192aa3d5e1',
      'c02f7719ab4d8e330',
      'd5518cc23e9f10a47',
      'e9930ab77c1d2f684',
    ].map((id) => `/Users/dev/Haven-AI/.claude/worktrees/agent-${id}`)
    expect(new Set(siblings.map((p) => derivePort(p))).size).toBe(siblings.length)
  })

  it('does not RELY on that — a hash collision still cannot cross-capture', async () => {
    // Distinct ports are a convenience; the safety comes from the two layers
    // below. Two worktrees that hashed to the same port would still be safe:
    // the second one cannot bind the port, so it takes another…
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const collided = (server.address() as net.AddressInfo).port
    try {
      expect(await reserveFreePort(collided, { log: () => {} })).not.toBe(collided)
    } finally {
      await new Promise((r) => server.close(r))
    }
    // …and even if it somehow reached that server, the identity probe refuses.
    const mine = identityFor(WORKTREE_B)
    expect(identityMismatch(mine, identityFor(WORKTREE_A))).not.toBeNull()
  })
})

describe('identityMismatch — the refusal decision', () => {
  it('accepts the run\'s own marker', () => {
    const mine = identityFor(WORKTREE_B)
    expect(identityMismatch(mine, { ...mine })).toBeNull()
  })

  it('REFUSES another worktree serving a healthy marker (the #1800 defect)', () => {
    const mine = identityFor(WORKTREE_B)
    const theirs = identityFor(WORKTREE_A)
    const reason = identityMismatch(mine, theirs)
    expect(reason).toMatch(/DIFFERENT capture run/)
    expect(reason).toContain(WORKTREE_A)
  })

  it('REFUSES a server with no marker at all — a 200 is not proof of identity', () => {
    const mine = identityFor(WORKTREE_B)
    expect(identityMismatch(mine, null)).toMatch(/not proof of identity/)
    expect(identityMismatch(mine, undefined)).toMatch(/not proof of identity/)
    expect(identityMismatch(mine, '<!doctype html>')).toMatch(/not proof of identity/)
  })

  it('REFUSES a marker with a missing or empty token', () => {
    const mine = identityFor(WORKTREE_B)
    expect(identityMismatch(mine, { worktree: WORKTREE_B })).toMatch(/no token/)
    expect(identityMismatch(mine, { token: '', worktree: WORKTREE_B })).toMatch(/no token/)
  })

  it('REFUSES a stale server from the SAME worktree started by an earlier run', () => {
    const mine = identityFor(WORKTREE_B)
    const earlierRun = { ...mine, token: 'token-from-an-earlier-run' }
    expect(identityMismatch(mine, earlierRun)).toMatch(/DIFFERENT capture run/)
  })

  it('REFUSES a replayed token served from a different worktree', () => {
    const mine = identityFor(WORKTREE_B)
    expect(identityMismatch(mine, { ...mine, worktree: WORKTREE_A })).toMatch(/worktree does not/)
  })
})

describe('verifyServerIdentity — probing the server about to be captured', () => {
  const mine = identityFor(WORKTREE_B)

  it('passes when the server serves this run\'s marker', async () => {
    const served = await verifyServerIdentity('http://127.0.0.1:3111', mine, {
      fetchImpl: stubFetch(async () => okResponse({ ...mine })),
    })
    expect(served.token).toBe(mine.token)
  })

  it('fetches the marker from the base URL, once, at the documented path', async () => {
    const urls: string[] = []
    await verifyServerIdentity('http://127.0.0.1:3111/', mine, {
      fetchImpl: stubFetch(async (url: string) => {
        urls.push(url)
        return okResponse({ ...mine })
      }),
    })
    expect(urls).toEqual([`http://127.0.0.1:3111/${IDENTITY_FILENAME}`])
  })

  it('throws ForeignServerError on another worktree\'s app (200 OK, wrong branch)', async () => {
    const theirs = identityFor(WORKTREE_A)
    await expect(
      verifyServerIdentity('http://127.0.0.1:3111', mine, { fetchImpl: stubFetch(async () => okResponse(theirs)) }),
    ).rejects.toBeInstanceOf(ForeignServerError)
  })

  it('names the foreign worktree and says nothing was captured', async () => {
    const theirs = identityFor(WORKTREE_A)
    await expect(
      verifyServerIdentity('http://127.0.0.1:3111', mine, { fetchImpl: stubFetch(async () => okResponse(theirs)) }),
    ).rejects.toThrow(/Nothing was captured/)
    await expect(
      verifyServerIdentity('http://127.0.0.1:3111', mine, { fetchImpl: stubFetch(async () => okResponse(theirs)) }),
    ).rejects.toThrow(new RegExp(WORKTREE_A))
  })

  it('throws when the marker 404s — an older server that predates the guard', async () => {
    await expect(
      verifyServerIdentity('http://127.0.0.1:3111', mine, {
        fetchImpl: stubFetch(async () => ({ ok: false, status: 404, json: async () => ({}) })),
      }),
    ).rejects.toThrow(/REFUSING to capture/)
  })

  it('throws when the marker path returns HTML instead of JSON', async () => {
    await expect(
      verifyServerIdentity('http://127.0.0.1:3111', mine, {
        fetchImpl: stubFetch(async () => ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('Unexpected token <')
          },
        })),
      }),
    ).rejects.toThrow(/REFUSING to capture/)
  })

  it('throws when the server cannot be reached at all', async () => {
    await expect(
      verifyServerIdentity('http://127.0.0.1:3111', mine, {
        fetchImpl: stubFetch(async () => {
          throw new Error('ECONNREFUSED')
        }),
      }),
    ).rejects.toThrow(/REFUSING to capture/)
  })
})

describe('the marker file the app serves', () => {
  it('round-trips through public/ and verifies against itself', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'haven-capture-marker-'))
    try {
      const mine = identityFor(WORKTREE_B)
      await writeIdentityMarker(dir, mine)
      const onDisk = JSON.parse(await readFile(identityMarkerPath(dir), 'utf8'))
      expect(identityMismatch(mine, onDisk)).toBeNull()
      expect(path.basename(identityMarkerPath(dir))).toBe(IDENTITY_FILENAME)

      await removeIdentityMarker(dir)
      await expect(stat(identityMarkerPath(dir))).rejects.toThrow()
      // Removing twice is what a finally block plus a signal handler will do.
      await expect(removeIdentityMarker(dir)).resolves.toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('port reservation', () => {
  const listen = (port: number) =>
    new Promise<net.Server>((resolve, reject) => {
      const server = net.createServer()
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => resolve(server))
    })

  it('reports a bound port as not free, and free again once released', async () => {
    const server = await listen(0)
    const port = (server.address() as net.AddressInfo).port
    expect(await isPortFree(port)).toBe(false)
    await new Promise((r) => server.close(r))
    expect(await isPortFree(port)).toBe(true)
  })

  it('walks past a port another session already holds instead of assuming it is ours', async () => {
    const server = await listen(0)
    const held = (server.address() as net.AddressInfo).port
    const messages: string[] = []
    try {
      const chosen = await reserveFreePort(held, { log: (m: string) => messages.push(m) })
      expect(chosen).toBeGreaterThan(held)
      expect(await isPortFree(chosen)).toBe(true)
      expect(messages.join('\n')).toMatch(/already bound|using :/)
    } finally {
      await new Promise((r) => server.close(r))
    }
  })

  it('returns the preferred port untouched when it is free, and says nothing', async () => {
    const server = await listen(0)
    const free = (server.address() as net.AddressInfo).port
    await new Promise((r) => server.close(r))
    const messages: string[] = []
    expect(await reserveFreePort(free, { log: (m: string) => messages.push(m) })).toBe(free)
    expect(messages).toEqual([])
  })

  it('fails loudly rather than returning an unusable port', async () => {
    const servers = await Promise.all([listen(0)])
    const held = (servers[0].address() as net.AddressInfo).port
    try {
      await expect(reserveFreePort(held, { attempts: 1, log: () => {} })).rejects.toThrow(/no free port/)
    } finally {
      await Promise.all(servers.map((s) => new Promise((r) => s.close(r))))
    }
  })
})

// `git` subprocesses on a machine running several agent sessions are slow —
// these two shell out for real, so they get room rather than a flaky default.
describe('worktreeIdentity', { timeout: 60_000 }, () => {
  it('reports the real branch and commit of this checkout', () => {
    const id = worktreeIdentity(path.resolve(__dirname, '..', '..'))
    expect(id.worktree.length).toBeGreaterThan(0)
    expect(id.commit).toMatch(/^[0-9a-f]{40}$|^unknown$/)
  })

  it('degrades to the directory outside a git checkout instead of failing the run', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'haven-capture-nogit-'))
    try {
      const id = worktreeIdentity(dir)
      // macOS resolves /var → /private/var; the point is that it answered.
      expect(id.worktree.endsWith(path.basename(dir))).toBe(true)
      expect(derivePort(id.worktree)).toBeGreaterThanOrEqual(PORT_RANGE.start)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('the capture script wires the guard in', () => {
  // Without this, a future edit could drop the identity probe or reintroduce a
  // fixed port and every test above would still pass — the guard would be
  // present, correct, and called by nobody.
  it('derives the port and verifies identity, with no fixed port left behind', async () => {
    const source = await readFile(path.resolve(__dirname, '../../scripts/screenshot.mjs'), 'utf8')
    expect(source).toMatch(/verifyServerIdentity\(BASE_URL, identity\)/)
    expect(source).toMatch(/reserveFreePort\(preferred\)/)
    expect(source).toMatch(/derivePort\(identity\.worktree\)/)
    // The old fixed default. It must not come back — in any form. Comments
    // may still NAME it (the docblock explains the defect), so they are
    // stripped before the check rather than the check being softened.
    const code = source.replace(/^\s*(\*|\/\/).*$/gm, '')
    expect(code).not.toMatch(/\b3111\b/)
  })
})
