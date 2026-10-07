import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { ConnectError } from './connect-error.js'
import {
  installedClientHint,
  installedClientTargets,
  promptForInstalledClient,
  resolveRuntimeByInstalledClientPrompt,
  scanInstalledClients,
  type InstalledClientCandidate,
  type PromptIo,
} from './installed-clients.js'

const HOME = '/home/tester'
const CWD = '/work/project'

/**
 * A scan over exactly the paths named — everything else on this machine is
 * absent. Files needing CONTENT (only `~/.claude.json`'s `mcpServers` check,
 * #3732) are stubbed in `contents`; an existing path without an entry is an
 * empty/unreadable file.
 */
function scanWith(present: string[], contents: Record<string, string> = {}) {
  const set = new Set(present)
  return scanInstalledClients({
    homeDir: HOME,
    cwd: CWD,
    env: {},
    exists: async (path) => set.has(path),
    readFile: async (path) => {
      if (!(path in contents)) throw new Error(`no content stubbed for ${path}`)
      return contents[path]
    },
  })
}

function recordingIo(answers: (string | null)[]): PromptIo & { written: string[]; asked: string[] } {
  const written: string[] = []
  const asked: string[] = []
  return {
    written,
    asked,
    write: (text) => void written.push(text),
    question: async (query) => {
      asked.push(query)
      return answers.length > 0 ? (answers.shift() as string | null) : null
    },
  }
}

function candidate(overrides: Partial<InstalledClientCandidate> = {}): InstalledClientCandidate {
  return {
    runtime: 'cursor',
    label: 'Cursor',
    detail: 'installed',
    configPath: '/home/tester/.cursor/mcp.json',
    evidence: 'config-file',
    ...overrides,
  }
}

