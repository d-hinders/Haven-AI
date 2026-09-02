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
    //
    // #2422: the hint now has TWO branches (server-provided spec, and the
    // rolling-deploy skew with none). This guarantee has to hold in BOTH, so
    // assert both rather than whichever one the default argument happens to
    // select — a one-branch assertion would have gone on passing while the
    // other branch lost the warning entirely.
    const withSpec = runtimeStatusHelper(
      installWith('runtime_config_unreadable'),
      '@haven_ai/connect@alpha',
    )
    const withoutSpec = runtimeStatusHelper(installWith('runtime_config_unreadable'))

    for (const helper of [withSpec, withoutSpec]) {
      expect(helper).toContain('--doctor --repair')
      expect(helper).not.toMatch(/run the setup command again/i)
    }

    // Each branch words the warning to fit its own sentence shape; both say
    // "do not re-run setup as it stands".
    expect(withSpec).toContain('not the setup command')
    expect(withoutSpec).toContain('rather than re-running that setup command as-is')
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

/**
 * #2422: the repair hint must name the connector the BACKEND handed out, not a
 * literal compiled into the client.
 *
 * Before this slice the template said `npx @haven_ai/connect@alpha …`
 * unconditionally, so a developer connecting to the DEV backend was told to
 * repair their setup with the PRODUCTION connector — and it would have looked
 * like it worked. The dist-tag is deployment configuration
 * (`HAVEN_CONNECTOR_CHANNEL`), so the only correct source is the response.
 *
 * These assertions guard the code that GENERATES the sentence, and each one is
 * mutation-proved: reverting the template to the `@alpha` literal reddens the
 * first two.
 */
describe('runtimeStatusHelper takes the connector spec from the server (#2422)', () => {
  it('renders the spec it was given, verbatim', () => {
    const helper = runtimeStatusHelper(
      installWith('runtime_config_unreadable'),
      '@haven_ai/connect@dev',
    )

    expect(helper).toContain('npx @haven_ai/connect@dev --doctor --repair --runtime cursor')
  })

  it('names NO channel the server did not send', () => {
    // The failure this closes is specifically a *second*, hard-coded spec
    // surviving next to the server-provided one, so enumerate every spec in
    // the sentence rather than asserting the presence of the right one.
    const helper = runtimeStatusHelper(
      installWith('runtime_config_unreadable'),
      '@haven_ai/connect@dev',
    )
    const specs = [...helper.matchAll(/@haven_ai\/connect@([a-z0-9-]+)/g)].map((m) => m[1])

    expect(specs).toEqual(['dev'])
    expect(helper).not.toContain('@haven_ai/connect@alpha')
  })

  it('passes an alpha spec through unchanged, so production copy is untouched', () => {
    const helper = runtimeStatusHelper(
      installWith('runtime_config_unreadable'),
      '@haven_ai/connect@alpha',
    )

    // Byte-for-byte the sentence this surface rendered before #2422.
    expect(helper).toBe(
      'The agent client config on that machine could not be read, so Haven left it untouched. ' +
        'Fix the file the connector named, then run `npx @haven_ai/connect@alpha --doctor --repair --runtime cursor` ' +
        'there — not the setup command, which this agent no longer needs.',
    )
  })

  it('invents no package spec when the server sent none', () => {
    // Rolling-deploy skew against a backend that predates connector_package.
    // A guessed channel is worse than an unspelled command: the user runs the
    // wrong connector and it LOOKS like it worked.
    const helper = runtimeStatusHelper(installWith('runtime_config_unreadable'))

    expect(helper).not.toContain('@haven_ai/connect')
    expect(helper).not.toMatch(/@(alpha|dev|latest|beta|next)\b/)
    expect(helper).toContain('Fix the file')
  })

  it('still gives a RUNNABLE instruction when the server sent none', () => {
    // #2422 design review, finding 1: bare flags are not an instruction — the
    // user has nothing to attach them to. The fallback must name a command,
    // and the only one guaranteed correct for their machine is the invocation
    // they already ran, with the setup flag swapped out.
    const helper = runtimeStatusHelper(installWith('runtime_config_unreadable'))

    expect(helper).toContain('re-run the same npx connector command you used for setup')
    expect(helper).toContain('instead of --setup')
    expect(helper).toContain('--doctor --repair --runtime cursor')
    // It must still warn against re-running setup as it stands (#1719: the
    // token is spent and a fresh connection mints a second agent).
    expect(helper).toContain('rather than re-running that setup command as-is')
  })

  it('spends exactly ONE backtick pair on the fallback sentence', () => {
    // #2422 rendered re-review: this string lands in a `<dd>` that does no
    // markdown parsing, so every pair shows up as literal backticks on screen.
    // The renderer bug is pre-existing and out of scope; the COUNT is a choice
    // made in this copy, so hold it at one — the flags — and let a future
    // editor who adds a second pair find out here.
    const helper = runtimeStatusHelper(installWith('runtime_config_unreadable'))

    expect((helper.match(/`/g) ?? []).length).toBe(2)
  })
})
