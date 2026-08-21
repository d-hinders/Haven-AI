/**
 * Hybrid DeleGator provisioning (#825, epic #821 Phase 1).
 *
 * Computes the COUNTERFACTUAL account address for a new Hybrid DeleGator —
 * no transaction, no deployment: the address is deterministic from the
 * owner configuration. Actual deployment happens at grant activation
 * (ensureHybridDeployed, #860): a delegation's EIP-1271 signature needs
 * deployed code, and the relayer's factory call is permissionless — no
 * owner signature, no owner transaction.
 *
 * Non-custody: address derivation uses a WATCH-ONLY owner (the session-rail
 * pattern) — this module can never sign anything, loudly (#824 invariant 5).
 *
 * Two owner configurations (the Hybrid account's native shapes):
 * - EOA owner:      deployParams [ownerAddress, [], [], []]
 * - Passkey owner:  deployParams [zeroAddress, [keyId], [x], [y]] — pure P256;
 *   both may be combined (EOA + N passkeys) which #836 (recovery) will use.
 */

import { http, createPublicClient, zeroAddress, type Address, type LocalAccount } from 'viem'
import { KEYED_LOCK_NAMESPACES, withKeyedAdvisoryLock } from '../platform/leader-lock.js'
import { toAccount } from 'viem/accounts'
import { Implementation, toMetaMaskSmartAccount } from '@metamask/smart-accounts-kit'
import { getChain } from '../domain/chains.js'

import { getDelegationContracts, chainForId } from './delegation-contracts.js'

export interface PasskeySigner {
  /** WebAuthn credential id (hex or base64url-derived hex, per the kit). */
  keyId: string
  /** P256 public key coordinates as 0x-hex. */
  x: bigint
  y: bigint
}

export interface HybridOwnerConfig {
  /** EOA owner — omit for a pure-passkey account. */
  ownerAddress?: Address
  /** P256/passkey signers — omit for a pure-EOA account. */
  passkeys?: PasskeySigner[]
}

function watchOnly(address: Address): LocalAccount {
  const refuse = async (): Promise<never> => {
    throw new Error('non-custody: provisioning is watch-only and cannot sign')
  }
  return toAccount({
    address,
    signMessage: refuse,
    signTransaction: refuse,
    signTypedData: refuse,
  })
}

async function buildWatchOnlyAccount(chainId: number, owner: HybridOwnerConfig) {
  getDelegationContracts(chainId) // fail-closed on unpinned chains

  const eoa = owner.ownerAddress ?? zeroAddress
  const passkeys = owner.passkeys ?? []
  if (eoa === zeroAddress && passkeys.length === 0) {
    throw new Error('hybrid provisioning: at least one owner (EOA or passkey) is required')
  }

  const client = createPublicClient({
    chain: chainForId(chainId),
    transport: http(getChain(chainId).rpcUrl),
  })
  const account = await toMetaMaskSmartAccount({
    client: client as never, // two viem instances in the type graph — runtime-identical
    implementation: Implementation.Hybrid,
    deployParams: [
      eoa,
      passkeys.map((p) => p.keyId),
      passkeys.map((p) => p.x),
      passkeys.map((p) => p.y),
    ],
    deploySalt: '0x',
    signer: { account: watchOnly(eoa === zeroAddress ? '0x0000000000000000000000000000000000000001' : eoa) },
  })
  return { account, client }
}

/**
 * The deterministic account address for an owner configuration. Read-only:
 * one RPC to derive via the pinned factory. Throws on a chain without pinned
 * delegation contracts (fail-closed, #825).
 */
export async function computeHybridAccountAddress(
  chainId: number,
  owner: HybridOwnerConfig,
): Promise<Address> {
  const { account } = await buildWatchOnlyAccount(chainId, owner)
  return account.address
}

/**
 * How long the deploy waits for its own receipt before handing the
 * transaction off to the bump worker (#1722).
 *
 * Derived from the two things that actually constrain it, not picked round:
 *
 * - FLOOR — what a healthy deploy takes. The delegation rail runs on Base and
 *   Base Sepolia, whose blocks are 2 s, and this waits ONE confirmation of a
 *   single factory call broadcast with `getRelayerFeeOverrides`' doubled fee
 *   headroom. That is one to a few blocks; 120 s is ~60 blocks of slack, so a
 *   healthy deploy never reaches the deadline and no ordinary caller sees a
 *   behaviour change.
 * - CEILING — where the transaction stops being this caller's problem.
 *   `STALE_BROADCAST_SECONDS` (180 s, `infra/outbound-bump-worker.ts`) is the
 *   age at which the bump worker's unmined scan adopts a `broadcast` row and
 *   starts replacing it with bumped fees. Waiting past that would leave this
 *   caller waiting on a transaction another owner may already have replaced.
 *   120 s < 180 s, so the request has released its advisory lock — and with
 *   it its pooled connection — before the worker can take over.
 *
 * The same bracket-between-the-two-bounds reasoning fixes the passport
 * anchor's wait at 120 s against its 600 s claim window
 * (`modules/passport/attestation.ts`); the shared value is a coincidence of
 * two independent derivations, not a copied constant.
 */
