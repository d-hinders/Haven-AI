/**
 * Trustworthy full-page captures (#1738).
 *
 * ── The bug this exists to prevent ───────────────────────────────────────────
 * A `fullPage: true` screenshot of any authenticated Haven route used to come
 * back **blank below the first viewport**, and nothing said so. The PNG had a
 * plausible file size and a correct-looking top strip, so a reviewer — human or
 * `haven-design-reviewer` — would judge a screen they had only seen 5% of.
 *
 * The cause is the app shell, not Chromium's surface cap:
 *
 *   <div class="flex h-screen … overflow-hidden">   ← the document NEVER scrolls
 *     <Sidebar />
 *     <div class="flex-1 flex flex-col … overflow-hidden">
 *       <TopBar />
 *       <main id="main-content" class="flex-1 … overflow-y-auto">  ← real scroller
 *
 * `Page.getLayoutMetrics` measures layout overflow *through* the clip, so
 * Chromium sizes the capture surface to the full 16,000px+ content height —
 * but `overflow: hidden` means nothing below the viewport is ever painted.
 * The result is a correctly-sized image containing one viewport of content and
 * a very long white tail.
 *
 * Measured on `/design-system` at the evidence viewports:
 *
 *   desktop 1280×800 @2x → 2560×32094 image, painted to y=1599   (5.0%)
 *   mobile   390×844 @2x →  780×52218 image, painted to y=1687   (3.2%)
 *
 * y=1599 and y=1687 are exactly 800 and 844 CSS px at `deviceScaleFactor: 2`
 * — one viewport, to the pixel.
 *
 * ── Why the surface cap is NOT the cause ─────────────────────────────────────
 * Chromium's ~16,384px cap is a real limit and was the first suspect, but it
 * does not explain this: the desktop *visual-regression* baseline is 16,086px
 * at `deviceScaleFactor: 1` — under the cap — and was blank all the same.
 * Un-clipping the shell then produced a **33,160px** image painted to 99.8%,
 * which is twice the cap. So Chromium rasterises far past 16,384px here, and
 * neither tiling nor stitching is needed. Un-clip, and `fullPage` just works.
 *
 * ── The two halves ───────────────────────────────────────────────────────────
 * `unclipScrollShell` fixes the capture. `assertCaptureNotBlank` makes the
 * failure impossible to ship silently again — it reads the PNG back and fails
 * loudly when a tall capture carries content only in its first viewport. The
 * fix without the guard would just be the same trap re-armed for whoever next
 * changes the shell's overflow.
 *
 * Dependency-free on purpose (`node:zlib` only), like `evidence-viewports.mjs`:
 * both the screenshot script and the Playwright visual spec import it.
 */
import { createInflate } from 'node:zlib'
import { Readable } from 'node:stream'

/**
 * The app shell's real scroll container. Every authenticated route mounts its
 * content inside it (`(authenticated)/layout.tsx`), so un-clipping from here
 * up to `<html>` is enough for any route the capture scripts visit.
 */
export const SCROLL_SHELL_ROOT = '#main-content'

/**
 * A capture is judged blank-below-the-fold when the image is meaningfully
 * TALLER than one viewport yet carries no painted pixel below it.
 *
 * Both slack factors matter. `TALL_FACTOR` keeps a page that genuinely fits in
 * one viewport (plus a little) out of scope — there is no "below the fold" to
 * be blank. `PAINTED_SLACK` allows a capture whose content ends just past the
 * fold; the failure this catches ends *at* the fold, so a 5% allowance cannot
 * mask it while it does absorb a stray scrollbar or rounding row.
 *
 * Deliberately NOT "must be painted to the last row": a page is allowed to end
 * in whitespace. The signal is content below the fold, not content at the
 * bottom.
 */
export const TALL_FACTOR = 1.25
export const PAINTED_SLACK = 1.05

