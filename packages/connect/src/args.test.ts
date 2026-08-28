import { describe, expect, it } from 'vitest'
import { helpText, parseArgs } from './args.js'

describe('parseArgs', () => {
  it('parses the one-command setup shape', () => {
    const parsed = parseArgs([
      '--setup',
      'hv_setup_test',
      '--api',
      'https://api.haven.example/',
      '--runtime',
      'claude-code',
      '--credentials-dir',
      '/tmp/haven-creds',
      '--ack-local-tools',
    ], {})

    expect(parsed.help).toBe(false)
    expect(parsed.json).toBe(false)
    expect(parsed.options).toMatchObject({
      setupToken: 'hv_setup_test',
      apiBaseUrl: 'https://api.haven.example',
      runtime: 'claude-code',
      credentialsDir: '/tmp/haven-creds',
      ackLocalTools: true,
    })
  })

  it('parses --local as the advanced local MCP opt-in', () => {
    const parsed = parseArgs(['--setup', 'hv_setup_test', '--local'], {})
    expect(parsed.options.localMcp).toBe(true)
  })

  it('parses --json as a structured-output request', () => {
    const parsed = parseArgs(['--setup', 'hv_setup_test', '--json'], {})
    expect(parsed.json).toBe(true)
    expect(helpText()).toContain('--json')
  })

  it('does not enable local MCP by default', () => {
    const parsed = parseArgs(['--setup', 'hv_setup_test'], {})
    expect(parsed.options.localMcp).toBeUndefined()
  })

  it('documents --local in help output', () => {
    expect(helpText()).toContain('--local')
    expect(helpText()).toContain('Claude Code and Codex')
  })

  it('keeps --ack-signer as an alias for local tools acknowledgement', () => {
    const parsed = parseArgs(['--setup', 'hv_setup_test', '--ack-signer'], {})

    expect(parsed.options.ackSigner).toBe(true)
    expect(parsed.options.ackLocalTools).toBe(true)
  })

  it('uses HAVEN_API_URL when --api is omitted', () => {
    const parsed = parseArgs(['--setup', 'hv_setup_test'], {
      HAVEN_API_URL: 'https://api.env.example/',
    })

    expect(parsed.options.apiBaseUrl).toBe('https://api.env.example')
  })

  it('requires a setup token unless help is requested', () => {
    expect(() => parseArgs([], {})).toThrow('--setup')
    expect(parseArgs(['--help'], {}).help).toBe(true)
    expect(helpText()).toContain('codex-desktop')
    expect(helpText()).toContain('hermes')
    expect(helpText()).toMatch(/never sends it to Haven/)
  })

  it('parses --runtime-force into options.runtimeForce (#1672)', () => {
    const parsed = parseArgs(['--setup', 'hv_setup_test', '--runtime-force', 'claude-desktop'], {})

    expect(parsed.options.runtimeForce).toBe('claude-desktop')
    expect(parsed.options.runtime).toBeUndefined()
    expect(() => parseArgs(['--setup', 'hv_setup_test', '--runtime-force'], {})).toThrow('Missing value for --runtime-force')
    expect(helpText()).toContain('--runtime-force')
  })
})

