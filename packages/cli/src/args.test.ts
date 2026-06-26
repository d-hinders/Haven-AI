import { describe, expect, it } from 'vitest'
import { parseArgs } from './args.js'

describe('parseArgs', () => {
  it('parses command + subcommand + positionals', () => {
    const a = parseArgs(['agents', 'show', 'agt_1'])
    expect(a.command).toBe('agents')
    expect(a.sub).toBe('show')
    expect(a.positionals).toEqual(['agt_1'])
  })

  it('collects flags with values', () => {
    const a = parseArgs(['activity', 'list', '--safe', 's1', '--limit', '5', '--direction', 'in', '--json'])
    expect(a.flags).toMatchObject({ safe: 's1', limit: 5, direction: 'in', json: true })
  })

  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['wallets', 'list', '--nope'])).toThrow(/Unknown option/)
  })

  it('rejects a missing flag value', () => {
    expect(() => parseArgs(['login', '--email'])).toThrow(/Missing value/)
  })

  it('validates --limit and --direction', () => {
    expect(() => parseArgs(['activity', 'list', '--limit', 'x'])).toThrow(/positive integer/)
    expect(() => parseArgs(['activity', 'list', '--direction', 'sideways'])).toThrow(/in.*out|"in"/)
  })

  it('parses --offset and rejects a negative one', () => {
    expect(parseArgs(['activity', 'list', '--offset', '50']).flags.offset).toBe(50)
    expect(parseArgs(['activity', 'list', '--offset', '0']).flags.offset).toBe(0)
    expect(() => parseArgs(['activity', 'list', '--offset', '-1'])).toThrow(/non-negative integer/)
  })

  it('surfaces help and version', () => {
    expect(parseArgs(['--help']).flags.help).toBe(true)
    expect(parseArgs(['-v']).flags.version).toBe(true)
  })
})
