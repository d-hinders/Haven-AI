/**
 * #4786: the operator tool, run the way an operator runs it — as built
 * JavaScript under plain `node` — and never against the real action.
 *
 * With no row id (or one that is not a UUID) the tool prints its usage text
 * and returns 1 before it imports anything. With a row id it imports
 * `../infra/outbound-lane-cancel.js`, and the scratch build has no such file
 * unless a test writes a stub there: a run that got past the argument check
 * fails on that import. The child environment carries no backend
 * configuration either.
 *
 * The backend's unit tests run before its build in CI, so there is no `dist`
 * to start. Each `.ts` module in this directory is transpiled here instead,
 * one file at a time, into a scratch `ops/` directory beside a
 * `{"type":"module"}` package file, which is the shape `tsc` gives
 * `dist/ops/`. `tsx` on the source would not do: how Node treats the path it
 * was handed (a symlink, a space, a missing extension) is the thing under
 * test.
 */
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const OPS_SRC = path.dirname(fileURLToPath(import.meta.url))
const ENTRY = 'cancel-stuck-lane'
/** The importable half: the code, and nothing that starts it. */
const COMMAND = 'lane-cancel-command'

const USAGE = [
  'usage: npm run ops:cancel-stuck-attest -w packages/backend -- <outbound_txs row id (uuid)>',
  '   or: npm run ops:cancel-stuck-lane -w packages/backend -- <outbound_txs row id (uuid)>',
  '   or (deployed container): node packages/backend/dist/ops/cancel-stuck-lane.js <outbound_txs row id (uuid)>',
].join('\n')

/** Transpile every non-test module of `src/ops` into `<root>/ops`, as ESM. */
function buildOps(root: string): void {
  mkdirSync(path.join(root, 'ops'), { recursive: true })
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n')
  for (const name of readdirSync(OPS_SRC)) {
    if (!name.endsWith('.ts') || name.includes('.test.')) continue
    const { outputText } = ts.transpileModule(readFileSync(path.join(OPS_SRC, name), 'utf8'), {
      // `NodeNext` emits CommonJS for a lone file with no package file to
      // read; the real build sees `"type": "module"` and emits ESM.
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: name,
    })
    writeFileSync(path.join(root, 'ops', name.replace(/\.ts$/, '.js')), outputText)
  }
}

interface Run {
  status: number | null
  stdout: string
  stderr: string
}

/** `node <args>` in `cwd`, with no backend configuration in the environment. */
function runNode(args: string[], cwd: string): Run {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    timeout: 30_000,
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

// Each case starts up to three node processes; vitest's default 5 s is too
// little on a loaded machine, and the suite sets no test timeout of its own.
const CASE_TIMEOUT_MS = 60_000

function expectUsage(run: Run): void {
  expect(run.stderr.trimEnd()).toBe(USAGE)
  expect(run.stdout).toBe('')
  expect(run.status).toBe(1)
}

describe('cancel-stuck-lane, as built JavaScript under plain node (#4786)', () => {
  let base: string
  let plain: string
  let linked: string
  let encoded: string

  beforeAll(() => {
    // Resolved first: on macOS the temp directory is itself behind a symlink,
    // and the cases below must choose for themselves whether one is involved.
    base = mkdtempSync(path.join(realpathSync(tmpdir()), 'cancel-stuck-lane-'))
    plain = path.join(base, 'plain')
    buildOps(plain)
    // The same build behind a symlink, as `/tmp/<checkout>` is on macOS.
    linked = path.join(base, 'linked')
    symlinkSync(plain, linked)
    // And one whose real path cannot be written into a file URL unchanged.
    encoded = path.join(base, 'ops spåce')
    buildOps(encoded)
  })

  afterAll(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('prints the usage text and exits 1 with no row id, by a relative path', { timeout: CASE_TIMEOUT_MS }, () => {
    expectUsage(runNode([`ops/${ENTRY}.js`], plain))
  })

  it('prints the usage text and exits 1 for an argument that is not a UUID', { timeout: CASE_TIMEOUT_MS }, () => {
    expectUsage(runNode([`ops/${ENTRY}.js`, 'not-a-row-id'], plain))
  })

  // Before #4786 the three cases below printed nothing and exited 0: the tool
  // compared its own URL with `process.argv[1]`, which node leaves unresolved
  // (a symlink), unencoded (a space) and without the extension the operator
  // left off.
  it('starts without the .js extension', { timeout: CASE_TIMEOUT_MS }, () => {
    expectUsage(runNode([`ops/${ENTRY}`], plain))
  })

  it('starts by an absolute path through a symlink, with and without the extension', { timeout: CASE_TIMEOUT_MS }, () => {
    expect(realpathSync(linked)).not.toBe(linked)
    expectUsage(runNode([path.join(linked, 'ops', `${ENTRY}.js`)], base))
    expectUsage(runNode([path.join(linked, 'ops', ENTRY)], base))
  })

  it('starts from a directory whose real path has a space and a non-ASCII character', { timeout: CASE_TIMEOUT_MS }, () => {
    expect(pathToFileURL(encoded).pathname).not.toBe(encoded)
    expectUsage(runNode([`ops/${ENTRY}.js`], encoded))
    expectUsage(runNode([`ops/${ENTRY}`], encoded))
    expectUsage(runNode([path.join(encoded, 'ops', `${ENTRY}.js`)], base))
  })

  // The entry file starts unconditionally, so the code it starts must live in
  // a module that does not. If the start moves into that module, the `tsx`
  // wrapper (which imports it and calls `runCli()` itself) would run the
  // command twice.
  it('does not start when the command module is only imported', { timeout: CASE_TIMEOUT_MS }, () => {
    const url = pathToFileURL(path.join(plain, 'ops', `${COMMAND}.js`)).href
    const run = runNode(['--input-type=module', '-e', `await import(${JSON.stringify(url)})`], plain)
    expect(run).toEqual({ status: 0, stdout: '', stderr: '' })
  })

  // The usage cases cannot tell whether the row id on the command line
  // reaches the action: a tool that dropped it would print usage for every
  // input. Here the action is a stub in a build of its own, which refuses and
  // echoes the id it was given. Nothing real is imported.
  it('hands the row id from the command line to the action', { timeout: CASE_TIMEOUT_MS }, () => {
    const stubbed = path.join(base, 'stubbed')
    buildOps(stubbed)
    mkdirSync(path.join(stubbed, 'infra'))
    writeFileSync(
      path.join(stubbed, 'infra', 'outbound-lane-cancel.js'),
      [
        'export const productionLaneCancelDeps = async () => ({})',
        "export const cancelStuckOutboundLane = async (id) => ({ outcome: 'refused', code: 'stub', detail: id })",
        '',
      ].join('\n'),
    )
    const id = '00000000-0000-4000-8000-000000000000'
    const run = runNode([`ops/${ENTRY}.js`, id], stubbed)
    expect(run).toEqual({ status: 1, stdout: '', stderr: `REFUSED (stub): ${id}\n` })
  })
})
