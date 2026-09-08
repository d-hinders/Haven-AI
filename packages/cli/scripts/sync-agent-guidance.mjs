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
 * BUT that test runs in the `cli` job, and an SDK-only change does not route
 * `cli`. The same held for the frontend copy and its `frontend` job. #2713
 * edited the SDK runbook, both copies went stale, and `dev` went red for
 * everyone (#2727).
 *
 * `--check` is the answer to that: it verifies EVERY generated copy against
 * this one reader and exits non-zero on drift, and `sdk_checks` runs it via
 * `npm run lint:runbook-parity`. The job that owns the canonical source is the
 * one job guaranteed to run when that source changes, so the check belongs
 * there rather than in each consumer's job — which would also mean routing the
 * whole matrix on every SDK edit, the over-routing this same issue removes.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SDK_SOURCE = join(here, '..', '..', 'sdk', 'src', 'agent-guidance.ts')
const TARGET = join(here, '..', 'src', 'agent-guidance-text.ts')

/**
 * Every generated copy of the canonical runbook, and how to read each back.
 *
 * Enumerated here, not in the caller, so adding a third copy is a one-line
 * change in the place the generator already lives. `extract` turns a file's
 * bytes into the runbook string it embeds; for a raw Markdown copy that is the
 * identity function.
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
const runbook = await readCanonicalRunbook()

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
  if (process.argv.includes('--check')) {
    const drifted = []
    for (const copy of GENERATED_COPIES) {
      const embedded = copy.extract(await readFile(copy.file, 'utf8'))
      if (embedded === runbook) {
        console.log(`✓ ${copy.label} matches the canonical runbook`)
        continue
      }
      drifted.push(copy)
      console.error(
        `✗ ${copy.label} has DRIFTED from packages/sdk/src/agent-guidance.ts\n` +
          `    canonical ${Buffer.byteLength(runbook)} bytes / ${runbook.length} UTF-16 units\n` +
          `    copy      ${Buffer.byteLength(embedded)} bytes / ${embedded.length} UTF-16 units`,
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
  }
}
