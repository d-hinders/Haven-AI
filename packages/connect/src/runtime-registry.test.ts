import { describe, expect, it } from 'vitest'
import { normalizeRuntime, restartRequiredForRuntime, runtimeProfile } from './runtime-registry.js'

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
    })
    expect(restartRequiredForRuntime('hermes')).toBe(true)
  })

  it('detects Hermes environment signals without overriding an explicit runtime', () => {
    expect(normalizeRuntime(undefined, { HERMES_HOME: '/tmp/hermes' })).toBe('hermes')
    expect(normalizeRuntime(undefined, { HERMES_AGENT: '1' })).toBe('hermes')
    expect(normalizeRuntime('codex-cli', { HERMES_HOME: '/tmp/hermes' })).toBe('codex-cli')
  })
})
