/**
 * The AllowanceModule chain fixture — one factory, three consumers.
 *
 * Extracted from `screenshot.mjs` (#1930) rather than copied. The
 * visual-regression spec `e2e/agent-panel-states.visual.spec.ts` needs the same
 * answers to reach `UnmanagedDelegateCard`, and it cannot import
 * `screenshot.mjs`: Playwright transpiles a statically-imported module to CJS,
 * and a runtime import of the CLI trips over `evidence-viewports.mjs` being
 * loaded twice under two different module systems. A second hand-written
 * encoder was the alternative and is the worse one — a wrong encoding here is
 * swallowed by `useOnChainAllowances` into an empty map and renders as a
 * plausible EMPTY card, so two copies would drift silently and photogenically.
 *
 * Nothing about the behaviour changed in the move. This module deliberately
 * imports only `viem`, `viem/chains` and `@haven_ai/core`, so it can be loaded
 * from Node, from vitest, and from a Playwright worker without dragging the
 * harness in behind it.
 */
import { decodeAbiParameters, encodeAbiParameters, parseAbiParameters, toFunctionSelector } from 'viem'
import { base as viemBase, baseSepolia as viemBaseSepolia } from 'viem/chains'
import { getChainData } from '@haven_ai/core'

// ── The AllowanceModule chain fixture (#1935, generalised by #1971) ──────────
//
// `useOnChainAllowances` is the harness's only render-time chain read, and it
// feeds four surfaces (AgentPanel via useAgentPanelState, AgentDetailClient,
// EditAgentModal, and the unmanaged-delegate discovery inside AgentPanel). This
// factory answers the exact reads that hook makes, for ONE (chain, safe,
// delegates, rows) tuple, so the shared fixture and a scenario-local one are the
// same code with different data rather than two fixtures that can drift.
//
// ── Why the shared fixture needed one at all (#1971) ─────────────────────────
//
// Until #1971 the shared fixture's chain (84532) had no wagmi transport:
// `lib/wagmi.ts` registered only `base`, `@wagmi/core`'s `getClient` caught
// `ChainNotConfiguredError` and returned `undefined`, and the hook returned at
// its first line. ZERO JSON-RPC requests left the browser in a screenshot run,
// so every one of those four surfaces was captured in its empty branch — and
// because nothing threw, the PNGs looked fine. #1971 fixed the transport in
// `lib/wagmi.ts` (the app OFFERS 84532; it was never the fixture that was
// wrong), which means those reads now really happen. They must not reach a
// public node — a capture whose data came off the live internet is not
// deterministic evidence — so the harness answers them for every scenario,
// not only for one that opts in.
const MULTICALL3_AGGREGATE3 = toFunctionSelector(
  'function aggregate3((address target, bool allowFailure, bytes callData)[]) returns ((bool success, bytes returnData)[])',
)
// Canonical across every chain Haven serves — ASSERTED rather than assumed,
// because a wrong `to` here would be answered as if it were right, and the
// factory below serves two chains from this one constant.
const MULTICALL3_ADDRESS = viemBase.contracts.multicall3.address
if (
  viemBaseSepolia.contracts.multicall3.address.toLowerCase() !==
  MULTICALL3_ADDRESS.toLowerCase()
) {
  throw new Error(
    'screenshot fixture: Multicall3 is not at the same address on Base and Base Sepolia ' +
      `(${MULTICALL3_ADDRESS} vs ${viemBaseSepolia.contracts.multicall3.address}) — ` +
      'makeAllowanceChainFixture assumes one address for every chain it serves',
  )
}

/**
 * A deterministic block, parameterised by timestamp.
 *
 * `useOnChainAllowances` reads `block.timestamp` alongside the allowances so the
 * reset math keys off chain time rather than the device clock, so this has to be
 * a real-shaped block or viem's formatter throws before the allowances are ever
 * mapped.
 */
