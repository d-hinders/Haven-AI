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
 * ⚠️ **The second paragraph is branched on owner type, and that is not a
 * nicety.** The first version of this component told every legacy account
 * "you remain an owner of the Safe on-chain, so your funds are ... reachable
 * with your own Safe tooling". `haven-reviewer` caught that it contradicted
 * `docs/product/account-recovery.md` and `CLAUDE.md` **in the same pull
 * request**: for a Safe whose only owner is a Haven passkey, that sentence is
 * false. Haven's passkey Safe signer is a custom WebAuthn scheme that
 * app.safe.global cannot drive, and #1989 deleted the only screen that composed
 * a transfer — so there is currently no self-serve exit for that owner, and
 * telling them there is would send them to an interface that cannot help.
 *
 * `unknown` is a real state and must stay one: while the owner set is still
 * loading, or if the read failed, the notice claims nothing about how to reach
 * the funds. Guessing wrong is worse in both directions here.
 *
 * Presented in a neutral tone rather than a warning one — nothing is wrong with
 * the account and nothing is at risk — and it offers no action, because there
 * is no action here to offer.
 */
export type RetiredRailOwnerAccess = 'wallet' | 'passkey-only' | 'unknown'

export default function RetiredRailNotice({
  ownerAccess = 'unknown',
  className = '',
}: {
  ownerAccess?: RetiredRailOwnerAccess
  className?: string
}) {
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
      </p>
      {ownerAccess === 'wallet' ? (
        <p className="mt-2 text-sm text-[var(--v2-ink-2)] leading-relaxed">
          Your funds are unaffected. This Safe has a wallet owner, so you can move them at any time
          from Safe&apos;s own interface with that wallet — independently of Haven.
        </p>
      ) : ownerAccess === 'passkey-only' ? (
        <p className="mt-2 text-sm text-[var(--v2-ink-2)] leading-relaxed">
          Your funds are unaffected on-chain, but this Safe&apos;s only owner is a Haven passkey,
          and there is currently no self-serve way to move them out — your passkey cannot sign at
          Safe&apos;s own interface. Contact Haven before sending anything else here.
        </p>
      ) : null}
    </div>
  )
}
