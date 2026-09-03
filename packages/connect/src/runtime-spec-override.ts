/**
 * Local runtime-spec override (#2424, slice 4 of epic #2420).
 *
 * `prepareSignerRuntime` and `prepareLocalMcpRuntime` install the connector's
 * PINNED siblings — `@haven_ai/signer@<pin>`, `@haven_ai/sdk@<pin>`,
 * `@haven_ai/mcp@<pin>` from `runtime-manifest.ts` — into a version-named
 * directory under `~/.haven`. That is right for every user and wrong for the
 * one developer iterating on the signer or SDK, who until now had to publish
 * to find out whether a change works end to end.
 *
 * Three environment variables let that developer name a different spec:
 *
 *   HAVEN_SIGNER_SPEC   what `npm install` gets instead of `@haven_ai/signer@<pin>`
 *   HAVEN_SDK_SPEC      … instead of `@haven_ai/sdk@<pin>`
 *   HAVEN_MCP_SPEC      … instead of `@haven_ai/mcp@<pin>` (the `--local` topology)
 *
 * A value is anything `npm install` accepts as a package spec whose name is
 * fixed by the variable: `file:/abs/path/to/packages/signer`, a `.tgz` from
 * `npm pack`, or an explicit version such as `@haven_ai/signer@0.0.0-dev.…`.
 *
 * ## Why environment variables and not a `--runtime-spec` flag
 *
 * - The install runs from THREE entry points — `--setup`, `--doctor --repair`
 *   and `--rekey-finish` — and every one of them has to honour the same
 *   override or the developer's re-key silently reinstalls the registry build.
 *   One env read inside the two `prepare*Runtime` functions covers all three;
 *   a flag would have to be plumbed through each argv parser and each result
 *   type separately, and the first one forgotten is a hole.
 * - The setup command is minted by the dashboard and pasted verbatim, often by
 *   an agent. An override that lived in argv would have to be spliced into a
 *   command the developer did not write; an env var sits beside it.
 * - It is out of band by construction: an agent following the printed command
 *   cannot pass it by accident, and it never appears in the copy-pasted line.
 * - It matches the vocabulary the backend already uses for the same axis
 *   (`HAVEN_CONNECTOR_CHANNEL`, #2422/#2423).
 *
 * ## What an active override changes, and what it never changes
 *
 * - The runtime directory is keyed by a short hash of the RESOLVED specs
 *   (`override-<hash>`) instead of the manifest version, so an override can
 *   never poison the pinned directory the normal path reuses.
 * - An override install is never reused from an earlier run: a rebuilt local
 *   package must not be shadowed by a cache hit, and `npm install` of an
 *   already-satisfied spec is cheap.
 * - The override is printed loudly in setup output, recorded in the sidecar,
 *   written as a comment into the wrapper the agent client launches, and
 *   reported by `--doctor` as a failing check.
 * - The post-setup handshake probe still requires every tool in
 *   `requiredTools` / `requiredSignerTools`, so a local build that dropped a
 *   tool fails setup exactly like a bad registry version would.
 * - No variable set → nothing here runs. `resolveRuntimeSpecOverride` returns
 *   `undefined`, the callers fall through to the manifest specs, and the
 *   install args, directory, sidecar and wrapper are byte-for-byte what they
 *   were before this module existed. `signer-runtime.test.ts` pins that.
 *
 * ## Validation
 *
 * A set-but-malformed value is refused BEFORE `npm` is invoked, naming the
 * variable: empty or whitespace-only, containing whitespace or a control
 * character, or containing a shell metacharacter. The install runs through
 * `execFile` (no shell), so a metacharacter could not inject anything — the
 * refusal is because such a value is never a spec npm would accept and the
 * failure would otherwise surface minutes later as an npm error that does not
 * name the variable.
 */

import { createHash } from 'node:crypto'

export const RUNTIME_SPEC_ENV = {
  signer: 'HAVEN_SIGNER_SPEC',
  sdk: 'HAVEN_SDK_SPEC',
  mcp: 'HAVEN_MCP_SPEC',
} as const

export type RuntimeSpecPackage = keyof typeof RUNTIME_SPEC_ENV

/** Every override that is set — absent keys mean "the pinned manifest spec". */
export type RuntimeSpecOverride = Partial<Record<RuntimeSpecPackage, string>>

/**
 * Characters that can never appear in a spec `npm install` accepts and that,
 * in a shell, would mean something else. Whitespace and control characters
 * are checked separately so the message can say which.
 */
