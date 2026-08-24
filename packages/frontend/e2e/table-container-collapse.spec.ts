/**
 * The `Table` primitive's column collapse is keyed on the table's CONTAINER,
 * not on the viewport (#1999).
 *
 * WHY THIS SPEC EXISTS AND WHY IT RESIZES THE CONTAINER.
 *
 * Every other guard in this suite drives the viewport. On this app shell that
 * cannot tell a container query from a viewport query, because container width
 * is a (discontinuous) function of viewport width and the two thresholds were
 * deliberately chosen to coincide:
 *
 *     viewport   390   767   768   900   1023  1024  1279  1280
 *     container  340   717   718   850   973   718   973   974
 *
 * Two things step at `lg` and both take width — `Sidebar.tsx` goes `fixed` ->
 * `lg:static` at `w-[240px]` (border-box: `main` measures 784px at a 1024px
 * viewport, so the 1px `border-r` is inside the 240) and the authenticated
 * layout's `main` steps `p-6` -> `lg:p-8`. 240 + 16 = 256px handed back at
 * once, so the content available to a table is a SAWTOOTH and a table is
 * exactly as cramped at 1024px as at 768px (#1827).
 *
 * So a viewport-driven assertion would pass identically against the OLD
 * `hidden md:table-cell` implementation — it would prove the old thing. The
 * assertions below therefore hold the viewport FIXED and resize the query
 * container itself. That is the only shape of test that can fail if this is
 * re-keyed back onto the viewport, and it is the shape that was
 * mutation-proven.
 */
