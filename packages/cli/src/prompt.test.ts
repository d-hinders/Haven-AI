import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { promptPasswordWith, type PromptStreams } from './cli.js'

/**
 * The password prompt is part of the `--json` contract (#2525 review, finding 1).
 *
 * `haven login --json` at a terminal, with no HAVEN_PASSWORD, used to write
 * "Password: " to **stdout** — ahead of the JSON object, breaking "one JSON
 * value and nothing else" for the one command an agent runs to get a session.
 * The stream is now stderr, and this is what holds it there: reverting the
 * write to stdout fails the first assertion below.
 */
function fakeStreams(isTty: boolean) {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & PassThrough
  Object.defineProperty(stdin, 'isTTY', { value: isTty })
  stdin.setRawMode = (() => stdin) as never
  const stdout: string[] = []
  const stderr: string[] = []
  const sink = (into: string[]) =>
    ({ write: (chunk: string) => { into.push(chunk); return true } }) as unknown as NodeJS.WriteStream
  return {
    streams: { stdin, stdout: sink(stdout), stderr: sink(stderr) } as PromptStreams,
    stdin,
    stdout,
    stderr,
  }
}

describe('password prompt', () => {
  it('writes the prompt to stderr, never stdout', async () => {
    const { streams, stdin, stdout, stderr } = fakeStreams(true)
    const pending = promptPasswordWith(streams)
    // Type a password and press return.
    stdin.emit('keypress', 's', { name: 's' })
    stdin.emit('keypress', 'e', { name: 'e' })
    stdin.emit('keypress', '', { name: 'return' })
    await expect(pending).resolves.toBe('se')
    expect(stderr.join('')).toContain('Password: ')
    expect(stdout.join('')).toBe('')
  })

  it('never echoes the typed characters to either stream', async () => {
    const { streams, stdin, stdout, stderr } = fakeStreams(true)
    const pending = promptPasswordWith(streams)
    for (const ch of 'hunter2') stdin.emit('keypress', ch, { name: ch })
    stdin.emit('keypress', '', { name: 'return' })
    await expect(pending).resolves.toBe('hunter2')
    expect([...stdout, ...stderr].join('')).not.toContain('hunter2')
  })

  it('falls back to a line read when stdin is not a TTY, writing no prompt at all', async () => {
    const { streams, stdin, stdout, stderr } = fakeStreams(false)
    const pending = promptPasswordWith(streams)
    stdin.write('from-a-pipe\n')
    stdin.end()
    await expect(pending).resolves.toBe('from-a-pipe')
    expect([...stdout, ...stderr].join('')).toBe('')
  })
})
