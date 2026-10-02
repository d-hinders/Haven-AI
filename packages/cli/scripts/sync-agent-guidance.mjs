#!/usr/bin/env node
/**
 * Regenerate `packages/cli/src/agent-guidance-text.ts` from the canonical
 * runbook in `packages/sdk/src/agent-guidance.ts` (#2523, #2525).
 *
 * Why a generated copy rather than an import (owner decision, 2026-09-04):
 * `@haven_ai/cli` has ZERO runtime dependencies, and `@haven_ai/sdk` pulls
 * ethers + viem + x402 — ~94 MB measured in this repo's node_modules. `haven
 * guide` prints one Markdown string; paying that install cost on the very
 * `npx @haven_ai/cli` path an agent uses would trade the epic's own goal for a
 * dependency edge. This is the `packages/frontend/src/lib/agent-skill-bundle.ts`
 * precedent: a decoupled copy, byte-pinned by a test, for a package that must
 * stay installable on its own.
 *
 *   node packages/cli/scripts/sync-agent-guidance.mjs           # write
 *   node packages/cli/scripts/sync-agent-guidance.mjs --check   # verify only
 *
 * The pin test (`src/agent-guidance-text.test.ts`) fails if this file is not
 * re-run after the SDK string changes, so the copy cannot drift silently —
 * BUT that test runs in the `cli` job, and before #2727 an SDK-only change
 * routed neither `cli` nor `frontend`. #2713 edited the SDK runbook and the
 * CLI copy went stale; the frontend copy survived only because that PR
 * happened to touch frontend files too, so its job ran. `dev` did not even go
 * red -- `cli_checks` was skipped, so the stale copy was carried until an
 * unrelated backend PR (#2719) regenerated it.
 *
 * `--check` verifies the FULL-TEXT copies below against this one reader and
 * exits non-zero on drift; `sdk_checks` runs it via
 * `npm run lint:runbook-parity`. Since #2727 `cli_checks` and
 * `frontend_checks` run it too; `sdk_checks` is the one that runs on a change
 * to the canonical source even without the manifest row, via the generic
 * `packages/sdk/*` arm.
 *
 * It is NOT the whole story, and must not be described as one. The frontend
 * also holds `packages/frontend/src/lib/agent-onboarding-prompt.ts` (a copy
 * of one constant) and `packages/frontend/src/lib/agent-skill-bundle.ts` (text
 * composed from four of them by `packages/sdk/src/skill-content.ts`) —
 * resolved text, not an extractable literal, so no check here can read it
 * back. Those are covered by routing: the manifest names `frontend` as an
 * owner of the canonical source, so their own pin tests run on a change to
 * `agent-guidance.ts` (#2727) — and `skill-content.ts`, which the skill bundle
 * is pinned to as well, carries its own manifest entry for the same reason
 * (#2743). Routing, not this script, is what covers both.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SDK_SOURCE = join(here, '..', '..', 'sdk', 'src', 'agent-guidance.ts')
const TARGET = join(here, '..', 'src', 'agent-guidance-text.ts')
const STEP_FILES_DIR = join(here, '..', '..', 'frontend', 'public', 'agent-skills')

/**
 * The runbook's step files, in document order (#3596) — a duplicate of
 * `packages/frontend/src/lib/agent-skill-steps.ts`'s `AGENT_SKILL_STEPS`,
 * same discipline as every other copy of this runbook: kept in sync by hand,
 * caught by `--check` below if it drifts. `heading` is the exact `## ` line
 * each step's slice starts at; the first step's slice starts at byte 0
 * instead (it also carries the preamble).
 */
const STEPS = [
  { slug: 'what-haven-is', heading: '## What Haven is, in three sentences', title: 'What Haven is, in three sentences' },
  { slug: 'the-sequence', heading: '## The sequence', title: 'The sequence' },
  {
    slug: 'budget-changes-later',
    heading: '## Budget changes later (second token, raise, revoke)',
    title: 'Budget changes later',
  },
  { slug: 'hand-off-scripts', heading: '## Hand-off scripts', title: 'Hand-off scripts' },
  { slug: 'what-you-run', heading: '## What you run', title: 'What you run' },
  { slug: 'how-to-verify', heading: '## How to verify', title: 'How to verify' },
  { slug: 'if-you-cannot-open-a-browser', heading: '## If you cannot open a browser', title: 'If you cannot open a browser' },
  { slug: 'if-something-breaks', heading: '## If something breaks', title: 'If something breaks' },
  { slug: 'vocabulary', heading: '## Vocabulary', title: 'Vocabulary' },
]