describe('parseArgs --tombstone (#1681)', () => {
  it('parses the retirement shape without a setup token or runtime', () => {
    const parsed = parseArgs(
      ['--tombstone', '/tmp/agents/agent-old', '--reason', 'superseded', '--replaced-by', 'agent-new'],
      {},
    )
    expect(parsed.tombstone).toEqual({
      directory: '/tmp/agents/agent-old',
      reason: 'superseded',
      replacedBy: 'agent-new',
    })
  })

  it('takes precedence over --doctor: no --runtime requirement kicks in', () => {
    // cli.ts dispatches on tombstone FIRST; parseArgs must not throw doctor's
    // runtime-required error when both are passed.
    const parsed = parseArgs(['--tombstone', '/tmp/agents/agent-old', '--doctor'], {})
    expect(parsed.tombstone?.directory).toBe('/tmp/agents/agent-old')
    expect(parsed.doctor).toBe(true)
  })

  it('REFUSES --reason / --replaced-by without --tombstone — never a silent no-op', () => {
    expect(() => parseArgs(['--setup', 'hv_setup_x', '--reason', 'oops'], {})).toThrow(/require --tombstone/)
    expect(() => parseArgs(['--setup', 'hv_setup_x', '--replaced-by', 'a'], {})).toThrow(/require --tombstone/)
  })

  it('--help still wins over a stray --reason', () => {
    const parsed = parseArgs(['--help', '--reason', 'oops'], {})
    expect(parsed.help).toBe(true)
  })

describe('parseArgs --unwire (#2169)', () => {
  it('parses the positional directory form without a setup token or runtime', () => {
    const parsed = parseArgs(['--unwire', '/tmp/agents/agent-old', '--reason', 'retiring'], {})
    expect(parsed.unwire).toEqual({ reason: 'retiring' })
    expect(parsed.unwireDir).toBe('/tmp/agents/agent-old')
  })

  it('accepts --unwire --name <slug> as the target and resolves the dir in cli.ts', () => {
    const parsed = parseArgs(['--unwire', '--name', 'research'], {})
    expect(parsed.unwire).toEqual({})
    expect(parsed.options.serverName).toBe('research')
  })

  it('accepts --unwire --credentials-dir <path> as the target', () => {
    const parsed = parseArgs(['--unwire', '--credentials-dir', '/tmp/agents'], {})
    expect(parsed.options.credentialsDir).toBe('/tmp/agents')
  })

  it('REFUSES --unwire without any target — never operates on a guessed directory', () => {
    expect(() => parseArgs(['--unwire'], {})).toThrow(/--unwire needs a target/)
  })

  it('REFUSES --unwire together with --setup — the token belongs to new wiring only', () => {
    expect(() => parseArgs(['--unwire', '--name', 'research', '--setup', 'hv_setup_x'], {})).toThrow(
      /does not take --setup/,
    )
  })

  it('REFUSES --unwire together with --tombstone — both are standalone teardown modes', () => {
    expect(() => parseArgs(['--unwire', '/a', '--tombstone', '/b'], {})).toThrow(/separate operations/)
  })

  it('lets a following flag after --unwire win over the directory (--reason does not swallow a dir)', () => {
    const parsed = parseArgs(['--unwire', '--reason', 'why', '--name', 'research'], {})
    expect(parsed.unwire).toEqual({ reason: 'why' })
    expect(parsed.options.serverName).toBe('research')
  })
})
})

describe('parseArgs --name (#1696)', () => {
  it('parses the wiring slug into options.serverName', () => {
    const parsed = parseArgs(['--setup', 'hv_setup_x', '--name', 'work'], {})
    expect(parsed.options.serverName).toBe('work')
  })

  it('omitting --name leaves serverName undefined — the bare pair', () => {
    const parsed = parseArgs(['--setup', 'hv_setup_x'], {})
    expect(parsed.options.serverName).toBeUndefined()
  })

  it('MUTATION PROOF: an invalid slug dies AT THE ARGUMENT, before anything else runs', () => {
    // parseArgs touches no filesystem, so a throw here proves validation
    // precedes every write — the slug is immutable once wired (#1694).
    expect(() => parseArgs(['--setup', 'hv_setup_x', '--name', 'Bad Slug'], {})).toThrow(/Invalid server name/)
    expect(() => parseArgs(['--setup', 'hv_setup_x', '--name', 'haven'], {})).toThrow(/unnamed pair/)
    expect(() => parseArgs(['--setup', 'hv_setup_x', '--name', 'haven-signer'], {})).toThrow(/unnamed pair/)
    expect(() => parseArgs(['--setup', 'hv_setup_x', '--name', 'signer-ops'], {})).toThrow(/reserved/)
  })
})
