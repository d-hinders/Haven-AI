import { FrameControl } from '../ProductFrame'
import { SITE_TYPE } from '../SiteSection'
import styles from './motion.module.css'

/**
 * Step 1's mini card (mockup `index.html:144`): the passkey prompt. It lives
 * inside a decorative frame-like mini card; its control is a `FrameControl`
 * span, never a button.
 *
 * The component owns the card's markup and nothing else (#3575): slice 3's
 * `AnimatedPasskeyMiniCard` drives the mockup's 12 s script by passing
 * `state`; with no state it renders the settled card below, byte-for-byte
 * what slice 2 shipped.
 */
export type PasskeyCardState = {
  /** The scan ring on the face (mockup `index.html:278`). */
  scanning?: boolean
  /** Completed: green face, saved note, the "Account created" confirmation (:279). */
  done?: boolean
}

export function PasskeyMiniCard({ state }: { state?: PasskeyCardState } = {}) {
  const done = state?.done ?? false
  const scanning = (state?.scanning ?? false) && !done
  return (
    <div className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] p-3.5 text-[13px] shadow-card">
      <div className="grid gap-2.5 py-1.5 text-center">
        <div
          aria-hidden
          className={`relative mx-auto grid h-11 w-11 place-items-center rounded-xl ${
            done ? styles.done : 'bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]'
          } ${scanning ? styles.scanRing : ''}`}
        >
          {done ? (
            <CheckGlyph />
          ) : (
            <svg
              aria-hidden
              focusable="false"
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4" />
              <path d="M14 13.12c0 2.38 0 6.38-1 8.88" />
              <path d="M17.29 21.02c.12-.6.43-2.3.5-3.02" />
              <path d="M2 12a10 10 0 0 1 18-6" />
              <path d="M2 16h.01" />
              <path d="M21.8 16c.2-2 .131-5.354 0-6" />
              <path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2" />
              <path d="M8.65 22c.21-.66.45-1.32.57-2" />
              <path d="M9 6.8a6 6 0 0 1 9 5.2v2" />
            </svg>
          )}
        </div>
        <b className="text-[14px] text-[var(--v2-ink)]">
          {done ? 'Account created' : 'Create your passkey'}
        </b>
        <span className="block min-h-[2.6em] text-[12px] text-[var(--v2-ink-3)]">
          {done ? 'Passkey saved on this device.' : 'Face ID or Touch ID. You stay in control of the account.'}
        </span>
        <span className="inline-flex min-h-[36px] items-center justify-end">
          {done ? (
            <Confirmation text="Account created" />
          ) : (
            <FrameControl variant="primary">Continue</FrameControl>
          )}
        </span>
      </div>
    </div>
  )
}

/**
 * Step 2's mini card (mockup `index.html:150-154`): the budget form, settled
 * at 250.00 USDC / Monthly / Any merchant — the fixture budget the frames use.
 *
 * Slice 3's `AnimatedBudgetMiniCard` passes `state` to run the mockup's
 * typing progression inside a cycle; with no state the card is settled.
 */
export type BudgetCardState = {
  /** waiting = cycle running, before the type step; then typing/signing/approved. */
  phase?: 'waiting' | 'typing' | 'signing' | 'approved'
  /** The live typed amount during `typing` ("25", "250.0", …). */
  typedAmount?: string
}

export function BudgetMiniCard({ state }: { state?: BudgetCardState } = {}) {
  const phase = state?.phase
  const typing = phase === 'typing'
  const typed = state?.typedAmount ?? ''
  const caret = typing && typed.length < '250.00'.length
  // Settled (no state): the fixture 250.00, slice 2's pinned state. Inside a
  // cycle the mockup's progression: 0.00 until the type step (:280's start),
  // the typed value during it, 250.00 once typed.
  const preType = phase === 'waiting'

  return (
    <div className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] p-3.5 text-[13px] shadow-card">
      <div className="grid grid-cols-[1.4fr_1fr] gap-2.5">
        <div>
          <label className="mb-1 block text-[11.5px] text-[var(--v2-ink-3)]">Budget</label>
          <div className="flex items-center justify-between rounded-md border border-[var(--v2-border-strong)] bg-[var(--v2-bg)] px-2.5 py-[7px]">
            <span className={`${SITE_TYPE.mono} ${caret ? styles.typing : ''}`}>
              {typing ? typed : preType ? '0.00' : '250.00'}
            </span>
            <span className="text-[var(--v2-ink-3)]">USDC</span>
          </div>
        </div>
        <div>
          <label className="mb-1 block text-[11.5px] text-[var(--v2-ink-3)]">Resets</label>
          <div className="flex items-center justify-between rounded-md border border-[var(--v2-border-strong)] bg-[var(--v2-bg)] px-2.5 py-[7px]">
            <span>Monthly</span>
            <span aria-hidden className="text-[var(--v2-ink-3)]">
              ▾
            </span>
          </div>
        </div>
      </div>
      <div className="pt-2.5">
        <label className="mb-1 block text-[11.5px] text-[var(--v2-ink-3)]">Recipient</label>
        <div className="flex items-center justify-between rounded-md border border-[var(--v2-border-strong)] bg-[var(--v2-bg)] px-2.5 py-[7px]">
          <span>Any merchant</span>
          <span aria-hidden className="text-[var(--v2-ink-3)]">
            ▾
          </span>
        </div>
      </div>
      <div className="flex justify-end pt-3">
        <span className="inline-flex min-h-[36px] items-center">
          {phase === 'approved' ? (
            <Confirmation text="Budget approved" />
          ) : phase === 'signing' ? (
            <FrameControl variant="primary">Signing…</FrameControl>
          ) : (
            <FrameControl variant="primary">Approve budget</FrameControl>
          )}
        </span>
      </div>
    </div>
  )
}

/**
 * The completion pattern both animated cards end on: TEXT with a check icon
 * in the success colour — never a pill, never a button (the mockup's
 * `.confirm`, site.css:346; `index.html:273`).
 */
export function Confirmation({ text }: { text: string }) {
  return (
    <span className={styles.confirm} data-testid="confirmation">
      <CheckGlyph small />
      {text}
    </span>
  )
}

/** The check icon, drawn at the mockup's two sizes (:270-271). */
export function CheckGlyph({ small = false }: { small?: boolean }) {
  return (
    <svg
      aria-hidden
      focusable="false"
      width={small ? 14 : 22}
      height={small ? 14 : 22}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={small ? 2.4 : 2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  )
}
