/**
 * Delegate hot-balance sweep orchestration (#997, epic #713's sweep leg).
 * Extracted verbatim from `routes/machine-payments.ts`: `POST /sweep/prepare`
 * builds a gasless EIP-3009 `TransferWithAuthorization` for the delegate's
 * stranded USDC; `POST /sweep/submit` re-derives the authorization from
 * server state (never the client), verifies the delegate's signature,
 * re-reads the balance, and relays through a compare-and-swap claim so two
 * concurrent submits cannot both broadcast. The #717 budget-release path
 * (a relayer-budget refusal releases the claim back to `prepared` rather
 * than `failed`, so the sweep is retryable after the window) is preserved
 * exactly — see the characterization tests added in #997 for the CAS
 * lifecycle transitions this file must not disturb.
 */
import { config } from '../../config.js'
import {
  claimPreparedSweepForBoundAgent,
  expirePreparedSweep,
  findSweepById,
  findSweepByNonce,
  insertPreparedSweepForBoundAgent,
  markSweepFailed,
  markSweepSubmitted,
  releaseSweepClaim,
  resolveStrandedEventsForAgent,
} from '../../infra/repositories/machine-payments.js'
import { RelayerBudgetExceededError } from '../../infra/relayer-spend-guard.js'
import { getTokenBalance } from '../../rails/allowance-module.js'
import { getExplorerUrl } from '../../domain/chains.js'
import {
  buildSweepAuthorization,
  signSweepExpectedContext,
  recoverSweepSigner,
  relaySweepAuthorization,
} from '../../rails/sweep.js'
import {
  isSweepableChain,
  sweepUsdcAddress,
  type SweepAuthorization,
} from '@haven_ai/sdk'
import { formatTokenAmount, parseTokenAmount } from '@haven_ai/core'
import type { AgentContext } from '../../middleware/agentAuth.js'
import type { MppHandlerResult } from './types.js'

const USDC_DECIMALS = 6

function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase())
}

function sweepResultBody(fields: {
  txHash: string
  valueAtomic: string
  from: string
  to: string
  chainId: number
  idempotent?: boolean
}) {
  return {
    tx_hash: fields.txHash,
    asset: 'USDC',
    amount: formatTokenAmount(BigInt(fields.valueAtomic), USDC_DECIMALS),
    amount_atomic: fields.valueAtomic,
    from_address: fields.from,
    to_address: fields.to,
    chain_id: fields.chainId,
    explorer_url: getExplorerUrl(fields.chainId, 'tx', fields.txHash),
    ...(fields.idempotent ? { idempotent_replay: true } : {}),
  }
}

interface DelegateSweepRow {
  id: string
  chain_id: number
  token_address: string
  from_address: string
  to_address: string
  value_atomic: string
  valid_after: string
  valid_before: string
  nonce: string
  status: string
  tx_hash: string | null
}

/**
 * `POST /sweep/prepare` — reads the delegate's stranded USDC and returns an
 * EIP-3009 `TransferWithAuthorization` (delegate → the agent's own Safe) plus
 * Haven's binding signature. The edge signer signs it; `submitSweep` relays
 * it. The delegate never needs ETH and the hosted server never holds the key.
 */
