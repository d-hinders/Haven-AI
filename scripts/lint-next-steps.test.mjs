// Self-test for scripts/lint-next-steps.mjs (#3104). Spawns the CLI (#2720's
// rule) and unit-tests the numerator on literal snippets, including the shapes
// the epic's base commit 4ed69592 carried, so the positive control is
// reproducible without a second tree.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanSource, balancedBlock, scan, SCAN_TARGETS, BASELINE_PATH } from './lint-next-steps.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'scripts/lint-next-steps.mjs')

describe('scanSource — the numerator, defined', () => {
  test('a builder call naming a tool, or a reason, or a handoff spread, is NAMED', () => {
    for (const src of [
      "buildAgentGuidance({ nextAction: A.X, nextTool: 'haven_sign', nextArguments: { payment_id: id }, reason: 'r' })",
      "refusalNextStep({ nextAction: A.X, nextTool: null, nextToolOmittedReason: 'why' })",
      "buildAgentGuidance({ nextAction: A.X, ...paymentStatusHandoff(err.paymentId), reason: 'r' })",
      "new HostedToolError({ code: 'X', message: 'm', nextStep: refusalNextStep({ nextAction: A.X, nextTool: null, nextToolOmittedReason: 'why' }) })",
    ]) assert.equal(scanSource(src).unnamed, 0, src)
  })

  test('the epic-base shapes count: a bare nextAction on a builder call or a HostedToolError literal', () => {
    assert.equal(scanSource("buildAgentGuidance({ nextAction: A.X, safeToContinue: true, reason: 'r' })").unnamed, 1)
    assert.equal(scanSource("new HostedToolError({ code: 'X', message: 'm', nextAction: AgentPaymentNextAction.StopAndTellUser })").unnamed, 1)
    // A HostedToolError with no action decision is not an emission.
    assert.equal(scanSource("new HostedToolError({ code: 'X', message: 'm' })").unnamed, 0)
  })

  test('signer and local decision literals outside the builder family', () => {
    assert.equal(scanSource("return { success: false, code: err.code, next_action: AgentPaymentNextAction.StopAndTellUser }").unnamed, 1)
    assert.equal(scanSource("return { success: false, code: err.code, next_action: AgentPaymentNextAction.StopAndTellUser, ...nextStepWireFields(step) }").unnamed, 0)
    assert.equal(scanSource("return { success: false, nextAction: AgentPaymentNextAction.StopAndTellUser }").unnamed, 1)
    assert.equal(scanSource("return { success: false, nextAction: AgentPaymentNextAction.StopAndTellUser, next_tool_omitted_reason: 'why' }").unnamed, 0)
  })

  test('discovery entries: suggested_tool without suggested_arguments counts; failure hints do not', () => {
    assert.equal(scanSource("entries.map((e) => ({ resource_url: e.resourceUrl, suggested_tool: 'haven_pay_x402' }))").discovery_without_arguments, 1)
    assert.equal(scanSource("entries.map((e) => ({ resource_url: e.resourceUrl, suggested_tool: 'haven_pay_x402', suggested_arguments: { url: e.resourceUrl } }))").discovery_without_arguments, 0)
    assert.equal(scanSource("return { success: false, code: err.code, suggested_tool: err.suggestedTool }").discovery_without_arguments, 0)
  })

  test('a commented-out step or a nested unrelated nextTool does not read as NAMED (#3142 review)', () => {
    assert.equal(scanSource("new HostedToolError({ code: 'X', message: 'm', /* nextStep: refusalNextStep({ nextTool: null, nextToolOmittedReason: 'x' }) */ nextAction: AgentPaymentNextAction.StopAndTellUser })").unnamed, 1)
    assert.equal(scanSource("buildAgentGuidance({ nextAction: A.X, // nextTool: 'old'\n  reason: 'r' })").unnamed, 1)
    assert.equal(scanSource("buildAgentGuidance({ nextAction: A.X, debug: { previous: { nextTool: 'old' } }, reason: 'r' })").unnamed, 1)
  })

  test('a comment opener or line comment inside a string literal is not a comment (#3142 review, round 2)', () => {
    assert.equal(scanSource("const a = 'contains /* here'\nthrow new HostedToolError({ code: 'X', message: 'm', nextAction: AgentPaymentNextAction.StopAndTellUser })\nconst b = 'and */ there'").unnamed, 1)
    assert.equal(scanSource("buildAgentGuidance({ nextAction: A.X, note: 'see // docs', nextTool: 'haven_sign', nextArguments: {}, reason: 'r' })").unnamed, 0)
    assert.equal(scanSource("const h = { accept: '*/*' }\nbuildAgentGuidance({ nextAction: A.X, reason: 'r' })").unnamed, 1)
  })

  test('a discovery hint built in a spread branch is still counted (#3142 review)', () => {
    assert.equal(scanSource("entries.map((e) => ({ resource_url: e.url, ...(e.paid ? { suggested_tool: 'haven_pay_x402' } : {}) }))").discovery_without_arguments, 1)
    assert.equal(scanSource("entries.map((e) => ({ resource_url: e.url, ...(e.paid ? { suggested_tool: 'haven_pay_x402', suggested_arguments: { url: e.url } } : {}) }))").discovery_without_arguments, 0)
  })

  test('balancedBlock stops at the matching brace', () => {
    assert.equal(balancedBlock('x({ a: { b: 1 }, c: 2 }) y', 2), '{ a: { b: 1 }, c: 2 }')
  })
})

