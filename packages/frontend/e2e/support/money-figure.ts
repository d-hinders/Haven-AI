import { expect, type Locator } from '@playwright/test'

/**
 * #5105: the tile's value line renders on ONE line and FITS its track — the
 * #4400 rule ("a money figure never wraps") for a raw string the caller places
 * in a `StatTile`. The value is the tile's second paragraph.
 *
 * Two checks, because a too-wide figure fails in one of two ways depending on
 * its text. With a breakable space ("4,115.23 USDC") it wraps: the box grows
 * past one line box (its computed `line-height`). With no break opportunity —
 * the value and the unit span sit side by side with no whitespace, and Unicode
 * line breaking allows no break between a digit and a letter (UAX #14 LB23) —
 * it cannot wrap and overflows the track sideways instead, which the height
 * never shows (#2251's overflow-instead-of-fit). So the paragraph's content
 * width must not exceed its box: the `<p>` is a block in a `minmax(0,1fr)`
 * track, so its `clientWidth` is the track.
 */
export async function expectFigureOnOneLine(tile: Locator, label: string) {
  const value = tile.locator('p').nth(1)
  const box = await value.evaluate((el) => {
    const style = window.getComputedStyle(el)
    return {
      height: el.getBoundingClientRect().height,
      lineHeight: parseFloat(style.lineHeight),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      text: el.textContent,
    }
  })
  expect(
    box.height,
    `${label}: "${box.text}" wraps (${box.height}px tall, one line is ${box.lineHeight}px) — a money figure never wraps (#4400)`,
  ).toBeLessThanOrEqual(box.lineHeight * 1.5)
  expect(
    box.scrollWidth,
    `${label}: "${box.text}" overflows its track (${box.scrollWidth}px of content in ${box.clientWidth}px) — a money figure fits its track (#4400, #2251)`,
  ).toBeLessThanOrEqual(box.clientWidth)
}
