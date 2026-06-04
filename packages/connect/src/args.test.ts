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
      '--ack-signer',
    ], {})

    expect(parsed.help).toBe(false)
    expect(parsed.options).toMatchObject({
      setupToken: 'hv_setup_test',
      apiBaseUrl: 'https://api.haven.example',
      runtime: 'claude-code',
      credentialsDir: '/tmp/haven-creds',
      ackSigner: true,
    })
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
    expect(helpText()).toMatch(/never sends it to Haven/)
  })
})
