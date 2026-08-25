/**
 * On-chain caveat-enforcer probe (#2004, epic #1440).
 *
 * Asks a DEPLOYED MetaMask caveat enforcer, on a testnet, whether it would
 * allow or revert a given redemption — by `eth_call`ing its `beforeHook`
 * with the EXACT `terms` bytes Haven's own caveat compiler produced.
 *
 * ## Why this exists
 *
 * `casp-risk-guardrails.md` Red Line #4 claims the ON-CHAIN policy is the
 * final gate. On the delegation rail that gate is Solidity — the
 * `ERC20PeriodTransferEnforcer`, `AllowedCalldataEnforcer` and
 * `TimestampEnforcer` the DelegationManager runs while redeeming. Every
 * backend unit test mocks `prepareDelegationPayment`, which is the network
 * seam, so a unit test can only ever prove Haven FORWARDS the chain's
 * verdict — never that the verdict is correct. That boundary was filed as
 * #2004 and is what this module closes.
 *
 * ## Why `beforeHook` and not a full redemption
 *
 * `beforeHook` is the enforcer's entire decision. The DelegationManager calls
 * it per caveat while redeeming, and a revert there is what aborts the
 * redemption — the same revert a bundler surfaces during gas estimation. It
 * is reachable by a plain `eth_call` from an arbitrary sender, so proving it
 * needs:
 *
 * - **no private key** — `eth_call` is unsigned;
 * - **no funded account** — nothing is broadcast, nothing is mined;
 * - **no mainnet** — the probe is pinned to a testnet chain id and refuses
 *   any other (see `assertTestnetOnly`).
 *
 * A full `redeemDelegations` round trip would prove strictly more (it would
 * also cover the manager's caveat *sequencing*), but it needs a deployed and
 * funded delegator account plus a signature, i.e. operator-held testnet keys.
 * That remains open; it is recorded as the residual gap rather than papered
 * over — see the suite header.
 *
 * ## Transport failure is NOT a policy failure
 *
 * The one way a proof like this goes false is by reading an unreachable RPC
 * as "the enforcer allowed it". Every call therefore ends in exactly one of
 * three outcomes, and the unreachable one is a distinct thrown type
 * (`EnforcerProbeTransportError`) that no caller can mistake for `allowed`.
 */

import { concat, encodeFunctionData, pad, toHex, type Address, type Hex } from 'viem'

/** Set to `1` to accept a locally narrowed run. Ignored in CI, by design. */
export const SKIP_ACK_ENV = 'HAVEN_SKIP_ENFORCER_PROBE'
/** Override the RPC endpoint (a paid endpoint in CI, a fork locally). */
export const RPC_URL_ENV = 'HAVEN_ENFORCER_PROBE_RPC_URL'
/** Base Sepolia's public endpoint — testnet, no key, read-only. */
export const DEFAULT_PROBE_RPC_URL = 'https://sepolia.base.org'
/** The only chain this probe is allowed to touch. */
export const PROBE_CHAIN_ID = 84532

/**
 * Chain ids this probe must never be pointed at, whatever the env says.
 * Not a general "is it a testnet" heuristic — an explicit deny list of the
 * chains Haven serves with real money (`delegation-contracts.ts`).
 */
const FORBIDDEN_CHAIN_IDS: ReadonlySet<number> = new Set([1, 8453, 100])

export type ProbeMode = 'run' | 'skip-acknowledged' | 'fail-ci' | 'fail-unacknowledged'

export interface ProbeModeInputs {
  reachable: boolean
  ci: boolean
  acknowledged: boolean
}

/**
 * The whole availability policy as one total function over three booleans —
 * pure, so it is provable by ordinary tests that need no network at all.
 *
 * Deliberately the same shape as `db-availability.ts`'s `decideDbMode`
 * (#1763), for the same reason: a green run that silently skipped the proof
 * is the worst outcome this file can have, so the absence of a chain is
 * something a human SAYS they accept, never something that quietly narrows
 * what the run proved. `fail-ci` is not overridable — the acknowledgement is
 * a human at a terminal, not a CI escape hatch.
 */
