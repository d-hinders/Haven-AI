/**
 * #1743 operator action: cancel a stuck non-idempotent outbound broadcast
 * (in practice: a stuck `passport_attest`) by burning its nonce with a
 * 0-value relayer self-send — THROUGH the outbound pipeline, replacing the
 * hand-run cancel `docs/operations/delegation-rail-vendor-ops.md` §3 used to
 * prescribe. The hand-run version's hazards (typo'd nonce, wrong chain, wrong
 * wallet, no `outbound_txs` record for the guards to see) all disappear: the
 * nonce, chain and wallet come from the stuck row itself, and the cancel gets
 * a durable record the bump worker reconciles like any other broadcast.
 *
 *   npm run ops:cancel-stuck-attest -w packages/backend -- <outbound-row-id>
 *
 * The row id is in the worker's alert:
 *   outbound-bump: stuck broadcast from a non-idempotent submitter — NOT replacing it …
 *
 * Fail-closed: the trigger refuses anything that is not a stale, stamped,
 * still-unmined broadcast from a non-rebroadcast-safe submitter (a young/slow
 * tx, an already-mined one, a row already cancelled, a worker-owned
 * submitter). Triggering twice is safe — the second run is refused. Both race
 * outcomes after a successful trigger resolve automatically (see
 * `infra/outbound-lane-cancel.ts`); there is nothing further to run by hand.
 *
 * Requires the ordinary backend env (DATABASE_URL, relayer key + RPC for the
 * row's chain). exit 0 = recovery in motion (cancel broadcast, or stamped
 * with the bump worker owning the send) or closed from the receipt ·
 * 1 = refused or errored (nothing reached the chain).
 */
import { cancelStuckOutboundLane, productionLaneCancelDeps } from '../src/infra/outbound-lane-cancel.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function main(): Promise<number> {
  const id = process.argv[2]
  if (!id || !UUID_RE.test(id)) {
    console.error('usage: npm run ops:cancel-stuck-attest -w packages/backend -- <outbound_txs row id (uuid)>')
    return 1
  }
  const deps = await productionLaneCancelDeps()
  const result = await cancelStuckOutboundLane(id, deps)
  switch (result.outcome) {
    case 'cancel_broadcast':
      console.log(
        `CANCEL BROADCAST at nonce ${result.nonce} (tx ${result.txHash}, outbound row ${result.cancelRowId}).\n` +
          'Nothing further to do: if the cancel mines, the sweep re-anchors on its own (#1745); ' +
          'if the original attest wins the race instead, its receipt recovery closes on the original anchor (#1043). ' +
          'The bump worker owns the cancel row from here (fee-replaces it if it sticks, closes it from the receipt).',
      )
      return 0
    case 'cancel_stamped_send_unconfirmed':
      console.log(
        `CANCEL STAMPED at nonce ${result.nonce} (outbound row ${result.cancelRowId}) but the send call errored: ${result.detail}\n` +
          'The error is ambiguous (the node may have accepted the transaction), so the row is left broadcast and ' +
          'the bump worker owns it: it re-broadcasts the stored calldata with bumped fees until a receipt closes it. ' +
          'Watch the worker logs; nothing further to run by hand.',
      )
      return 0
    case 'closed_mined':
      console.log(`Row ${result.rowId} had already MINED — closed from the receipt; the lane is free, no cancel needed.`)
      return 0
    case 'closed_reverted':
      console.log(`Row ${result.rowId} mined and REVERTED — closed; the lane is free, no cancel needed.`)
      return 0
    case 'refused':
      console.error(`REFUSED (${result.code}): ${result.detail}`)
      return 1
  }
}

async function closePool(): Promise<void> {
  try {
    const { getPool } = await import('../src/db.js')
    await getPool().end()
  } catch {
    // Never let pool teardown mask the outcome.
  }
}

main()
  .then(async (code) => {
    await closePool()
    process.exit(code)
  })
  .catch(async (err) => {
    console.error('cancel-stuck-attest-lane failed:', err instanceof Error ? err.message : err)
    await closePool()
    process.exit(1)
  })