import { expect, test } from '@playwright/test'
import { mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'

/**
 * Anchor on the TRANSACTION table, never on `querySelector('table')`.
 * `/design-system` renders the z-index token table earlier in the document,
 * and it is a `scrollable` table with no query container at all — a probe
 * that takes the first `<table>` measures that one and reports a confident
 * wrong answer. Trap 1 from `transaction-row.mobile.spec.ts`, one level up.
 */
function transactionTable(): HTMLTableElement | null {
  return (
    Array.from(document.querySelectorAll('table')).find(
      (t) => t.getClientRects().length > 0 && t.querySelector('tbody tr p[title]') !== null,
    ) ?? null
  )
}

type Shape = {
  /** Header labels that are actually laid out, in DOM order. */
  columns: string[]
  /** Cells laid out in the first body row. The body half of the same decision. */
  bodyCells: number
  /** The query container's own width, so a reading can be tied to its cause. */
  containerWidth: number
}

/**
 * Read BOTH halves. Headers alone would be satisfied by `Table.Head`
 * collapsing wholesale (it does, below the `md` stage — an empty header list
 * is the correct answer there and would make a header-only assertion
 * vacuous). Body cells alone would not see a header/body split. #1774 is the
 * standing proof that reading one half proves nothing about the other.
 */
async function readShape(page: import('@playwright/test').Page): Promise<Shape> {
  return page.evaluate(() => {
    const visible = (el: Element) => el.getClientRects().length > 0
    const table = Array.from(document.querySelectorAll('table')).find(
      (t) => t.getClientRects().length > 0 && t.querySelector('tbody tr p[title]') !== null,
    )
    if (!table) return { columns: ['NO TABLE'], bodyCells: -1, containerWidth: -1 }
    const headRow = table.querySelector('thead tr')
    const columns = headRow
      ? Array.from(headRow.children)
          .filter(visible)
          .map((th) => (th.textContent ?? '').trim().replace(/\s+/g, ' ') || '·')
      : []
    const bodyRow = Array.from(table.querySelectorAll('tbody tr')).find(visible)
    const bodyCells = bodyRow ? Array.from(bodyRow.children).filter(visible).length : -1
    const container = table.parentElement
    return {
      columns,
      bodyCells,
      containerWidth: container ? +container.getBoundingClientRect().width.toFixed(1) : -1,
    }
  })
}

/**
 * Set the query container's own width. The container is the `div` the `Table`
 * primitive wraps its `<table>` in; an explicit width on it is what
 * `container-type: inline-size` resolves against, so this changes the answer
 * to the query and nothing else — the viewport, the sidebar and `main` all
 * stay exactly where they were.
 */
async function setContainerWidth(page: import('@playwright/test').Page, px: number) {
  await page.evaluate((width) => {
    const table = Array.from(document.querySelectorAll('table')).find(
      (t) => t.getClientRects().length > 0 && t.querySelector('tbody tr p[title]') !== null,
    )
    const container = table?.parentElement
    if (!container || !container.className.includes('container-type')) {
      throw new Error('no inline-size container found around the table')
    }
    container.style.width = `${width}px`
  }, px)
  // Container queries re-evaluate on the next layout; two frames is ample.
  await page.waitForTimeout(250)
}

const TX_COLUMNS = ['·', 'Activity', 'Initiator', 'From / To', 'Date', 'Amount', '·']
const SHOWCASE_COLUMNS = [
  'Direction',
  'Activity',
  'Initiator',
  'From / To',
  'Date',
  'Amount',
  'External details',
]

test('/transactions: the collapse follows the CONTAINER while the viewport stands still', async ({
  page,
}) => {
  test.slow()
  await mockHavenApi(page)
  await seedAuthenticatedSession(page)
  await page.goto('/transactions')
  await page.waitForSelector('tbody tr', { timeout: 60_000 })

  // A viewport where `md` is true with 672px to spare. Under the old viewport
  // keying, nothing below could change the column set from here.
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(400)

  const wide = await readShape(page)
  expect(wide.columns, 'at a 1440px viewport the full column set renders').toEqual(TX_COLUMNS)
  expect(wide.bodyCells, 'and the body row carries the same seven cells').toBe(7)

  // Now starve the CONTAINER without touching the viewport. 717px is one
  // pixel under the `md` stage — the same container width a 767px viewport
  // produces on this shell.
  await setContainerWidth(page, 717)
  const starved = await readShape(page)
  expect(starved.containerWidth, 'the container really is 717px wide').toBe(717)
  expect(
    starved.bodyCells,
    'a 717px container collapses three columns out of the body row even though the viewport is 1440px',
  ).toBe(4)
  expect(
    starved.columns,
    'and Table.Head collapses wholesale below the md stage, as it does at a narrow viewport',
  ).toEqual([])

  // One pixel wider is the stage boundary itself, in both halves at once.
  await setContainerWidth(page, 718)
  const atStage = await readShape(page)
  expect(atStage.columns, 'a 718px container is the md stage — header half').toEqual(TX_COLUMNS)
  expect(atStage.bodyCells, 'a 718px container is the md stage — body half').toBe(7)
})

test('/design-system: both stages are container-keyed, and the second one is not redundant', async ({
  page,
}) => {
  test.slow()
  await mockHavenApi(page)
  await seedAuthenticatedSession(page)
  await page.goto('/design-system')
  await page.waitForSelector('tbody tr', { timeout: 60_000 })

  // Deliberately a viewport BELOW `xl`. Under viewport keying the Initiator
  // and Date columns could not appear here at all, whatever the container did.
  await page.setViewportSize({ width: 900, height: 900 })
  await page.waitForTimeout(400)

  await setContainerWidth(page, 974)
  const wide = await readShape(page)
  expect(wide.columns, 'a 974px container reveals the xl stage at a 900px viewport').toEqual(
    SHOWCASE_COLUMNS,
  )
  expect(wide.bodyCells, 'body half of the xl stage').toBe(7)

  // 973px is the container a 1023px AND a 1279px viewport both produce, and it
  // is one pixel short of the stage. This is the assertion that keeps the
  // second stage honest: #1827 showed the seven-column layout starves the
  // title below it.
  await setContainerWidth(page, 973)
  const mid = await readShape(page)
  expect(mid.columns, 'a 973px container is one pixel short of the xl stage').toEqual([
    'Direction',
    'Activity',
    'From / To',
    'Amount',
    'External details',
  ])
  expect(mid.bodyCells, 'the md stage keeps five cells in the body row').toBe(5)

  // And the md stage, from the same fixed viewport.
  await setContainerWidth(page, 717)
  const narrow = await readShape(page)
  expect(narrow.bodyCells, 'a 717px container collapses to the four-cell narrow layout').toBe(4)
  expect(narrow.columns, 'and the header row collapses with it').toEqual([])
})

/**
 * The wrapper the container lives on must not have become the sticky scroll
 * ancestor. `container-type: inline-size` implies `contain: layout style
 * inline-size`, and #1772 is this repo's standing proof that putting the wrong
 * box between a sticky `thead` and its scrollport silently stops it pinning —
 * the failure looked like nothing at all until the header's `y` was read while
 * scrolling. Same instrument here.
 */
test('/transactions: the sticky header still pins through the container wrapper (#1772)', async ({
  page,
}) => {
  test.slow()
  await mockHavenApi(page)
  await seedAuthenticatedSession(page)
  await page.setViewportSize({ width: 1280, height: 700 })
  await page.goto('/transactions')
  await page.waitForSelector('thead tr', { timeout: 60_000 })
  await page.waitForTimeout(600)

  const headTop = () =>
    page.evaluate(() => {
      const thead = document.querySelector('thead')
      return thead ? +thead.getBoundingClientRect().top.toFixed(1) : NaN
    })

  const before = await headTop()
  await page.evaluate(() => {
    const main = document.querySelector('main')
    if (main) main.scrollTop = 400
  })
  await page.waitForTimeout(400)
  const after = await headTop()

  // Pinned means it barely moves. Unpinned, it leaves with the content —
  // #1772 measured y=56 pinned against y=-303 unpinned on this same page.
  expect(
    Math.abs(after - before),
    `thead moved from y=${before} to y=${after} while main scrolled 400px`,
  ).toBeLessThan(40)
})
