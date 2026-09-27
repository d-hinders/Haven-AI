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
 * Lives here (compiled by the ordinary `tsc` build into `dist/ops/`) rather
 * than in `scripts/` so it is runnable in the deployed Railway container,
 * which copies only `dist/` and installs with `--omit=dev` — neither
 * `scripts/` nor `tsx` exist there (2026-09-26 incident: the owner had to
 * `railway ssh` and paste a `node --input-type=module -e '...'` one-liner).
 * `scripts/cancel-stuck-attest-lane.ts` is now a thin wrapper around
 * {@link runCli} for local/dev callers who still invoke it through `tsx`.
 *
 *   npm run ops:cancel-stuck-attest -w packages/backend -- <outbound-row-id>
 *   npm run ops:cancel-stuck-lane -w packages/backend -- <outbound-row-id>
 *
 * In the deployed container (WORKDIR /app, dist already copied), the same
 * thing runs with no npm script and no scripts/ or tsx dependency:
 *
 *   node packages/backend/dist/ops/cancel-stuck-lane.js <outbound-row-id>
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
 * 1 = refused, errored (nothing reached the chain) or bad usage.
 *
 * ## Usage before config
 *
 * `../config.ts` throws on import if a required env var is missing, so
 * argument validation (including printing usage) happens BEFORE anything
 * that transitively imports it — `infra/outbound-lane-cancel.ts` reaches
 * `infra/relayer.ts`, which does. That import is therefore dynamic, deferred
 * until after a valid row id is on the command line: `node
 * dist/ops/cancel-stuck-lane.js` with no argument prints usage and exits 1
 * with no DATABASE_URL, JWT_SECRET, etc. required.
 *
 * ## Row id only, deliberately
 *
 * A `--nonce <n> --chain <id>` alternative to pasting the row's UUID was
 * considered (operators trigger this from a phone, off the alert text) but
 * dropped: doing it fail-closed means a NEW repository query — "exactly one
 * live `broadcast` row at this (chain_id, nonce), else refuse" — and
 * `infra/repositories/outbound-txs.ts` is out of this change's ownership.
 * Reported to the captain rather than added silently; the row id the alert
 * already prints is one copy-paste away.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const USAGE =
  'usage: npm run ops:cancel-stuck-attest -w packages/backend -- <outbound_txs row id (uuid)>\n' +
  '   or: npm run ops:cancel-stuck-lane -w packages/backend -- <outbound_txs row id (uuid)>\n' +
  '   or (deployed container): node packages/backend/dist/ops/cancel-stuck-lane.js <outbound_txs row id (uuid)>'

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

/**
 * The whole operation, argv in — usage-checked before any config-dependent
 * import happens. Exported (rather than folded into {@link runCli}) so a
 * future test can exercise it without going through `process.exit`.
 */
export async function main(argv: string[]): Promise<number> {
  const id = argv[0]
  if (!id || !UUID_RE.test(id)) {
    console.error(USAGE)
    return 1
  }

  // Deferred until a valid row id is in hand: this reaches infra/relayer.ts,
  // which reaches ../config.ts, which throws on a missing required env var.
  const { cancelStuckOutboundLane, productionLaneCancelDeps } = await import('../infra/outbound-lane-cancel.js')

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

/**
 * The CLI entry point, guarded so importing this module (a test, or any
 * future caller) never runs it — only a direct `node .../cancel-stuck-lane.js`
 * invocation does, via the `import.meta.url` check at the bottom of this file.
 *
 * `process.exit(code)` below terminates immediately, open pg pool connections
 * included — there is no separate pool-teardown step to await first. This
 * process runs exactly one command and exits; nothing else shares its pool.
 * (An explicit `getPool().end()` would need a dynamic `import('../db.js')`
 * from `ops/`, which `lint:deps`' `pg-only-in-infra` rule refuses and whose
 * waiver comment its parser cannot recognize on a dynamic import — reported
 * to the captain rather than routed around.)
 */
export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  try {
    const code = await main(argv)
    process.exit(code)
  } catch (err) {
    console.error('cancel-stuck-lane failed:', err instanceof Error ? err.message : err)
    process.exit(1)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void runCli()
}
