/**
 * The full-onboarding spike runner (#4682).
 *
 * One attempt is the whole chain, in the order the code requires:
 *
 *   stand-in signup → hybrid account → connection setup
 *     → the CONNECTOR registers the agent (`agents connect`, the real CLI)
 *     → the stand-in approves the budget (build → sign → activate → approve)
 *     → the agent's first payment settles on Base Sepolia
 *     → teardown (sweep, return, close, revoke)
 *
 * ## Why the connector is the "agent" here
 *
 * `agents connect` is the step #4680 defers, and the connector CLI IS that
 * step: it resolves the setup, mints the delegate key, signs the challenge,
 * registers the agent and writes the runtime config. Running the real CLI
 * exercises the product path rather than a re-implementation of it. What this
 * runner does NOT do is drive an LLM through the hand-offs — that is the
 * claude-code lane, and it needs the owner's subscription token (see the
 * runbook's "what could not be run" section).
 *
 * ## Spike discipline
 *
 * Every attempt tears down, including a failed or timed-out one, and the
 * teardown's warnings ride on the evidence row. Every step is BOUNDED — the
 * connector spawn, each backend request and the whole attempt have timers — so
 * a hung step resolves instead of skipping the teardown. The connector child
 * gets an allowlist env, never the harness's own credentials. Nothing here
 * runs in the default suite: the file is a CLI, not a test.
 */

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ethers } from 'ethers'
import { payViaDelegation } from '../lib/throwaway-identity.js'
import { SecretManifest } from './secret-manifest.js'
import { COMMAND_ENV_ALLOWLIST } from './command-tool.js'
import { createStandInHuman, type StandInHuman } from './stand-in-human.js'

/** One attempt's row in the evidence table. */
export interface SpikeAttempt {
  attempt: number
  startedAt: string
  /** Did the first payment settle on chain? */
  settled: boolean
  /** Who the failure belongs to, when it did not settle. */
  attribution: 'agent' | 'script' | 'haven' | null
  /** The step that failed, when one did. */
  failedStep?: string
  /** Atomic USDC the attempt moved out of the eval account (the funding payment). */
  spentAtomic: string
  /** Atomic USDC the teardown returned to the eval account. */
  returnedAtomic: string
  /** Atomic USDC left stranded on the delegate EOA (the stand-in cannot sweep it). */
  sweptAtomic: string
  revoke: 'ok' | 'warning' | 'not-attempted'
  cleanupWarning?: string
  setupId?: string
  agentId?: string
  paymentId?: string
  txHash?: string
  connectorExit?: number
  notes: string[]
}

export interface SpikeOptions {
  apiUrl: string
  chainId: number
  evalAgentApiKey: string
  evalDelegateKey: string
  evalAccountAddress: string
  recipient: string
  /** The built connector CLI (`packages/connect/dist/cli.js`). */
  connectorCli: string
  /** The funding amount per attempt, atomic. */
  fundingAtomic: string
  /** The budget the setup asks for, atomic. */
  budgetAtomic: string
  /** The budget period, seconds. */
  periodSeconds: number
  /** Where the per-attempt manifests and credential dirs go. */
  workDir: string
  /** Bound on the settlement poll, ms. */
  settleTimeoutMs?: number
  /** Bound on the connector spawn, ms. A hung connector is killed. */
  connectorTimeoutMs?: number
  /** Bound on ONE backend request, ms. */
  fetchTimeoutMs?: number
  /** Bound on the WHOLE attempt, ms — the teardown runs when it expires. */
  attemptTimeoutMs?: number
  /** Injectable USDC balance read (tests). */
  readUsdcBalance?: (address: string) => Promise<bigint>
  /** Injectable spawn (tests). */
  spawnImpl?: typeof spawn
}

/** The default bound on the connector spawn: 3 minutes. */
export const DEFAULT_CONNECTOR_TIMEOUT_MS = 180_000
/** The default bound on one backend request: 30 s. */
export const DEFAULT_SPIKE_FETCH_TIMEOUT_MS = 30_000
/** The default bound on one whole attempt: 10 minutes. */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 600_000

