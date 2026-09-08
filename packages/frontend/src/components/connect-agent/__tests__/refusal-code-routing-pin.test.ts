// #2680 slice-2 guard — pins mcp-runtime-compatibility.md's status-routing
// claim: of the six refusal codes in the doc's error table
// (`runtime_undetermined`, `runtime_unrecognized`, `runtime_force_unrecognized`,
// `runtime_no_installed_clients`, `runtime_prompt_aborted`,
// `runtime_config_unreadable`), exactly ONE reaches the dashboard's
// `runtimeStatusHelper` — `runtime_config_unreadable`, because it is the only
// one that happens after credentials exist. The other five refuse before any
// side effect, so they are the connector's exit contract only (doc, table
// footnote). Pinned by scanning the helper's error_code branches in
// `setup-copy.ts`.
//
// Mutation-proven for #2680: adding a branch naming `runtime_undetermined` in
// setup-copy.ts reddens; restoring byte-identical greens.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SETUP_COPY = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'setup-copy.ts',
)

const SIX_REFUSAL_CODES = [
  'runtime_undetermined',
  'runtime_unrecognized',
  'runtime_force_unrecognized',
  'runtime_no_installed_clients',
  'runtime_prompt_aborted',
  'runtime_config_unreadable',
] as const

describe('refusal-code → dashboard routing (#2680 pin)', () => {
  const src = readFileSync(SETUP_COPY, 'utf8')

  it('runtimeStatusHelper handles exactly one of the six refusal codes', () => {
    const reached = SIX_REFUSAL_CODES.filter((code) =>
      src.includes(`error_code === '${code}'`),
    )
    expect(reached).toEqual(['runtime_config_unreadable'])
    // And the other five stay out of the helper's vocabulary entirely — the
    // doc's "they never appear in the dashboard's install_status" half.
    for (const code of SIX_REFUSAL_CODES.filter((c) => c !== 'runtime_config_unreadable')) {
      expect(src).not.toContain(code)
    }
  })
})