export function decideProbeMode({ reachable, ci, acknowledged }: ProbeModeInputs): ProbeMode {
  if (reachable) return 'run'
  if (ci) return 'fail-ci'
  return acknowledged ? 'skip-acknowledged' : 'fail-unacknowledged'
}

export function readProbeModeInputs(
  env: NodeJS.ProcessEnv = process.env,
): Omit<ProbeModeInputs, 'reachable'> {
  return { ci: Boolean(env.CI), acknowledged: env[SKIP_ACK_ENV] === '1' }
}

export function resolveProbeRpcUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env[RPC_URL_ENV] ?? DEFAULT_PROBE_RPC_URL
}

export function unreachableMessage(rpcUrl: string, ci: boolean): string {
  return [
    `on-chain caveat-enforcer probe: could not reach ${rpcUrl}.`,
    'THIS IS A TRANSPORT FAILURE, NOT A POLICY FAILURE — it says nothing about',
    'whether the enforcers refuse an out-of-policy redemption. Do not read it as',
    'either a pass or a breach of CASP Red Line #4.',
    ci
      ? `Set ${RPC_URL_ENV} to a reliable Base Sepolia endpoint, or re-run the job.`
      : `Set ${SKIP_ACK_ENV}=1 to accept a run that does not prove Red Line #4 on-chain.`,
  ].join('\n')
}

/** Thrown when the chain could not be reached. Never conflated with a verdict. */
export class EnforcerProbeTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'EnforcerProbeTransportError'
  }
}

export type ProbeOutcome =
  | { kind: 'allowed' }
  | { kind: 'reverted'; reason: string }

const ERROR_STRING_SELECTOR = '0x08c379a0'

/**
 * `beforeHook(bytes,bytes,bytes32,bytes,bytes32,address,address)` — the
 * enforcer interface every caveat enforcer in the framework implements. The
 * unnamed parameters are `_args`, `_executionCallData`, `_delegationHash` and
 * `_redeemer`; the shape is pinned here rather than imported so a package
 * upgrade that changed it fails this file loudly instead of silently
 * re-encoding the money path.
 */
const BEFORE_HOOK_ABI = [
  {
    type: 'function',
    name: 'beforeHook',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_terms', type: 'bytes' },
      { name: '_args', type: 'bytes' },
      { name: '_mode', type: 'bytes32' },
      { name: '_executionCallData', type: 'bytes' },
      { name: '_delegationHash', type: 'bytes32' },
      { name: '_delegator', type: 'address' },
      { name: '_redeemer', type: 'address' },
    ],
    outputs: [],
  },
] as const

/** ERC-7579 single-call mode — the mode Haven's redemptions use. */
export const SINGLE_CALL_MODE: Hex = `0x${'00'.repeat(32)}`

/**
 * The execution calldata for one ERC-20 `transfer`, packed the way the
 * DelegationManager hands it to an enforcer: `target(20) || value(32) || data`.
 */
export function erc20TransferExecution(
  token: Address,
  to: Address,
  amountAtomic: bigint,
): Hex {
  return concat([
    token,
    pad(toHex(0n), { size: 32 }),
    encodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'transfer',
          stateMutability: 'nonpayable',
          inputs: [
            { name: 'to', type: 'address' },
            { name: 'amount', type: 'uint256' },
          ],
          outputs: [{ type: 'bool' }],
        },
      ] as const,
      functionName: 'transfer',
      args: [to, amountAtomic],
    }),
  ])
}

function decodeRevertReason(data: unknown): string {
  if (typeof data !== 'string' || !data.startsWith(ERROR_STRING_SELECTOR)) {
    return typeof data === 'string' ? data : 'unknown revert'
  }
  // Error(string): selector || offset(32) || length(32) || utf8 bytes
  const body = data.slice(ERROR_STRING_SELECTOR.length)
  const length = Number.parseInt(body.slice(64, 128), 16)
  const bytes = body.slice(128, 128 + length * 2)
  return Buffer.from(bytes, 'hex').toString('utf8')
}

