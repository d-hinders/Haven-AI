import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { ConnectError } from './connect-error.js'
import {
  installedClientHint,
  promptForInstalledClient,
  resolveRuntimeByInstalledClientPrompt,
  scanInstalledClients,
  type InstalledClientCandidate,
  type PromptIo,
} from './installed-clients.js'

const HOME = '/home/tester'
const CWD = '/work/project'

/** A scan over exactly the paths named — everything else on this machine is absent. */
function scanWith(present: string[]) {
  const set = new Set(present)
  return scanInstalledClients({
    homeDir: HOME,
    cwd: CWD,
    env: {},
    exists: async (path) => set.has(path),
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

  it('takes an empty answer as the pre-selected default', async () => {
    const candidates = [candidate({ runtime: 'cursor' }), candidate({ runtime: 'vscode', label: 'VS Code' })]
    expect(await promptForInstalledClient(candidates, recordingIo(['']))).toBe('cursor')
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
    await promptForInstalledClient([candidate()], io)

    expect(io.written.join('')).toContain('API key and a signing key')
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
