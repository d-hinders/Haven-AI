/**
 * #735 standing re-check: is the pinned Smart Sessions deployment attested by
 * the Rhinestone attester on the ERC-7484 registry yet?
 *
 * Decision (#735, 2026-07-02): registry gating stays DISABLED — verified
 * on-chain that Rhinestone has not attested Smart Sessions on any chain
 * (Base, Base Sepolia, Optimism, Arbitrum), while their OwnableValidator IS
 * attested (positive control). Compensating controls: module addresses are
 * source-pinned constants, installed only via our own provisioning payload,
 * and CI-guarded (#736 invariants 5–10).
 *
 * Run this periodically (#738 vendor-ops runbook). The day it prints ✅,
 * enable gating: flip `registryInit` in safe7579-provisioning.ts to
 * `{ registry: REGISTRY, attesters: [RHINESTONE_ATTESTER], threshold: 1 }`,
 * verify a provisioning on a fork, and ship it as its own reviewed PR.
 *
 * Run: npm run ops:check-attestation -w @haven/backend
 */

import { ethers } from 'ethers'

const REGISTRY = '0x000000000069E2a187AEFFb852bF3cCdC95151B2'
const RHINESTONE_ATTESTER = '0x000000333034E9f539ce08819E12c1b8Cb29084d'
const SMART_SESSIONS = '0x00000000008bDABA73cD9815d79069c247Eb4bDA'
// Positive control: known-attested module proving the query works.
const OWNABLE_VALIDATOR = '0x2483DA3A338895199E5e538530213157e931Bf06'

const REGISTRY_ABI = [
  'function findAttestation(address module, address attester) view returns ((uint48 time, uint48 expirationTime, uint48 revocationTime, uint32 moduleTypes, address moduleAddress, address attester, address dataPointer, bytes32 schemaUID))',
]

const CHAINS: Array<{ name: string; chainId: number; rpc: string }> = [
  { name: 'Base mainnet', chainId: 8453, rpc: process.env.RPC_URL_BASE ?? 'https://mainnet.base.org' },
  { name: 'Base Sepolia', chainId: 84532, rpc: process.env.RPC_URL_BASE_SEPOLIA ?? 'https://sepolia.base.org' },
]

interface Attestation {
  time: bigint
  revocationTime: bigint
}

async function query(rpc: string, module: string): Promise<Attestation | null> {
  const provider = new ethers.JsonRpcProvider(rpc)
  const registry = new ethers.Contract(REGISTRY, REGISTRY_ABI, provider)
  const record = await registry.findAttestation(module, RHINESTONE_ATTESTER)
  provider.destroy()
  if (record.time === 0n) return null
  return { time: record.time, revocationTime: record.revocationTime }
}

async function main(): Promise<void> {
  let anyAttested = false
  let controlOk = false

  for (const chain of CHAINS) {
    console.log(`\n── ${chain.name} (${chain.chainId}) ──`)
    try {
      const control = await query(chain.rpc, OWNABLE_VALIDATOR)
      if (control) controlOk = true
      console.log(
        `   positive control (OwnableValidator): ${control ? `attested ${new Date(Number(control.time) * 1000).toISOString().slice(0, 10)}` : 'not attested'}`,
      )
      const ss = await query(chain.rpc, SMART_SESSIONS)
      if (ss && ss.revocationTime === 0n) {
        anyAttested = true
        console.log(`   ✅ Smart Sessions ATTESTED ${new Date(Number(ss.time) * 1000).toISOString()}`)
      } else if (ss) {
        console.log(`   ⚠️ Smart Sessions attestation REVOKED at ${ss.revocationTime}`)
      } else {
        console.log('   ❌ Smart Sessions: no attestation')
      }
    } catch (err) {
      console.log(`   (query failed: ${err instanceof Error ? err.message.slice(0, 80) : err})`)
    }
  }

  console.log('')
  if (!controlOk) {
    console.log('⚠️ positive control failed everywhere — the query itself may be broken; do not conclude anything.')
    process.exit(1)
  }
  if (anyAttested) {
    console.log('🎉 Coverage appeared — time to enable registry gating. See the header of this script.')
  } else {
    console.log('status quo: no coverage — gating stays disabled (decision on #735). Re-check next ops cycle.')
  }
}

main().catch((e) => {
  console.error('check-attestation failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
