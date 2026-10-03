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
 * - 3000 ms — a payment appears as pending (`row('pending')`, :105).
 * - 5200 ms — it settles; the used amount tweens 201.50 → 214.00 over 900 ms
 *   and the bar jumps to the target (`tween(BASE, BASE+PAY, 900)`, :106-109).
 * - 6800 ms — the row gains its "In Fortnox" accounting badge (:111).
 * - 11000 ms — an over-budget attempt is refused: "Refused: over budget ·
 *   36.00 left, nothing paid" — the amount it asked for (:112, :91).
 * - 11000+420 ms — the row it displaced finishes leaving and is dropped
 *   (`insert()`'s 420 ms removal, :94-97).
 * - 17500/18100 ms — the list fades out and the settled baseline returns
 *   (:113-114); at 19000 the cycle restarts (:115).
 *
 * Under reduced motion, before the loop starts, and while the frame is out
 * of view or the tab hidden, no state is passed and the settled frame renders
 * exactly — the mockup's script bails on the same media query (:83). The
 * frame is decorative: the hero section wraps it in `aria-hidden`.
 */

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
  const [leavingKeys, setLeavingKeys] = useState<string[]>([])
  const [dropped, setDropped] = useState(false)
  const [fading, setFading] = useState(false)

  const reset = () => {
    setPendingInserted(false)
    setSettled(false)
    setBadged(false)
    setRefused(false)
    setLeavingKeys([])
    setDropped(false)
    setFading(false)
  }

  const steps: CycleStep[] = [
    { at: 3000, act: () => setPendingInserted(true) },
    { at: 5200, act: () => setSettled(true) },
    { at: 6800, act: () => setBadged(true) },
    {
      at: 11000,
      act: () => {
        setRefused(true)
        // The displaced row starts its exit (`insert()`, :96).
        setLeavingKeys(['base-3'])
      },
    },
    { at: 17500, act: () => setFading(true) },
    { at: 18100, act: reset },
  ]

  useCycle(steps, HERO_CYCLE_MS, looping, reset)
  const tween = useTween(201.5, 201.5 + HERO_PAYMENT, 900, settled)

  // The leaving row is dropped 420 ms after it starts leaving (:96). The
  // timer rides the fake clocks like every other step.
  useEffect(() => {
    if (leavingKeys.length === 0) return
    const timer = setTimeout(() => setDropped(true), 420)
    return () => clearTimeout(timer)
  }, [leavingKeys])

  const rows: HeroActivityRow[] = []
  if (refused) {
    rows.push({
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
    rows.push({
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
  rows.push(
    ...BASE_ROWS.filter((row) => !(dropped && leavingKeys.includes(row.key))).map((row) => ({
      ...row,
      leaving: leavingKeys.includes(row.key),
    })),
  )

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