/**
 * Slice `runbook` into one chunk per `STEPS` entry, boundary-exact: every
 * `body` concatenated in order reproduces `runbook` byte-for-byte. Throws by
 * name on a heading that moved or was reworded away, rather than silently
 * mis-slicing — the same failure mode `readCanonicalRunbook` already named
 * for the whole-string copies.
 */
function sliceRunbookSteps(runbook) {
  const starts = STEPS.map((step, i) => {
    if (i === 0) return 0
    const at = runbook.indexOf(step.heading)
    if (at < 0) throw new Error(`heading not found in runbook: ${step.heading}`)
    return at
  })
  const bounds = [...starts, runbook.length]
  return STEPS.map((step, i) => ({ ...step, body: runbook.slice(bounds[i], bounds[i + 1]) }))
}

/** The generated "Next" link every step file carries except the last. */
function nextLinkSuffix(next) {
  if (!next) return ''
  return `\n\n---\n\nNext: [${next.title}](/agent-skills/${next.slug}.md)\n`
}

/**
 * The copies of the canonical runbook that can be READ BACK and compared —
 * i.e. those embedding the whole string, or a boundary-exact slice of it, as
 * a literal or as raw Markdown.
 *
 * Deliberately not named "every copy": the frontend's partial derivations
 * (`packages/frontend/src/lib/agent-onboarding-prompt.ts` and
 * `packages/frontend/src/lib/agent-skill-bundle.ts`) are not in here and
 * cannot be, because the skill bundle embeds text composed at build
 * time rather than a literal. Their pin tests are the check for those, and
 * routing is what makes those tests run (see the header).
 *
 * `extract` turns a file's bytes into the runbook string (or slice) it
 * embeds; for a raw Markdown copy that is the identity function. `expected`
 * computes what that extraction must equal from the canonical runbook —
 * defaulting to the whole runbook for the whole-string copies, and to one
 * slice plus its generated next-link for a step file.
 */
export const GENERATED_COPIES = [
  {
    label: 'CLI (packages/cli/src/agent-guidance-text.ts)',
    file: TARGET,
    extract: (text) => {
      const match = text.match(/export const HAVEN_AGENT_RUNBOOK_MD = ("(?:[^"\\]|\\.)*")/)
      if (!match) throw new Error(`${TARGET}: no HAVEN_AGENT_RUNBOOK_MD string literal found`)
      return JSON.parse(match[1])
    },
  },
  {
    label: 'frontend (packages/frontend/public/for-agents.md)',
    file: join(here, '..', '..', 'frontend', 'public', 'for-agents.md'),
    extract: (text) => text,
  },
  ...STEPS.map((step, i) => ({
    label: `frontend step (packages/frontend/public/agent-skills/${step.slug}.md)`,
    file: join(STEP_FILES_DIR, `${step.slug}.md`),
    extract: (text) => text,
    expected: (runbook) => {
      const slices = sliceRunbookSteps(runbook)
      return slices[i].body + nextLinkSuffix(STEPS[i + 1])
    },
  })),
]

/**
 * The canonical runbook, read from the SDK source.
 *
 * Exported so the parity test asserts against the SAME reader this generator
 * writes from — one definition of "canonical" rather than two that can drift
 * apart while both look right. (A direct `import` of the SDK module would be
 * the obvious alternative and does not typecheck: the CLI's `rootDir` is its
 * own `src`, and cross-package source imports fall outside it.)
 */
export async function readCanonicalRunbook() {
  const source = await readFile(SDK_SOURCE, 'utf8')
  // The SDK module is plain consts plus one template literal that interpolates
  // the earlier consts. Evaluating it is what makes this a copy of the RESOLVED
  // string rather than of the template — the same thing the frontend pins.
  return new Function(`${source.replace(/^export /gm, '')}\nreturn HAVEN_AGENT_RUNBOOK_MD;`)()
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]

