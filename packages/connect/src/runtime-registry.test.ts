import { describe, expect, it, vi } from 'vitest'
import { ConnectError } from './connect-error.js'
import {
  normalizeRuntime,
  resolveRuntimeSelection,
  restartRequiredForRuntime,
  runtimeProfile,
  runtimeVerificationInstruction,
  RUNTIME_FLAG_VALUES,
} from './runtime-registry.js'

describe('Hermes runtime registry', () => {
  it('normalizes Hermes aliases to a writable restart-session runtime', () => {
    for (const alias of ['hermes', 'hermes-agent', 'hermes_agent', 'hermesagent']) {
      expect(normalizeRuntime(alias), alias).toBe('hermes')
    }

    expect(runtimeProfile('hermes')).toMatchObject({
      id: 'hermes',
      label: 'Hermes Agent',
      restartMode: 'restart-session',
      canWriteRuntimeConfig: true,
      activationInstruction: 'Start a new Hermes session; in Hermes Gateway, run `/restart` instead.',
    })
    expect(restartRequiredForRuntime('hermes')).toBe(true)
  })

  it('owns precise activation and safe verification instructions for every runtime', () => {
    expect(runtimeProfile('codex-cli').activationInstruction).toContain('codex resume --last')
    expect(runtimeProfile('codex-desktop').activationInstruction).toContain('Quit and reopen')
    expect(runtimeProfile('claude-desktop').activationInstruction).toContain('Quit and reopen')
    expect(runtimeProfile('cursor').activationInstruction).toContain('hot-reload')
    expect(runtimeProfile('other').activationInstruction).toContain('manual MCP setup')

    for (const runtime of ['codex-cli', 'codex-desktop', 'claude-code', 'claude-desktop', 'hermes', 'cursor', 'other'] as const) {
      const instruction = runtimeVerificationInstruction(runtime)
      expect(instruction).toContain('haven_get_agent')
      expect(instruction).toContain('haven_get_allowances')
      expect(instruction).toMatch(/do not sign, fund, or create a payment/i)
    }
  })

  it('detects Hermes environment signals without overriding an explicit runtime', () => {
    expect(normalizeRuntime(undefined, { HERMES_HOME: '/tmp/hermes' })).toBe('hermes')
    expect(normalizeRuntime(undefined, { HERMES_AGENT: '1' })).toBe('hermes')
    expect(normalizeRuntime('codex-cli', { HERMES_HOME: '/tmp/hermes' })).toBe('codex-cli')
  })

  // #1682: the name-first picker introduced two product names the connector
  // had no word for. Without these, `--runtime cowork` / `--runtime openclaw`
  // fell through to the #1672 no-runtime refusal — a hard failure before any
  // side effect, which is the right behaviour for a value nobody understands
  // and the wrong outcome for a row the dashboard itself offers.
  it('resolves Cowork to the Claude Code profile whose config it shares', () => {
    expect(normalizeRuntime('cowork', {})).toBe('claude-code')
    expect(normalizeRuntime('Cowork', {})).toBe('claude-code')
  })

  it('resolves OpenClaw to the manual profile a snippet target needs', () => {
    for (const alias of ['openclaw', 'open-claw', 'open_claw', 'OpenClaw']) {
      expect(normalizeRuntime(alias, {}), alias).toBe('other')
    }
    // The 'other' profile is what makes this correct: Haven writes credentials
    // to disk and does NOT auto-write a config, which is exactly the OpenClaw
    // flow (paste the mcpServers entry into ~/.openclaw/openclaw.json).
    expect(runtimeProfile('openclaw', {})).toMatchObject({
      id: 'other',
      canWriteRuntimeConfig: false,
    })
  })
})

