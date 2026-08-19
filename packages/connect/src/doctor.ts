/**
 * `--doctor` / `--repair` (#1589, epic #1585) — end-to-end setup diagnosis
 * without hand-building an MCP stdio client, which is what the 2026-08-18
 * external Codex Desktop tester was reduced to.
 *
 * Doctor is READ-ONLY (its one spawn is the same read-only tools/list
 * handshake setup itself uses) and secret-free: checks report names, paths,
 * versions and verdicts — never the api key or any key material. Repair
 * re-runs the pieces setup already owns — reinstall the pinned signer
 * runtime, rewrite wrapper + sidecar, re-write the runtime config from the
 * STORED identity — and never touches credentials or needs a new setup token.
 *
 * Design notes carried in from #1587's review:
 * - the signer probe reports the initialize payload, so compat versions come
 *   from the SAME handshake (no second probe);
 * - a probe against an un-acknowledged consent gate exits 1 — the doctor
 *   reports that as "consent missing" with the ack re-run as the repair,
 *   never as "signer broken".
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MCP_RUNTIME_MANIFEST } from './runtime-manifest.js'
import { probeHostedMcpTools, probeLocalMcpTools, type LocalMcpProbeResult } from './probes.js'
import {
  installedRuntimeMatches,
  prepareSignerRuntime,
  readRuntimeSidecar,
  type SignerRuntimeSidecar,
} from './signer-runtime.js'
import { runtimeConfigPathFor, writeRuntimeConfig } from './config-writers.js'
import { restartRequiredForRuntime, type RuntimeId } from './runtime-registry.js'
import { getLocalSignerConsentStatus } from './signer-consent.js'

export interface DoctorCheck {
  id: string
  label: string
  ok: boolean
  /** Human detail — never secret material. */
  detail: string
  /** One concrete action, present exactly when the check fails. */
  repair?: string
}

export interface DoctorReport {
  version: 1
  ok: boolean
  runtime: string
  credentialDirectory?: string
  checks: DoctorCheck[]
  /** Signer compat surface from the live handshake, when it succeeded. */
  signerCapabilities?: Record<string, unknown>
}

export interface DoctorDeps {
  homeDir?: string
  fetch?: typeof fetch
  probeSignerTools?: typeof probeLocalMcpTools
  probeHosted?: typeof probeHostedMcpTools
  runCommand?: (command: string, args: string[]) => Promise<void>
  env?: NodeJS.ProcessEnv
}

interface IdentityFile {
  api_key?: string
  agent_id?: string
  api_url?: string
  hosted_mcp_url?: string
}

const RERUN = 'npx @haven_ai/connect@alpha'

/** Newest agent directory that holds an identity.json, plus a multi-dir note. */
async function discoverCredentialDirectory(
  homeDir: string,
  explicit?: string,
): Promise<{ directory?: string; note?: string }> {
  if (explicit) return { directory: explicit }
  const root = join(homeDir, '.haven', 'agents')
  let entries: string[] = []
  try {
    entries = await readdir(root)
  } catch {
    return {}
  }
  const candidates: Array<{ directory: string; mtimeMs: number }> = []
  for (const entry of entries) {
    const directory = join(root, entry)
    try {
      const s = await stat(join(directory, 'identity.json'))
      candidates.push({ directory, mtimeMs: s.mtimeMs })
    } catch {
      // not an agent credential dir
    }
  }
  if (candidates.length === 0) return {}
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return {
    directory: candidates[0].directory,
    note: candidates.length > 1 ? `${candidates.length} agent credential dirs found; examining the newest.` : undefined,
  }
}