export const HYBRID_DEPLOY_CONFIRM_TIMEOUT_MS = 120_000

/**
 * The deploy was broadcast but not confirmed within
 * {@link HYBRID_DEPLOY_CONFIRM_TIMEOUT_MS} (#1722).
 *
 * Deliberately distinct from a revert: nothing failed, the transaction may
 * still mine, and its durable outbound record is intentionally left in
 * `broadcast` for the bump worker (#1558) to adopt. Callers surface it as a
 * retryable 502, exactly as they already do for any other deploy error.
 */
export class HybridDeployUnconfirmedError extends Error {
  constructor(
    readonly txHash: string,
    timeoutMs: number,
  ) {
    super(
      `hybrid deploy not confirmed within ${timeoutMs}ms (${txHash}) — ` +
        'the transaction may still mine; its outbound record is left for the bump worker',
    )
    this.name = 'HybridDeployUnconfirmedError'
  }
}

/** ethers v6 rejects a timed-out `wait()` with `code: 'TIMEOUT'`. */
function isWaitTimeout(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'TIMEOUT'
}

export interface EnsureDeployedResult {
  address: Address
  alreadyDeployed: boolean
  txHash?: string
}

/**
 * Deploy the counterfactual Hybrid if it has no code yet (#860).
 *
 * A 4337 factory deploy is PERMISSIONLESS — it instantiates the account with
 * the owner configuration baked into the deterministic address and grants the
 * deployer nothing. Haven's relayer therefore deploys the delegator account
 * without any owner signature, preserving the grant flow's one-signature UX.
 * This must happen before the first redemption: the DelegationManager
 * validates the delegator's delegation signature via EIP-1271, which reverts
 * against an account with no code (found live by the #835 DoD).
 *
 * Non-custody unchanged: the relayer signs a plain transaction to the audited
 * factory; the deployed account's signers are the owner's keys, never Haven's.
 */
export async function ensureHybridDeployed(
  chainId: number,
  owner: HybridOwnerConfig,
  /**
   * The account's KNOWN address, when the caller has one (#891 fix). Checked
   * FIRST: a deployed account short-circuits before any derivation — the
   * signer set may have evolved since provisioning (addKey/removeKey, #888),
   * in which case deriving from the CURRENT set would derive a different,
   * wrong address and deploy a spurious account.
   */
  expectedAddress?: Address,
  /** #717: who this deploy is billed to (relayer gas budget + attribution). */
  attribution?: { agentId?: string | null; userId?: string | null },
): Promise<EnsureDeployedResult> {
  if (expectedAddress) {
    const client = createPublicClient({
      chain: chainForId(chainId),
      transport: http(getChain(chainId).rpcUrl),
    })
    const existing = await client.getBytecode({ address: expectedAddress })
    if (existing && existing !== '0x') {
      return { address: expectedAddress, alreadyDeployed: true }
    }
  }
  const { account, client } = await buildWatchOnlyAccount(chainId, owner)

  // #1673: everything from the bytecode check to the mined receipt runs under
  // a per-(chain, address) advisory lock, so two concurrent first payments
  // from a brand-new agent cannot both pass the check and both broadcast a
  // deploy to the same CREATE2 address. Before #1667 this was reachable only
  // from grant activation — effectively once per account, serialised by the
  // UI — but every erc7710 authorize now calls it, and two different
  // merchants mean two different idempotency keys, so the #961 replay dedupe
  // does not apply.
  //
  // The lock spans a chain round-trip, which is the trade: it holds one
  // pooled connection for the deploy's duration. That is acceptable BECAUSE
  // of how rare it is — an account is deployed once, ever, so this path runs
  // at most once per account in the system's lifetime.
  //
  // Nothing here is fund safety. A 4337 factory deploy is permissionless and
  // grants the deployer nothing; the loser of the race merely burns a second
  // relayer gas spend and can record a spurious failure. So the lock is
  // fail-open by construction (see withKeyedAdvisoryLock): if it cannot be
  // acquired, this degrades to exactly the pre-#1673 behaviour.
  return withKeyedAdvisoryLock(
    KEYED_LOCK_NAMESPACES.accountDeploy,
    `${chainId}:${account.address.toLowerCase()}`,
    () => deployIfStillMissing(chainId, account, client, attribution),
  )
}

/**
 * The check-then-act half of `ensureHybridDeployed`, run under the lock.
 *
 * The bytecode read here is the SECOND check — the one that matters. A caller
 * that queued behind the winner arrives after the winner's deploy is mined,
 * sees code, and returns `alreadyDeployed` instead of broadcasting a
 * duplicate. Reading before the lock would answer the question at the moment
 * it was still racing.
 */