const header = `/**
 * The agent onboarding runbook — GENERATED, do not edit by hand.
 *
 * Canonical source: \`packages/sdk/src/agent-guidance.ts\` (#2523), served to
 * agents at \`/for-agents.md\`. This is a decoupled copy so \`@haven_ai/cli\`
 * keeps zero runtime dependencies: importing it from the SDK would put ethers,
 * viem and x402 on the \`npx @haven_ai/cli\` path for one Markdown string.
 * Same arrangement, and the same reason, as
 * \`packages/frontend/src/lib/agent-skill-bundle.ts\`.
 *
 * Regenerate:  node packages/cli/scripts/sync-agent-guidance.mjs
 * The parity test in \`agent-guidance-text.test.ts\` fails if you forget.
 */
`

if (invokedDirectly) {
  // Read INSIDE the guard, not at module scope (review nit, #2743).
  // `readCanonicalRunbook` evaluates the SDK source through `new Function`, and
  // scripts/ci/root-guard-ownership.test.mjs imports GENERATED_COPIES from this
  // file. At module scope that eval ran on import, so a future `import`
  // statement in agent-guidance.ts — anything `new Function` cannot eval —
  // would fail the ENTIRE ci_config_checks suite with a SyntaxError pointing at
  // a package source, far from anything the suite is about. Every use of
  // `runbook` is in this block already, so the move costs nothing.
  const runbook = await readCanonicalRunbook()

  if (process.argv.includes('--check')) {
    const drifted = []
    for (const copy of GENERATED_COPIES) {
      const expected = copy.expected ? copy.expected(runbook) : runbook
      const embedded = copy.extract(await readFile(copy.file, 'utf8'))
      if (embedded === expected) {
        console.log(`✓ ${copy.label} matches the canonical runbook`)
        continue
      }
      drifted.push(copy)
      // Sizes alone are useless for a same-length edit — both lines read
      // identical under a "DRIFTED" heading. Name where they part company.
      let at = 0
      while (at < expected.length && expected[at] === embedded[at]) at += 1
      const excerpt = (text) => JSON.stringify(text.slice(Math.max(0, at - 20), at + 40))
      console.error(
        `✗ ${copy.label} has DRIFTED from packages/sdk/src/agent-guidance.ts\n` +
          `    expected ${Buffer.byteLength(expected)} bytes / ${expected.length} UTF-16 units\n` +
          `    copy     ${Buffer.byteLength(embedded)} bytes / ${embedded.length} UTF-16 units\n` +
          `    first differs at UTF-16 offset ${at}\n` +
          `      expected ${excerpt(expected)}\n` +
          `      copy     ${excerpt(embedded)}`,
      )
    }
    if (drifted.length > 0) {
      console.error(
        `\n${drifted.length} generated copy/copies are stale. Regenerate with:\n` +
          '    node packages/cli/scripts/sync-agent-guidance.mjs\n' +
          '  and update any hand-asserted size figures the pin tests carry — a content\n' +
          '  change invalidates those too, so regenerating alone does not go green.',
      )
      process.exitCode = 1
    }
  } else {
    const body = `${header}\nexport const HAVEN_AGENT_RUNBOOK_MD = ${JSON.stringify(runbook)}\n`
    await writeFile(TARGET, body)
    console.log(`wrote ${TARGET} (${Buffer.byteLength(runbook)} bytes, ${runbook.length} UTF-16 units)`)

    // The step files regenerate too — same canonical source, same reason the
    // CLI copy does. `for-agents.md` is deliberately NOT written here: it
    // never has been (see the file header), and nothing in this change
    // extends that.
    const slices = sliceRunbookSteps(runbook)
    for (let i = 0; i < STEPS.length; i++) {
      const file = join(STEP_FILES_DIR, `${STEPS[i].slug}.md`)
      const content = slices[i].body + nextLinkSuffix(STEPS[i + 1])
      await writeFile(file, content)
      console.log(`wrote ${file} (${Buffer.byteLength(content)} bytes)`)
    }
  }
}
