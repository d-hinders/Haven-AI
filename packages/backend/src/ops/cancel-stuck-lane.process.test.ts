/**
 * #4786: the operator tool, run the way an operator runs it — as built
 * JavaScript under plain `node` — and never with a row id.
 *
 * With no row id (or one that is not a UUID) the tool prints its usage text
 * and returns 1 before it imports anything that reads configuration, so these
 * runs reach no database and no chain. The child environment carries no
 * backend configuration either: a run that got further would fail on the
 * first missing variable instead of doing anything.
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

  it('prints the usage text and exits 1 with no row id, by a relative path', () => {
    expectUsage(runNode([`ops/${ENTRY}.js`], plain))
  })

  it('prints the usage text and exits 1 for an argument that is not a UUID', () => {
    expectUsage(runNode([`ops/${ENTRY}.js`, 'not-a-row-id'], plain))
  })

  // Before #4786 the three cases below printed nothing and exited 0: the tool
  // compared its own URL with `process.argv[1]`, which node leaves unresolved
  // (a symlink), unencoded (a space) and without the extension the operator
  // left off.
  it('starts without the .js extension', () => {
    expectUsage(runNode([`ops/${ENTRY}`], plain))
  })

  it('starts by an absolute path through a symlink, with and without the extension', () => {
    expect(realpathSync(linked)).not.toBe(linked)
    expectUsage(runNode([path.join(linked, 'ops', `${ENTRY}.js`)], base))
    expectUsage(runNode([path.join(linked, 'ops', ENTRY)], base))
  })

  it('starts from a directory whose real path has a space and a non-ASCII character', () => {
    expect(pathToFileURL(encoded).pathname).not.toBe(encoded)
    expectUsage(runNode([`ops/${ENTRY}.js`], encoded))
    expectUsage(runNode([`ops/${ENTRY}`], encoded))
    expectUsage(runNode([path.join(encoded, 'ops', `${ENTRY}.js`)], base))
  })

  // The entry file starts unconditionally, so the code it starts must live in
  // a module that does not. If the start moves into that module, the `tsx`
  // wrapper (which imports it and calls `runCli()` itself) would run the
  // command twice.
  it('does not start when the command module is only imported', () => {
    const url = pathToFileURL(path.join(plain, 'ops', `${COMMAND}.js`)).href
    const run = runNode(['--input-type=module', '-e', `await import(${JSON.stringify(url)})`], plain)
    expect(run).toEqual({ status: 0, stdout: '', stderr: '' })
  })
})