async function deployIfStillMissing(
  chainId: number,
  account: Awaited<ReturnType<typeof buildWatchOnlyAccount>>['account'],
  client: Awaited<ReturnType<typeof buildWatchOnlyAccount>>['client'],
  attribution?: { agentId?: string | null; userId?: string | null },
): Promise<EnsureDeployedResult> {
  const code = await client.getBytecode({ address: account.address })
  if (code && code !== '0x') {
    return { address: account.address, alreadyDeployed: true }
  }

  const { factory, factoryData } = await account.getFactoryArgs()
  if (!factory || !factoryData) {
    throw new Error('hybrid provisioning: account reports no factory args to deploy with')
  }

  // #717: budget check BEFORE the relayer signs — over-cap throws (429 at
  // the route); lazy import keeps the pure derivation path free of db wiring.
  const { assertRelayerBudget, recordRelayerSpend, finishRelayerSpend } = await import('../infra/relayer-spend-guard.js')
  await assertRelayerBudget('hybrid_deploy', attribution ?? {})
  // Attempt row before broadcast: bursts see each other, and the row exists
  // even when tx.wait() throws on a reverted deploy (ethers v6).
  const spendId = await recordRelayerSpend({
    operation: 'hybrid_deploy',
    chainId,
    agentId: attribution?.agentId,
    userId: attribution?.userId,
  })

  // Lazy import: the relayer wiring pulls ethers + env config; keep the pure
  // derivation path (compute…) free of it for tests and scripts.
  const { getRelayer, getRelayerFeeOverrides } = await import('../infra/relayer.js')
  const relayer = getRelayer(chainId)
  if (!relayer.provider) {
    throw new Error('hybrid provisioning: relayer has no provider')
  }
  // #1556: durable record opened BEFORE the broadcast — a crash between here
  // and the send leaves a queued row the bump worker (#1558) can adopt. The
  // record carries the exact factory calldata a bump would re-broadcast.
  const { openOutboundRecord, submitRecorded } = await import('../infra/outbound-queue.js')
  const record = await openOutboundRecord({
    chainId,
    submitter: 'hybrid_deploy',
    to: factory,
    data: factoryData,
  })
  // #1559: sign → stamp → broadcast; the stamp inside submitRecorded is the
  // durable record and the fence. The deploy keeps its doubled fee headroom.
  const overrides = await getRelayerFeeOverrides(relayer.provider)
  const tx = await submitRecorded({
    chainId,
    recordId: record.id,
    to: factory,
    data: factoryData,
    ...overrides,
  })
  let receipt
  let waitError: unknown
  try {
    // #1722: BOUNDED. `wait()` called bare waits forever in ethers v6, and
    // this call sits inside the #1673 advisory-lock critical section — so the
    // pooled-connection hold inherited that unboundedness, and the #1686
    // accept ("a chain round-trip, seconds") rested on nothing.
    receipt = await tx.wait(1, HYBRID_DEPLOY_CONFIRM_TIMEOUT_MS)
  } catch (err) {
    // ethers v6 throws out of wait() on a mined-and-reverted tx — this catch,
    // not the status check below, is where a real revert closes the record
    // (#1556 review; same reason the spend-guard stamp sits in a finally).
    // Since #1722 it also catches the deadline (`code: 'TIMEOUT'`), which is
    // NOT a revert and must not be treated as one — see below.
    waitError = err
  } finally {
    // Stamp the hash whatever happened — a reverting deploy burned gas too,
    // and ethers v6 throws out of wait() on revert.
    await finishRelayerSpend(spendId, {
      txHash: tx.hash,
      gasUsed: receipt ? BigInt(receipt.gasUsed.toString()) : null,
      effectiveGasPrice: receipt?.gasPrice != null ? BigInt(receipt.gasPrice.toString()) : null,
    })
  }
  // NO RECEIPT IS NOT A REVERT (#1722). A wait timeout cancels nothing — the
  // transaction stays in the mempool and may still mine — and #690 records
  // that a lagging RPC can hand back a null receipt for a tx that confirmed.
  // Both mean "not observed", so the record is left in `broadcast`, which is
  // exactly the state the bump worker's unmined scan adopts (`hybrid_deploy`
  // is on its rebroadcast-safe list, `infra/outbound-bump-worker.ts`).
  // Marking it failed here would strand the tx between two owners and make a
  // later-mined deploy look wrong. The caller still gets a retryable 502; a
  // retry is safe because the deploy is permissionless, relayer-paid and
  // idempotent on-chain — a duplicate costs gas and nothing else.
  if (!receipt && (!waitError || isWaitTimeout(waitError))) {
    throw new HybridDeployUnconfirmedError(tx.hash, HYBRID_DEPLOY_CONFIRM_TIMEOUT_MS)
  }
  if (waitError || !receipt || receipt.status !== 1) {
    await record.failed(`hybrid deploy transaction reverted (${tx.hash})`)
    if (waitError) throw waitError
    throw new Error(`hybrid deploy transaction reverted (${tx.hash})`)
  }
  await record.mined()
  return { address: account.address, alreadyDeployed: false, txHash: tx.hash }
}
