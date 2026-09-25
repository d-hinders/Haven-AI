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
 * Since #2769 it also clears a lane the bump worker has GIVEN UP on: a stuck
 * sweep, hybrid deploy, passport revoke or lane cancel whose nonce is at the
 * worker's cap (alert: `outbound-bump: nonce lane stuck after 3 replacements
 * — INCIDENT, not retrying`). Below the cap those rows are still the worker's
 * and the trigger refuses them. `ops:cancel-stuck-lane` is the same command
 * under a name that says so.
 *
 * Fail-closed: the trigger refuses anything that is not a stale, stamped,
 * still-unmined broadcast the worker will not recover (a young/slow tx, an
 * already-mined one, a row already cancelled, a rebroadcast-safe row still
 * below the bump cap). Triggering twice is safe — the second run is refused. Both race
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

/** What happens to the payload whose nonce was burned, by who owned it. */
const AFTERMATH =
  'A passport_attest: if the cancel mines, the sweep re-anchors on its own (#1745); if the attest wins the race ' +
  'instead, its receipt recovery closes on the original anchor (#1043). A sweep, deploy or revoke: its owner ' +
  'retries on a fresh record — a revoke by the next reconcile, a deploy at the next activation or erc7710 ' +
  'authorize, a sweep only when the agent sweeps again (its funds stay visible as stranded until then). '

/** The lane was already at the bump cap, so nothing will re-send the cancel (#2769). */
const CAPPED_CANCEL = (cancelRowId: string): string =>
  'This lane was already at the bump cap, so the bump worker will NOT re-send the cancel. If it has not mined ' +
  `after 3 minutes (the stale threshold), re-run this command with the cancel row's id: ${cancelRowId}.`

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
          AFTERMATH +
          (result.workerResends
            ? 'The bump worker owns the cancel row from here (fee-replaces it if it sticks, closes it from the receipt).'
            : CAPPED_CANCEL(result.cancelRowId)),
      )
      return 0
    case 'cancel_stamped_send_unconfirmed':
      console.log(
        `CANCEL STAMPED at nonce ${result.nonce} (outbound row ${result.cancelRowId}) but the send call errored: ${result.detail}\n` +
          'The error is ambiguous (the node may have accepted the transaction), so the row is left broadcast. ' +
          (result.workerResends
            ? 'The bump worker owns it: it re-broadcasts the stored calldata with bumped fees until a receipt closes it. ' +
              'Watch the worker logs; nothing further to run by hand.'
            : CAPPED_CANCEL(result.cancelRowId)),
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