async function rpc(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (cause) {
    throw new EnforcerProbeTransportError(`${method} failed to reach ${rpcUrl}`, { cause })
  }
  if (!response.ok) {
    // 429/5xx are the endpoint, not the enforcer. The HTTP status is
    // AUTHORITATIVE and is checked before the body is even parsed: a rate
    // limiter is free to return a body that looks like anything, including
    // something that would decode as a revert, and letting the body win would
    // let an endpoint under load fabricate a Red Line #4 verdict.
    throw new EnforcerProbeTransportError(`${method} → HTTP ${response.status} from ${rpcUrl}`)
  }
  try {
    return (await response.json()) as unknown
  } catch (cause) {
    // An HTML error page or a truncated body is the endpoint, not a verdict.
    throw new EnforcerProbeTransportError(`${method} returned an unparseable body`, { cause })
  }
}

/** True when the endpoint answers and serves the chain the probe is pinned to. */
export async function probeReachable(rpcUrl: string): Promise<boolean> {
  try {
    const body = (await rpc(rpcUrl, 'eth_chainId', [])) as { result?: string }
    if (typeof body.result !== 'string') return false
    assertTestnetOnly(Number.parseInt(body.result, 16))
    return true
  } catch (err) {
    if (err instanceof EnforcerProbeTransportError) return false
    throw err
  }
}

/**
 * Refuse outright to probe a chain Haven serves with real money. The probe
 * only ever `eth_call`s, so it cannot move funds even by accident — this is
 * belt-and-braces against a misconfigured `HAVEN_ENFORCER_PROBE_RPC_URL`
 * silently making a testnet-only proof read a mainnet contract.
 */
export function assertTestnetOnly(chainId: number): void {
  if (FORBIDDEN_CHAIN_IDS.has(chainId) || chainId !== PROBE_CHAIN_ID) {
    throw new Error(
      `enforcer probe is testnet-only: refusing chain ${chainId}, expected ${PROBE_CHAIN_ID}`,
    )
  }
}

export interface ProbeRequest {
  rpcUrl: string
  enforcer: Address
  terms: Hex
  executionCallData: Hex
  delegator: Address
  redeemer: Address
  delegationHash?: Hex
  args?: Hex
}

/**
 * Ask the deployed enforcer for its verdict. Exactly three outcomes:
 * `allowed`, `reverted` with the on-chain reason, or a thrown
 * `EnforcerProbeTransportError` — never a silent pass.
 */
export async function probeEnforcer(request: ProbeRequest): Promise<ProbeOutcome> {
  const data = encodeFunctionData({
    abi: BEFORE_HOOK_ABI,
    functionName: 'beforeHook',
    args: [
      request.terms,
      request.args ?? '0x',
      SINGLE_CALL_MODE,
      request.executionCallData,
      request.delegationHash ?? (`0x${'11'.repeat(32)}` as Hex),
      request.delegator,
      request.redeemer,
    ],
  })

  const body = (await rpc(request.rpcUrl, 'eth_call', [
    { to: request.enforcer, data },
    'latest',
  ])) as { result?: string; error?: { message?: string; data?: unknown } }

  if (body.error) {
    const revertData = body.error.data
    const reason = decodeRevertReason(revertData)
    const message = body.error.message ?? ''
    // An endpoint that answered with a JSON-RPC error but no revert payload
    // has told us nothing about the enforcer — treat it as transport.
    if (typeof revertData !== 'string' && !/revert/i.test(message)) {
      throw new EnforcerProbeTransportError(`eth_call errored without a revert: ${message}`)
    }
    return { kind: 'reverted', reason: reason || message }
  }
  if (typeof body.result !== 'string') {
    throw new EnforcerProbeTransportError('eth_call returned neither a result nor an error')
  }
  return { kind: 'allowed' }
}
