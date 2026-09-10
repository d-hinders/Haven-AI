/**
 * The opaque strip that sits behind the iOS status bar, above a page's top bar
 * (#2819).
 *
 * ## Why this exists rather than `pt-[var(--v2-safe-top)]` on the bar itself
 *
 * #2730 gave every top bar its safe-area clearance as padding on the bar, which
 * is the obvious shape and was wrong in one specific way: those bars carry
 * `backdrop-blur`, so the padding put the status-bar band *inside* a
 * `backdrop-filter` layer. #2819 replaced that shape at all five sites — this
 * component is the replacement, and no bar should reintroduce the padding. On the installed iOS shell that band was observed
 * keeping the nav scrim's grey after the drawer closed, while the bar's own
 * hairline below it drew correctly (#2819).
 *
 * The mechanism is a hypothesis — the symptom needs a standalone shell with
 * non-zero insets and no engine in CI has one — but the class is avoidable
 * without settling it: give the band its own element, outside anything
 * filtered. Then no composited blur layer spans the status bar and nothing
 * there can hold a stale frame, whatever the precise cause.
 *
 * It is also the better rendering on its own terms. The band behind a status
 * bar wants to be opaque; blur is for content scrolling *under* a bar, and
 * nothing scrolls under the status bar.
 *
 * ## Using it
 *
 * Put it as the first child of the bar's outermost element, with the blurred
 * bar as its sibling — never inside the blurred element, which is the shape it
 * exists to replace:
 *
 * ```tsx
 * <header className="relative z-[var(--v2-z-chrome)]">
 *   <SafeAreaBand />
 *   <div className="h-14 border-b bg-bg/85 backdrop-blur-md">…</div>
 * </header>
 * ```
 *
 * `--v2-safe-top` is 0 on anything without a notch, so this collapses to a
 * zero-height box on every desktop and in every gate — it moves no baseline.
 *
 * `bg-bg`, not `bg-[var(--v2-bg)]`: same colour, but the channel-token pipeline
 * (#1818), so a future `/N` opacity modifier compiles instead of silently
 * dropping the whole declaration. Both halves of the chrome are then on one
 * pipeline.
 *
 * `className` overrides the background for a bar that is not on `--v2-bg`;
 * `bg-transparent` lets a coloured ancestor show through, which is what the
 * marketing header's dark-section state needs. It must not be used to add a
 * filter — that would reintroduce the defect.
 */
export function SafeAreaBand({ className = '' }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      data-safe-area-band=""
      className={`h-[var(--v2-safe-top)] bg-bg ${className}`}
    />
  )
}
