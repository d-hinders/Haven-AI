/**
 * #2812 — the permanent structural guard over hosted-tool OWNERSHIP and the
 * capability-module import boundary.
 *
 * The #2806 chain is complete: every hosted tool is owned by exactly one
 * capability module and `tools.ts` is a composition-only facade. This file
 * makes both invariants executable at the source level, so the NEXT module
 * added under `tools/` inherits the rules instead of the archaeology:
 *
 * 1. EXACTLY-ONE OWNER — the `_TOOLS` tuples of the capability modules are
 *    the ownership data. A tool claimed by two modules (duplicate) or by
 *    none (missing) is named and red. Duplicates matter even though the
 *    facade compile-checks the missing direction (TS2741): a duplicate split
 *    across two capability tuples compiles clean and resolves last-wins.
 * 2. NO SIBLING IMPORTS — a capability module may import the #2807 seams,
 *    shared support, the SDK and declared node built-ins; it must NEVER
 *    import another capability module, whether the symbol it wants is a
 *    helper or a handler. The check reads import SPECIFIERS, not symbols:
 *    reaching into a sibling at all is the violation, because that is how
 *    the monolith regrows one import at a time.
 * 3. NO TOOL-SPECIFIC BRANCHING IN THE FACADE — `tools.ts` must not mention
 *    a single tool name outside comments. Registry composition is by spread;
 *    a `haven_x:` literal key in the composition object silently shadows a
 *    capability handler (TS1117 does not reach across a spread), and any
 *    other tool-name reference in code is a branch the capability modules
 *    were extracted to remove.
 *
 * MUTATION PROTOCOL (issue acceptance criteria, non-negotiable): rules 1 and
 * 2 are proven fail-capable — duplicate one ownership entry, introduce one
 * cross-capability import, watch BOTH named tests go red, restore, watch
 * green. The evidence runs are quoted in the PR/handoff.
 *
 * Companion guards, deliberately NOT duplicated here: the helper-to-capability
 * ownership map and the allow-list form of the import rule live in
 * `tools/support/shared-helper-ownership.test.ts`; the #2807 runtime registry
 * twin lives in `tools/registry.ts` + `tools-registry-boot.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { toolSchemas } from '../tools.js'

/**
 * The capability modules, DERIVED from the directory — every non-test
 * `tools/*.ts` that is not one of #2807's three named seams — with the same
 * exclusion-shaped default as the #2809 derivation: a new file is a capability
 * (guarded) unless argued into the seam list.
 */
const TOOL_SEAM_MODULES = ['contracts', 'parsing', 'registry']

