'use client'

import { useEffect, useRef, useState } from 'react'
import {
  HERO_BUDGET_CAP,
  HERO_CYCLE_MS,
  HERO_PAYMENT,
  useCycle,
  useDocumentVisible,
  useInView,
  usePrefersReducedMotion,
  useTween,
  type CycleStep,
} from './motion'
import { HeroAgentsFrame, type HeroActivityRow, type HeroFrameState } from './HeroAgentsFrame'

/**
 * The hero frame's payment loop — the mockup's own 19 s script
 * (`docs/product/site-mockup/index.html:81-118`) as a client controller
 * (#3575). It owns only the loop's state; `HeroAgentsFrame` owns the frame
 * markup and renders slice 2's settled state whenever this controller passes
 * no state.
 *
 * Offsets, verbatim from the script (`cycle()` at :103-118):
 *
 * - 3000 ms — a payment appears as pending (`row('pending')`, :105) and
 *   pushes the oldest row out; it is dropped 420 ms later (`insert()`, :94-97).
 * - 5200 ms — it settles; the used amount tweens 201.50 → 214.00 over 900 ms
 *   and the bar jumps to the target (`tween(BASE, BASE+PAY, 900)`, :106-109).
 * - 6800 ms — the row gains its "In Fortnox" accounting badge (:111).
 * - 11000 ms — an over-budget attempt is refused: "Refused: over budget ·
 *   36.00 left, nothing paid" — the amount it asked for (:112, :91).
 * - 11000+420 ms — the row it displaced finishes leaving and is dropped, so
 *   the list shows three rows throughout, as the mockup's does.
 * - 17500/18100 ms — the list fades out and the settled baseline returns
 *   (:113-114); at 19000 the cycle restarts (:115).
 *
 * Under reduced motion, before the loop starts, and while the frame is out
 * of view or the tab hidden, no state is passed and the settled frame renders
 * exactly — the mockup's script bails on the same media query (:83). The
 * frame is decorative: the hero section wraps it in `aria-hidden`.
 */

/** How many activity rows the list shows at any moment (`rows.length>3`, :96). */
const VISIBLE_ROWS = 3

/** The three settled activity rows (mockup `index.html:60-74`). */
const BASE_ROWS: HeroActivityRow[] = [
  {
    key: 'base-1',
    icon: 'up',
    title: 'Atlas',
    detail: 'Paid data.example over x402',
    badge: 'fortnox',
    amount: '−6.20 USDC',
    when: '1 h ago',
  },
  {
    key: 'base-2',
    icon: 'up',
    title: 'Iris',
    detail: 'Paid Klara Data AB over x402',
    badge: 'fortnox',
    amount: '−5.00 USDC',
    when: '1 d ago',
  },
  {
    key: 'base-3',
    icon: 'up',
    title: 'Atlas',
    detail: 'Paid api.example over x402',
    badge: 'fortnox',
    amount: '−8.25 USDC',
    when: '2 d ago',
  },
]

export function AnimatedHeroFrame() {
  const reduced = usePrefersReducedMotion()
  const visible = useDocumentVisible()
  const { ref, inView } = useInView<HTMLDivElement>()
  const looping = !reduced && visible && inView

  const [pendingInserted, setPendingInserted] = useState(false)
  const [settled, setSettled] = useState(false)
  const [badged, setBadged] = useState(false)
  const [refused, setRefused] = useState(false)
  const [droppedKeys, setDroppedKeys] = useState<string[]>([])
  const [fading, setFading] = useState(false)

  const reset = () => {
    setPendingInserted(false)
    setSettled(false)
    setBadged(false)
    setRefused(false)
    setDroppedKeys([])
    setFading(false)
  }

  const steps: CycleStep[] = [
    { at: 3000, act: () => setPendingInserted(true) },
    { at: 5200, act: () => setSettled(true) },
    { at: 6800, act: () => setBadged(true) },
    { at: 11000, act: () => setRefused(true) },
    { at: 17500, act: () => setFading(true) },
    { at: 18100, act: reset },
  ]

  useCycle(steps, HERO_CYCLE_MS, looping, reset)
  const tween = useTween(201.5, 201.5 + HERO_PAYMENT, 900, settled)

  const ordered: HeroActivityRow[] = []
  if (refused) {
    ordered.push({
      key: 'refusal',
      icon: 'refused',
      title: 'Atlas',
      detail: `Refused: over budget · ${(HERO_BUDGET_CAP - 201.5 - HERO_PAYMENT).toFixed(2)} left, nothing paid`,
      badge: null,
      amount: '40.00 USDC',
      when: 'just now',
      entering: true,
    })
  }
  if (pendingInserted) {
    ordered.push({
      key: 'pending',
      icon: settled ? 'up' : 'pending',
      title: 'Atlas',
      detail: settled ? 'Paid research.example over x402' : 'Paying research.example over x402',
      // The mockup replaces the whole detail line at the settle step (:108),
      // taking the Pending pill with it; the Fortnox badge lands at :111.
      badge: badged ? 'fortnox' : settled ? null : 'pending',
      badgeEntering: badged,
      amount: `−${HERO_PAYMENT.toFixed(2)} USDC`,
      when: 'just now',
      entering: !settled,
    })
  }
  ordered.push(...BASE_ROWS)

  // The list always shows three rows: each insert pushes the last one out
  // (`insert()`, :96 — `rows.length>3` leaves on every insert). The row just
  // displaced shrinks away while the new one grows in (the frame's `grow` /
  // `shrink` pair), so the list's height never changes, and it is dropped
  // 420 ms later; anything further down is already gone.
  const displaced = ordered[VISIBLE_ROWS]
  const rows: HeroActivityRow[] = ordered.slice(0, VISIBLE_ROWS)
  if (displaced && !droppedKeys.includes(displaced.key)) {
    rows.push({ ...displaced, leaving: true })
  }

  // The timer rides the fake clocks like every other step.
  const displacedKey = displaced?.key
  useEffect(() => {
    if (!displacedKey) return
    const timer = setTimeout(() => setDroppedKeys((keys) => [...keys, displacedKey]), 420)
    return () => clearTimeout(timer)
  }, [displacedKey])

  const state: HeroFrameState | undefined = !looping
    ? undefined
    : {
        atlasUsed: settled ? tween.toFixed(2) : '201.50',
        atlasPercent: settled ? String(Math.round((tween / HERO_BUDGET_CAP) * 100)) : '81',
        atlasBarPercent: settled ? ((201.5 + HERO_PAYMENT) / HERO_BUDGET_CAP) * 100 : 81,
        rows,
        fading,
      }

  return (
    <div ref={ref} data-testid="hero-animated">
      <HeroAgentsFrame state={state} />
    </div>
  )
}