/**
 * Make the document itself scrollable so `fullPage: true` paints everything.
 *
 * Walks from the scroll container up to `<html>` clearing the height cap and
 * the clip on every ancestor — the shell nests two `overflow-hidden` divs
 * inside an `h-screen` flex row, so clearing only the innermost is not enough.
 *
 * Returns the resulting document height. THROWS when the scroll root is
 * missing: a renamed `#main-content` must fail the run, because the fallback
 * is silently capturing the blank page this whole module exists to prevent.
 *
 * ── How to read the resulting PNG ────────────────────────────────────────────
 * Chrome OUTSIDE `#main-content` does not stretch to the un-clipped height.
 * The shell row goes from a definite `100vh` to `height: auto`, and the
 * sidebar sizes itself with `lg:h-full` — a percentage against an auto-height
 * parent resolves to `auto` — so its tint and right border stop at the bottom
 * of the nav instead of running the full ~16,000px. Below that the sidebar
 * column is plain white.
 *
 * That is expected, and it is not what a user sees (live, the sidebar stays
 * pinned to the viewport while `<main>` scrolls under it). So: judge SHELL AND
 * CHROME from the first viewport, and CONTENT from the whole image. A long
 * white column beside the content is the capture technique, not a broken
 * sidebar — do not file it as one.
 */
export async function unclipScrollShell(page, { selector = SCROLL_SHELL_ROOT } = {}) {
  const height = await page.evaluate((sel) => {
    const root = document.querySelector(sel)
    if (!root) return null
    for (let el = root; el && el !== document.documentElement; el = el.parentElement) {
      el.style.setProperty('height', 'auto', 'important')
      el.style.setProperty('max-height', 'none', 'important')
      el.style.setProperty('overflow', 'visible', 'important')
    }
    return document.documentElement.scrollHeight
  }, selector)

  if (height === null) {
    throw new Error(
      `full-page capture: scroll root "${selector}" not found. The app shell clips at ` +
        `h-screen/overflow-hidden, so without un-clipping it the capture is blank below ` +
        `the first viewport. Update SCROLL_SHELL_ROOT in scripts/full-page-capture.mjs.`,
    )
  }

  // Reflow after the style writes; without it the capture can size itself from
  // the pre-un-clip layout and land back in the failure case.
  await page.waitForTimeout(300)
  return height
}

/**
 * Capture the whole page and refuse to return a blank one.
 *
 * `viewportDevicePx` is the viewport height in DEVICE pixels — CSS height ×
 * deviceScaleFactor. The capture is measured in device pixels, so comparing it
 * against a CSS height would put the fold in the wrong place (at `dsf: 2` it
 * would sit at half the real fold and the guard would never fire).
 */
export async function captureFullPage(page, { path, label, viewportDevicePx, selector } = {}) {
  await unclipScrollShell(page, selector ? { selector } : undefined)
  const buffer = await page.screenshot({ path, fullPage: true })
  await assertCaptureNotBlank(buffer, { label, viewportDevicePx })
  return buffer
}

/** Structured verdict for one capture. `blankBelowFold` is the failure. */
export async function inspectCapture(buffer, { viewportDevicePx }) {
  const { width, height, lastPaintedRow } = await scanPng(buffer)
  const paintedRows = lastPaintedRow + 1
  const tallerThanViewport = height > viewportDevicePx * TALL_FACTOR
  const paintedOnlyInFirstViewport = paintedRows <= viewportDevicePx * PAINTED_SLACK

  return {
    width,
    height,
    lastPaintedRow,
    paintedRatio: height === 0 ? 0 : paintedRows / height,
    blankBelowFold: tallerThanViewport && paintedOnlyInFirstViewport,
  }
}

/** Throw a diagnosable error when a capture is blank below the fold. */
export async function assertCaptureNotBlank(buffer, { label = 'capture', viewportDevicePx }) {
  if (!Number.isFinite(viewportDevicePx) || viewportDevicePx <= 0) {
    throw new Error(`assertCaptureNotBlank(${label}): viewportDevicePx must be a positive number`)
  }
  const result = await inspectCapture(buffer, { viewportDevicePx })
  if (!result.blankBelowFold) return result

  const pct = (result.paintedRatio * 100).toFixed(1)
  throw new Error(
    `${label}: capture is BLANK below the fold — ${result.width}×${result.height}, but the last ` +
      `painted row is y=${result.lastPaintedRow} (${pct}% of the image), which is within one ` +
      `${viewportDevicePx}px viewport. The image is the right SIZE and mostly empty, so it looks ` +
      `like valid evidence and is not.\n` +
      `Likeliest cause is the capture path — the app shell was not un-clipped before the shot ` +
      `(see unclipScrollShell in scripts/full-page-capture.mjs). But the PAGE can put a capture ` +
      `in this state too: a route that never hydrated, or one that stopped painting at an error ` +
      `boundary, ends at the fold for its own reasons. Check what the route should render at ` +
      `this height before assuming the capture is at fault.`,
  )
}