export async function prepareSweep(agent: AgentContext): Promise<MppHandlerResult> {
  // Agent auth normally rejects this state. Keep the money path fail-closed
  // as a second boundary because an account can be unlinked between auth and
  // handler execution, and never construct a transfer to a mutable fallback
  // wallet address.
  if (agent.has_bound_safe === false) {
    return {
      statusCode: 422,
      body: { error: 'Agent is no longer linked to a Haven wallet; recovery is unavailable.' },
    }
  }

  if (!isSweepableChain(agent.chain_id)) {
    return {
      statusCode: 422,
      body: { error: `Sweep is not supported on chain ${agent.chain_id}.` },
    }
  }
  if (!agent.delegate_address || !agent.safe_address) {
    return { statusCode: 422, body: { error: 'Agent is missing a delegate or Safe address.' } }
  }

  const token = sweepUsdcAddress(agent.chain_id)

  let balance: bigint
  try {
    balance = await getTokenBalance(agent.chain_id, agent.delegate_address, token)
  } catch (err) {
    return {
      statusCode: 502,
      body: {
        error: 'Failed to read delegate USDC balance',
        details: err instanceof Error ? err.message : String(err),
      },
    }
  }

  if (balance <= 0n) {
    return {
      statusCode: 200,
      body: {
        nothing_stranded: true,
        asset: 'USDC',
        chain_id: agent.chain_id,
        message: 'No stranded USDC on the delegate wallet — nothing to recover.',
      },
    }
  }

  // Sweep balance floor (#700, recalibrated #2293): recover a stranded balance
  // when it reaches SWEEP_MIN_USDC. This is a relayer-paid, gasless EIP-3009
  // transfer on Base, so the default also recovers ordinary 0.01 USDC x402
  // micropayments. A balance below the floor remains on the delegate until
  // additional stranded funds bring it up to the floor. No authorization is
  // stored below the floor, so /sweep/submit cannot relay it. Balances at or
  // above the floor (including large ones) are recovered normally.
  const minAtomic = parseTokenAmount(config.sweepMinUsdc, USDC_DECIMALS)
  if (balance < minAtomic) {
    return {
      statusCode: 200,
      body: {
        below_min: true,
        asset: 'USDC',
        amount: formatTokenAmount(balance, USDC_DECIMALS),
        amount_atomic: balance.toString(),
        min_usdc: config.sweepMinUsdc,
        chain_id: agent.chain_id,
        message:
          `Stranded balance is ${formatTokenAmount(balance, USDC_DECIMALS)} USDC, below the ` +
          `sweep floor of ${config.sweepMinUsdc} USDC — it remains on the delegate until ` +
          `additional stranded funds bring the balance to at least the floor.`,
      },
    }
  }

  const authorization = buildSweepAuthorization({
    delegateAddress: agent.delegate_address,
    safeAddress: agent.safe_address,
    chainId: agent.chain_id,
    valueAtomic: balance,
  })

  const inserted = await insertPreparedSweepForBoundAgent({
    agentId: agent.id,
    userId: agent.user_id,
    chainId: authorization.chainId,
    tokenAddress: authorization.token.toLowerCase(),
    fromAddress: authorization.from.toLowerCase(),
    toAddress: authorization.to.toLowerCase(),
    valueAtomic: authorization.value,
    validAfter: authorization.validAfter,
    validBefore: authorization.validBefore,
    nonce: authorization.nonce.toLowerCase(),
  })
  if (!inserted) {
    return {
      statusCode: 422,
      body: { error: 'Agent is no longer linked to a Haven wallet; recovery is unavailable.' },
    }
  }

  const expectedAuth = await signSweepExpectedContext(authorization)

  return {
    statusCode: 201,
    body: {
      authorization,
      expected_auth: expectedAuth,
      asset: 'USDC',
      amount: formatTokenAmount(balance, USDC_DECIMALS),
      amount_atomic: balance.toString(),
      chain_id: agent.chain_id,
      sign_instructions:
        'Sign `authorization` with the local signer tool haven_sign_sweep_delegate ' +
        '(pass authorization and expected_auth), then POST the returned signature to ' +
        '/machine-payments/sweep/submit with the same authorization.',
    },
  }
}

/**
 * `POST /sweep/submit` — relays a signed sweep authorization. Trusts nothing
 * from the client payload: the authorization is re-derived from the prepared
 * row, the delegate signature is verified off-chain, and the balance is
 * re-read before the relayer spends gas.
 */
