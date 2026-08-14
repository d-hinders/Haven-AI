import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HAVEN_SKILL_MD, HAVEN_SKILL_BODY_MD } from '@haven_ai/sdk'
import {
  CODEX_AGENTS_BEGIN_MARKER,
  CODEX_AGENTS_END_MARKER,
  installSkillForRuntime,
  upsertManagedSection,
} from './skill-install.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'haven-skill-install-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('installSkillForRuntime (#1332 runtime parity)', () => {
  it('claude-code writes the canonical SKILL.md byte-for-byte', async () => {
    const result = await installSkillForRuntime('claude-code', { homeDir: home })
    expect(result?.installed).toBe(true)
    const written = await readFile(join(home, '.claude', 'skills', 'haven-pay', 'SKILL.md'), 'utf8')
    expect(written).toBe(HAVEN_SKILL_MD)
  })

  it('hermes writes the SAME SKILL.md into the Hermes skills folder', async () => {
    const result = await installSkillForRuntime('hermes', { homeDir: home, env: {} })
    expect(result?.installed).toBe(true)
    const written = await readFile(join(home, '.hermes', 'skills', 'haven-pay', 'SKILL.md'), 'utf8')
    expect(written).toBe(HAVEN_SKILL_MD)
  })

  it('hermes honors HERMES_HOME, matching the config writer convention', async () => {
    const hermesHome = join(home, 'custom-hermes')
    const result = await installSkillForRuntime('hermes', {
      homeDir: home,
      env: { HERMES_HOME: hermesHome },
    })
    expect(result?.installed).toBe(true)
    const written = await readFile(join(hermesHome, 'skills', 'haven-pay', 'SKILL.md'), 'utf8')
    expect(written).toBe(HAVEN_SKILL_MD)
  })

  it('codex creates ~/.codex/AGENTS.md with a marker-delimited section carrying the skill BODY', async () => {
    const result = await installSkillForRuntime('codex-cli', { homeDir: home })
    expect(result?.installed).toBe(true)
    const written = await readFile(join(home, '.codex', 'AGENTS.md'), 'utf8')
    expect(written.startsWith(CODEX_AGENTS_BEGIN_MARKER)).toBe(true)
    expect(written).toContain(CODEX_AGENTS_END_MARKER)
    // Substance parity: the body verbatim, minus only the front matter.
    expect(written).toContain(HAVEN_SKILL_BODY_MD.trimEnd())
    expect(written).not.toContain('---\nname: haven-pay')
    // Secret-free by construction.
    expect(written).not.toMatch(/sk_agent_|Bearer /)
  })

  it('codex-desktop shares the same global AGENTS.md as codex-cli', async () => {
    await installSkillForRuntime('codex-desktop', { homeDir: home })
    const written = await readFile(join(home, '.codex', 'AGENTS.md'), 'utf8')
    expect(written).toContain(CODEX_AGENTS_BEGIN_MARKER)
  })

  it('codex preserves user content and stays idempotent across re-runs', async () => {
    const codexDir = join(home, '.codex')
    await mkdir(codexDir, { recursive: true })
    const userContent = '# My global rules\n\nAlways use TypeScript strict mode.\n'
    await writeFile(join(codexDir, 'AGENTS.md'), userContent, 'utf8')

    await installSkillForRuntime('codex-cli', { homeDir: home })
    const first = await readFile(join(codexDir, 'AGENTS.md'), 'utf8')
    expect(first.startsWith('# My global rules')).toBe(true)
    expect(first).toContain(CODEX_AGENTS_BEGIN_MARKER)

    await installSkillForRuntime('codex-cli', { homeDir: home })
    const second = await readFile(join(codexDir, 'AGENTS.md'), 'utf8')
    // Re-run replaces the managed section in place: no growth, no duplicates.
    expect(second).toBe(first)
    expect(second.split(CODEX_AGENTS_BEGIN_MARKER).length).toBe(2)
  })

  it('codex updates a stale managed section in place, keeping content AFTER it', async () => {
    const codexDir = join(home, '.codex')
    await mkdir(codexDir, { recursive: true })
    await writeFile(
      join(codexDir, 'AGENTS.md'),
      `before\n\n${CODEX_AGENTS_BEGIN_MARKER}\nold haven guidance from a previous release\n${CODEX_AGENTS_END_MARKER}\n\nafter\n`,
      'utf8',
    )
    await installSkillForRuntime('codex-cli', { homeDir: home })
    const written = await readFile(join(codexDir, 'AGENTS.md'), 'utf8')
    expect(written.startsWith('before\n')).toBe(true)
    expect(written).toContain('\nafter\n')
    expect(written).not.toContain('old haven guidance')
    expect(written).toContain(HAVEN_SKILL_BODY_MD.trimEnd())
  })

  it('codex fails CLOSED on a damaged marker pair instead of risking user content', async () => {
    const codexDir = join(home, '.codex')
    await mkdir(codexDir, { recursive: true })
    const damaged = `user text\n${CODEX_AGENTS_BEGIN_MARKER}\norphaned — no end marker\n`
    await writeFile(join(codexDir, 'AGENTS.md'), damaged, 'utf8')
    const result = await installSkillForRuntime('codex-cli', { homeDir: home })
    expect(result?.installed).toBe(false)
    expect(result?.messages.join(' ')).toMatch(/damaged Haven marker section/i)
    // The file was left byte-for-byte untouched.
    expect(await readFile(join(codexDir, 'AGENTS.md'), 'utf8')).toBe(damaged)
  })

  it('runtimes without a documented instruction file install nothing', async () => {
    for (const runtime of ['cursor', 'vscode', 'vscode-insiders', 'claude-desktop', 'other'] as const) {
      expect(await installSkillForRuntime(runtime, { homeDir: home })).toBeUndefined()
    }
  })
})

