/**
 * Backend-suite response recorder — the instrument behind quality-scan blocks
 * 8 and 9 (#4471).
 *
 * WHAT IT DOES
 *
 * Wraps the `fastify` factory so every app the backend suite builds carries an
 * `onSend` hook that appends one NDJSON row per response: method, route,
 * status, body, and the test file that produced it. Nothing else. It never
 * edits a payload, never throws into the request path, and never changes a
 * status — the response a test sees is byte-identical with and without it
 * (`refusal-census.test.mjs` pins that on a toy Fastify app).
 *
 * WHY IT IS A FACTORY WRAP AND NOT A ROUTE HOOK
 *
 * The backend suite builds its apps in 134 test files, each calling
 * `Fastify(...)` directly; there is no single app factory to hook. No backend
 * test mocks `fastify` itself, so a factory mock reaches all of them. The
 * shared `buildApp()` helper (`packages/backend/src/__tests__/helpers.ts`)
 * mounts none of the payment routes, so hooking it would record almost
 * nothing.
 *
 * WHY THE MOCK ID IS AN ABSOLUTE PATH
 *
 * `fastify` is not hoisted to the repo root: it resolves only from
 * `packages/backend/node_modules`. A bare `vi.mock('fastify')` in a setup file
 * under `scripts/ci/` resolves from THIS file's location, matches nothing the
 * backend imports, and records zero rows — a false zero that reads as "the
 * suite answers nothing". `refusal-census.mjs record` resolves the entry from
 * `packages/backend/package.json` with `createRequire` and passes it in
 * `HAVEN_RECORDER_FASTIFY`; the fallback below is the same file by path, so a
 * hand-run vitest still mocks the right module.
 *
 * WHY `vi.mock` AND NOT `vi.doMock`
 *
 * `vi.mock` is hoisted, which is what makes it reach the test files' own
 * `import Fastify from 'fastify'`. `vi.doMock` is not hoisted and, measured on
 * this suite, reached only a handful of files (13 rows instead of ~2,000) —
 * a false zero that looks like a quiet suite. The inertness is therefore
 * inside the factory: with `HAVEN_RESPONSE_RECORDING` unset it returns the
 * actual module untouched, registers no hook and writes nothing.
 *
 * ORDERING
 *
 * The hook is added inside the factory, before any route or middleware
 * registers, so it runs BEFORE `client-compat.ts`'s `onSend` splices
 * `client_update` into a body. A recorded 2xx body therefore does not carry
 * `client_update`; block 9 says so, and treats `client_update` as read outside
 * the mapper rather than as an emitted-but-unread key.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { vi } from 'vitest'
import { CONTROL_CODE, CONTROL_ROUTE } from './control.mjs'

const OUT = process.env.HAVEN_RESPONSE_RECORDING

/**
 * The run this setup execution belongs to.
 *
 * A setup file runs once PER TEST FILE, so truncating on every execution would
 * leave only the last file's rows — measured: 1 row instead of ~2,000. The
 * instrument passes a unique `HAVEN_RECORDER_RUN`; a hand-run vitest falls back
 * to the parent pid, which is the vitest process for a fork pool and the shell
 * for a thread pool.
 */
const RUN_ID = process.env.HAVEN_RECORDER_RUN ?? String(process.ppid)
const RUN_MARKER = OUT ? `${OUT}.run` : null

/** 2xx rows are kept only on the agent read routes; every error row is kept. */
const READ_ROUTE_RE = /^\/(machine-payments|payments|x402|catalog|agents)(\/|$)/

/** A body larger than this is recorded truncated, with `truncated: true`. */
const MAX_BODY_CHARS = 8_000

function parseBody(payload) {
  if (typeof payload !== 'string') return { body: null, nonJson: true }
  if (payload.length === 0) return { body: null, nonJson: false }
  try {
    return { body: JSON.parse(payload), nonJson: false }
  } catch {
    return { body: payload.slice(0, MAX_BODY_CHARS), nonJson: true }
  }
}

function record(request, reply, payload) {
  const status = reply.statusCode
  const route = request.routeOptions?.url ?? request.routerPath ?? request.url
  const isError = status >= 400
  if (!isError && !(status >= 200 && status < 300 && READ_ROUTE_RE.test(route))) return

  const { body, nonJson } = parseBody(payload)
  let bounded = body
  let truncated = false
  if (body !== null && typeof body === 'object') {
    const text = JSON.stringify(body)
    if (text.length > MAX_BODY_CHARS) {
      bounded = { truncated: true, preview: text.slice(0, MAX_BODY_CHARS) }
      truncated = true
    }
  }

  const row = {
    method: request.method,
    route,
    status,
    body: bounded,
    nonJson,
    truncated,
    testFile: globalThis.expect?.getState?.().testPath ?? null,
  }
  appendFileSync(OUT, `${JSON.stringify(row)}\n`)
}

if (OUT) {
  // Truncate once per RUN, not once per test file: an append-only file would
  // double every row on a re-run and inflate every count, and a per-file
  // truncate would keep only the last file's rows.
  const previous = existsSync(RUN_MARKER) ? readFileSync(RUN_MARKER, 'utf8') : null
  if (previous !== RUN_ID) {
    writeFileSync(OUT, '')
    writeFileSync(RUN_MARKER, RUN_ID)
    // The seeded control row. `assertPlausible` in the instrument refuses a
    // recording without it, so a file left over from an earlier run — or one
    // the recorder never wrote — cannot pass as this run's.
    appendFileSync(
      OUT,
      `${JSON.stringify({
        method: 'GET',
        route: CONTROL_ROUTE,
        status: 418,
        body: { error_code: CONTROL_CODE },
        nonJson: false,
        truncated: false,
        testFile: null,
        control: true,
      })}\n`,
    )
  }
}

vi.mock(
  process.env.HAVEN_RECORDER_FASTIFY ??
    new URL('../../../../packages/backend/node_modules/fastify/fastify.js', import.meta.url).pathname,
  async (importOriginal) => {
    const actual = await importOriginal()
    // Inert unless asked: no hook, no writes, the actual module untouched.
    if (!process.env.HAVEN_RESPONSE_RECORDING) return actual
    const factory = actual.default ?? actual
    const wrapped = (options) => {
      const app = factory(options)
      app.addHook('onSend', async (request, reply, payload) => {
        try {
          record(request, reply, payload)
        } catch {
          // A recorder that can fail a test is worse than no recorder.
        }
        return payload
      })
      return app
    }
    return { ...actual, default: wrapped }
  },
)
