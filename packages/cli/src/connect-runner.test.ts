import { describe, expect, it, vi } from 'vitest'
import {
  isRefusal,
  parseOutcome,
  relayLine,
  runConnector,
  splitConnectorCommand,
  type Spawner,
} from './connect-runner.js'

/**
 * The connector child process (#2527).
 *
 * Two rules carry this file, and both come from the setup prompt's own
 * contract rather than from taste: the printed command may be changed in
 * exactly one way here (`--json` appended), and a refusal is relayed to the
 * human rather than resolved by the CLI.
 */

/**
 * What the backend ACTUALLY emits for ordinary inputs — both values bare,
 * because `shellQuote` leaves anything matching its plain pattern unquoted.
 * Pinned from the other side by `connector-command-parity.test.ts`, which
 * builds it and asserts this file contains it; an earlier version of this
 * fixture invented quotes the builder does not add, and that test caught it.
 */
const REAL_COMMAND =
  'npx -y @haven_ai/connect@alpha --setup hv_setup_abc123 --api https://api.haven.example --ack-local-tools'

function spawnerReturning(
  stdout: string,
  exitCode = 0,
  stderr = '',
): { spawner: Spawner; seen: { command: string; args: string[] }[] } {
  const seen: { command: string; args: string[] }[] = []
  const spawner: Spawner = async (command, args, onStderr) => {
    seen.push({ command, args })
    if (stderr) onStderr(stderr)
    return { stdout, stderr, exitCode }
  }
  return { spawner, seen }
}

describe('splitConnectorCommand', () => {
  it('splits the real backend-built command, keeping quoted values whole', () => {
    expect(splitConnectorCommand(REAL_COMMAND)).toEqual([
      'npx', '-y', '@haven_ai/connect@alpha',
      '--setup', 'hv_setup_abc123',
      '--api', 'https://api.haven.example',
      '--ack-local-tools',
    ])
  })

  it('keeps a quoted value containing a space in one argv entry', () => {
    expect(splitConnectorCommand("npx --api 'https://a b.example'")).toEqual([
      'npx', '--api', 'https://a b.example',
    ])
  })

  it('REFUSES shell metacharacters rather than approximating them', () => {
    // This is not a shell and must not pretend to be one. A command carrying
    // any of these means the backend built something this cannot faithfully
    // represent, and running a rewritten version of a command whose whole
    // contract is "unchanged" is worse than not running it.
    for (const nasty of [
      'npx --setup a && rm -rf /',
      'npx --setup "$(whoami)"',
      'npx --setup `id`',
      'npx --setup a | tee /tmp/x',
      'npx --setup a; echo done',
      'npx --setup a > /tmp/out',
    ]) {
      expect(() => splitConnectorCommand(nasty), nasty).toThrow(/Refusing to run/)
    }
  })

  it("understands the ONE escape the backend can emit, and no other", () => {
    // `shellQuote` escapes an embedded single quote as POSIX `'\''`. A
    // backend-built command carrying one has to be runnable — the backend
    // parity test caught this splitter refusing its own builder's output.
    expect(splitConnectorCommand("npx --setup 'a'\\''b'")).toEqual(['npx', '--setup', "a'b"])
    // Any other backslash is still refused: this parses one known quoting
    // function, it is not a shell.
    expect(() => splitConnectorCommand('npx --setup a\\nb')).toThrow(/backslash escape/)
  })

  it('refuses an unterminated quote and an empty command', () => {
    expect(() => splitConnectorCommand("npx --setup 'oops")).toThrow(/unterminated quote/)
    expect(() => splitConnectorCommand('   ')).toThrow(/empty connector command/)
  })
})

describe('parseOutcome', () => {
  it('reads the outcome even when a package manager wrote a line first', () => {
    // The `npx` path can print its own noise. Taking the last parseable object
    // rather than assuming the whole stream is the outcome keeps a good run
    // readable.
    const { outcome, noise } = parseOutcome(
      'npm warn exec The following package was not found\n{"schema_version":1,"outcome":"complete"}\n',
    )
    expect(outcome).toMatchObject({ outcome: 'complete' })
    expect(noise).toContain('npm warn exec')
  })

  it('returns null when there is no object at all', () => {
    expect(parseOutcome('nothing useful here').outcome).toBeNull()
  })
})

