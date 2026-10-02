import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
// Canonical runbook lives in the SDK source, same import path
// for-agents-runbook.test.ts uses for the whole-file pin.
import { HAVEN_AGENT_RUNBOOK_MD } from '../../../../sdk/src/agent-guidance'
import { AGENT_SKILL_STEPS, nextLinkSuffix, sliceRunbookSteps, stepPath } from '../agent-skill-steps'
import { PUBLIC_SURFACES } from '@/lib/discovery-surfaces'

/**
 * Guard for the runbook's step files at `/agent-skills/<step>.md` (#3596).
 *
 * The step files are byte-slices of `HAVEN_AGENT_RUNBOOK_MD` at `## `
 * boundaries — never separately written prose — so this test proves the
 * slicing is lossless and that every committed file on disk is exactly one
 * slice plus the generated "Next" link, nothing else.
 */

const PUBLIC_DIR = join(__dirname, '../../../public')

function readStepFile(slug: string): string {
  return readFileSync(join(PUBLIC_DIR, 'agent-skills', `${slug}.md`), 'utf8')
}

describe('runbook step files (#3596)', () => {
  it('has nine steps, one per ## heading in the canonical runbook', () => {
    const headingCount = HAVEN_AGENT_RUNBOOK_MD.split('\n').filter((line) => line.startsWith('## ')).length
    expect(headingCount).toBe(9)
    expect(AGENT_SKILL_STEPS).toHaveLength(9)
  })

  it('slices the canonical runbook losslessly: concatenation reproduces it byte-for-byte', () => {
    const slices = sliceRunbookSteps(HAVEN_AGENT_RUNBOOK_MD)
    expect(slices.map((s) => s.body).join('')).toBe(HAVEN_AGENT_RUNBOOK_MD)
  })

  it('every heading this module names appears, in document order, in the canonical runbook', () => {
    let cursor = 0
    for (const step of AGENT_SKILL_STEPS) {
      const at = HAVEN_AGENT_RUNBOOK_MD.indexOf(step.heading, cursor)
      expect(at, `${step.heading} not found after offset ${cursor}`).toBeGreaterThanOrEqual(0)
      cursor = at + step.heading.length
    }
  })

  it.each(AGENT_SKILL_STEPS.map((s) => s.slug))(
    'served %s.md is byte-equal to its slice plus the generated next-link',
    (slug) => {
      const slices = sliceRunbookSteps(HAVEN_AGENT_RUNBOOK_MD)
      const i = slices.findIndex((s) => s.slug === slug)
      const served = readStepFile(slug)
      const expected = slices[i].body + nextLinkSuffix(AGENT_SKILL_STEPS[i + 1])
      expect(served).toBe(expected)
    },
  )

  it('every step file except the last links to the next', () => {
    for (let i = 0; i < AGENT_SKILL_STEPS.length - 1; i++) {
      const served = readStepFile(AGENT_SKILL_STEPS[i].slug)
      const next = AGENT_SKILL_STEPS[i + 1]
      expect(served).toContain(`Next: [${next.title}](${stepPath(next.slug)})`)
    }
  })

  it('the last step file carries no generated next-link', () => {
    const last = AGENT_SKILL_STEPS[AGENT_SKILL_STEPS.length - 1]
    expect(nextLinkSuffix(undefined)).toBe('')
    const served = readStepFile(last.slug)
    // The runbook's OWN final line is a cross-reference to other documents
    // (/402.md, /llms.txt) — that is content, not the generated step-chain
    // link, and it must still be there.
    expect(served).toContain('Next: [your agent hit a 402](/402.md)')
    // But no step-chain "Next: [<title>](/agent-skills/...)" link follows it.
    expect(served).not.toMatch(/Next: \[.*\]\(\/agent-skills\//)
  })

  it('every step file exists on disk and is advertised in PUBLIC_SURFACES', () => {
    for (const step of AGENT_SKILL_STEPS) {
      const file = join(PUBLIC_DIR, 'agent-skills', `${step.slug}.md`)
      expect(existsSync(file), file).toBe(true)
      expect(PUBLIC_SURFACES).toContain(stepPath(step.slug))
    }
  })

  it('sliceRunbookSteps throws on a heading that moved or was reworded away', () => {
    const broken = HAVEN_AGENT_RUNBOOK_MD.replace('## Vocabulary', '## Glossary')
    expect(() => sliceRunbookSteps(broken)).toThrow(/heading not found/)
  })
})
