import { emitKeypressEvents } from 'node:readline'

/** The three streams the prompt touches, injectable so a test can watch them. */
export interface PromptStreams {
  stdin: NodeJS.ReadStream
  stdout: NodeJS.WriteStream
  stderr: NodeJS.WriteStream
}

/**
 * Read a password from the TTY without echoing it. Falls back to a plain line
 * read when stdin isn't a TTY (so piping `HAVEN_PASSWORD` or a heredoc still
 * works, though the env var is the documented non-interactive path).
 *
 * Exported and stream-injected for one reason: which stream the prompt writes
 * to is part of the `--json` contract, and asserting it needs a seam. It is
 * `stderr` — see the comment at the write.
 */
export function promptPasswordWith(streams: PromptStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    const { stdin, stderr } = streams
    if (!stdin.isTTY) {
      let data = ''
      stdin.setEncoding('utf8')
      stdin.on('data', (chunk) => (data += chunk))
      stdin.on('end', () => resolve(data.trim()))
      stdin.on('error', reject)
      return
    }
    // stderr, never stdout (#2525 review): under `--json` stdout carries one
    // JSON value and nothing else, and a prompt written there would land ahead
    // of it. A prompt is prose addressed to a human at a terminal, so stderr is
    // where it belongs in both modes — the TTY still shows it.
    stderr.write('Password: ')
    emitKeypressEvents(stdin)
    stdin.setRawMode(true)
    let value = ''
    const onKey = (char: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.name === 'return' || key.name === 'enter') {
        cleanup()
        stderr.write('\n')
        resolve(value)
      } else if (key.ctrl && key.name === 'c') {
        cleanup()
        stderr.write('\n')
        reject(new Error('Cancelled'))
      } else if (key.name === 'backspace') {
        value = value.slice(0, -1)
      } else if (char && !key.ctrl) {
        value += char
      }
    }
    function cleanup() {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.off('keypress', onKey)
    }
    stdin.resume()
    stdin.on('keypress', onKey)
  })
}
