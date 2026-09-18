// Self-test for scripts/lint-next-steps.mjs (#3104). Spawns the CLI (#2720's
// rule) and unit-tests the numerator on literal snippets, including the shapes
// the epic's base commit 4ed69592 carried, so the positive control is
// reproducible without a second tree.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanSource, balancedBlock } from './lint-next-steps.mjs'

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
})