describe('installed-client scan (#1719)', () => {
  it('offers only clients whose config the connector can actually write', async () => {
    const found = await scanWith([
      join(HOME, '.cursor', 'mcp.json'),
      join(HOME, '.codex'),
      // OpenClaw resolves to the manual `other` profile, which Haven cannot
      // write. Its config existing must not put a row in front of the user
      // that picking would strand them on.
      join(HOME, '.openclaw', 'openclaw.json'),
    ])

    expect(found.map((entry) => entry.runtime)).toEqual(['cursor', 'codex-cli'])
    expect(found.every((entry) => entry.runtime !== 'other')).toBe(true)
  })

  it('ranks an existing MCP config above a bare client directory', async () => {
    // claude-code sorts FIRST among directory evidence, so if evidence tier did
    // not dominate it would lead here — it must not.
    const found = await scanWith([join(HOME, '.claude'), join(HOME, '.cursor', 'mcp.json')])

    expect(found.map((entry) => entry.runtime)).toEqual(['cursor', 'claude-code'])
    expect(found[0].evidence).toBe('config-file')
    expect(found[1].evidence).toBe('client-directory')
  })

  it('counts a workspace .vscode directory as VS Code evidence', async () => {
    const found = await scanWith([join(CWD, '.vscode')])
    expect(found.map((entry) => entry.runtime)).toEqual(['vscode'])
  })

  it('finds nothing on a machine with no agent client installed', async () => {
    expect(await scanWith([])).toEqual([])
  })

  it('counts a ~/.claude.json carrying mcpServers as config-file evidence for Claude Code (#3732)', async () => {
    // Claude Code configures through its own CLI, so `configPath` stays null —
    // but the file proves the user has already pointed Claude Code at an MCP
    // server, which is the evidence tier the scan treats as a fact.
    const claudeJson = join(HOME, '.claude.json')
    const found = await scanWith([claudeJson], { [claudeJson]: JSON.stringify({ mcpServers: { haven: {} } }) })

    expect(found.map((entry) => entry.runtime)).toEqual(['claude-code'])
    expect(found[0].evidence).toBe('config-file')
    expect(found[0].configPath).toBeNull()
    expect(found[0].evidencePath).toBe(claudeJson)
    expect(found[0].detail).toContain('.claude.json')
  })

  it('a Codex config and a Claude Code MCP config tie — no suggestion, no Codex by construction (#3732)', async () => {
    // The field evidence: on this pair the picker used to pre-select Codex —
    // config-file tier beat Claude Code's bare directory marker, whatever the
    // user's actual runtime. Both are config-tier now, so the top two share a
    // tier and `installedClientHint` suggests NOTHING.
    const claudeJson = join(HOME, '.claude.json')
    const codexToml = join(HOME, '.codex', 'config.toml')
    const found = await scanWith([claudeJson, codexToml], { [claudeJson]: JSON.stringify({ mcpServers: {} }) })

    expect(found.map((entry) => entry.runtime)).toEqual(['claude-code', 'codex-cli'])
    expect(found.every((entry) => entry.evidence === 'config-file')).toBe(true)
    expect(installedClientHint(found).suggestedRuntime).toBeUndefined()
  })

  it('a ~/.claude.json WITHOUT mcpServers stays directory-tier evidence, as before', async () => {
    const claudeJson = join(HOME, '.claude.json')
    const found = await scanWith([claudeJson], { [claudeJson]: JSON.stringify({ projects: {} }) })

    expect(found.map((entry) => entry.runtime)).toEqual(['claude-code'])
    expect(found[0].evidence).toBe('client-directory')
    expect(found[0].evidencePath).toBeNull()
  })

  it('a ~/.claude.json that cannot be parsed grants nothing beyond the directory marker', async () => {
    const claudeJson = join(HOME, '.claude.json')
    const found = await scanWith([claudeJson], { [claudeJson]: 'not json at all' })

    expect(found.map((entry) => entry.runtime)).toEqual(['claude-code'])
    expect(found[0].evidence).toBe('client-directory')
  })

  it('labels the chat app "Claude Desktop (chat app)", never bare "Claude Desktop" (#3732)', () => {
    // The chat app is a separate runtime from Claude Code, and its label used
    // to sort above Claude Code whenever both had config — a user in the
    // desktop app's Code tab could read the row as "where I am".
    const desktop = installedClientTargets(HOME, CWD, {}).find((target) => target.runtime === 'claude-desktop')

    expect(desktop?.label).toBe('Claude Desktop (chat app)')
  })
})