// ── PNG reading ──────────────────────────────────────────────────────────────
// Enough of the format to answer one question: which is the last row carrying
// more than a single flat colour? Streamed one scanline at a time — a captured
// `/design-system` is ~2560×33160, which is 254MB of pixels that nothing here
// needs to hold all at once.

/** Read IHDR + the concatenated IDAT stream out of a PNG buffer. */
function readPngChunks(buffer) {
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('full-page capture: not a PNG')
  }
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  const bitDepth = buffer[24]
  const colorType = buffer[25]
  const interlace = buffer[28]

  // Playwright writes 8-bit non-interlaced PNGs. Anything else is a format we
  // have not verified against, and guessing would make the guard unreliable in
  // exactly the silent direction it exists to close.
  if (bitDepth !== 8) throw new Error(`full-page capture: unsupported PNG bit depth ${bitDepth}`)
  if (interlace !== 0) throw new Error('full-page capture: interlaced PNGs are not supported')

  // Palette (3) is scanned on its INDEX bytes: a row of one index is a row of
  // one colour, which is all the uniformity test asks.
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error(`full-page capture: unsupported PNG colour type ${colorType}`)

  const idat = []
  let offset = 8
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    if (type === 'IDAT') idat.push(buffer.subarray(offset + 8, offset + 8 + length))
    if (type === 'IEND') break
    offset += 12 + length
  }
  return { width, height, channels, idat }
}

/** Undo one PNG scanline filter in place. `prev` is the already-decoded row above. */
function unfilter(type, line, prev, bpp) {
  switch (type) {
    case 0:
      break
    case 1:
      for (let i = bpp; i < line.length; i++) line[i] = (line[i] + line[i - bpp]) & 0xff
      break
    case 2:
      for (let i = 0; i < line.length; i++) line[i] = (line[i] + prev[i]) & 0xff
      break
    case 3:
      for (let i = 0; i < line.length; i++) {
        const a = i >= bpp ? line[i - bpp] : 0
        line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xff
      }
      break
    case 4:
      for (let i = 0; i < line.length; i++) {
        const a = i >= bpp ? line[i - bpp] : 0
        const b = prev[i]
        const c = i >= bpp ? prev[i - bpp] : 0
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
      }
      break
    default:
      throw new Error(`full-page capture: unknown PNG filter type ${type}`)
  }
}

/** True when every pixel in the row is the same colour. */
function isUniformRow(line, channels) {
  for (let i = channels; i < line.length; i++) {
    if (line[i] !== line[i % channels]) return false
  }
  return true
}

/**
 * Scan a PNG for the last row that is not a single flat colour.
 *
 * Returns `lastPaintedRow: -1` for an image that is uniform throughout.
 *
 * Async because it STREAMS. `zlib.inflateSync` would allocate the entire
 * decompressed image up front — a full-page `/design-system` at
 * `deviceScaleFactor: 2` is 2560×33160, i.e. ~254MB of pixels — when the
 * question only ever needs two scanlines in memory at once. Rows are unfiltered
 * and tested as the inflater emits them, so peak memory is O(width).
 */
export async function scanPng(buffer) {
  const { width, height, channels, idat } = readPngChunks(buffer)
  const stride = width * channels

  let lastPaintedRow = -1
  if (stride === 0 || height === 0) return { width, height, channels, lastPaintedRow }

  const cur = Buffer.alloc(stride)
  const prev = Buffer.alloc(stride)

  let row = 0
  let filled = 0 // bytes of the current scanline already copied into `cur`
  let filterType = -1

  const inflated = Readable.from(idat).pipe(createInflate())
  for await (const chunk of inflated) {
    let at = 0
    while (at < chunk.length && row < height) {
      // Each record is one filter byte followed by `stride` data bytes, and a
      // chunk boundary can fall anywhere inside either.
      if (filterType === -1) {
        filterType = chunk[at++]
        filled = 0
        continue
      }
      const take = Math.min(stride - filled, chunk.length - at)
      chunk.copy(cur, filled, at, at + take)
      filled += take
      at += take
      if (filled < stride) continue

      unfilter(filterType, cur, prev, channels)
      if (!isUniformRow(cur, channels)) lastPaintedRow = row
      cur.copy(prev)
      row++
      filterType = -1
    }
  }

  if (row < height) {
    throw new Error(
      `full-page capture: PNG ended after ${row} of ${height} scanlines — truncated image`,
    )
  }
  return { width, height, channels, lastPaintedRow }
}
