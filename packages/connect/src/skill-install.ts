import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { HAVEN_SKILL_MD, HAVEN_SKILL_BODY_MD, SKILL_FOLDER_NAME } from '@haven_ai/sdk'
import type { RuntimeId } from './runtime-registry.js'

/**
 * Guidance-surface parity across runtimes (#1332).
 *
 * The generic payment skill is static and secret-free. Where a runtime has a
 * DOCUMENTED instruction mechanism, setup installs the canonical content
 * there; the substance is identical everywhere — only the wrapper differs:
 *
 * - claude-code — `~/.claude/skills/haven-pay/SKILL.md` (Claude's skills
 *   folder; unchanged behavior, moved here from runtime-install.ts).
 * - hermes — `$HERMES_HOME/skills/haven-pay/SKILL.md` (default
 *   `~/.hermes/skills/…`). Hermes auto-discovers SKILL.md skills from that
 *   directory in the same front-matter format Claude uses, so the file is
 *   byte-identical to the Claude install.
 * - codex-cli / codex-desktop — a marker-delimited managed section in the
 *   global `~/.codex/AGENTS.md` (Codex's documented global-guidance file,
 *   shared by CLI and Desktop). The section carries the skill BODY (front
 *   matter is skills-registry metadata and meaningless in AGENTS.md). Writes
 *   are idempotent — an existing managed section is replaced in place — and
 *   everything outside the markers is preserved byte-for-byte. The file is
 *   created when absent. `AGENTS.override.md` is never touched.
 * - every other runtime — no documented instruction file; the baseline is the
 *   MCP server-level initialize instructions, so nothing is written.
 */

export const CODEX_AGENTS_BEGIN_MARKER =
  '<!-- BEGIN haven-pay (managed by @haven_ai/connect; edits inside this section are overwritten on re-setup) -->'
export const CODEX_AGENTS_END_MARKER = '<!-- END haven-pay -->'

export interface SkillInstallResult {
  installed: boolean
  target?: string
  messages: string[]
}

export interface SkillInstallDeps {
  homeDir?: string
  env?: NodeJS.ProcessEnv
}

export async function installSkillForRuntime(
  runtime: RuntimeId,
  deps: SkillInstallDeps = {},
): Promise<SkillInstallResult | undefined> {
  switch (runtime) {
    case 'claude-code':
      return installSkillFile(
        resolve(deps.homeDir ?? homedir(), '.claude', 'skills', SKILL_FOLDER_NAME),
        '~/.claude/skills/haven-pay',
      )
    case 'hermes':
      return installSkillFile(
        join(hermesHome(deps), 'skills', SKILL_FOLDER_NAME),
        'the Hermes skills folder',
      )
    case 'codex-cli':
    case 'codex-desktop':
      return installCodexAgentsSection(deps)
    default:
      // No documented instruction file for this runtime — the MCP server's
      // initialize instructions carry the baseline guidance.
      return undefined
  }
}

async function installSkillFile(skillDir: string, label: string): Promise<SkillInstallResult> {
  try {
    await mkdir(skillDir, { recursive: true })
    const target = join(skillDir, 'SKILL.md')
    await writeFile(target, HAVEN_SKILL_MD, 'utf8')
    return {
      installed: true,
      target,
      messages: [`Installed the generic Haven payment skill (${label}). It contains no secrets.`],
    }
  } catch (err) {
    return {
      installed: false,
      messages: [
        `Could not install the Haven payment skill: ${err instanceof Error ? err.message : String(err)}. Download it from the Haven dashboard instead.`,
      ],
    }
  }
}

async function installCodexAgentsSection(deps: SkillInstallDeps): Promise<SkillInstallResult> {
  try {
    const codexDir = resolve(deps.homeDir ?? homedir(), '.codex')
    const target = join(codexDir, 'AGENTS.md')
    await mkdir(codexDir, { recursive: true })
    const existing = await readFile(target, 'utf8').catch(() => null)
    const next = upsertManagedSection(existing, codexManagedSection())
    if (next !== existing) {
      await writeFile(target, next, 'utf8')
    }
    return {
      installed: true,
      target,
      messages: [
        'Installed the generic Haven payment guidance as a managed section in ~/.codex/AGENTS.md (Codex reads it as global instructions). It contains no secrets; your own content in that file is untouched.',
      ],
    }
  } catch (err) {
    return {
      installed: false,
      messages: [
        `Could not install the Haven payment guidance into ~/.codex/AGENTS.md: ${err instanceof Error ? err.message : String(err)}. Download the skill from the Haven dashboard instead.`,
      ],
    }
  }
}

function codexManagedSection(): string {
  return `${CODEX_AGENTS_BEGIN_MARKER}\n\n${HAVEN_SKILL_BODY_MD.trimEnd()}\n\n${CODEX_AGENTS_END_MARKER}\n`
}

/**
 * Replace the existing managed section in place, or append one. Everything
 * outside the markers is preserved byte-for-byte — this file belongs to the
 * user; Haven owns only the span between its own markers.
 */
export function upsertManagedSection(existing: string | null, section: string): string {
  if (existing === null || existing.trim() === '') return section
  const begin = existing.indexOf(CODEX_AGENTS_BEGIN_MARKER)
  const end = existing.indexOf(CODEX_AGENTS_END_MARKER)
  if (begin !== -1 && end !== -1 && end > begin) {
    const afterEnd = end + CODEX_AGENTS_END_MARKER.length
    // Swallow the newline the section itself terminates with, if present.
    const tail = existing.startsWith('\n', afterEnd) ? existing.slice(afterEnd + 1) : existing.slice(afterEnd)
    return existing.slice(0, begin) + section + tail
  }
  if (begin !== -1 || end !== -1) {
    // One marker without its pair. Appending would plant a second marker and
    // make a LATER run's replace span swallow user content between the orphan
    // and the new section — fail closed instead and leave the file alone.
    throw new Error(
      'found a damaged Haven marker section (one marker without its pair); remove the leftover marker line and re-run setup',
    )
  }
  // No markers: append at the end, separated by a blank line.
  return `${existing.replace(/\n*$/, '\n\n')}${section}`
}

function hermesHome(deps: SkillInstallDeps): string {
  const env = deps.env ?? process.env
  return env.HERMES_HOME ?? join(deps.homeDir ?? homedir(), '.hermes')
}
