/**
 * `sync-agent-guidance.mjs --check` tells the reader the right fix for each
 * copy that drifted (#4748).
 *
 * `packages/frontend/public/for-agents.md` is a hand-kept copy the script
 * verifies but never writes, so "regenerate" — the only instruction `--check`
 * printed before #4748 — left that copy stale. This drives the REAL script
 * over a mirrored temp tree, edits one copy or two, and asserts the
 * instruction lines; then it runs the printed instruction and asserts that
 * `--check` goes green, so "concrete" is measured rather than read.
 *
 * Why a mirror, not the repository: `--check` takes no path override — every
 * path derives from the script's own `import.meta.url` — and these cases have
 * to edit the copies. Why `realpathSync`: the script's entry guard compares
 * the resolved `import.meta.url` with the unresolved `argv[1]`, and on macOS
 * `os.tmpdir()` is a symlink, so an unresolved tree makes `--check` print
 * nothing and exit 0. The no-drift case below is the positive control for
 * that: it requires every ✓ line, which a silent exit cannot produce.
 *
 * Lives in scripts/ci/ because CI runs `node --test scripts/ci/*.test.mjs`
 * with no install step; `packages/cli` runs vitest, which would not run a
 * `node:test` file.
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = 'packages/cli/scripts/sync-agent-guidance.mjs'
const CLI_COPY = 'packages/cli/src/agent-guidance-text.ts'
const FOR_AGENTS = 'packages/frontend/public/for-agents.md'
const STEPS_DIR = 'packages/frontend/public/agent-skills'
const STEP = `${STEPS_DIR}/the-sequence.md`

// Every file `--check` reads: the script, the canonical source, and the copies.
const MIRRORED = [
  SCRIPT,
  'packages/sdk/src/agent-guidance.ts',
  CLI_COPY,
  FOR_AGENTS,
  ...readdirSync(path.join(REPO, STEPS_DIR))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `${STEPS_DIR}/${name}`),
]

// The labels `--check` prints, as they appear in its ✓ / ✗ lines.
const LABEL = {
  cli: 'CLI (packages/cli/src/agent-guidance-text.ts)',
  forAgents: 'frontend (packages/frontend/public/for-agents.md)',
  step: 'frontend step (packages/frontend/public/agent-skills/the-sequence.md)',
  otherStep: 'frontend step (packages/frontend/public/agent-skills/vocabulary.md)',
}

let root

beforeEach(() => {
  root = mkdtempSync(path.join(realpathSync(tmpdir()), 'sync-agent-guidance-check-'))
  for (const rel of MIRRORED) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    cpSync(path.join(REPO, rel), path.join(root, rel))
  }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const read = (rel) => readFileSync(path.join(root, rel), 'utf8')
const write = (rel, text) => writeFileSync(path.join(root, rel), text)

function run(...args) {
  const result = spawnSync(process.execPath, [path.join(root, SCRIPT), ...args], {
    cwd: root,
    encoding: 'utf8',
  })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** The command printed on the line after `<lead>:` in `--check`'s stderr. */
function instructionAfter(stderr, lead) {
  const lines = stderr.split('\n')
  const at = lines.findIndex((line) => line.endsWith(`${lead}:`))
  assert.ok(at >= 0, `no "${lead}:" line in:\n${stderr}`)
  return lines[at + 1].trim()
}

/** Run a printed instruction the way a reader would: in a shell, from the repo root. */
function follow(command) {
  execFileSync('sh', ['-c', command], { cwd: root, stdio: 'pipe' })
}

const driftForAgents = () => write(FOR_AGENTS, `${read(FOR_AGENTS)}\nDRIFT\n`)
const driftCli = () =>
  write(CLI_COPY, read(CLI_COPY).replace('HAVEN_AGENT_RUNBOOK_MD = "', 'HAVEN_AGENT_RUNBOOK_MD = "DRIFT '))
const driftStep = () => write(STEP, `${read(STEP)}\nDRIFT\n`)

const REGENERATE = 'node packages/cli/scripts/sync-agent-guidance.mjs'
const RESTORE = `node packages/cli/scripts/sync-agent-guidance.mjs --print-runbook > ${FOR_AGENTS}`
const RESTORE_LEAD = `${LABEL.forAgents} is stale, and this script does not write it. Restore it with:`
const SIZE_NOTE =
  '\nThen update any hand-asserted size figures the pin tests carry — a content\n' +
  'change invalidates those too, so restoring the copies can still leave a pin test red.\n'

/** The line above the restore command names the copy it restores, whole. */
function assertRestoreLead(stderr) {
  assert.ok(stderr.split('\n').includes(RESTORE_LEAD), `no exact restore lead line in:\n${stderr}`)
}

/** Every drift ends with the size note, once, whichever instructions came before it. */
function assertSizeNote(stderr) {
  assert.ok(stderr.endsWith(SIZE_NOTE), `stderr does not end with the size note:\n${stderr}`)
  assert.equal(stderr.split('Then update any hand-asserted size figures').length, 2, stderr)
}