describe('the gate', () => {
  test('is green at the repository head with the committed zero baseline', () => {
    const r = spawnSync(process.execPath, [CLI], { cwd: ROOT, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /every next-step emission names a tool or a reason/)
  })

  test('POSITIVE CONTROL: a tree carrying an epic-base shape is red', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const root = await mkdtemp(join(tmpdir(), 'lint-next-steps-'))
    try {
      // Placeholder files at the four targets the violation does not live in:
      // since #3230 the gate refuses when ANY target matches no files, so a
      // fixture touching one target must still read all five for the growth
      // verdict to be the thing that fires.
      for (const target of SCAN_TARGETS) {
        const abs = join(root, target)
        if (target.endsWith('.ts')) {
          await mkdir(dirname(abs), { recursive: true })
          await writeFile(abs, '')
        } else {
          await mkdir(abs, { recursive: true })
          await writeFile(join(abs, 'placeholder.ts'), '')
        }
      }
      await mkdir(join(root, 'packages/mcp-server/src/tools/support'), { recursive: true })
      await writeFile(join(root, 'packages/mcp-server/src/tools/support/cap-price.ts'),
        "throw new HostedToolError({ code: 'X', message: 'm', nextAction: AgentPaymentNextAction.StopAndTellUser })\n")
      const r = spawnSync(process.execPath, [CLI, `--root=${root}`], { cwd: ROOT, encoding: 'utf8' })
      assert.equal(r.status, 1)
      assert.match(r.stderr, /cap-price\.ts unnamed: 1 \(baseline allows 0\)/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a target matching no files is REFUSED, naming it (#3230)', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    // The exact measured defect: EVERY target moved aside — the gate read
    // nothing and still printed a clean verdict.
    const root = await mkdtemp(join(tmpdir(), 'lint-next-steps-'))
    try {
      const r = spawnSync(process.execPath, [CLI, `--root=${root}`], { cwd: ROOT, encoding: 'utf8' })
      assert.equal(r.status, 1)
      assert.match(r.stderr, /matched no source files/)
      for (const target of SCAN_TARGETS) assert.match(r.stderr, new RegExp(target.replace(/[.\\]/g, '\\$&')))
      assert.doesNotMatch(r.stdout, /✓/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('ONE missing target refuses too — the check is per target, not only on a total zero', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const root = await mkdtemp(join(tmpdir(), 'lint-next-steps-'))
    try {
      // Four targets populated, the fifth missing: the scan is non-empty, so
      // only the per-target census catches this.
      for (const target of SCAN_TARGETS) {
        if (target === 'packages/signer/src/sign-context.ts') continue
        const abs = join(root, target)
        if (target.endsWith('.ts')) {
          await mkdir(dirname(abs), { recursive: true })
          await writeFile(abs, '')
        } else {
          await mkdir(abs, { recursive: true })
          await writeFile(join(abs, 'placeholder.ts'), '')
        }
      }
      const r = spawnSync(process.execPath, [CLI, `--root=${root}`], { cwd: ROOT, encoding: 'utf8' })
      assert.equal(r.status, 1)
      assert.match(r.stderr, /matched no source files/)
      assert.match(r.stderr, /sign-context\.ts/)
      assert.doesNotMatch(r.stdout, /✓/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('the refusal gates --update: a zero-file scan writes NO baseline (#3230)', async () => {
    const { mkdtemp, mkdir, writeFile, rm, readFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    // `scan` is pure of the refusal (it must stay usable as a census), and the
    // write refusal lives in main. Rather than spawn a second COPY of the
    // script, run the real CLI in a fixture where scripts/ holds the shipped
    // gate and the baseline path points inside the fixture via --root (the
    // baseline is read/written relative to THIS repo, so --update against a
    // starved root must fail here before touching the committed file).
    const root = await mkdtemp(join(tmpdir(), 'lint-next-steps-'))
    try {
      const before = await readFile(BASELINE_PATH, 'utf8')
      const r = spawnSync(process.execPath, [CLI, '--update', `--root=${root}`], { cwd: ROOT, encoding: 'utf8' })
      assert.equal(r.status, 1)
      assert.match(r.stderr, /matched no source files/)
      assert.equal(await readFile(BASELINE_PATH, 'utf8'), before, 'committed baseline must be untouched')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('scan() reports the census: every target read on this repo, fileCount > 0', async () => {
    const { fileCount, readByTarget } = await scan(ROOT)
    assert.ok(fileCount > 0, 'the real tree reads a non-zero number of files')
    for (const target of SCAN_TARGETS) {
      assert.ok((readByTarget.get(target) ?? 0) > 0, `${target} matched no files in the census`)
    }
  })

  test('scan() counts files actually read, per target, on a fixture tree', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const root = await mkdtemp(join(tmpdir(), 'lint-next-steps-'))
    try {
      // tools/ gets two readable .ts files (one nested), one .test.ts the
      // gate's own filter excludes, and one .md the extension filter ignores —
      // the census counts READS, not directory entries, so it must say 2 here.
      await mkdir(join(root, 'packages/mcp-server/src/tools/nested'), { recursive: true })
      await writeFile(join(root, 'packages/mcp-server/src/tools/a.ts'), '')
      await writeFile(join(root, 'packages/mcp-server/src/tools/a.test.ts'), '')
      await writeFile(join(root, 'packages/mcp-server/src/tools/nested/b.ts'), '')
      await writeFile(join(root, 'packages/mcp-server/src/tools/notes.md'), '')
      await writeFile(join(root, 'packages/mcp-server/src/tools.ts'), '')
      await mkdir(join(root, 'packages/signer/src'), { recursive: true })
      await writeFile(join(root, 'packages/signer/src/sign-context.ts'), '')
      await writeFile(join(root, 'packages/signer/src/tools.ts'), '')
      await mkdir(join(root, 'packages/mcp/src'), { recursive: true })
      await writeFile(join(root, 'packages/mcp/src/tools.ts'), '')
      const { fileCount, readByTarget } = await scan(root)
      assert.equal(readByTarget.get('packages/mcp-server/src/tools'), 2)
      assert.equal(readByTarget.get('packages/mcp-server/src/tools.ts'), 1)
      assert.equal(readByTarget.get('packages/signer/src/sign-context.ts'), 1)
      assert.equal(readByTarget.get('packages/signer/src/tools.ts'), 1)
      assert.equal(readByTarget.get('packages/mcp/src/tools.ts'), 1)
      assert.equal(fileCount, 6)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