describe('installed-client prompt (#1719)', () => {
  it('NEVER selects for the user, even when exactly one client is installed', async () => {
    const io = recordingIo(['1'])
    const runtime = await resolveRuntimeByInstalledClientPrompt({
      homeDir: HOME,
      cwd: CWD,
      env: {},
      exists: async (path) => path === join(HOME, '.cursor', 'mcp.json'),
      io,
    })

    // The single candidate is what makes this the interesting case: detecting
    // one installed app tells you what EXISTS, not where the user wants their
    // agent to run — and a silent write plants an API key and a delegate key
    // in an app they may not use.
    expect(io.asked).toHaveLength(1)
    expect(runtime).toBe('cursor')
  })

  it('refuses with a machine-readable code when nothing writable is installed, without prompting', async () => {
    const io = recordingIo(['1'])
    const error = await resolveRuntimeByInstalledClientPrompt({
      homeDir: HOME,
      cwd: CWD,
      env: {},
      exists: async () => false,
      io,
    }).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(ConnectError)
    expect((error as ConnectError).code).toBe('runtime_no_installed_clients')
    expect((error as ConnectError).message).toContain('--runtime other')
    expect(io.asked).toHaveLength(0)
  })

  it('treats an empty answer as NO default: re-asks, then aborts after MAX_PROMPT_ATTEMPTS (#3732)', async () => {
    // Inverted from the pre-#3732 rule (empty accepted the first candidate):
    // Enter used to write an API key and a signing key into whichever client
    // sorted first. Now it re-asks — spending an attempt, like the
    // wiring-collision prompt — and aborts with nothing written.
    const io = recordingIo(['', '', ''])
    const error = await promptForInstalledClient(
      [candidate(), candidate({ runtime: 'vscode', label: 'VS Code' })],
      io,
    ).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(ConnectError)
    expect((error as ConnectError).code).toBe('runtime_prompt_aborted')
    expect(io.asked).toHaveLength(3)
    expect((error as ConnectError).message).toContain('Nothing was written')
  })

  it('an empty answer never selects, even the lone suggested candidate', async () => {
    // Property 2 holds at the prompt too: the single candidate is what EXISTS.
    // The empty answer is re-asked; only the typed number resolves.
    const io = recordingIo(['', '1'])
    expect(await promptForInstalledClient([candidate()], io)).toBe('cursor')
    expect(io.asked).toHaveLength(2)
  })

  it('marks the suggested runtime in the list but pre-selects nothing', async () => {
    const io = recordingIo(['1'])
    const candidates = [
      candidate({
        runtime: 'codex-cli',
        label: 'Codex (CLI or Desktop)',
        detail: 'MCP config found at /home/tester/.codex/config.toml',
      }),
      candidate({ runtime: 'hermes', label: 'Hermes Agent', evidence: 'client-directory', configPath: null, detail: 'installed (/home/tester/.hermes)' }),
    ]

    expect(await promptForInstalledClient(candidates, io)).toBe('codex-cli')
    const written = io.written.join('')
    expect(written).toContain('1) Codex (CLI or Desktop) (suggested)')
    expect(written).not.toContain('2) Hermes Agent (suggested)')
    expect(written).not.toContain('default')
  })

  it('Enter writes nothing over real paths: a Codex config and a Claude Code MCP config produce no default (#3732)', async () => {
    const claudeJson = join(HOME, '.claude.json')
    const codexToml = join(HOME, '.codex', 'config.toml')
    const io = recordingIo(['', '', ''])
    const error = await resolveRuntimeByInstalledClientPrompt({
      homeDir: HOME,
      cwd: CWD,
      env: {},
      exists: async (path) => path === claudeJson || path === codexToml,
      readFile: async (path) => (path === claudeJson ? JSON.stringify({ mcpServers: {} }) : '[mcp_servers.haven]'),
      io,
    }).catch((err: unknown) => err)

    expect((error as ConnectError).code).toBe('runtime_prompt_aborted')
    expect(io.asked).toHaveLength(3)
    // Both rows are config-tier, so nothing is marked suggested — before the
    // fix this pair pre-selected Codex by construction.
    expect(io.written.join('')).not.toContain('(suggested)')
  })

  it('resolves the numbered choice the user actually types', async () => {
    const candidates = [candidate({ runtime: 'cursor' }), candidate({ runtime: 'vscode', label: 'VS Code' })]
    expect(await promptForInstalledClient(candidates, recordingIo(['2']))).toBe('vscode')
  })

  it('re-asks on an out-of-range answer instead of guessing', async () => {
    const io = recordingIo(['9', 'banana', '2'])
    const candidates = [candidate({ runtime: 'cursor' }), candidate({ runtime: 'vscode', label: 'VS Code' })]

    expect(await promptForInstalledClient(candidates, io)).toBe('vscode')
    expect(io.asked).toHaveLength(3)
  })

  it('refuses rather than falling back after repeated invalid answers', async () => {
    const io = recordingIo(['9', '9', '9'])
    const error = await promptForInstalledClient([candidate()], io).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(ConnectError)
    expect((error as ConnectError).code).toBe('runtime_prompt_aborted')
  })

  it('treats Ctrl-C / EOF as an abort with a code, not as the default', async () => {
    const io = recordingIo([null])
    const candidates = [candidate({ runtime: 'cursor' }), candidate({ runtime: 'vscode', label: 'VS Code' })]
    const error = await promptForInstalledClient(candidates, io).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(ConnectError)
    expect((error as ConnectError).code).toBe('runtime_prompt_aborted')
    // The message has to say what state the user is in, because "cancelled"
    // alone leaves them wondering whether an agent now exists.
    expect((error as ConnectError).message).toContain('Nothing was written')
    expect((error as ConnectError).message).toContain('setup token is still unused')
  })

  it('names what a wrong pick costs, before asking', async () => {
    const io = recordingIo([''])
    // #3732: the empty answer no longer selects — the prompt re-asks, then
    // aborts. The cost line is still written BEFORE the first ask.
    const error = await promptForInstalledClient([candidate()], io).catch((err: unknown) => err)

    expect(io.written.join('')).toContain('API key and a signing key')
    expect((error as ConnectError).code).toBe('runtime_prompt_aborted')
  })

  it('refuses an empty candidate list rather than prompting for nothing', async () => {
    const question = vi.fn()
    const error = await promptForInstalledClient([], { write: () => {}, question }).catch((err: unknown) => err)

    expect((error as ConnectError).code).toBe('runtime_no_installed_clients')
    expect(question).not.toHaveBeenCalled()
  })
})