const SHELL_METACHARACTERS = /[;&|<>$`'"()!#*?[\]{}\\]/

export class RuntimeSpecOverrideError extends Error {
  readonly code = 'runtime_spec_override_invalid'
  readonly variable: string

  constructor(variable: string, reason: string) {
    super(`${variable} is set but not usable as an npm package spec: ${reason}. Unset it, or set it to a spec npm install accepts (file:/abs/path, a .tgz, or @haven_ai/<pkg>@<version>).`)
    this.name = 'RuntimeSpecOverrideError'
    this.variable = variable
  }
}

/**
 * Read the override from `env`. Returns `undefined` when no variable is set —
 * the production case, and the only case in which callers must behave exactly
 * as before. Throws `RuntimeSpecOverrideError` on a set-but-malformed value.
 */
export function resolveRuntimeSpecOverride(env: NodeJS.ProcessEnv): RuntimeSpecOverride | undefined {
  const override: RuntimeSpecOverride = {}
  for (const pkg of Object.keys(RUNTIME_SPEC_ENV) as RuntimeSpecPackage[]) {
    const variable = RUNTIME_SPEC_ENV[pkg]
    const raw = env[variable]
    if (raw === undefined) continue
    override[pkg] = validateSpec(variable, raw)
  }
  return Object.keys(override).length > 0 ? override : undefined
}

function validateSpec(variable: string, raw: string): string {
  if (raw.length === 0 || raw.trim().length === 0) {
    throw new RuntimeSpecOverrideError(variable, 'it is empty')
  }
  if (/\s/.test(raw)) {
    throw new RuntimeSpecOverrideError(variable, 'it contains whitespace')
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    throw new RuntimeSpecOverrideError(variable, 'it contains a control character')
  }
  const meta = SHELL_METACHARACTERS.exec(raw)
  if (meta) {
    throw new RuntimeSpecOverrideError(variable, `it contains the shell metacharacter ${JSON.stringify(meta[0])}`)
  }
  return raw
}

/**
 * The directory key for an override install: `override-` plus the first 12
 * hex characters of a SHA-256 over the resolved specs, in a fixed order. Two
 * setups with the same resolved specs share a directory; any difference in
 * any spec — including the NON-overridden sibling's pinned version — gets a
 * fresh one, so a pinned-sdk bump never reuses a directory built against the
 * previous pin.
 */
export function runtimeSpecOverrideDirectoryKey(resolvedSpecs: readonly string[]): string {
  const digest = createHash('sha256').update(resolvedSpecs.join('\n')).digest('hex')
  return `override-${digest.slice(0, 12)}`
}

/** True when `override` touches any of `packages`. */
export function overrideApplies(
  override: RuntimeSpecOverride | undefined,
  packages: readonly RuntimeSpecPackage[],
): override is RuntimeSpecOverride {
  return override !== undefined && packages.some((pkg) => override[pkg] !== undefined)
}

/**
 * The record written into the runtime sidecar and read back by `--doctor`.
 * `specs` holds only the overridden packages; `resolved_specs` holds every
 * spec the install actually ran with, overridden or pinned, in the order the
 * directory key hashes them.
 */
export interface RuntimeSpecOverrideRecord {
  specs: RuntimeSpecOverride
  resolved_specs: string[]
  directory_key: string
}

/**
 * The lines setup prints when an override is active. Deliberately loud and
 * deliberately first: a developer who forgot the variable is set in their
 * shell should not have to read the sidecar to learn why the signer differs.
 */
export function runtimeSpecOverrideNotice(
  runtimeLabel: string,
  override: RuntimeSpecOverride,
  pinned: Partial<Record<RuntimeSpecPackage, string>>,
  runtimeDirectory: string,
): string[] {
  const lines = [`RUNTIME SPEC OVERRIDE ACTIVE for the local Haven ${runtimeLabel} — this is NOT the pinned manifest.`]
  for (const pkg of Object.keys(RUNTIME_SPEC_ENV) as RuntimeSpecPackage[]) {
    const spec = override[pkg]
    if (spec === undefined) continue
    const pin = pinned[pkg]
    lines.push(`  ${RUNTIME_SPEC_ENV[pkg]}=${spec}${pin ? ` (instead of ${pin})` : ''}`)
  }
  lines.push(`  Installing into ${runtimeDirectory} — the pinned runtime directory is untouched.`)
  lines.push('  Unset the variable(s) and re-run to return to the pinned manifest.')
  return lines
}

/** One-line summary for wrapper comments and doctor output. */
export function describeRuntimeSpecOverride(override: RuntimeSpecOverride): string {
  return (Object.keys(RUNTIME_SPEC_ENV) as RuntimeSpecPackage[])
    .filter((pkg) => override[pkg] !== undefined)
    .map((pkg) => `${RUNTIME_SPEC_ENV[pkg]}=${override[pkg]}`)
    .join(' ')
}