/** The connector's JSON output, as far as the runner reads it. */
interface ConnectorOutput {
  ok?: boolean
  /** The connector's own verdict: `complete` is the success value. */
  outcome?: string
  setupId?: string
  agentId?: string
  approvalUrl?: string
  /** The connector nests the approval link under `approval.url`. */
  approval?: { required?: boolean; url?: string }
  setup_id?: string
  agent_id?: string
  approval_url?: string
  error?: { code?: string; message?: string }
}

/**
 * The connector child's env: an ALLOWLIST, never `{...process.env}` (#4682
 * round 2).
 *
 * The connector is the harness's own CLI, but it is spawned from the process
 * that holds the eval agent's credentials — `QA_EVAL_AGENT_API_KEY`,
 * `QA_EVAL_DELEGATE_KEY`, `QA_EVAL_AGENT_ACCOUNT`, `QA_EVAL_RECIPIENT` — and
 * the agent under test must never inherit them. `HOME` is kept because node
 * and the connector's own config lookup need it; nothing else is.
 */
export function buildConnectorEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of COMMAND_ENV_ALLOWLIST) {
    const value = base[name]
    if (value !== undefined) env[name] = value
  }
  if (base.HOME !== undefined) env.HOME = base.HOME
  return env
}

function runConnector(
  opts: SpikeOptions,
  setupToken: string,
  credentialsDir: string,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut?: boolean }> {
  const spawnImpl = opts.spawnImpl ?? spawn
  const timeoutMs = opts.connectorTimeoutMs ?? DEFAULT_CONNECTOR_TIMEOUT_MS
  return new Promise((resolve) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    const done = (result: { code: number | null; stdout: string; stderr: string; timedOut?: boolean }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const child = spawnImpl(
      process.execPath,
      [
        opts.connectorCli,
        '--setup',
        setupToken,
        '--json',
        '--api',
        opts.apiUrl,
        // `--runtime-force` rather than `--runtime`: this box runs Hermes, so
        // detection would override the hint and write the trial's wiring into
        // the harness's own Hermes config.
        '--runtime-force',
        'other',
        '--credentials-dir',
        credentialsDir,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], env: buildConnectorEnv(process.env) },
    )
    // A connector that never exits must not hold the attempt open: kill it and
    // resolve, so the runner's `finally` still tears the attempt down.
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done({
        code: null,
        stdout,
        stderr: `${stderr}\nthe connector did not exit within ${timeoutMs}ms and was killed`,
        timedOut: true,
      })
    }, timeoutMs)
    // The attempt-level bound may reject first; an unref'd timer must not keep
    // the process alive after the attempt has already been torn down.
    timer.unref?.()
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = `${stdout}${chunk}`.slice(-40_000)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk}`.slice(-8_000)
    })
    child.on('error', (err) => done({ code: null, stdout, stderr: `${stderr}${err.message}` }))
    child.on('close', (code) => done({ code, stdout, stderr }))
  })
}

/** The last JSON object the connector printed on stdout. */
function parseConnectorOutput(stdout: string): ConnectorOutput | null {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]!) as ConnectorOutput
      if (typeof parsed === 'object' && parsed !== null) return parsed
    } catch {
      // not the JSON line
    }
  }
  return null
}

/**
 * Did the connector REGISTER the agent?
 *
 * `complete` is the fully-wired verdict. `action_required` is the manual
 * runtime's verdict: the agent is registered and the approval URL is issued,
 * but the connector wrote no runtime config because `--runtime-force other`
 * has none to write. For the spike that is the step that matters — the setup
 * now carries `agent_id` and `delegate_address`, which is what the budget
 * approval needs.
 */
function connectorSucceeded(output: ConnectorOutput | null): boolean {
  if (!output) return false
  if (output.ok === true || output.outcome === 'complete') return true
  return output.outcome === 'action_required' && Boolean(output.approval?.url ?? output.approvalUrl ?? output.approval_url)
}

/**
 * Pay as the trial's agent, keeping the `payment_id` the authorize step
 * returns — `payViaDelegation` drops it, and the settlement poll needs it.
 */
async function payAsAgent(
  apiUrl: string,
  apiKey: string,
  delegateKey: string,
  to: string,
  human: string,
  fetchTimeoutMs: number,
): Promise<{ ok: true; paymentId?: string; tx?: string } | { ok: false; status: number; error: string }> {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }
  const auth = await fetch(`${apiUrl}/payments`, {
    signal: AbortSignal.timeout(fetchTimeoutMs),
    method: 'POST',
    headers,
    body: JSON.stringify({ token: 'USDC', amount: human, to }),
  })
  const intent = (await auth.json().catch(() => ({}))) as {
    payment_id?: string
    sign_data?: { typed_data?: Record<string, unknown> }
    error?: string
  }
  if (!auth.ok || !intent.payment_id || !intent.sign_data?.typed_data) {
    return { ok: false, status: auth.status, error: intent.error ?? `authorize ${auth.status}` }
  }
  const { signUserOpTypedDataForDelegation } = await import('@haven_ai/sdk')
  const signature = await signUserOpTypedDataForDelegation(delegateKey, intent.sign_data.typed_data as never)
  const submit = await fetch(`${apiUrl}/payments/${intent.payment_id}/sign`, {
    signal: AbortSignal.timeout(fetchTimeoutMs),
    method: 'POST',
    headers,
    body: JSON.stringify({ signature }),
  })
  const done = (await submit.json().catch(() => ({}))) as { tx_hash?: string; error?: string }
  if (!submit.ok) {
    return { ok: false, status: submit.status, error: done.error ?? `sign ${submit.status}` }
  }
  return { ok: true, paymentId: intent.payment_id, ...(done.tx_hash ? { tx: done.tx_hash } : {}) }
}

/**
 * Find the connector's credential files under `--credentials-dir`. The
 * connector writes them into a per-agent slug directory, so they are one
 * level down; a future layout that writes them at the top is accepted too.
 */
async function findCredentialFiles(
  dir: string,
): Promise<{ identity: string; signer: string } | null> {
  const candidates = [dir, ...(await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name))]
  for (const candidate of candidates) {
    const identity = join(candidate, 'identity.json')
    const signer = join(candidate, 'signer.json')
    try {
      await readFile(identity, 'utf8')
      await readFile(signer, 'utf8')
      return { identity, signer }
    } catch {
      // try the next candidate
    }
  }
  return null
}

/**
 * Poll the payment until it reaches a terminal state, or the bound expires.
 *
 * The delegation rail's terminal SUCCESS state is `confirmed` (the submission
 * reconciler's word for "the transaction landed"), not `settled` — the first
 * live attempt read `confirmed` and the runner called it a failure.
 */
async function waitForSettlement(
  apiUrl: string,
  apiKey: string,
  paymentId: string,
  timeoutMs: number,
  fetchTimeoutMs: number,
): Promise<{ settled: boolean; status: string }> {
  const deadline = Date.now() + timeoutMs
  let status = 'unknown'
  for (;;) {
    const res = await fetch(`${apiUrl}/payments/${paymentId}`, {
      signal: AbortSignal.timeout(fetchTimeoutMs),
      headers: { authorization: `Bearer ${apiKey}` },
    })
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { status?: string }
      status = body.status ?? 'unknown'
      if (status === 'confirmed' || status === 'settled') return { settled: true, status }
      if (status === 'failed' || status === 'failed_reverted' || status === 'refused') {
        return { settled: false, status }
      }
    }
    if (Date.now() > deadline) return { settled: false, status }
    await new Promise((r) => setTimeout(r, 3_000))
  }
}

/**
 * Run ONE attempt. Never throws: a failure is a row with an attribution, and
 * the teardown runs whatever happened.
 */
export async function runAttempt(opts: SpikeOptions, attempt: number): Promise<SpikeAttempt> {
  const startedAt = new Date().toISOString()
  const row: SpikeAttempt = {
    attempt,
    startedAt,
    settled: false,
    attribution: null,
    spentAtomic: '0',
    returnedAtomic: '0',
    sweptAtomic: '0',
    revoke: 'not-attempted',
    notes: [],
  }
  const dir = join(opts.workDir, `attempt-${attempt}`)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const manifest = await SecretManifest.create(join(dir, 'secrets.jsonl'), { setupTasks: 1 })

  let standIn: StandInHuman | undefined
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS
  let deadlineTimer: NodeJS.Timeout | undefined
  let rejectDeadline: ((err: Error) => void) | undefined
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject
  })
  /**
   * Start the attempt-level bound. It is armed once the stand-in EXISTS: the
   * stand-in owns its own teardown while it is being provisioned (each request
   * is bounded, and a provisioning failure tears the account down), so the
   * bound covers the connector, the budget, the funding and the payment.
   */
  const armDeadline = (): void => {
    deadlineTimer = setTimeout(
      () => rejectDeadline?.(new Error(`attempt ${attempt} timed out after ${attemptTimeoutMs}ms`)),
      attemptTimeoutMs,
    )
    deadlineTimer.unref?.()
  }
  /**
   * The attempt's steps. Kept as a function so the attempt-level bound can
   * race it: a hung connector or a fetch that never answers must not skip the
   * teardown (#4682 round 2).
   */
  const runSteps = async (): Promise<SpikeAttempt> => {
    // ── 1. the stand-in ────────────────────────────────────────────────────
    const created = await createStandInHuman({
      apiUrl: opts.apiUrl,
      chainId: opts.chainId,
      label: `spike-${attempt}`,
      evalAgentApiKey: opts.evalAgentApiKey,
      evalDelegateKey: opts.evalDelegateKey,
      evalAccountAddress: opts.evalAccountAddress,
      manifest,
      budgetAtomic: opts.budgetAtomic,
      periodSeconds: opts.periodSeconds,
      fetchTimeoutMs: opts.fetchTimeoutMs ?? DEFAULT_SPIKE_FETCH_TIMEOUT_MS,
      ...(opts.readUsdcBalance !== undefined ? { readUsdcBalance: opts.readUsdcBalance } : {}),
    })
    if ('error' in created) {
      row.attribution = 'haven'
      row.failedStep = 'stand-in provisioning'
      row.notes.push(created.error)
      // The stand-in tears down whatever it created before returning the
      // error; the row carries that teardown so a failed attempt cannot look
      // like it left an account behind (#4682 round 2).
      if (created.cleanupWarning) row.cleanupWarning = created.cleanupWarning
      return row
    }
    standIn = created
    armDeadline()
    row.setupId = standIn.evidence.setupId

    // ── 2. the connector registers the agent ───────────────────────────────
    const credentialsDir = join(dir, 'credentials')
    const connector = await runConnector(opts, standIn.evidence.connectorCommand.split('--setup ')[1]?.split(' ')[0] ?? '', credentialsDir)
    await writeFile(join(dir, 'connector.stdout.txt'), connector.stdout)
    await writeFile(join(dir, 'connector.stderr.txt'), connector.stderr)
    row.connectorExit = connector.code ?? undefined
    if (connector.timedOut) {
      row.attribution = 'script'
      row.failedStep = 'agents connect (timeout)'
      row.notes.push(
        `the connector did not exit within ${opts.connectorTimeoutMs ?? DEFAULT_CONNECTOR_TIMEOUT_MS}ms and was killed`,
      )
      return row
    }
    const output = parseConnectorOutput(connector.stdout)
    if (connector.code !== 0 || !connectorSucceeded(output)) {
      row.attribution = 'agent'
      row.failedStep = 'agents connect (register)'
      const detail = output?.error?.message ?? (connector.stderr.slice(-400) || '(no output)')
      row.notes.push(`connector exited ${connector.code}: ${detail}`)
      return row
    }
    row.agentId = output?.agentId ?? output?.agent_id

    // ── 3. the stand-in approves the budget ────────────────────────────────
    try {
      const grant = await standIn.approveBudget()
      row.notes.push(`grant ${grant.delegationHash} for ${grant.budgetAtomic} atomic / ${grant.periodSeconds}s`)
    } catch (err) {
      row.attribution = 'script'
      row.failedStep = 'budget approval'
      row.notes.push((err as Error).message)
      return row
    }

    // ── 4. fund the account, then pay ──────────────────────────────────────
    try {
      await standIn.fund(opts.fundingAtomic)
      row.spentAtomic = opts.fundingAtomic
    } catch (err) {
      row.attribution = 'haven'
      row.failedStep = 'funding'
      row.notes.push((err as Error).message)
      return row
    }

    // The connector writes the credentials into a per-agent slug directory
    // under `--credentials-dir`, so the files are one level down.
    const credentialFiles = await findCredentialFiles(credentialsDir)
    if (!credentialFiles) {
      row.attribution = 'agent'
      row.failedStep = 'connector credential files'
      row.notes.push('the connector did not write identity.json / signer.json')
      return row
    }
    const identity = JSON.parse(await readFile(credentialFiles.identity, 'utf8')) as { api_key?: string }
    const signer = JSON.parse(await readFile(credentialFiles.signer, 'utf8')) as { delegate_key?: string }
    if (!identity.api_key || !signer.delegate_key) {
      row.attribution = 'agent'
      row.failedStep = 'connector credential files'
      row.notes.push('identity.json / signer.json carried no key')
      return row
    }

    const paid = await payAsAgent(
      opts.apiUrl,
      identity.api_key,
      signer.delegate_key,
      opts.recipient,
      ethers.formatUnits(BigInt(opts.fundingAtomic), 6),
      opts.fetchTimeoutMs ?? DEFAULT_SPIKE_FETCH_TIMEOUT_MS,
    )
    if (!paid.ok) {
      row.attribution = 'agent'
      row.failedStep = 'first payment'
      row.notes.push(`payment refused (${paid.status}): ${paid.error}`)
      return row
    }
    row.txHash = paid.tx
    if (paid.paymentId) {
      row.paymentId = paid.paymentId
      const settlement = await waitForSettlement(
        opts.apiUrl,
        identity.api_key,
        paid.paymentId,
        opts.settleTimeoutMs ?? 120_000,
        opts.fetchTimeoutMs ?? DEFAULT_SPIKE_FETCH_TIMEOUT_MS,
      )
      row.settled = settlement.settled
      row.notes.push(`payment ${paid.paymentId} status ${settlement.status}`)
      if (!settlement.settled) {
        row.attribution = 'haven'
        row.failedStep = 'settlement'
      }
    } else {
      // The delegation rail answers with a tx hash on submit; a hash is the
      // settlement evidence when the route does not return a payment id.
      row.settled = Boolean(paid.tx)
      row.notes.push('the payment route returned a tx hash and no payment id')
    }
    return row
  }
  try {
    return await Promise.race([runSteps(), deadline])
  } catch (err) {
    row.attribution = 'script'
    row.failedStep = row.failedStep ?? 'runner'
    row.notes.push((err as Error)?.message ?? String(err))
    return row
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer)
    // ── 5. teardown, ALWAYS ────────────────────────────────────────────────
    if (standIn) {
      const teardown = await standIn.teardown()
      row.revoke = teardown.warnings.some((w) => w.includes('revoke')) ? 'warning' : 'ok'
      row.returnedAtomic = standIn.evidence.returnedAtomic ?? '0'
      if (teardown.unreturnedAtomic) row.returnedAtomic = `0 (unreturned ${teardown.unreturnedAtomic})`
      row.sweptAtomic = standIn.evidence.sweptAtomic ?? '0'
      if (teardown.warnings.length > 0) row.cleanupWarning = teardown.warnings.join('; ')
    }
    await writeFile(join(dir, 'attempt.json'), JSON.stringify(row, null, 2))
  }
}

/** Run N attempts and write the evidence table. */
export async function runSpike(opts: SpikeOptions, attempts: number): Promise<SpikeAttempt[]> {
  const rows: SpikeAttempt[] = []
  for (let i = 1; i <= attempts; i += 1) {
    rows.push(await runAttempt(opts, i))
  }
  return rows
}

/** Render the evidence table as markdown (the PR/comment artifact). */
export function renderEvidenceTable(rows: SpikeAttempt[]): string {
  const header =
    '| # | settled | attribution | failed step | spent (atomic) | returned | swept | revoke | cleanup warning |\n' +
    '|---|---|---|---|---|---|---|---|---|\n'
  const body = rows
    .map(
      (r) =>
        `| ${r.attempt} | ${r.settled ? 'yes' : 'no'} | ${r.attribution ?? '—'} | ${r.failedStep ?? '—'} | ` +
        `${r.spentAtomic} | ${r.returnedAtomic} | ${r.sweptAtomic} | ${r.revoke} | ${r.cleanupWarning ?? '—'} |`,
    )
    .join('\n')
  return `${header}${body}\n`
}

/** The CLI entry: `tsx src/evals/spike-full-onboarding.ts --attempts=5 --out=spike.json`. */
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const attempts = Number(args.find((a) => a.startsWith('--attempts='))?.split('=')[1] ?? '5')
  const out = args.find((a) => a.startsWith('--out='))?.split('=')[1] ?? 'spike-evidence.json'
  const env = process.env
  const required = [
    'QA_HAVEN_API_URL',
    'QA_EVAL_AGENT_API_KEY',
    'QA_EVAL_DELEGATE_KEY',
    'QA_EVAL_AGENT_ACCOUNT',
    'QA_EVAL_RECIPIENT',
    'QA_EVAL_CONNECT_CLI',
  ]
  const missing = required.filter((name) => !env[name])
  if (missing.length > 0) {
    throw new Error(`missing env: ${missing.join(', ')} — the spike refuses to guess its wiring`)
  }
  const workDir = await mkdtemp(join(tmpdir(), 'qa-spike-'))
  const rows = await runSpike(
    {
      apiUrl: env.QA_HAVEN_API_URL!,
      chainId: Number(env.QA_CHAIN_ID ?? '84532'),
      evalAgentApiKey: env.QA_EVAL_AGENT_API_KEY!,
      evalDelegateKey: env.QA_EVAL_DELEGATE_KEY!,
      evalAccountAddress: env.QA_EVAL_AGENT_ACCOUNT!,
      recipient: env.QA_EVAL_RECIPIENT!,
      connectorCli: env.QA_EVAL_CONNECT_CLI!,
      fundingAtomic: env.QA_SPIKE_FUNDING_ATOMIC ?? '100000',
      budgetAtomic: env.QA_SPIKE_BUDGET_ATOMIC ?? '100000',
      periodSeconds: Number(env.QA_SPIKE_PERIOD_SECONDS ?? '1440') * 60,
      workDir,
    },
    attempts,
  )
  await writeFile(out, JSON.stringify(rows, null, 2))
  process.stdout.write(`${renderEvidenceTable(rows)}\n`)
  process.stdout.write(`evidence written to ${out}; per-attempt artifacts under ${workDir}\n`)
}

const isMain = (() => {
  try {
    return process.argv[1]?.endsWith('spike-full-onboarding.ts') || process.argv[1]?.endsWith('spike-full-onboarding.js')
  } catch {
    return false
  }
})()

if (isMain) {
  void main().catch((err) => {
    process.stderr.write(`${(err as Error)?.message ?? String(err)}\n`)
    process.exit(1)
  })
}
