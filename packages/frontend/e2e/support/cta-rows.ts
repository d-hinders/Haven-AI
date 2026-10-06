import { expect, type Page } from '@playwright/test'

/**
 * Every CTA row's buttons span the row on a phone (#3685): below `sm` the row
 * is a column (`SiteCtaRow`) and flex's default `align-items: stretch` widens
 * each child, whatever button component it holds — so each link's width
 * equals its row's within 1px. Desktop runs skip the assertion: side by side
 * the buttons keep their natural widths, which is right. Baselines alone
 * would not catch a regression here (visual regression is advisory on `dev`).
 */
export async function expectCtaRowsFillColumn(page: Page): Promise<void> {
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.sm\\:flex-wrap')))
  expect(rows.length, 'CTA rows to be present (the .sm\\:flex-wrap rows)').toBeGreaterThan(0)

  const mismatches = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('.sm\\:flex-wrap')).flatMap((row) => {
      const rowWidth = row.getBoundingClientRect().width
      return Array.from(row.querySelectorAll<HTMLElement>('a, button'))
        .filter((el) => el.offsetParent !== null)
        .map((el) => ({
          label: (el.textContent ?? '').trim(),
          width: el.getBoundingClientRect().width,
          rowWidth,
        }))
        .filter((m) => Math.abs(m.width - m.rowWidth) > 1)
    }),
  )
  expect(
    mismatches,
    'each CTA link to span its stacked row (within 1px of the row width)',
  ).toEqual([])
}
