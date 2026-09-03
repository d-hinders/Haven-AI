/**
 * The npm dist-tag the published Haven packages tell a user to re-run (#2423,
 * slice 3 of epic #2420).
 *
 * ## Why a constant and not a literal
 *
 * Roughly a dozen user- and agent-facing strings across `@haven_ai/sdk`,
 * `@haven_ai/signer`, `@haven_ai/connect` and the hosted MCP server say some
 * form of "re-run `npx @haven_ai/connect@alpha`". Every one of them was a
 * hard-coded literal, which is correct only for a build published under the
 * `alpha` dist-tag. Once `dev`-branch snapshots publish under a `dev` tag
 * (#2421), a snapshot build telling its tester to re-run `@alpha` would hand
 * them the production connector — silently replacing the very build they are
 * testing. So the tag becomes one build-time constant and every hint derives
 * from it.
 *
 * ## Who writes it
 *
 * `scripts/release-bump.mjs` rewrites {@link HAVEN_CONNECTOR_CHANNEL} from the
 * version it is bumping to, using exactly the rule `.github/workflows/publish.yml`
 * uses to pick the `--tag` for that same version:
 *
 * | version | dist-tag / channel |
 * |---|---|
 * | `0.1.34-alpha.0` | `alpha` |
 * | `0.0.0-dev.202609021200.abc1234` | `dev` |
 * | `0.2.0` | `latest` |
 *
 * One rule, two consumers. `scripts/ci/connector-channel-agreement.test.mjs`
 * executes the workflow's own shell and the bump script's own function over the
 * same version table and fails if they ever disagree.
 *
 * ## Build-time here, run-time there
 *
 * A published tarball cannot read a deployment's environment, so for the
 * published packages the channel is baked in at release time. A surface that is
 * *deployed* rather than published has no release at which to bake anything in,
 * so it reads the `HAVEN_CONNECTOR_CHANNEL` environment variable and falls back
 * to this constant. In this repository that surface is the hosted MCP server
 * (`packages/mcp-server/src/connector-channel.ts`); slice 2 of the epic (#2422,
 * open at the time of writing, not merged) gives the backend's connector
 * handout the same treatment under the same variable name, default and
 * validation pattern — deliberately, so the two cannot disagree about what a
 * valid channel is.
 *
 * **This says nothing about how any environment is configured.** Setting the
 * variable anywhere is an operator action (epic #2420, operator step 3); no
 * code here can observe it and none of this comment asserts it has happened.
 */

/** The published connector package. Never varies; only its tag does. */
export const CONNECTOR_PACKAGE_NAME = '@haven_ai/connect'

/**
 * The npm dist-tag this build's re-run hints name.
 *
 * **Do not hand-edit.** `scripts/release-bump.mjs` owns this literal the same
 * way it owns `CONNECTOR_VERSION` and its siblings, and
 * `scripts/release-bump.test.mjs` fails if the two drift.
 */
export const HAVEN_CONNECTOR_CHANNEL = 'alpha'

/**
 * A channel is a bare npm dist-tag: lowercase, starts with a letter, and may
 * carry digits and hyphens. This is not only a tidiness check — the resulting
 * spec is interpolated into an `npx <spec> …` command line that a human pastes
 * into a real terminal, so the pattern is also a shell boundary. It cannot
 * express a different package, a registry, a path or a shell metacharacter:
 * a wrong value selects another Haven channel and nothing else.
 *
 * Deliberately the same pattern slice 2 (#2422, open, not merged) uses for the
 * backend's copy of this variable: two readers of one environment variable that
 * disagree about what is valid is a worse failure than either rule alone.
 */
const CHANNEL_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

/** True when `value` is a well-formed dist-tag. */
export function isConnectorChannel(value: string): boolean {
  return CHANNEL_PATTERN.test(value)
}

/**
 * Resolve a channel from a deployment's `HAVEN_CONNECTOR_CHANNEL`.
 *
 * - unset, empty or whitespace ⇒ `fallback` (dashboards store a cleared
 *   variable as `""`, and that must land on the production-safe value);
 * - well-formed ⇒ itself;
 * - anything else ⇒ **throws**. It does not quietly fall back: a typo such as
 *   `dve` would then land on the production channel, and the environment would
 *   look fixed while reproducing the exact defect this slice removes.
 *
 * Well-formed-but-wrong (`dve` again) is *not* caught here and cannot be — it
 * fails later at `npx`, where the error names the package. Stated rather than
 * implied.
 */
export function resolveConnectorChannel(
  raw: string | undefined | null,
  fallback: string = HAVEN_CONNECTOR_CHANNEL,
): string {
  const trimmed = (raw ?? '').trim()
  if (trimmed === '') return fallback
  if (!isConnectorChannel(trimmed)) {
    throw new Error(
      `HAVEN_CONNECTOR_CHANNEL is set to ${JSON.stringify(raw)}, which is not a valid npm ` +
        'dist-tag (lowercase letter first, then letters, digits or hyphens). Refusing to start ' +
        'rather than fall back to the default channel, because falling back would hand out the ' +
        'production connector while looking configured.',
    )
  }
  return trimmed
}

/** `@haven_ai/connect@<channel>` — the spec an `npx` invocation names. */
export function connectorSpec(channel: string = HAVEN_CONNECTOR_CHANNEL): string {
  return `${CONNECTOR_PACKAGE_NAME}@${channel}`
}

/**
 * The re-run command every hint embeds.
 *
 * `connectorRerunCommand()` → `npx @haven_ai/connect@alpha`
 * `connectorRerunCommand('--doctor')` → `npx @haven_ai/connect@alpha --doctor`
 *
 * `args` is appended verbatim so each call site keeps its own flags and its own
 * surrounding sentence. The wording of those sentences is deliberately NOT
 * moved here: several are inside signer refusal messages that users and agents
 * pattern-match on, and this change is meant to move the channel token and
 * nothing else.
 */
export function connectorRerunCommand(
  args?: string,
  options?: { channel?: string; npxFlags?: string },
): string {
  const channel = options?.channel ?? HAVEN_CONNECTOR_CHANNEL
  const flags = options?.npxFlags ? `${options.npxFlags} ` : ''
  const command = `npx ${flags}${connectorSpec(channel)}`
  return args ? `${command} ${args}` : command
}