// #2174: the scan's findings as DATA for the --json refusal. The invariant
// under test is #1719's property 2 — populates, never selects — which here
// means the hint must stay silent whenever "top" would be an artefact of the
// fixed SCAN_ORDER tiebreak rather than a fact about the machine.
describe('installedClientHint (#2174)', () => {
  function candidate(
    runtime: InstalledClientCandidate['runtime'],
    evidence: InstalledClientCandidate['evidence'],
  ): InstalledClientCandidate {
    return { runtime, label: runtime, detail: 'x', configPath: null, evidence }
  }

  it('reports nothing and suggests nothing when the scan found nothing', () => {
    expect(installedClientHint([])).toEqual({ installedClients: [] })
  })

  it('suggests a lone candidate', () => {
    expect(installedClientHint([candidate('cursor', 'client-directory')])).toEqual({
      installedClients: ['cursor'],
      suggestedRuntime: 'cursor',
    })
  })

  it('suggests a live MCP config over a bare client directory', () => {
    const hint = installedClientHint([
      candidate('codex-cli', 'config-file'),
      candidate('claude-code', 'client-directory'),
    ])

    expect(hint.installedClients).toEqual(['codex-cli', 'claude-code'])
    expect(hint.suggestedRuntime).toBe('codex-cli')
  })

  it('lists both but suggests neither when the top two share an evidence tier', () => {
    // Separated only by SCAN_ORDER — a fixed preference, not a finding. The
    // agent still gets the narrowed list to choose from.
    const hint = installedClientHint([
      candidate('claude-code', 'config-file'),
      candidate('cursor', 'config-file'),
    ])

    expect(hint.installedClients).toEqual(['claude-code', 'cursor'])
    expect(hint.suggestedRuntime).toBeUndefined()
  })

  it('picks the single configured client out of an UNSORTED list', () => {
    // The rule reads the whole array, not the first two entries: this is an
    // exported function, and a caller that has not sorted its candidates must
    // not get a quietly wrong suggestion.
    const hint = installedClientHint([
      candidate('claude-code', 'client-directory'),
      candidate('hermes', 'client-directory'),
      candidate('codex-cli', 'config-file'),
    ])

    expect(hint.suggestedRuntime).toBe('codex-cli')
    // The list itself keeps the order it was given.
    expect(hint.installedClients).toEqual(['claude-code', 'hermes', 'codex-cli'])
  })

  it('suggests nothing when two configured clients tie anywhere in the list', () => {
    const hint = installedClientHint([
      candidate('cursor', 'config-file'),
      candidate('claude-code', 'client-directory'),
      candidate('hermes', 'config-file'),
    ])

    expect(hint.suggestedRuntime).toBeUndefined()
  })

  it('suggests nothing when two bare client directories tie', () => {
    const hint = installedClientHint([
      candidate('claude-code', 'client-directory'),
      candidate('hermes', 'client-directory'),
    ])

    expect(hint.suggestedRuntime).toBeUndefined()
  })
})