describe('the runtime resolution ladder (#1719)', () => {
  const AGENT_SHELL = { CLAUDECODE: '1' }

  it('takes an agent self-report when detection found nothing', async () => {
    const selection = await resolveRuntimeSelection(undefined, undefined, {
      env: {},
      selfReported: 'claude-desktop',
    })

    expect(selection).toEqual({ runtime: 'claude-desktop', source: 'explicit' })
  })

  it('DISCARDS a self-reported runtime when detection fires', async () => {
    // The #1672 property that makes rung 3b safe: the self-report enters at
    // hint precedence, so it can only fill a vacuum. An agent that mis-reports
    // itself inside a detectable shell cannot redirect the write.
    const selection = await resolveRuntimeSelection(undefined, undefined, {
      env: AGENT_SHELL,
      selfReported: 'claude-desktop',
    })

    expect(selection.runtime).toBe('claude-code')
    expect(selection.source).toBe('detected')
    expect(selection.overrodeHint).toBe('claude-desktop')
  })

  it('lets an explicit --runtime outrank a self-report', async () => {
    const selection = await resolveRuntimeSelection('cursor', undefined, {
      env: {},
      selfReported: 'claude-desktop',
    })

    expect(selection).toEqual({ runtime: 'cursor', source: 'explicit' })
  })

  it('refuses an unrecognised self-report instead of guessing a config location', async () => {
    const error = await resolveRuntimeSelection(undefined, undefined, {
      env: {},
      selfReported: 'not-a-harness',
    }).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(ConnectError)
    expect((error as ConnectError).code).toBe('runtime_unrecognized')
    expect((error as ConnectError).message).toContain('not-a-harness')
    expect((error as ConnectError).message).toContain(RUNTIME_FLAG_VALUES)
    expect((error as ConnectError).message).toContain('--runtime other')
  })

  it('never prompts after refusing an unrecognised hint', async () => {
    const promptForRuntime = vi.fn()
    await resolveRuntimeSelection('not-a-harness', undefined, { env: {}, promptForRuntime }).catch(() => undefined)

    expect(promptForRuntime).not.toHaveBeenCalled()
  })

  it('lets detection carry an unrecognised hint rather than failing a rollout window', async () => {
    // The dashboard can learn a picker id before the PUBLISHED connector does.
    // With a confident detection there is no guess to make, so the run
    // proceeds — loudly, via discardedHint, never silently.
    const selection = await resolveRuntimeSelection('a-harness-shipped-after-this-connector', undefined, {
      env: AGENT_SHELL,
    })

    expect(selection.runtime).toBe('claude-code')
    expect(selection.discardedHint).toBe('a-harness-shipped-after-this-connector')
  })

  it('refuses an unknown --runtime-force with a code and the valid values', async () => {
    const error = await resolveRuntimeSelection(undefined, 'nope', { env: AGENT_SHELL }).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(ConnectError)
    expect((error as ConnectError).code).toBe('runtime_force_unrecognized')
    expect((error as ConnectError).message).toContain(RUNTIME_FLAG_VALUES)
  })

  it('reaches the prompt rung only when nothing else answered', async () => {
    const promptForRuntime = vi.fn(async () => 'claude-desktop' as const)
    const selection = await resolveRuntimeSelection(undefined, undefined, { env: {}, promptForRuntime })

    expect(promptForRuntime).toHaveBeenCalledTimes(1)
    expect(selection).toEqual({ runtime: 'claude-desktop', source: 'prompted' })
  })

  it('does not prompt when detection already answered', async () => {
    const promptForRuntime = vi.fn(async () => 'claude-desktop' as const)
    const selection = await resolveRuntimeSelection(undefined, undefined, { env: AGENT_SHELL, promptForRuntime })

    expect(promptForRuntime).not.toHaveBeenCalled()
    expect(selection.runtime).toBe('claude-code')
  })

  it('falls through to the caller refusal when the prompt rung is omitted', async () => {
    // Omitting the rung is how --json, CI, and library callers are SKIPPED
    // rather than blocked on stdin.
    expect(await resolveRuntimeSelection(undefined, undefined, { env: {} })).toEqual({
      runtime: null,
      source: 'none',
    })
  })
})