export async function runDoctor(
  input: { runtime: string; credentialsDir?: string },
  deps: DoctorDeps = {},
): Promise<DoctorReport> {
  const homeDir = deps.homeDir ?? homedir()
  const checks: DoctorCheck[] = []
  let signerCapabilities: Record<string, unknown> | undefined

  const { directory, note } = await discoverCredentialDirectory(homeDir, input.credentialsDir)

  // ── 1. Credentials ────────────────────────────────────────────────────────
  let identity: IdentityFile | undefined
  let signerParses = false
  if (!directory) {
    checks.push({
      id: 'credentials',
      label: 'Agent credentials',
      ok: false,
      detail: 'No agent credential directory with an identity.json under ~/.haven/agents.',
      repair: `Run the full setup once: ${RERUN} --setup <token from the Haven dashboard>.`,
    })
  } else {
    try {
      identity = JSON.parse(await readFile(join(directory, 'identity.json'), 'utf8')) as IdentityFile
    } catch {
      identity = undefined
    }
    try {
      const signer = JSON.parse(await readFile(join(directory, 'signer.json'), 'utf8')) as Record<string, unknown>
      signerParses = typeof signer === 'object' && signer !== null
    } catch {
      signerParses = false
    }
    const ok = Boolean(identity?.api_key) && signerParses
    checks.push({
      id: 'credentials',
      label: 'Agent credentials',
      ok,
      detail: ok
        ? `identity.json and signer.json parse (agent ${identity?.agent_id ?? 'unknown'})${note ? ` — ${note}` : ''}`
        : 'identity.json or signer.json is missing or unparseable.',
      ...(ok ? {} : { repair: `Re-run the full setup with a fresh token: ${RERUN} --setup <token>.` }),
    })
  }

  // ── 2. Signer runtime install ─────────────────────────────────────────────
  let sidecar: SignerRuntimeSidecar | null = null
  if (directory) {
    sidecar = await readRuntimeSidecar(directory)
    if (!sidecar) {
      checks.push({
        id: 'signer_runtime',
        label: 'Signer runtime (preinstalled wrapper)',
        ok: false,
        detail: 'No signer-runtime.json sidecar — the pinned signer runtime was never prepared (or a pre-#1586 npx config).',
        repair: `Run: ${RERUN} --doctor --repair --runtime ${input.runtime}`,
      })
    } else {
      const matches = await installedRuntimeMatches(sidecar.runtime_directory, sidecar.cli_path)
      const versionOk = sidecar.signer_version === MCP_RUNTIME_MANIFEST.signerVersion
      const ok = matches && versionOk
      checks.push({
        id: 'signer_runtime',
        label: 'Signer runtime (preinstalled wrapper)',
        ok,
        detail: ok
          ? `Installed ${sidecar.signer_package}@${sidecar.signer_version} at ${sidecar.runtime_directory}`
          : matches
            ? `Installed version ${sidecar.signer_version} does not match the connector's pinned ${MCP_RUNTIME_MANIFEST.signerVersion}.`
            : `Runtime directory is stale or empty (${sidecar.runtime_directory}) — the CLI or package versions are missing.`,
        ...(ok ? {} : { repair: `Run: ${RERUN} --doctor --repair --runtime ${input.runtime}` }),
      })
    }
  }

  // ── 3. Runtime config ─────────────────────────────────────────────────────
  const configPath = runtimeConfigPathFor(input.runtime, homeDir)
  if (configPath === null) {
    checks.push({
      id: 'runtime_config',
      label: 'Runtime MCP config',
      ok: true,
      detail: `Runtime '${input.runtime}' has no file-based config the connector owns (CLI-managed) — skipping the file check.`,
    })
  } else {
    let configText: string | null = null
    try {
      configText = await readFile(configPath, 'utf8')
    } catch {
      configText = null
    }
    if (configText === null) {
      checks.push({
        id: 'runtime_config',
        label: 'Runtime MCP config',
        ok: false,
        detail: `No runtime config at ${configPath}.`,
        repair: `Run: ${RERUN} --doctor --repair --runtime ${input.runtime}`,
      })
    } else {
      const hasHaven = identity?.hosted_mcp_url
        ? configText.includes(identity.hosted_mcp_url)
        : configText.includes('haven')
      // The wrapper form never writes the package spec into the config; only
      // the retired npx launch does — so the spec's presence IS the tell.
      const signerViaNpx = configText.includes('@haven_ai/signer')
      const wrapperReferenced = sidecar ? configText.includes(sidecar.wrapper_path) : false
      const ok = hasHaven && !signerViaNpx && (sidecar ? wrapperReferenced : true)
      checks.push({
        id: 'runtime_config',
        label: 'Runtime MCP config',
        ok,
        detail: ok
          ? `Config at ${configPath} references the hosted server and the prepared signer wrapper.`
          : signerViaNpx
            ? `Config at ${configPath} still launches the signer via npx — the pre-#1586 shape that cannot start under a 120s startup timeout.`
            : `Config at ${configPath} is missing the Haven entries${sidecar && !wrapperReferenced ? ' (or references a different signer wrapper)' : ''}.`,
        ...(ok ? {} : { repair: `Run: ${RERUN} --doctor --repair --runtime ${input.runtime}` }),
      })
    }
  }

  // ── 4. Hosted MCP ─────────────────────────────────────────────────────────
  if (identity?.api_key && (identity.hosted_mcp_url || identity.api_url)) {
    const hostedUrl = identity.hosted_mcp_url ?? `${identity.api_url}/mcp`
    const probe = await (deps.probeHosted ?? probeHostedMcpTools)(identity.api_key, hostedUrl, deps.fetch)
    checks.push({
      id: 'hosted_mcp',
      label: 'Hosted Haven MCP',
      ok: probe.status === 'ok',
      detail: probe.status === 'ok'
        ? `Reachable and authorized (${hostedUrl}).`
        : `Probe failed: ${probe.status} (${hostedUrl}).`,
      ...(probe.status === 'ok'
        ? {}
        : {
            repair: probe.status === 'unauthorized'
              ? `The stored API key was rejected — re-run the full setup with a fresh token: ${RERUN} --setup <token>.`
              : 'Check network access to the hosted MCP URL, then re-run --doctor.',
          }),
    })
  } else {
    checks.push({
      id: 'hosted_mcp',
      label: 'Hosted Haven MCP',
      ok: false,
      detail: 'No stored API key / hosted MCP URL to probe with.',
      repair: `Re-run the full setup: ${RERUN} --setup <token>.`,
    })
  }

  // ── 5. Signer process handshake ───────────────────────────────────────────
  if (sidecar && directory) {
    const consent = await getLocalSignerConsentStatus(join(directory, 'signer.json'))
    if (!consent.acknowledged) {
      // #1587 review: an un-acknowledged consent gate exits 1 and would read
      // as process_error — report the true cause instead of "signer broken".
      checks.push({
        id: 'signer_process',
        label: 'Signer stdio handshake',
        ok: false,
        detail: 'The local-tools consent is not acknowledged, so the signer refuses to start (by design).',
        repair: `Run: ${RERUN} --ack-local-tools --setup <token>  (or re-run your original setup command with --ack-local-tools).`,
      })
    } else {
      const probe: LocalMcpProbeResult = await (deps.probeSignerTools ?? probeLocalMcpTools)(
        sidecar.wrapper_path,
        [],
        MCP_RUNTIME_MANIFEST.requiredSignerTools,
      )
      // Real signer shape nests MCP capabilities under `experimental`
      // (signerCapabilityAdvertisement); accept both for robustness.
      const experimental = (probe.capabilities?.experimental ?? probe.capabilities) as
        | Record<string, unknown>
        | undefined
      const compat = experimental?.['haven/signer-compatibility'] as Record<string, unknown> | undefined
      signerCapabilities = compat ? { 'haven/signer-compatibility': compat } : undefined
      const compatDetail = compat
        ? ` Compat: x402 expected-context v${JSON.stringify((compat as { x402_expected_context_versions?: unknown }).x402_expected_context_versions ?? '?')}.`
        : ''
      checks.push({
        id: 'signer_process',
        label: 'Signer stdio handshake',
        ok: probe.status === 'ok',
        detail: probe.status === 'ok'
          ? `Signer started, listed ${probe.toolNames?.length ?? 0} tools${probe.serverInfo?.version ? ` (v${probe.serverInfo.version})` : ''}.${compatDetail}`
          : `Handshake failed: ${probe.status}.`,
        ...(probe.status === 'ok' ? {} : { repair: `Run: ${RERUN} --doctor --repair --runtime ${input.runtime}` }),
      })
    }
  } else if (directory) {
    checks.push({
      id: 'signer_process',
      label: 'Signer stdio handshake',
      ok: false,
      detail: 'Skipped — no prepared signer runtime to probe.',
      repair: `Run: ${RERUN} --doctor --repair --runtime ${input.runtime}`,
    })
  }

  // ── 6. Restart still required? (informational, never fails the doctor) ────
  const restart = restartRequiredForRuntime(input.runtime, deps.env)
  checks.push({
    id: 'restart',
    label: 'Runtime restart',
    ok: true,
    detail: restart
      ? 'This runtime loads MCP config at startup — restart it after any repair before expecting the tools to appear.'
      : 'No restart requirement known for this runtime.',
  })

  return {
    version: 1,
    ok: checks.every((check) => check.ok),
    runtime: input.runtime,
    credentialDirectory: directory,
    checks,
    ...(signerCapabilities ? { signerCapabilities } : {}),
  }
}