function fixtureBlock(timestampSec) {
  return {
    number: '0x1122334',
    hash: `0x${'11'.repeat(32)}`,
    parentHash: `0x${'22'.repeat(32)}`,
    nonce: '0x0000000000000000',
    sha3Uncles: `0x${'33'.repeat(32)}`,
    logsBloom: `0x${'00'.repeat(256)}`,
    transactionsRoot: `0x${'44'.repeat(32)}`,
    stateRoot: `0x${'55'.repeat(32)}`,
    receiptsRoot: `0x${'66'.repeat(32)}`,
    miner: '0x4200000000000000000000000000000000000011',
    difficulty: '0x0',
    totalDifficulty: '0x0',
    extraData: '0x',
    size: '0x220',
    gasLimit: '0x3938700',
    gasUsed: '0x0',
    timestamp: `0x${timestampSec.toString(16)}`,
    baseFeePerGas: '0x1',
    transactions: [],
    uncles: [],
  }
}

export const FIXTURE_BLOCK_TIMESTAMP = Math.floor(Date.parse('2026-07-10T09:00:00.000Z') / 1000)

/**
 * Build a `scenario.chain`-shaped answer function for one Safe's AllowanceModule.
 *
 * `rows` are the budgets the module reports for `delegates[0]`; amounts are
 * atomic and `resetTimeMin` must match a RESET_PERIODS entry so the row reads
 * "Daily" rather than a raw "1440m" fallthrough. `lastResetMin` is optional and
 * defaults to 0 — see the note at `getTokenAllowance` for what that decides.
 */
