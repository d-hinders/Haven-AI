import { expect, type Locator } from '@playwright/test'

/**
 * #5105: the tile's value line renders on ONE line — the #4400 rule ("a money
 * figure never wraps") for a raw string the caller places in a `StatTile`. The
 * value is the tile's second paragraph; one line is a height of at most one
 * line box (its computed `line-height`), with a little slack for rounding.
 */
export async function expectFigureOnOneLine(tile: Locator, label: string) {
  const value = tile.locator('p').nth(1)
  const box = await value.evaluate((el) => {
    const style = window.getComputedStyle(el)
    return { height: el.getBoundingClientRect().height, lineHeight: parseFloat(style.lineHeight), text: el.textContent }
  })
  expect(
    box.height,
    `${label}: "${box.text}" wraps (${box.height}px tall, one line is ${box.lineHeight}px) — a money figure never wraps (#4400)`,
  ).toBeLessThanOrEqual(box.lineHeight * 1.5)
}
