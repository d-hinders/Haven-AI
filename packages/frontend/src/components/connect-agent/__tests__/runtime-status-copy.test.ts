import { describe, expect, it } from 'vitest'
import { runtimeStatusHelper, runtimeStatusLabel } from '../setup-copy'
import type { AgentConnectionSetupStatusResponse } from '@/hooks/useAgentConnectionSetupStatus'

type Install = AgentConnectionSetupStatusResponse['install_status']

function installWith(errorCode: string): Install {
  return {
    runtime: 'cursor',
    runtime_mcp_mode: 'hosted_plus_signer',
    hosted_mcp_configured: false,
    local_signer_configured: false,
    local_mcp_configured: false,
    credential_files_written: true,
    restart_required: true,
    error_code: errorCode,
  } as unknown as Install
}

/**
 * #1719: the connector's config-write failures split into a retryable one and
 * one that never becomes retryable. The dashboard has to say which, because
 * "run the setup command again" is advice that cannot work against a config
 * file the user has to fix by hand first.
 */
describe('runtimeStatusHelper for config failures (#1719)', () => {
  it('tells the user to FIX the file when the client config could not be read', () => {
    const helper = runtimeStatusHelper(installWith('runtime_config_unreadable'))

    expect(helper).toContain('could not be read')
    expect(helper).toContain('left it untouched')
    expect(helper).toContain('Fix the file')
  })

  it('sends an unreadable config to --repair, never back through setup', () => {
    // #1719 review: this failure happens after the agent is registered, so the
    // setup token is spent. Telling the user to "run the setup command again"
    // lands on a 409; starting a fresh connection mints a SECOND agent (#1688).
    const helper = runtimeStatusHelper(installWith('runtime_config_unreadable'))

    expect(helper).toContain('--doctor --repair')
    expect(helper).toContain('not the setup command')
    expect(helper).not.toMatch(/run the setup command again/i)
  })

  it('spells the repair command WITH --runtime, because the parser requires it', () => {
    // #1719 design review (blocking): the connector's arg parser refuses
    // --doctor/--repair without --runtime and has no detection fallback on
    // that path. A command missing it reproduces the failure with a second,
    // less legible error — advice worse than none.
    expect(runtimeStatusHelper(installWith('runtime_config_unreadable'))).toContain(
      '--doctor --repair --runtime cursor',
    )
  })

  it('keeps the command shape correct when the connector reported no runtime', () => {
    const noRuntime = { ...installWith('runtime_config_unreadable'), runtime: undefined } as Install

    expect(runtimeStatusHelper(noRuntime)).toContain('--doctor --repair --runtime <your agent client>')
  })

  it('keeps the retry wording for a genuine write failure', () => {
    const helper = runtimeStatusHelper(installWith('runtime_config_write_failed'))

    expect(helper).toContain('could not update')
    expect(helper).toContain('run the setup command again')
    expect(helper).not.toContain('Fix the file')
  })

  it('does not leave either code on the generic manual-finish fallback', () => {
    const generic = 'The connector stored credentials, but runtime setup needs a manual finish.'

    expect(runtimeStatusHelper(installWith('runtime_config_unreadable'))).not.toBe(generic)
    expect(runtimeStatusHelper(installWith('runtime_config_write_failed'))).not.toBe(generic)
    // An unknown future code still falls back rather than rendering nothing.
    expect(runtimeStatusHelper(installWith('some_code_from_a_newer_connector'))).toBe(generic)
  })

  it('marks both as needing attention', () => {
    expect(runtimeStatusLabel(installWith('runtime_config_unreadable'))).toBe('Needs attention')
    expect(runtimeStatusLabel(installWith('runtime_config_write_failed'))).toBe('Needs attention')
  })
})