export function makeAllowanceChainFixture({ chainId, safeAddress, delegates, rows }) {
  const allowanceModule = getChainData(chainId).contracts.allowanceModule

  /** The reads `useOnChainAllowances` makes, by signature rather than hand-cut hex. */
  const READS = {
    isModuleEnabled: {
      signature: 'function isModuleEnabled(address) view returns (bool)',
      // `isModuleEnabled` is called ON THE SAFE; the rest on the module.
      to: safeAddress,
      returns: () => encodeAbiParameters(parseAbiParameters('bool'), [true]),
    },
    getDelegates: {
      signature: 'function getDelegates(address,uint48,uint8) view returns (address[],uint48)',
      to: allowanceModule,
      returns: () =>
        encodeAbiParameters(parseAbiParameters('address[], uint48'), [delegates, 0]),
    },
    getTokens: {
      signature: 'function getTokens(address,address) view returns (address[])',
      to: allowanceModule,
      returns: () =>
        encodeAbiParameters(parseAbiParameters('address[]'), [rows.map((r) => r.token)]),
    },
    // Native-balance read on Multicall3 itself (#2073). A scenario with a
    // `connectedWallet` mounts RainbowKit against a live wagmi connection,
    // and RainbowKit batch-reads the connected address's native balance
    // through `getEthBalance` — four aggregate3 members per dashboard mount.
    // Unseeded, those throw the loud "unseeded call" error below and fail the
    // run even though no capture renders the number. Zero, deterministically,
    // for ANY queried address: the fixture wallet holds nothing.
    getEthBalance: {
      signature: 'function getEthBalance(address) view returns (uint256)',
      to: MULTICALL3_ADDRESS,
      returns: () => encodeAbiParameters(parseAbiParameters('uint256'), [0n]),
    },
    getTokenAllowance: {
      signature: 'function getTokenAllowance(address,address,address) view returns (uint256[5])',
      to: allowanceModule,
      // The token is the THIRD argument, and it is read out of the calldata
      // rather than assumed, so two rows cannot come back identical — which is
      // exactly the silent duplicate a positional fixture would produce.
      returns: (data) => {
        const token = `0x${data.slice(10).slice(64 * 2 + 24, 64 * 3)}`
        const row = rows.find((r) => r.token.toLowerCase() === token.toLowerCase())
        if (!row) throw new Error(`getTokenAllowance for an unseeded token ${token}`)
        // Slot 3 is `lastResetMin`, and it decides whether the UI shows a
        // SPENT allowance or a reset-pending one — `computeEffectiveAllowance`
        // zeroes effective spend once `currentMin - lastResetMin >=
        // resetTimeMin` (`lib/allowance-math.ts:60-71`). It defaults to 0,
        // which is unboundedly far in the past and therefore ALWAYS
        // reset-pending: every existing consumer renders a full, unfilled bar,
        // and that is the behaviour they were captured against, so the default
        // is left alone. A row that wants to photograph a PARTIALLY SPENT bar
        // — the fill colour against its container, which a full bar cannot
        // show — sets `lastResetMin` inside the current period instead
        // (#1930, design review).
        return encodeAbiParameters(parseAbiParameters('uint256[5]'), [
          [row.amount, row.spent, BigInt(row.resetTimeMin), BigInt(row.lastResetMin ?? 0), 1n],
        ])
      },
    },
  }

  const SELECTORS = new Map(
    Object.entries(READS).map(([name, read]) => [
      toFunctionSelector(read.signature),
      { name, ...read },
    ]),
  )

  const block = fixtureBlock(FIXTURE_BLOCK_TIMESTAMP)

  /** One un-batched contract read — also the body of each `aggregate3` member. */
  function answerEthCall(to, data) {
    const read = SELECTORS.get(data.slice(0, 10))
    if (!read) return undefined
    if ((to ?? '').toLowerCase() !== read.to.toLowerCase()) {
      throw new Error(
        `${read.name} was called on ${to} but this fixture seeds it on ${read.to} — ` +
          'the app is reading a different contract than the fixture describes',
      )
    }
    return read.returns(data)
  }

  /**
   * Answer the app's own on-chain reads.
   *
   * Dispatches on the 4-byte selector AND checks the call's `to` — a selector
   * collision or a read aimed at some other contract must fail loudly rather
   * than be handed a plausible answer for the wrong address. Anything not
   * listed returns `undefined`, which the seam records as a gap and fails the
   * run on (see `CHAIN_READ_GAPS`): a fixture that quietly declines a read
   * produces a surface with no budget rows, which is a photogenic wrong answer.
   */
  return function answerChain(method, params) {
    if (method === 'eth_chainId') return `0x${chainId.toString(16)}`
    if (method === 'eth_blockNumber') return block.number
    if (method === 'eth_getBlockByNumber') return block
    if (method !== 'eth_call') return undefined

    const call = params?.[0] ?? {}
    const data = call.data ?? call.input ?? '0x'

    // MULTICALL, because that is what the app actually sends (#1935).
    //
    // Found by running this, not by reading it: wagmi enables viem's multicall
    // batching by default, so `useOnChainAllowances`' reads never reach the wire
    // as bare `eth_call`s to the AllowanceModule — every one of them is wrapped
    // in Multicall3's `aggregate3`, with the real call as `bytes` inside it. A
    // fixture that answered only the un-batched shape is served nothing, and
    // because the hook swallows the failure into an empty map it would produce a
    // surface with no budget list and no error on screen.
    //
    // MEASURED, because the obvious summary of that is wrong (review of #1935).
    // "The four reads arrive as one `eth_call`" is what batching sounds like; it
    // is not what this hook can produce. `useOnChainAllowances` is sequential —
    // it awaits `isModuleEnabled` before `getDelegates` is queued, and awaits
    // `getTokens` before the `getTokenAllowance`s are — and viem's batcher can
    // only merge calls queued inside the same wait window. Logged live, one
    // fetch cycle is FOUR aggregate3 POSTs plus one bare block read:
    //
    //   aggregate3[1] 0x2d9ad53d  isModuleEnabled
    //   eth_getBlockByNumber      (not wrapped — not a contract read)
    //   aggregate3[1] 0xeb37abe0  getDelegates
    //   aggregate3[1] 0x8d0e8e1d  getTokens
    //   aggregate3[2] 0x94b31fbd  getTokenAllowance x2  <- the only real batch
    //
    // So the thing a fixture must handle is not "one big batch": it is that a
    // LONE read is wrapped too. The direct branch below is kept as a fallback
    // rather than deleted, because it costs one line and the day someone
    // disables multicall this is the difference between a fixture that still
    // works and a silent empty list.
    if (
      data.slice(0, 10) === MULTICALL3_AGGREGATE3 &&
      (call.to ?? '').toLowerCase() === MULTICALL3_ADDRESS.toLowerCase()
    ) {
      const [inner] = decodeAbiParameters(
        parseAbiParameters('(address target, bool allowFailure, bytes callData)[]'),
        `0x${data.slice(10)}`,
      )
      const results = inner.map((c) => {
        const answer = answerEthCall(c.target, c.callData)
        if (answer === undefined) {
          throw new Error(
            `aggregate3 carried an unseeded call to ${c.target} (${c.callData.slice(0, 10)})`,
          )
        }
        return { success: true, returnData: answer }
      })
      return encodeAbiParameters(
        parseAbiParameters('(bool success, bytes returnData)[]'),
        [results],
      )
    }

    return answerEthCall(call.to, data)
  }
}