const CAPABILITY_MODULES: readonly string[] = fs
  .readdirSync(new URL('./', import.meta.url), { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
  .map((e) => e.name.replace(/\.ts$/, ''))
  .filter((stem) => !TOOL_SEAM_MODULES.includes(stem))
  .sort()

/** The `_TOOLS` tuple of a capability module, source-read (stem → names). */
function capabilityTuples(): Map<string, string[]> {
  const tuples = new Map<string, string[]>()
  for (const stem of CAPABILITY_MODULES) {
    const src = fs.readFileSync(new URL(`./${stem}.ts`, import.meta.url), 'utf8')
    // Anchor to the tuple START (not the file): a module declaring another
    // `] as const` array above its `_TOOLS` tuple would otherwise slice to ''
    // and silently drop its tools from the ownership set.
    const start = src.indexOf('_TOOLS = [')
    expect(
      start,
      `tools/${stem}.ts declares no _TOOLS tuple. Either it is a capability module missing one, ` +
        `or it is a new SEAM — add its stem to TOOL_SEAM_MODULES here AND in ` +
        `tools/support/shared-helper-ownership.test.ts with a reason, rather than leaving it to fail here.`,
    ).toBeGreaterThan(-1)
    const tuple = src.slice(start, src.indexOf('] as const', start))
    tuples.set(
      stem,
      [...tuple.matchAll(/'(haven_[a-z0-9_]+)'/g)].map((m) => m[1]),
    )
  }
  return tuples
}

/** Every `from '…'` specifier in a module's source, in file order. */
function importSpecifiers(stem: string): string[] {
  const src = fs.readFileSync(new URL(`./${stem}.ts`, import.meta.url), 'utf8')
  return [...src.matchAll(/\bfrom\s+'([^']+)'/g)].map((m) => m[1])
}

/**
 * The sibling rule as a PURE function over (specifiers, stem, capabilities),
 * so the instrument is proven on inputs the repository does not contain —
 * with four capability modules a real-file "no" is no longer vacuous, but the
 * positive control keeps the derivation honest if the directory is ever
 * re-rooted or the glob narrowed.
 */
export function siblingEdge(specifiers: string[], stem: string, capabilities: readonly string[]): string[] {
  const siblings = capabilities.filter((m) => m !== stem)
  return specifiers.filter((spec) =>
    siblings.some((m) => spec === `./${m}.js` || spec.endsWith(`/${m}.js`)),
  )
}

describe('module boundaries (#2812)', () => {
  it('every hosted tool is owned by exactly one capability module', () => {
    // The probe's own positive control first: a mis-rooted readdir or a
    // narrowed glob must not turn this into a suite that reports green over
    // an empty ownership set.
    expect(CAPABILITY_MODULES.length).toBeGreaterThan(0)
    expect(CAPABILITY_MODULES).toContain('paid-mcp-completion')

    const tuples = capabilityTuples()
    const owners = new Map<string, string[]>()
    for (const [stem, names] of tuples) {
      expect(names.length, `tools/${stem}.ts claims no tools — the probe is broken`).toBeGreaterThan(0)
      for (const name of names) {
        owners.set(name, [...(owners.get(name) ?? []), stem])
      }
    }
    const duplicated = [...owners.entries()].filter(([, mods]) => mods.length > 1)
    expect(
      duplicated,
      `tools claimed by MORE THAN ONE capability module (delete the entry that does not own it): ` +
        duplicated.map(([name, mods]) => `${name} -> ${mods.join(' + ')}`).join(', '),
    ).toEqual([])
    const missing = Object.keys(toolSchemas).filter((name) => !owners.has(name))
    expect(
      missing,
      `hosted tools owned by NO capability module (add them to the owning module's _TOOLS tuple): ${missing.join(', ')}`,
    ).toEqual([])
    const unknown = [...owners.keys()].filter((name) => !(name in toolSchemas))
    expect(
      unknown,
      `capability tuples name tools that are not in the hosted registry (stale or misspelled): ${unknown.join(', ')}`,
    ).toEqual([])
  })

  it('a capability module imports no sibling capability module — helper or handler', () => {
    // Positive control on the pure instrument, with synthetic names: the rule
    // must flag a sibling reach and stay silent on seams/support/SDK.
    expect(
      siblingEdge(
        ['@haven_ai/sdk', './contracts.js', './support/errors.js', './state-direct-recovery.js'],
        'paid-mcp-completion',
        ['state-direct-recovery', 'paid-mcp-completion'],
      ),
    ).toEqual(['./state-direct-recovery.js'])
    expect(
      siblingEdge(
        ['@haven_ai/sdk', './contracts.js', './support/errors.js'],
        'paid-mcp-completion',
        ['state-direct-recovery', 'paid-mcp-completion'],
      ),
    ).toEqual([])

    // The real files. Specifier-level, not symbol-level: `import { x } from
    // './sibling.js'` and `import './sibling.js'` are the same violation —
    // the edge itself, whatever it carries.
    for (const stem of CAPABILITY_MODULES) {
      const reached = siblingEdge(importSpecifiers(stem), stem, CAPABILITY_MODULES)
      expect(
        reached,
        `${stem} imports a sibling capability module (move the shared code into support, or own it outright): ${reached.join(', ')}`,
      ).toEqual([])
    }
  })

  it('tools.ts carries no tool-specific branching: no tool name outside comments', () => {
    const src = fs.readFileSync(new URL('../tools.ts', import.meta.url), 'utf8')
    // Strip comments first — the facade's header and spread annotations NAME
    // tools (that is documentation); only CODE may not. Self-check the
    // stripper with a synthetic input so a broken stripper cannot green a
    // facade full of branching.
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ')
    const stripperProbe = '// tools.ts mentions haven_comment_tool only in comments\nconst ok = 1 /* and haven_block_tool in blocks */'
    expect(
      stripperProbe.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ').match(/haven_[a-z0-9_]+/),
      'the comment stripper is broken — it stripped nothing from the probe',
    ).toBeNull()
    // `(?<!@)` keeps the SDK package scope (@haven_ai/sdk) out of the match
    // set — it is a dependency name, not a tool reference.
    const offenders = [...stripped.matchAll(/(?<!@)haven_[a-z0-9_]+/g)].map((m) => m[0])
    expect(
      offenders,
      `tools.ts references tool names OUTSIDE comments — the facade must compose spreads and re-export, never branch on a tool: ${offenders.join(', ')}`,
    ).toEqual([])
  })
})
