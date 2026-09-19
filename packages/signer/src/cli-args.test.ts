import { describe, expect, it } from 'vitest'
import { CONNECTOR_DOCTOR_COMMAND, helpText, parseSignerArgs } from './cli-args.js'
import { toolSchemas } from './tools.js'

describe('signer CLI arguments (#3173)', () => {
  it('parses the two real options', () => {
    expect(parseSignerArgs(['--credentials', '/x/agent.json', '--ack'])).toEqual({
      kind: 'run',
      options: { credentialsPath: '/x/agent.json', writeAck: true },
    })
    expect(parseSignerArgs([])).toEqual({ kind: 'run', options: {} })
  })

  it('refuses an unknown option with one line naming --help — it is never silently ignored', () => {
    const decision = parseSignerArgs(['--credentials', '/x/agent.json', '--verbose'])
    expect(decision.kind).toBe('unknown-option')
    if (decision.kind !== 'unknown-option') return
    expect(decision.option).toBe('--verbose')
    expect(decision.text).toMatch(/unknown option --verbose/)
    expect(decision.text).toMatch(/--help/)
    expect(decision.text.split('\n')).toHaveLength(1)
  })

  it("--ack-local-tools (the connector's flag) is named as the connector's, with the doctor command", () => {
    const decision = parseSignerArgs(['--ack-local-tools'])
    expect(decision.kind).toBe('unknown-option')
    if (decision.kind !== 'unknown-option') return
    expect(decision.text).toContain(CONNECTOR_DOCTOR_COMMAND)
    expect(decision.text).toMatch(/belongs to the connector/)
  })

  it('--help names EVERY registered tool — pinned against toolSchemas so a fifth tool cannot drift out', () => {
    const text = helpText()
    const registered = Object.keys(toolSchemas)
    expect(registered.length).toBeGreaterThanOrEqual(4)
    for (const name of registered) expect(text).toContain(`  - ${name}`)
    // and the bullet list has exactly that many entries
    expect(text.match(/^ {2}- haven_/gm)).toHaveLength(registered.length)
  })

  it('--help names the connector doctor and the --ack-local-tools repair', () => {
    const text = helpText()
    expect(text).toContain(CONNECTOR_DOCTOR_COMMAND)
    expect(text).toContain('local_signer_ack_required')
    expect(text).toContain('--ack-local-tools')
    expect(parseSignerArgs(['-h'])).toMatchObject({ kind: 'help' })
  })
})
