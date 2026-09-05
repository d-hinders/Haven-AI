import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildConnectorCommand } from '../agent-connection-setups.js'

/**
 * One connector command, two surfaces (#2527).
 *
 * `haven agents connect` has to print the same command the dashboard modal
 * shows for the same setup. The way this codebase makes that true is
 * structural rather than comparative: both surfaces render the
 * `connector_command` field `buildConnectorCommand` produced, so there is one
 * string rather than two kept in agreement by hand.
 *
 * ## Why this asserts through TEXT rather than an import
 *
 * The obvious test imports the CLI's own `splitConnectorCommand` and runs the
 * builder's output through it. That compiles under vitest and FAILS under
 * `tsc`: the backend's `rootDir` is its own `src`, so a cross-package import
 * is a build error CI would catch after this suite went green. The repo's
 * existing idiom for cross-package agreement is a pinned value checked from
 * both sides (`chains-registry-snapshot.test.ts`), so this pins the exact
 * string and asserts the CLI's fixtures carry the same one. If the builder's
 * shape or quoting changes, this fails and names the file to update.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_SRC = join(__dirname, '../../../../cli/src')

/** The pin. The CLI's `connect-runner.test.ts` splits this exact string. */
const PINNED_COMMAND =
  'npx -y @haven_ai/connect@alpha --setup hv_setup_abc123 --api https://api.haven.example --ack-local-tools'

describe('connector command parity (#2527)', () => {
  it('builds the pinned shape the CLI test is written against', () => {
    // `CONNECTOR_PACKAGE` is channel-resolved (#2422), so this asserts the
    // shape around it rather than pinning a channel a dev deployment changes.
    const command = buildConnectorCommand('hv_setup_abc123', 'https://api.haven.example')
    expect(command).toMatch(
      /^npx -y @haven_ai\/connect@[a-z0-9._-]+ --setup hv_setup_abc123 --api https:\/\/api\.haven\.example --ack-local-tools$/,
    )
    expect(PINNED_COMMAND.replace(/@haven_ai\/connect@[a-z0-9._-]+/, '')).toBe(
      command.replace(/@haven_ai\/connect@[a-z0-9._-]+/, ''),
    )
    expect(buildConnectorCommand('hv_setup_abc123', 'https://api.haven.example', true)).toBe(
      `${command} --local`,
    )
  })

  it('the CLI is written against that same string', async () => {
    // Textual rather than imported, for the rootDir reason in the header. It
    // is still a real check: change the builder's quoting and the CLI's
    // fixture no longer matches what the backend emits, and this says so.
    const cliTest = await readFile(join(CLI_SRC, 'connect-runner.test.ts'), 'utf8')
    const normalise = (s: string) => s.replace(/@haven_ai\/connect@[a-z0-9._-]+/, '@connect')
    expect(normalise(cliTest)).toContain(normalise(PINNED_COMMAND))
  })

  it('the CLI never builds a connector command of its own', async () => {
    // The load-bearing assertion, and the reason byte-identity holds without
    // anyone comparing two strings at runtime. If the CLI ever composed
    // `npx ... --setup` itself, identity would become a coincidence maintained
    // by hand — and the first divergence would be a command a user pastes that
    // does not match what their dashboard shows.
    for (const file of ['commands.ts', 'connect-runner.ts']) {
      const source = await readFile(join(CLI_SRC, file), 'utf8')
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
      expect(code, file).not.toMatch(/@haven_ai\/connect/)
      expect(code, file).not.toMatch(/--ack-local-tools/)
      expect(code, file).not.toMatch(/npx\s+-y/)
    }
  })

  it('quotes a value that needs it, in the one form the CLI can parse', () => {
    // Both values in the pinned command above are left BARE — they match
    // `shellQuote`'s plain-value pattern, which is the ordinary case and what
    // the CLI fixture therefore has to be written against. This test covers
    // the other branch: an awkward value is wrapped, escaping
    // an embedded single quote as POSIX `'\''`. The CLI's splitter understands
    // exactly that form and refuses every other backslash — a distinction this
    // test exists to keep true, because a command the backend can emit and
    // `--run` cannot execute is a broken contract, not a safe refusal.
    const quoted = buildConnectorCommand("hv_setup_with space_and'quote", 'https://api.haven.example')
    expect(quoted).toContain(`--setup 'hv_setup_with space_and'\\''quote'`)
    expect(quoted).toContain(`--api https://api.haven.example`)
  })
})
