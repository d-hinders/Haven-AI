import { describe, expect, it } from 'vitest'
import {
  RUNTIME_SPEC_ENV,
  RuntimeSpecOverrideError,
  describeRuntimeSpecOverride,
  overrideApplies,
  resolveRuntimeSpecOverride,
  runtimeSpecOverrideDirectoryKey,
  runtimeSpecOverrideNotice,
} from './runtime-spec-override.js'

describe('resolveRuntimeSpecOverride (#2424)', () => {
  it('returns undefined when none of the three variables is set — the production case', () => {
    expect(resolveRuntimeSpecOverride({})).toBeUndefined()
    // Unrelated HAVEN_* variables are not an override.
    expect(resolveRuntimeSpecOverride({ HAVEN_CONNECTOR_CHANNEL: 'dev', HAVEN_API_URL: 'x' })).toBeUndefined()
  })

  it('reads each variable by name and returns only the ones that are set', () => {
    expect(resolveRuntimeSpecOverride({ HAVEN_SIGNER_SPEC: 'file:/abs/signer' }))
      .toEqual({ signer: 'file:/abs/signer' })
    expect(resolveRuntimeSpecOverride({ HAVEN_SDK_SPEC: '/abs/haven_ai-sdk-0.0.0.tgz' }))
      .toEqual({ sdk: '/abs/haven_ai-sdk-0.0.0.tgz' })
    expect(resolveRuntimeSpecOverride({ HAVEN_MCP_SPEC: '@haven_ai/mcp@0.0.0-dev.202609031522.fd49e1a' }))
      .toEqual({ mcp: '@haven_ai/mcp@0.0.0-dev.202609031522.fd49e1a' })
    expect(resolveRuntimeSpecOverride({
      HAVEN_SIGNER_SPEC: 'file:/a', HAVEN_SDK_SPEC: 'file:/b', HAVEN_MCP_SPEC: 'file:/c',
    })).toEqual({ signer: 'file:/a', sdk: 'file:/b', mcp: 'file:/c' })
  })

  it.each([
    ['empty', '', 'it is empty'],
    ['whitespace-only', '   ', 'it is empty'],
    ['embedded whitespace', 'file:/abs/my signer', 'it contains whitespace'],
    ['newline', 'file:/abs\n/x', 'it contains whitespace'],
    ['control character', 'file:/abs/\u0001x', 'it contains a control character'],
    ['semicolon', 'file:/abs; rm -rf /', 'it contains whitespace'],
    ['semicolon without spaces', 'file:/abs;rm', 'it contains the shell metacharacter ";"'],
    ['pipe', 'file:/abs|cat', 'it contains the shell metacharacter "|"'],
    ['dollar', 'file:$HOME/x', 'it contains the shell metacharacter "$"'],
    ['backtick', 'file:`id`', 'it contains the shell metacharacter "`"'],
    ['glob', 'file:/abs/*', 'it contains the shell metacharacter "*"'],
    ['quote', "file:'/abs'", "it contains the shell metacharacter \"'\""],
  ])('refuses a %s value before npm is reached, naming the variable', (_label, value, reason) => {
    for (const variable of Object.values(RUNTIME_SPEC_ENV)) {
      let caught: unknown
      try {
        resolveRuntimeSpecOverride({ [variable]: value })
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(RuntimeSpecOverrideError)
      const error = caught as RuntimeSpecOverrideError
      expect(error.variable).toBe(variable)
      expect(error.code).toBe('runtime_spec_override_invalid')
      expect(error.message).toContain(variable)
      expect(error.message).toContain(reason)
    }
  })

  it('a malformed variable is refused even when a sibling variable is well-formed', () => {
    expect(() => resolveRuntimeSpecOverride({ HAVEN_SIGNER_SPEC: 'file:/ok', HAVEN_SDK_SPEC: '' }))
      .toThrow(/HAVEN_SDK_SPEC/)
  })
})

describe('runtimeSpecOverrideDirectoryKey (#2424)', () => {
  it('is deterministic, short, and prefixed so it can never collide with a version-named directory', () => {
    const key = runtimeSpecOverrideDirectoryKey(['file:/abs/signer', '@haven_ai/sdk@0.1.34-alpha.0'])
    expect(key).toMatch(/^override-[0-9a-f]{12}$/)
    expect(runtimeSpecOverrideDirectoryKey(['file:/abs/signer', '@haven_ai/sdk@0.1.34-alpha.0'])).toBe(key)
  })

  it('changes when ANY resolved spec changes — including the non-overridden pinned sibling', () => {
    const base = runtimeSpecOverrideDirectoryKey(['file:/abs/signer', '@haven_ai/sdk@0.1.34-alpha.0'])
    expect(runtimeSpecOverrideDirectoryKey(['file:/abs/signer2', '@haven_ai/sdk@0.1.34-alpha.0'])).not.toBe(base)
    expect(runtimeSpecOverrideDirectoryKey(['file:/abs/signer', '@haven_ai/sdk@0.1.35-alpha.0'])).not.toBe(base)
    // Order is part of the key: the callers hash in a fixed order.
    expect(runtimeSpecOverrideDirectoryKey(['@haven_ai/sdk@0.1.34-alpha.0', 'file:/abs/signer'])).not.toBe(base)
  })
})

describe('overrideApplies / notice / describe (#2424)', () => {
  it('a lone HAVEN_MCP_SPEC does not apply to the signer runtime, and vice versa', () => {
    const mcpOnly = resolveRuntimeSpecOverride({ HAVEN_MCP_SPEC: 'file:/mcp' })
    expect(overrideApplies(mcpOnly, ['signer', 'sdk'])).toBe(false)
    expect(overrideApplies(mcpOnly, ['mcp', 'sdk'])).toBe(true)
    const signerOnly = resolveRuntimeSpecOverride({ HAVEN_SIGNER_SPEC: 'file:/signer' })
    expect(overrideApplies(signerOnly, ['mcp', 'sdk'])).toBe(false)
    expect(overrideApplies(signerOnly, ['signer', 'sdk'])).toBe(true)
    // HAVEN_SDK_SPEC applies to both runtimes — both install the SDK.
    const sdkOnly = resolveRuntimeSpecOverride({ HAVEN_SDK_SPEC: 'file:/sdk' })
    expect(overrideApplies(sdkOnly, ['signer', 'sdk'])).toBe(true)
    expect(overrideApplies(sdkOnly, ['mcp', 'sdk'])).toBe(true)
    expect(overrideApplies(undefined, ['signer', 'sdk'])).toBe(false)
  })

  it('the notice names every variable, the pin it replaces, and the directory', () => {
    const lines = runtimeSpecOverrideNotice(
      'signer runtime',
      { signer: 'file:/abs/signer' },
      { signer: '@haven_ai/signer@0.1.34-alpha.0', sdk: '@haven_ai/sdk@0.1.34-alpha.0' },
      '/home/u/.haven/signer-runtime/override-abc',
    )
    expect(lines[0]).toContain('RUNTIME SPEC OVERRIDE ACTIVE')
    expect(lines[0]).toContain('NOT the pinned manifest')
    expect(lines.join('\n')).toContain('HAVEN_SIGNER_SPEC=file:/abs/signer (instead of @haven_ai/signer@0.1.34-alpha.0)')
    expect(lines.join('\n')).not.toContain('HAVEN_SDK_SPEC')
    expect(lines.join('\n')).toContain('/home/u/.haven/signer-runtime/override-abc')
    expect(describeRuntimeSpecOverride({ sdk: 'file:/sdk', signer: 'file:/signer' }))
      .toBe('HAVEN_SIGNER_SPEC=file:/signer HAVEN_SDK_SPEC=file:/sdk')
  })
})