describe('runConnector', () => {
  it('appends --json and changes NOTHING else', async () => {
    const { spawner, seen } = spawnerReturning('{"schema_version":1,"outcome":"complete"}')
    await runConnector(REAL_COMMAND, spawner, () => undefined)

    expect(seen).toHaveLength(1)
    expect(seen[0].command).toBe('npx')
    expect(seen[0].args).toEqual([
      '-y', '@haven_ai/connect@alpha',
      '--setup', 'hv_setup_abc123',
      '--api', 'https://api.haven.example',
      '--ack-local-tools',
      '--json',
    ])
    // The two flags the CLI must never add on its own: a wiring collision is
    // the human's decision, and a CLI that could resolve one would be taking
    // it (boundary note on #2527).
    expect(seen[0].args).not.toContain('--replace')
    expect(seen[0].args).not.toContain('--name')
  })

  it('reads the outcome even though a refusal exits NON-ZERO', async () => {
    // The connector exits 1 on a refusal while still writing a complete
    // outcome. Treating the exit code as the verdict would throw away exactly
    // the structured refusal the human needs.
    const refusal = JSON.stringify({
      schema_version: 1,
      outcome: 'failed',
      error: {
        code: 'wiring_collision',
        next_action: 'relay_wiring_collision_to_user',
        message: 'already wired to agent-old — relay this to your user',
        superseded_agent_ids: ['agent-old'],
        suggested_name: 'payment-agent',
      },
    })
    const { spawner } = spawnerReturning(refusal, 1)
    const run = await runConnector(REAL_COMMAND, spawner, () => undefined)

    expect(run.exitCode).toBe(1)
    expect(isRefusal(run.outcome)).toBe(true)
    expect(run.outcome?.error).toMatchObject({
      superseded_agent_ids: ['agent-old'],
      suggested_name: 'payment-agent',
    })
  })

  it('streams stderr as it arrives rather than buffering to the end', async () => {
    const chunks: string[] = []
    const { spawner } = spawnerReturning('{"outcome":"complete"}', 0, 'installing…\n')
    await runConnector(REAL_COMMAND, spawner, (chunk) => chunks.push(chunk))
    expect(chunks).toEqual(['installing…\n'])
  })
})

describe('relayLine — built from what the connector said, never from a code table', () => {
  it('relays an UNKNOWN future refusal without a CLI change', async () => {
    // The point of keying on structure. This code did not exist when the CLI
    // was written; it still reaches the human with its own next action.
    const line = relayLine({
      outcome: 'failed',
      error: {
        code: 'some_refusal_invented_next_year',
        next_action: 'do_the_new_thing',
        message: 'Something new happened',
      },
    })
    expect(line).toBe('Something new happened (next: do_the_new_thing)')
  })

  it('relays runtime_undetermined and wiring_collision identically', () => {
    // Neither is special-cased, which is what makes the claim above true.
    const undetermined = relayLine({
      error: { code: 'runtime_undetermined', next_action: 'rerun_connect_with_explicit_runtime', message: 'Pick a runtime' },
    })
    const collision = relayLine({
      error: { code: 'wiring_collision', next_action: 'relay_wiring_collision_to_user', message: 'Already wired' },
    })
    expect(undetermined).toBe('Pick a runtime (next: rerun_connect_with_explicit_runtime)')
    expect(collision).toBe('Already wired (next: relay_wiring_collision_to_user)')
  })

  it('puts a waiting approval first when nothing was refused', () => {
    expect(
      relayLine({ outcome: 'action_required', approval: { required: true, url: 'https://app.haven.example/x' } }),
    ).toBe('Approve the budget to finish: https://app.haven.example/x')
  })

  it('never invents an approval link when the connector gave none', () => {
    // An agent may relay a link it was given and must never build one (#2528).
    const line = relayLine({ outcome: 'action_required', approval: { required: true } })
    expect(line).toBe('Approve the budget in your Haven tab to finish.')
    expect(line).not.toMatch(/https?:/)
  })

  it('says nothing for a clean completed run', () => {
    expect(relayLine({ outcome: 'complete', approval: { required: false } })).toBeNull()
  })
})
