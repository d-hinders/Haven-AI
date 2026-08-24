'use client'

/**
 * Inert notice shown where a legacy Safe account's spend actions used to be
 * (#1989, epic #1440).
 *
 * The Safe / AllowanceModule rail is retired: `POST /payments`, the x402 paths
 * and the approval queue answer HTTP 410 for these accounts (#1986), and the
 * frontend surfaces that drove them — `SendModal`, `ApprovalQueue` — are
 * deleted. Reads are deliberately untouched, so this sits alongside a fully
 * rendered account: balances, tokens, agents and transaction history all still
 * load.
 *
 * It states a fact and offers no action, because there is no action here to
 * offer. The user still owns the Safe on-chain; Haven simply no longer
 * operates it. Presented in a neutral tone rather than a warning one — nothing
 * is wrong with the account and nothing is at risk.
 */
export default function RetiredRailNotice({ className = '' }: { className?: string }) {
  return (
    <div
      className={`rounded-xl border border-[var(--v2-border)] bg-[var(--v2-surface)] px-5 py-4 ${className}`.trim()}
    >
      <p className="text-sm font-semibold text-[var(--v2-ink)]">
        Haven no longer sends payments from this account.
      </p>
      <p className="mt-2 text-sm text-[var(--v2-ink-2)] leading-relaxed">
        This is an older Safe account. Its balances, agents and full transaction history stay
        available to read here, but Haven cannot send from it and agents cannot spend from it.
        You remain an owner of the Safe on-chain, so your funds are unaffected and reachable
        with your own Safe tooling.
      </p>
    </div>
  )
}