test('positive control: the mirror is checked, and an untouched mirror is green', () => {
  const { code, stdout, stderr } = run('--check')
  assert.equal(code, 0, stderr)
  // 2 full-text copies + every step file, one ✓ line each. An unresolved
  // tmpdir would print none of them.
  assert.equal(stdout.match(/^✓ /gm)?.length, MIRRORED.length - 2, stdout)
  for (const label of Object.values(LABEL)) assert.ok(stdout.includes(`✓ ${label} matches`), label)
  assert.equal(stderr, '')
})

test('only for-agents.md drifted: the instruction restores it, and does not say regenerate', () => {
  driftForAgents()
  const { code, stdout, stderr } = run('--check')
  assert.equal(code, 1, stderr)
  assert.ok(stderr.includes(`✗ ${LABEL.forAgents} has DRIFTED`), stderr)
  assertRestoreLead(stderr)
  assert.equal(instructionAfter(stderr, 'Restore it with'), RESTORE)
  assert.ok(!stderr.includes('Regenerate with'), stderr)
  assertSizeNote(stderr)
  for (const label of [LABEL.cli, LABEL.step, LABEL.otherStep]) {
    assert.ok(stdout.includes(`✓ ${label} matches`), `${label} should still be ✓`)
  }

  follow(instructionAfter(stderr, 'Restore it with'))
  const after = run('--check')
  assert.equal(after.code, 0, after.stderr)
})

test('only the CLI copy drifted: the instruction says regenerate, and never names for-agents.md', () => {
  driftCli()
  const { code, stdout, stderr } = run('--check')
  assert.equal(code, 1, stderr)
  assert.ok(stderr.includes(`✗ ${LABEL.cli} has DRIFTED`), stderr)
  assert.ok(stderr.includes('\n1 generated copy/copies are stale. Regenerate with:\n'), stderr)
  assert.equal(instructionAfter(stderr, 'Regenerate with'), REGENERATE)
  assert.ok(!stderr.includes('for-agents.md'), stderr)
  assert.ok(!stderr.includes('Restore it with'), stderr)
  assertSizeNote(stderr)
  for (const label of [LABEL.forAgents, LABEL.step]) {
    assert.ok(stdout.includes(`✓ ${label} matches`), `${label} should still be ✓`)
  }

  follow(instructionAfter(stderr, 'Regenerate with'))
  const after = run('--check')
  assert.equal(after.code, 0, after.stderr)
})

test('only one step file drifted: the instruction says regenerate, and never names for-agents.md', () => {
  driftStep()
  const { code, stdout, stderr } = run('--check')
  assert.equal(code, 1, stderr)
  assert.ok(stderr.includes(`✗ ${LABEL.step} has DRIFTED`), stderr)
  assert.equal(instructionAfter(stderr, 'Regenerate with'), REGENERATE)
  assert.ok(!stderr.includes('for-agents.md'), stderr)
  assertSizeNote(stderr)
  for (const label of [LABEL.cli, LABEL.forAgents, LABEL.otherStep]) {
    assert.ok(stdout.includes(`✓ ${label} matches`), `${label} should still be ✓`)
  }
})

test('for-agents.md and a generated copy both drifted: both instructions, and following both goes green', () => {
  driftForAgents()
  driftStep()
  const { code, stdout, stderr } = run('--check')
  assert.equal(code, 1, stderr)
  assert.ok(stderr.includes('\n1 generated copy/copies are stale. Regenerate with:\n'), stderr)
  assert.equal(instructionAfter(stderr, 'Regenerate with'), REGENERATE)
  assertRestoreLead(stderr)
  assert.equal(instructionAfter(stderr, 'Restore it with'), RESTORE)
  assertSizeNote(stderr)
  for (const label of [LABEL.cli, LABEL.otherStep]) {
    assert.ok(stdout.includes(`✓ ${label} matches`), `${label} should still be ✓`)
  }

  // Regenerating alone leaves for-agents.md stale — the defect #4748 fixed.
  follow(instructionAfter(stderr, 'Regenerate with'))
  const half = run('--check')
  assert.equal(half.code, 1, half.stderr)
  assert.equal(instructionAfter(half.stderr, 'Restore it with'), RESTORE)
  assert.ok(!half.stderr.includes('Regenerate with'), half.stderr)

  follow(instructionAfter(half.stderr, 'Restore it with'))
  const after = run('--check')
  assert.equal(after.code, 0, after.stderr)
})

test('--print-runbook prints the runbook alone and writes no file', () => {
  // Drift one copy of each kind first: a write of the canonical bytes to a
  // copy already IN sync leaves it unchanged, so only a drifted copy can show
  // that this mode wrote it — for-agents.md above all, which #4748 excludes
  // the script from ever writing.
  driftCli()
  driftForAgents()
  driftStep()
  const before = Object.fromEntries(MIRRORED.map((rel) => [rel, read(rel)]))
  const { code, stdout, stderr } = run('--print-runbook')
  assert.equal(code, 0, stderr)
  // The committed for-agents.md is the canonical runbook (the positive control
  // above checks it), so stdout must equal it byte for byte.
  assert.equal(stdout, readFileSync(path.join(REPO, FOR_AGENTS), 'utf8'))
  for (const rel of MIRRORED) assert.equal(read(rel), before[rel], `${rel} was written`)
})