export interface RepairResult {
  ok: boolean
  messages: string[]
}

/** Re-run the pieces setup owns; never touches credentials or tokens. */
export async function runRepair(
  input: { runtime: string; credentialsDir?: string },
  deps: DoctorDeps = {},
): Promise<RepairResult> {
  const homeDir = deps.homeDir ?? homedir()
  const messages: string[] = []
  const { directory, note } = await discoverCredentialDirectory(homeDir, input.credentialsDir)
  if (note) messages.push(`Note: ${note}`)
  if (!directory) {
    return {
      ok: false,
      messages: [`No agent credentials found to repair — run the full setup: ${RERUN} --setup <token>.`],
    }
  }
  let identity: IdentityFile
  try {
    identity = JSON.parse(await readFile(join(directory, 'identity.json'), 'utf8')) as IdentityFile
  } catch {
    return { ok: false, messages: ['identity.json is unreadable — re-run the full setup with a fresh token.'] }
  }
  if (!identity.api_key || !(identity.hosted_mcp_url || identity.api_url)) {
    return { ok: false, messages: ['identity.json lacks the stored API key / hosted URL — re-run the full setup.'] }
  }

  // #1589 review (HIGH): a --local (local-stdio) setup writes a structurally
  // different config (the haven entry is the LOCAL MCP wrapper, not the
  // hosted URL). Repair only knows how to write the hosted+signer shape, so
  // clobbering a local config would convert a working topology silently —
  // the exact class of harm a repair tool must never cause. Detect and
  // refuse: the local wrapper (bin/haven-mcp) and its mcp-runtime sidecar
  // are the tell.
  const configPath = runtimeConfigPathFor(input.runtime, homeDir)
  if (configPath) {
    try {
      const existing = await readFile(configPath, 'utf8')
      if (existing.includes('bin/haven-mcp') || existing.includes('.haven/mcp-runtime')) {
        return {
          ok: false,
          messages: [
            `The config at ${configPath} is the LOCAL-stdio topology (--local). Repair currently rewrites only the hosted+signer shape and will not touch it.`,
            'Re-run your original setup command (with --local) to repair a local-stdio install.',
          ],
        }
      }
    } catch {
      // No existing config — nothing to clobber; proceed.
    }
  }

  const signerPath = join(directory, 'signer.json')
  const prepared = await prepareSignerRuntime(
    { credentialDirectory: directory, signerPath, homeDir },
    { runCommand: deps.runCommand },
  )
  messages.push(...prepared.messages)

  const configResult = await writeRuntimeConfig({
    runtime: input.runtime as RuntimeId,
    hostedMcpUrl: identity.hosted_mcp_url ?? `${identity.api_url}/mcp`,
    apiKey: identity.api_key,
    identityPath: join(directory, 'identity.json'),
    signerPath,
    credentialDirectory: directory,
    signerCommand: { command: prepared.command, args: prepared.args },
    homeDir,
    mode: 'hosted',
  })
  messages.push(...configResult.messages)
  messages.push('Repair complete — restart the runtime, then verify with --doctor.')
  return { ok: true, messages }
}
