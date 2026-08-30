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
 *
 * EVERY option is documented here on purpose, in ONE block. #2106 added
 * `moduleEnabled` in a SECOND `@param {object} opts` block that named only the
 * new field — and TypeScript takes JSDoc as authoritative for the whole options
 * object, so documenting one property REPLACED the inferred shape instead of
 * extending it. The default kept every caller's behaviour identical while the
 * type surface silently lost `chainId`, `safeAddress`, `delegates` and `rows`;
 * two existing callers stopped compiling
 * (`e2e/agent-panel-states.visual.spec.ts`, `chain-fed-capture-guard.test.ts`).
 * Nothing local caught it: the suites were green because the runtime contract
 * was intact, and only a workspace-wide `tsc --noEmit` — what CI runs — sees a
 * narrowed shared type. So: add a property here, document it HERE, alongside
 * the others.
 *
 * @param {object} opts
 * @param {number} opts.chainId Chain the seeded Safe lives on; resolves the
 *   AllowanceModule address from the shared registry.
 * @param {readonly { safeAddress: string, delegates: readonly string[], rows: readonly { token: string, amount: bigint, spent: bigint, resetTimeMin: number, lastResetMin?: number }[], moduleEnabled?: boolean }[]} [opts.accounts]
 *   SEVERAL accounts on one chain (#2202). Every read is routed to the account
 *   it names — `isModuleEnabled` by the call's `to`, the three module reads by
 *   their first (Safe) argument — so one fixture can answer for a user who
 *   holds both a delegation-rail account and a legacy Safe, which is what
 *   `/custody` renders a card each for. Mutually exclusive with the four flat
 *   fields below, which are the single-account sugar this desugars into; pass
 *   one form or the other, never both.
 * @param {string} opts.safeAddress The Safe `isModuleEnabled` is called on.
 * @param {readonly string[]} opts.delegates Delegate addresses `getDelegates`
 *   reports.
 * @param {readonly { token: string, amount: bigint, spent: bigint, resetTimeMin: number, lastResetMin?: number }[]} opts.rows
 *   Per-token allowance rows reported for `delegates[0]`.
 *
 *   `readonly` on both array params is load-bearing, not stylistic: callers
 *   seed these as `as const` tuples (`agent-panel-states.visual.spec.ts`), and
 *   a mutable `T[]` annotation rejects a `readonly T[]` argument. Annotating
 *   them mutably reproduced this fix's own bug one layer down — inference had
 *   been permissive, and writing the type down narrowed it. A `readonly`
 *   parameter accepts both forms and this function only ever reads them.
 * @param {boolean} [opts.moduleEnabled] Whether the Safe answers
 *   `isModuleEnabled` TRUE. Defaults to true — every existing caller seeds a
 *   legacy Safe that has the module, and their captures depend on it.
 *
 *   Pass `false` to seed a **delegation-rail** account (#2106). That is not a
 *   cosmetic variant: a Hybrid DeleGator has no AllowanceModule, so `true` is
 *   a state the delegation rail cannot actually produce. Capturing `/custody`
 *   against the default photographed a delegation-rail account being told its
 *   spend control was the Safe AllowanceModule — a *different* falsehood from
 *   the one #2106 is about, which made the evidence useless for the branch it
 *   was supposed to prove. With `false`, `useOnChainAllowances` returns early
 *   and none of the other reads below is reached.
 */
export function makeAllowanceChainFixture(opts) {
  const { chainId } = opts
  const allowanceModule = getChainData(chainId).contracts.allowanceModule

  // ── One chain, possibly SEVERAL accounts (#2202) ───────────────────────────
  //
  // A user holds a set of `user_safes` rows, and since #2202 the shared
  // screenshot fixture describes two: a `delegator_hybrid` account (no
  // AllowanceModule) and the legacy Safe `agent-ops` actually lives on. Both
  // are read in ONE capture — `/custody` renders a card per account and only
  // the legacy card mounts `useOnChainAllowances` — so a fixture that can
  // answer for only one address throws on the other and the run fails with
  // "the app is reading a different contract than the fixture describes".
  //
  // The flat single-account form is unchanged and is still what every other
  // caller uses; `accounts` is the general form it desugars into.
  const accounts = (
    opts.accounts ?? [
      {
        safeAddress: opts.safeAddress,
        delegates: opts.delegates,
        rows: opts.rows,
        moduleEnabled: opts.moduleEnabled,
      },
    ]
  ).map((a) => ({ ...a, moduleEnabled: a.moduleEnabled ?? true }))

  const bySafe = new Map(accounts.map((a) => [a.safeAddress.toLowerCase(), a]))
  const seeded = accounts.map((a) => a.safeAddress).join(', ')

  /**
   * The account a read is about.
   *
   * `isModuleEnabled` is called ON the Safe, so its subject is the call's `to`.
   * The three module reads are called on the shared AllowanceModule and take
   * the Safe as their FIRST argument, so their subject is read out of the
   * calldata — the same "read it from the wire rather than assume it"
   * discipline `getTokenAllowance` already applies to its token argument, and
   * for the same reason: with two accounts, a positional assumption answers one
   * account's budget for the other and the PNG looks fine.
   */
  const accountFor = (address, readName) => {
    const account = bySafe.get((address ?? '').toLowerCase())
    if (!account) {
      throw new Error(
        `${readName} was called for Safe ${address} but this fixture seeds ${seeded} — ` +
          'the app is reading a different contract than the fixture describes',
      )
    }
    return account
  }

  /** The first `address` argument of a call, right-aligned in its 32-byte word. */
  const safeArgOf = (data) => `0x${data.slice(10).slice(24, 64)}`

  /** The reads `useOnChainAllowances` makes, by signature rather than hand-cut hex. */
  const READS = {
    isModuleEnabled: {
      signature: 'function isModuleEnabled(address) view returns (bool)',
      // `isModuleEnabled` is called ON THE SAFE; the rest on the module. `to`
      // is therefore per-account and is validated by `accountFor` instead of
      // the fixed-address check below.
      to: null,
      returns: (data, to) =>
        encodeAbiParameters(parseAbiParameters('bool'), [
          accountFor(to, 'isModuleEnabled').moduleEnabled,
        ]),
    },
    getDelegates: {
      signature: 'function getDelegates(address,uint48,uint8) view returns (address[],uint48)',
      to: allowanceModule,
      returns: (data) =>
        encodeAbiParameters(parseAbiParameters('address[], uint48'), [
          accountFor(safeArgOf(data), 'getDelegates').delegates,
          0,
        ]),
    },
    getTokens: {
      signature: 'function getTokens(address,address) view returns (address[])',
      to: allowanceModule,
      returns: (data) =>
        encodeAbiParameters(parseAbiParameters('address[]'), [
          accountFor(safeArgOf(data), 'getTokens').rows.map((r) => r.token),
        ]),
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
        // The Safe is the FIRST argument, the token the third — both read out
        // of the calldata, so neither the account nor the token can come back
        // as some other account's row (#2202).
        const { rows } = accountFor(safeArgOf(data), 'getTokenAllowance')
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
    // A `null` `to` means the read is addressed to one of the seeded SAFES
    // rather than to a single fixed contract (`isModuleEnabled`, #2202); its
    // `returns` validates the address through `accountFor` and raises the same
    // "different contract" refusal for a stranger. Everything else is pinned to
    // one address and is checked here, BEFORE any calldata is parsed — the
    // wrong-contract case must fail on the address, not on garbage arguments.
    if (read.to !== null && (to ?? '').toLowerCase() !== read.to.toLowerCase()) {
      throw new Error(
        `${read.name} was called on ${to} but this fixture seeds it on ${read.to} — ` +
          'the app is reading a different contract than the fixture describes',
      )
    }
    return read.returns(data, to)
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