export async function submitSweep(
  agent: AgentContext,
  nonce: string,
  signature: string,
): Promise<MppHandlerResult> {
  const row: DelegateSweepRow | null = await findSweepByNonce(nonce.toLowerCase(), agent.id)
  if (!row) {
    return {
      statusCode: 404,
      body: { error: 'No prepared sweep found for this nonce. Call /sweep/prepare first.' },
    }
  }

  // Idempotent replay: a retried submit of an already-relayed sweep returns the
  // original tx rather than relaying (and reverting) a second time.
  if (row.status === 'submitted' && row.tx_hash) {
    return {
      statusCode: 200,
      body: sweepResultBody({
        txHash: row.tx_hash,
        valueAtomic: row.value_atomic,
        from: row.from_address,
        to: row.to_address,
        chainId: row.chain_id,
        idempotent: true,
      }),
    }
  }
  if (row.status !== 'prepared') {
    return {
      statusCode: 409,
      body: { error: `Sweep is ${row.status}, expected prepared.`, status: row.status },
    }
  }
  if (Number(row.valid_before) <= Math.floor(Date.now() / 1000)) {
    await expirePreparedSweep(row.id)
    return { statusCode: 409, body: { error: 'Sweep authorization expired. Call /sweep/prepare again.' } }
  }

  // Re-derive the authorization from server state — never from the client.
  const expected: SweepAuthorization = {
    from: row.from_address,
    to: row.to_address,
    value: row.value_atomic,
    validAfter: String(row.valid_after),
    validBefore: String(row.valid_before),
    nonce: row.nonce,
    token: row.token_address,
    chainId: row.chain_id,
  }

  if (!sameAddress(expected.from, agent.delegate_address)) {
    return { statusCode: 409, body: { error: 'Prepared sweep `from` no longer matches the agent delegate.' } }
  }
  if (!sameAddress(expected.to, agent.safe_address)) {
    return { statusCode: 409, body: { error: 'Prepared sweep `to` no longer matches the agent Safe.' } }
  }

  let recovered: string
  try {
    recovered = recoverSweepSigner(expected, signature)
  } catch (err) {
    return {
      statusCode: 400,
      body: {
        error: 'Invalid signature format',
        details: err instanceof Error ? err.message : String(err),
      },
    }
  }
  if (!sameAddress(recovered, agent.delegate_address)) {
    return {
      statusCode: 403,
      body: {
        error: 'Signature does not recover the registered delegate address',
        expected: agent.delegate_address,
        recovered,
      },
    }
  }

  // Re-read balance: an exact-value transferWithAuthorization reverts if the
  // delegate no longer holds at least `value` (e.g. a concurrent payment).
  let balance: bigint
  try {
    balance = await getTokenBalance(expected.chainId, expected.from, expected.token)
  } catch (err) {
    return {
      statusCode: 502,
      body: {
        error: 'Failed to re-read delegate USDC balance',
        details: err instanceof Error ? err.message : String(err),
      },
    }
  }
  if (balance < BigInt(expected.value)) {
    return {
      statusCode: 409,
      body: {
        error: 'Delegate balance changed since prepare; re-run /sweep/prepare.',
        error_code: 'balance_changed',
        expected_atomic: expected.value,
        current_atomic: balance.toString(),
      },
    }
  }

  // Atomically claim the prepared sweep before relaying. Two concurrent submits
  // can otherwise both read 'prepared' and both broadcast — the second tx
  // reverts on the spent EIP-3009 nonce, and if its failure write lands first
  // it records a successful recovery as 'failed' and breaks replay. The loser
  // of this compare-and-swap re-reads and replays instead of relaying.
  const claim = await claimPreparedSweepForBoundAgent(
    row.id,
    agent.id,
    agent.user_id,
    agent.safe_address,
  )
  if (claim === 'not_bound') {
    return {
      statusCode: 409,
      body: { error: 'Agent is no longer linked to the prepared sweep destination.' },
    }
  }
  if (claim === 'already_claimed') {
    const current = await findSweepById(row.id)
    if (current?.status === 'submitted' && current.tx_hash) {
      return {
        statusCode: 200,
        body: sweepResultBody({
          txHash: current.tx_hash,
          valueAtomic: current.value_atomic,
          from: current.from_address,
          to: current.to_address,
          chainId: current.chain_id,
          idempotent: true,
        }),
      }
    }
    return {
      statusCode: 409,
      body: {
        error: 'Sweep is already being submitted.',
        status: current?.status ?? 'unknown',
      },
    }
  }

  let txHash: string
  try {
    ;({ txHash } = await relaySweepAuthorization(expected, signature, { agentId: agent.id, userId: agent.user_id }))
  } catch (err) {
    if (err instanceof RelayerBudgetExceededError) {
      // #717: refused before submission — release the claim back to
      // 'prepared' so the sweep can be retried after the window; 'failed'
      // would strand the funds path.
      await releaseSweepClaim(row.id)
      return { statusCode: 429, body: { error: err.message } }
    }
    const errorMsg = err instanceof Error ? err.message : String(err)
    await markSweepFailed(errorMsg, row.id)
    return { statusCode: 502, body: { error: 'Sweep relay failed', details: errorMsg } }
  }

  await markSweepSubmitted(txHash, row.id)

  // Recovering the stranded funds resolves the open stranded-funds reconciliation.
  await resolveStrandedEventsForAgent(agent.id)

  return {
    statusCode: 200,
    body: sweepResultBody({
      txHash,
      valueAtomic: expected.value,
      from: expected.from,
      to: expected.to,
      chainId: expected.chainId,
    }),
  }
}
