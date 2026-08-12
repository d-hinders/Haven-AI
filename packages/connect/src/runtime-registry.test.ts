import { describe, expect, it } from 'vitest'
import {
  normalizeRuntime,
  restartRequiredForRuntime,
  runtimeProfile,
  runtimeVerificationInstruction,
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
})
