/**
 * #971 operator step: register the L0 Agent Passport schema on EAS.
 *
 * This is the one part of #971 that cannot ship in a PR — registering a schema
 * is an on-chain transaction needing a funded key, and the resulting UID does
 * not exist until it lands. Everything else (the schema definition, the address
 * binding, the fail-closed config) is code and is already merged; this script
 * turns it into a live schema and prints the UID to record.
 *
 * FAIL-CLOSED ON THE PINS. The EAS addresses in `modules/passport/schema.ts` are the
 * standard OP-Stack predeploys Base inherits, but they were pinned WITHOUT an
 * on-chain check (no RPC egress where the file was written). This script proves
 * them before it will send anything:
 *
 *   1. both EAS contracts have bytecode on the target chain, and
 *   2. SchemaRegistry answers a read (`getSchema` on the zero UID) — i.e. it is
 *      really a SchemaRegistry and not merely some contract at that address.
 *
 * Only then does it register. A dry run does 1 and 2 and stops, so the pins can
 * be verified by anyone with an RPC URL and no key and no gas.
 *
 *   npm run ops:register-passport-schema -w packages/backend             # dry run
 *   npm run ops:register-passport-schema -w packages/backend -- --send   # register
 *
 * Requires RPC_URL_BASE_SEPOLIA. Sending additionally requires
 * PASSPORT_SCHEMA_REGISTRAR_KEY — a throwaway testnet key, NEVER the relayer
 * key: schema registration is a public, permissionless, one-off act and has no
 * business borrowing a key that moves value.
 *
 * exit 0 = verified (and registered, with --send) · 1 = a pin or a call failed.
 */

// Imported from `schema.js` DIRECTLY, not from the module's `index.js` barrel,
// and that is deliberate — see the "runnable with nothing but an RPC URL" note
// above. The barrel re-exports issuance/revocation/verification/x402-delivery,
// which reach `db.js` → `config.ts`, whose `requireEnv('DATABASE_URL')` runs at
// IMPORT time. Going through it made this probe die before its first line, so
// the one property it was built to have — verify contract pins with no
// database — was lost to an import path.
//
// This is a deliberate exception to module-boundaries rule 6 ("callers import
// from the barrel, never a private file"). That rule is about application code,
// where a barrel keeps the module's surface honest. An ops probe has the
// opposite requirement: it must load as little as possible. `schema.ts` is
// pure — its only import is `import type { Address } from 'viem'`, erased at
// compile time — so this reaches no I/O.
import {
  PASSPORT_SCHEMA,
  PASSPORT_SCHEMA_REVOCABLE,
  PASSPORT_CHAIN_IDS,
  getEasDeployment,
} from '../src/modules/passport/schema.js'

const SEND = process.argv.includes('--send')

/**
 * RPC URL per chain, read straight from env.
 *
 * Deliberately NOT via `domain/chains.js`: that pulls in `config.ts`, which
 * `requireEnv`s DATABASE_URL at import time — so verifying contract pins would
 * have needed a running Postgres. An ops probe must stay runnable with nothing
 * but an RPC URL. Defaults match config.ts's.
 */
const RPC_ENV: Record<number, { key: string; fallback: string }> = {
  84532: { key: 'RPC_URL_BASE_SEPOLIA', fallback: 'https://sepolia.base.org' },
}

function rpcUrlFor(chainId: number): string {
  const entry = RPC_ENV[chainId]
  if (!entry) throw new Error(`no RPC env mapping for chain ${chainId}`)
  return process.env[entry.key] || entry.fallback
}

async function rpc<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  })
  const body = (await response.json()) as { result?: T; error?: { message: string } }
  if (body.error) throw new Error(`${method}: ${body.error.message}`)
  return body.result as T
}

/**
 * Distinguish "no code at this address" from "the RPC never answered".
 *
 * Collapsing the two would tell an operator behind a broken RPC that the pins
 * are WRONG — the most alarming possible message, for a network problem. A
 * verification tool that cannot tell those apart is worse than none.
 */
type CodeProbe = { ok: true; hasCode: boolean } | { ok: false; error: string }