describe('upsertManagedSection', () => {
  const section = `${CODEX_AGENTS_BEGIN_MARKER}\nbody\n${CODEX_AGENTS_END_MARKER}\n`

  it('is the whole file when there is no existing content', () => {
    expect(upsertManagedSection(null, section)).toBe(section)
    expect(upsertManagedSection('  \n', section)).toBe(section)
  })

  it('appends after user content with a separating blank line', () => {
    expect(upsertManagedSection('user\n', section)).toBe(`user\n\n${section}`)
  })

  it('throws on an orphaned END marker too', () => {
    expect(() => upsertManagedSection(`text\n${CODEX_AGENTS_END_MARKER}\n`, section)).toThrow(
      /damaged Haven marker/i,
    )
  })

  it('fails closed on a DUPLICATED section instead of silently keeping the stray copy', () => {
    const doubled = `${section}\nuser text\n\n${section}`
    expect(() => upsertManagedSection(doubled, section)).toThrow(/damaged Haven marker/i)
  })

  it('ignores marker text quoted mid-line — only line-anchored markers are boundaries', () => {
    // A user documenting this mechanism ("the section between
    // `<!-- BEGIN haven-pay ... -->` markers") must not have their prose
    // treated as a live section boundary.
    const quoted = `See the \`${CODEX_AGENTS_BEGIN_MARKER}\` marker for details.\n`
    const result = upsertManagedSection(quoted, section)
    expect(result.startsWith(quoted.trimEnd())).toBe(true)
    expect(result.endsWith(section)).toBe(true)
  })

  it('replaces in place without accreting blank lines on CRLF files', () => {
    const crlf = `user line\r\n\r\n${section.replace(/\n/g, '\r\n')}\r\ntrailing\r\n`
    const once = upsertManagedSection(crlf, section)
    const twice = upsertManagedSection(once, section)
    expect(twice).toBe(once)
    expect(once).toContain('trailing')
  })
})

describe('HAVEN_SKILL_BODY_MD derivation', () => {
  it('is the canonical skill minus exactly the front matter', () => {
    expect(HAVEN_SKILL_MD).toContain(HAVEN_SKILL_BODY_MD)
    expect(HAVEN_SKILL_BODY_MD.startsWith('# Haven: pay from a Haven wallet')).toBe(true)
    expect(HAVEN_SKILL_BODY_MD).not.toContain('name: haven-pay')
  })
})
