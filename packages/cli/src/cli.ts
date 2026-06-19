#!/usr/bin/env node

import { emitKeypressEvents } from 'node:readline'
import { run } from './commands.js'

/**
 * Read a password from the TTY without echoing it. Falls back to a plain line
 * read when stdin isn't a TTY (so piping `HAVEN_PASSWORD` or a heredoc still
 * works, though the env var is the documented non-interactive path).
 */
function promptPassword(): Promise<string> {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process
    if (!stdin.isTTY) {
      let data = ''
      stdin.setEncoding('utf8')
      stdin.on('data', (chunk) => (data += chunk))
      stdin.on('end', () => resolve(data.trim()))
      stdin.on('error', reject)
      return
    }
    stdout.write('Password: ')
    emitKeypressEvents(stdin)
    stdin.setRawMode(true)
    let value = ''
    const onKey = (char: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.name === 'return' || key.name === 'enter') {
        cleanup()
        stdout.write('\n')
        resolve(value)
      } else if (key.ctrl && key.name === 'c') {
        cleanup()
        stdout.write('\n')
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

run(process.argv.slice(2), { promptPassword })
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