async function probeCode(rpcUrl: string, address: string): Promise<CodeProbe> {
  try {
    const code = await rpc<string>(rpcUrl, 'eth_getCode', [address, 'latest'])
    return { ok: true, hasCode: typeof code === 'string' && code.length > 2 }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * `getSchema(bytes32)` on the zero UID. A real SchemaRegistry returns an
 * (empty) record; a contract that is not one reverts or returns nothing. This
 * is what upgrades "there is code here" into "this is the right contract".
 */
async function answersAsSchemaRegistry(rpcUrl: string, registry: string): Promise<boolean> {
  const selector = '0xa2ea7c6e' // getSchema(bytes32)
  try {
    const out = await rpc<string>(rpcUrl, 'eth_call', [
      { to: registry, data: selector + '00'.repeat(32) },
      'latest',
    ])
    return typeof out === 'string' && out.length > 2
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  let failures = 0

  for (const chainId of PASSPORT_CHAIN_IDS) {
    const rpcUrl = rpcUrlFor(chainId)
    const eas = getEasDeployment(chainId)
    console.log(`\nchain ${chainId} — ${rpcUrl}`)

    let unreachable = false
    for (const [label, address] of [
      ['SchemaRegistry', eas.schemaRegistry],
      ['EAS', eas.eas],
    ] as const) {
      const probe = await probeCode(rpcUrl, address)
      if (!probe.ok) {
        console.log(`  ? ${label.padEnd(15)} ${address} RPC UNREACHABLE — ${probe.error}`)
        unreachable = true
        continue
      }
      console.log(
        `  ${probe.hasCode ? '✓' : '✗'} ${label.padEnd(15)} ${address} ` +
          `${probe.hasCode ? 'has code' : 'NO CODE'}`,
      )
      if (!probe.hasCode) failures++
    }

    if (unreachable) {
      console.error(
        `\n? could not reach ${rpcUrl} — pins NOT verified (this says nothing about ` +
          `whether they are correct).\n  Set RPC_URL_BASE_SEPOLIA to a reachable endpoint and re-run.`,
      )
      process.exit(1)
    }

    const isRegistry = await answersAsSchemaRegistry(rpcUrl, eas.schemaRegistry)
    console.log(`  ${isRegistry ? '✓' : '✗'} SchemaRegistry answers getSchema(bytes32)`)
    if (!isRegistry) failures++

    if (failures > 0) {
      console.error(
        '\n✗ pin verification FAILED against a reachable RPC — the pinned addresses are wrong ' +
          'for this chain.\n  Refusing to register. Fix modules/passport/schema.ts first.',
      )
      process.exit(1)
    }

    console.log(`\n  schema:    ${PASSPORT_SCHEMA}`)
    console.log(`  revocable: ${PASSPORT_SCHEMA_REVOCABLE}`)
    console.log(`  resolver:  none (0x0) — L0 needs no resolver hook`)

    if (!SEND) {
      console.log(
        '\n✓ pins verified. Dry run — nothing sent.\n' +
          '  Re-run with --send (and PASSPORT_SCHEMA_REGISTRAR_KEY set) to register,\n' +
          `  then record the UID as AGENT_PASSPORT_SCHEMA_UID_${chainId}.`,
      )
      continue
    }

    const key = process.env.PASSPORT_SCHEMA_REGISTRAR_KEY
    if (!key) {
      console.error(
        '\n✗ --send requires PASSPORT_SCHEMA_REGISTRAR_KEY (a throwaway testnet key).\n' +
          '  Do NOT reuse RELAYER_PRIVATE_KEY — this is a one-off public registration.',
      )
      process.exit(1)
    }

    const { createWalletClient, createPublicClient, http, encodeFunctionData, zeroAddress } =
      await import('viem')
    const { privateKeyToAccount } = await import('viem/accounts')
    const { baseSepolia } = await import('viem/chains')
    const VIEM_CHAINS: Record<number, typeof baseSepolia> = { 84532: baseSepolia }

    const account = privateKeyToAccount(key.startsWith('0x') ? (key as `0x${string}`) : `0x${key}`)
    const chain = VIEM_CHAINS[chainId]
    if (!chain) throw new Error(`no viem chain for ${chainId}`)
    const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) })
    const pub = createPublicClient({ chain, transport: http(rpcUrl) })

    console.log(`\n  registrar: ${account.address}`)
    const data = encodeFunctionData({
      abi: [
        {
          name: 'register',
          type: 'function',
          stateMutability: 'nonpayable',
          inputs: [
            { name: 'schema', type: 'string' },
            { name: 'resolver', type: 'address' },
            { name: 'revocable', type: 'bool' },
          ],
          outputs: [{ name: '', type: 'bytes32' }],
        },
      ],
      functionName: 'register',
      args: [PASSPORT_SCHEMA, zeroAddress, PASSPORT_SCHEMA_REVOCABLE],
    })

    const hash = await wallet.sendTransaction({ to: eas.schemaRegistry, data })
    console.log(`  tx: ${hash}`)
    const receipt = await pub.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') {
      console.error('✗ registration reverted')
      process.exit(1)
    }
    // The Registered event's first topic after the signature is the schema UID.
    const uid = receipt.logs[0]?.topics?.[1]
    console.log(`\n✓ registered on chain ${chainId}`)
    console.log(`  UID: ${uid}`)
    console.log(`\n  Record it:  AGENT_PASSPORT_SCHEMA_UID_${chainId}=${uid}`)
    console.log(`  Explorer:   https://base-sepolia.easscan.org/schema/view/${uid}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
