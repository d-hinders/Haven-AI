/**
 * Unit cover for the capture-integrity guard (#1738).
 *
 * The e2e counterpart (`e2e/capture-integrity.spec.ts`) proves the REAL
 * `/design-system` capture is not blank. This file proves the guard itself
 * discriminates — that it fires on the shape the bug produced, and does not
 * fire on the shapes a healthy page legitimately produces. A guard that only
 * ever returns "fine" is the failure mode #1738 is about, so the negative and
 * positive cases matter equally here.
 *
 * PNGs are synthesised rather than fixture'd: the failure is defined by pixel
 * layout, and building the exact layout under test beats committing a binary
 * whose relevant property is invisible in review.
 */
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs, shared by the screenshot script and both e2e specs
import {
  MIN_CONTENT_CHARS,
  MIN_CONTENT_ELEMENTS,
  PAINTED_SLACK,
  TALL_FACTOR,
  assertCaptureNotBlank,
  inspectCapture,
  judgeContentSettled,
  resolveContentSettled,
  resolveScrollShell,
  scanPng,
} from '../../scripts/full-page-capture.mjs'

const WHITE = [0xff, 0xff, 0xff]
const INK = [0x11, 0x11, 0x11]

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/**
 * Minimal 8-bit RGB PNG encoder, one IDAT.
 *
 * It really APPLIES the requested scanline filter rather than just stamping the
 * type byte — otherwise the filter cases below would be decoding unfiltered
 * bytes and would prove nothing about the decoder's unfilter paths.
 */
function encodePng(width: number, rows: number[][][], filter = 0): Buffer {
  const stride = width * 3
  const bpp = 3
  const raw = Buffer.alloc(rows.length * (stride + 1))
  const prev = Buffer.alloc(stride)
  const cur = Buffer.alloc(stride)

  rows.forEach((row, y) => {
    for (let x = 0; x < width; x++) {
      const px = row[x] ?? WHITE
      cur[x * 3] = px[0]
      cur[x * 3 + 1] = px[1]
      cur[x * 3 + 2] = px[2]
    }
    const at = y * (stride + 1)
    raw[at] = filter
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      let v: number
      switch (filter) {
        case 1: v = cur[i] - a; break
        case 2: v = cur[i] - b; break
        case 3: v = cur[i] - ((a + b) >> 1); break
        case 4: v = cur[i] - paeth(a, b, c); break
        default: v = cur[i]
      }
      raw[at + 1 + i] = v & 0xff
    }
    cur.copy(prev)
  })

  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    out.write(type, 4, 'ascii')
    data.copy(out, 8)
    out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length)
    return out
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(rows.length, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

let crcTable: number[] | null = null
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = []
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** A row of flat white, i.e. an unpainted one. */
const blankRow = (width: number) => Array.from({ length: width }, () => WHITE)
/** A row with a single ink pixel — the minimum that counts as painted. */
function paintedRow(width: number) {
  const row = blankRow(width)
  row[Math.floor(width / 2)] = INK
  return row
}

/**
 * The observed bug: a tall image painted for exactly one viewport, blank below.
 * Scaled down from the real 1280×16086 so the tests stay fast; the ratio and
 * the shape are what the guard reads.
 */
function blankBelowFoldPng(width = 8, viewportPx = 20, totalPx = 400) {
  return encodePng(width, [
    ...Array.from({ length: viewportPx }, () => paintedRow(width)),
    ...Array.from({ length: totalPx - viewportPx }, () => blankRow(width)),
  ])
}

describe('scanPng', () => {
  it('finds the last painted row', async () => {
    const png = encodePng(4, [paintedRow(4), blankRow(4), paintedRow(4), blankRow(4)])
    await expect(scanPng(png)).resolves.toMatchObject({
      width: 4,
      height: 4,
      lastPaintedRow: 2,
    })
  })

  it('reports -1 for an entirely flat image', async () => {
    const png = encodePng(4, [blankRow(4), blankRow(4)])
    expect((await scanPng(png)).lastPaintedRow).toBe(-1)
  })

  it('treats a row of one non-white colour as unpainted', async () => {
    // Uniformity, not whiteness, is the test: a solid brand-coloured band is
    // as uninformative as a white one, and a capture that failed to a coloured
    // backdrop must not read as painted.
    const solid = Array.from({ length: 4 }, () => INK)
    expect((await scanPng(encodePng(4, [solid, solid]))).lastPaintedRow).toBe(-1)
  })

  it.each([
    ['None', 0],
    ['Sub', 1],
    ['Up', 2],
    ['Average', 3],
    ['Paeth', 4],
  ])('unfilters %s-filtered scanlines', async (_name, filter) => {
    const png = encodePng(6, [blankRow(6), paintedRow(6), blankRow(6)], filter)
    expect((await scanPng(png)).lastPaintedRow).toBe(1)
  })

  it('rejects a truncated image rather than reporting a short one', async () => {
    // A capture cut off mid-stream would otherwise look like a page whose
    // content simply ended early — silent, and wrong in the same direction as
    // the bug itself.
    const png = encodePng(4, [paintedRow(4), paintedRow(4)])
    const ihdrHeightAt = 20
    png.writeUInt32BE(9, ihdrHeightAt) // claim 9 rows, carry 2
    await expect(scanPng(png)).rejects.toThrow(/truncated/i)
  })
})

describe('inspectCapture', () => {
  it('flags the blank-below-the-fold shape', async () => {
    const result = await inspectCapture(blankBelowFoldPng(), { viewportDevicePx: 20 })
    expect(result).toMatchObject({ height: 400, lastPaintedRow: 19, blankBelowFold: true })
    expect(result.paintedRatio).toBeCloseTo(0.05, 3)
  })

  it('passes a capture painted all the way down', async () => {
    const png = encodePng(8, Array.from({ length: 400 }, () => paintedRow(8)))
    await expect(inspectCapture(png, { viewportDevicePx: 20 })).resolves.toMatchObject({
      blankBelowFold: false,
    })
  })

  it('passes a tall page that merely ENDS in whitespace', async () => {
    // The guard asks for content below the fold, not content at the bottom.
    // Requiring the last row to be painted would fail every page with trailing
    // padding — and the pressure would be to loosen the guard, not the page.
    const png = encodePng(8, [
      ...Array.from({ length: 200 }, () => paintedRow(8)),
      ...Array.from({ length: 200 }, () => blankRow(8)),
    ])
    await expect(inspectCapture(png, { viewportDevicePx: 20 })).resolves.toMatchObject({
      blankBelowFold: false,
    })
  })

  it('does not flag a capture that fits within one viewport', async () => {
    // Nothing below the fold means nothing to be blank. Without this the guard
    // would fail every short route the screenshot script shoots.
    const png = encodePng(8, [
      ...Array.from({ length: 5 }, () => paintedRow(8)),
      ...Array.from({ length: 15 }, () => blankRow(8)),
    ])
    await expect(inspectCapture(png, { viewportDevicePx: 20 })).resolves.toMatchObject({
      blankBelowFold: false,
    })
  })

  // The two cases below straddle TALL_FACTOR's boundary deliberately. Stated
  // separately because the interesting one is the SECOND: the guard's bias
  // there is a real trade-off, not an accident, and a single test sitting on
  // the quiet side of the bound would hide it.
  const foldOnly = (viewportPx: number, height: number) =>
    encodePng(8, [
      ...Array.from({ length: viewportPx }, () => paintedRow(8)),
      ...Array.from({ length: height - viewportPx }, () => blankRow(8)),
    ])

  it('does not flag an image exactly at the tall/short boundary', async () => {
    // The comparison is strict (`height > viewport * TALL_FACTOR`), so an image
    // sitting exactly on the bound is SHORT and is never examined further,
    // whatever it painted.
    const viewportPx = 20
    await expect(
      inspectCapture(foldOnly(viewportPx, viewportPx * TALL_FACTOR), {
        viewportDevicePx: viewportPx,
      }),
    ).resolves.toMatchObject({ blankBelowFold: false })
  })

  it('flags a barely-tall capture whose content stops at the fold — by design', async () => {
    // One pixel past the bound the image counts as tall, and content ending at
    // the fold is flagged. A page CAN legitimately end in a deep whitespace
    // band and land here, so this is a narrow false-positive window, entered
    // knowingly: a false positive fails loudly and gets looked at, while a
    // false negative hands a reviewer blank pixels and says nothing. For a
    // guard whose whole subject is silent bad evidence, that is the side to
    // err on.
    const viewportPx = 20
    await expect(
      inspectCapture(foldOnly(viewportPx, Math.floor(viewportPx * TALL_FACTOR) + 1), {
        viewportDevicePx: viewportPx,
      }),
    ).resolves.toMatchObject({ blankBelowFold: true })
  })

  it('still flags a capture painted marginally past the fold', async () => {
    // PAINTED_SLACK absorbs a scrollbar or rounding row, and must not be wide
    // enough to absorb the bug: content ending a hair past the fold on a
    // 20×-viewport image is the failure, not a healthy page.
    const viewportPx = 20
    const painted = Math.floor(viewportPx * PAINTED_SLACK)
    const png = encodePng(8, [
      ...Array.from({ length: painted }, () => paintedRow(8)),
      ...Array.from({ length: 400 - painted }, () => blankRow(8)),
    ])
    await expect(inspectCapture(png, { viewportDevicePx: viewportPx })).resolves.toMatchObject({
      blankBelowFold: true,
    })
  })
})

describe('assertCaptureNotBlank', () => {
  it('throws with the measurements a reader needs to diagnose it', async () => {
    await expect(
      assertCaptureNotBlank(blankBelowFoldPng(), {
        label: '/design-system · desktop',
        viewportDevicePx: 20,
      }),
    ).rejects.toThrow(/\/design-system · desktop.*BLANK below the fold.*y=19.*5\.0%/s)
  })

  it('names the likely cause so the fix is one hop away', async () => {
    await expect(
      assertCaptureNotBlank(blankBelowFoldPng(), { viewportDevicePx: 20 }),
    ).rejects.toThrow(/unclipScrollShell/)
  })

  it('tags its failure so a caller never has to guess the cause', async () => {
    // Downstream, 'blank-below-fold' must be something this guard SAID, not a
    // default the reporter applied to every failure it did not recognise —
    // that default is what reported a 30s screenshot timeout as a blank PNG.
    const error: unknown = await assertCaptureNotBlank(blankBelowFoldPng(), {
      viewportDevicePx: 20,
    }).catch((e: unknown) => e)
    expect((error as { captureCause?: string }).captureCause).toBe('blank-below-fold')
  })

  it('resolves with the inspection for a healthy capture', async () => {
    const png = encodePng(8, Array.from({ length: 400 }, () => paintedRow(8)))
    await expect(assertCaptureNotBlank(png, { viewportDevicePx: 20 })).resolves.toMatchObject({
      blankBelowFold: false,
    })
  })

  it('refuses a missing viewport height instead of silently passing', async () => {
    // `viewportDevicePx: undefined` would make every comparison NaN and every
    // capture "fine" — the guard would be permanently disarmed and look green.
    await expect(
      assertCaptureNotBlank(blankBelowFoldPng(), {} as { viewportDevicePx: number }),
    ).rejects.toThrow(/viewportDevicePx/)
  })
})

/**
 * ── Which of the three failures is this? (#1936 / #1939 / #1943) ─────────────
 *
 * `resolveScrollShell` replaced one question ("is `#main-content` there?") with
 * a verdict that separates three situations that used to share one error
 * message. These tests exist to prove the separation is real — a classifier
 * that answered "missing-scroll-root" to everything would still make the
 * marketing capture fail and would still blame the shell for a cold compile,
 * which is exactly the defect being fixed.
 *
 * The page is faked rather than driven: every input this function reads is the
 * return value of a `page.evaluate`, so a fake that returns those values
 * exercises the real branching. The REAL DOM behaviour (that marketing routes
 * have no `#main-content`, that `/design-system` does) is proven by
 * `e2e/capture-integrity.spec.ts` and by the two-route run recorded on the PR.
 */
type FakeProbe = {
  found: boolean
  docScrollHeight: number
  viewportHeight: number
  renderedChars: number
}

const MARKETING: FakeProbe = {
  found: false,
  docScrollHeight: 9000,
  viewportHeight: 800,
  renderedChars: 5000,
}
const SHELL_MOUNTED: FakeProbe = {
  found: true,
  docScrollHeight: 18_000,
  viewportHeight: 800,
  renderedChars: 4000,
}
const PROTECTED_ROUTE_NULL: FakeProbe = {
  found: false,
  docScrollHeight: 800,
  viewportHeight: 800,
  renderedChars: 0,
}

/**
 * A `page` with exactly the three evaluate shapes the module uses: the probe
 * (called with a selector), the clipping scan (called with none) and the
 * un-clip walk (the selector call that follows a `found: true` probe).
 */
function fakePage(
  probes: FakeProbe[],
  clipping: { offenders: { selector: string; held: number }[] } = { offenders: [] },
  unclipHeight = 33_160,
) {
  let index = 0
  let unclipped = false
  const waits: number[] = []
  return {
    waits,
    async waitForTimeout(ms: number) {
      waits.push(ms)
    },
    async evaluate(_fn: unknown, arg?: unknown) {
      // The clipping scan is the one evaluate called with a NUMBER (the
      // minimum hidden height that counts as a scroll shell); the probe and
      // the un-clip walk are called with the selector. The fake applies that
      // floor itself, exactly as the real in-page scan does — otherwise the
      // threshold would be untested and a decorative 32px overlay would count.
      if (typeof arg === 'number') {
        const kept = clipping.offenders.filter((o) => o.held >= arg).slice(0, 3)
        return { count: kept.length, offenders: kept }
      }
      const probe = probes[Math.min(index, probes.length - 1)]
      if (probe.found && unclipped) return unclipHeight
      if (probe.found) unclipped = true
      index += 1
      return probe
    },
  }
}

describe('resolveScrollShell', () => {
  it('waits out the ProtectedRoute race and reports it as a wait, not a failure', async () => {
    // The #1936/#1943 race: the shell is genuinely absent for the first probes
    // and arrives afterwards. Before this, that random window failed the run
    // with "update SCROLL_SHELL_ROOT" against a selector that was correct.
    const page = fakePage([PROTECTED_ROUTE_NULL, PROTECTED_ROUTE_NULL, SHELL_MOUNTED])
    const result = await resolveScrollShell(page, { timeoutMs: 5_000, pollMs: 1 })

    expect(result.mode, 'a late shell must still be un-clipped, not reported missing').toBe(
      'unclipped',
    )
    expect(result.raced, 'a capture that had to wait must SAY it waited').toBe(true)
    expect(result.height).toBe(33_160)
  })

  it('captures a marketing route with no shell instead of throwing', async () => {
    // #1939: `/` and `/investor-briefing` have no `#main-content` at all, and
    // need none — they scroll natively. Every one of these used to throw, and
    // the caller deleted the PNG.
    const page = fakePage([MARKETING])
    const result = await resolveScrollShell(page, { timeoutMs: 5_000, pollMs: 1 })

    expect(result.mode, 'a natively scrolling page has no shell to un-clip').toBe('no-scroll-shell')
    expect(result.waitedMs, 'a settled marketing page must not burn the wait budget').toBeLessThan(
      1_000,
    )
  })

  it('still throws missing-scroll-root when content is clipped and the root is gone', async () => {
    // The load-bearing half. A renamed `#main-content` on a page that IS still
    // clipping must fail exactly as loudly as before — this is the #1738 defect
    // and the reason "just stop throwing" was rejected in #1939.
    const page = fakePage([{ ...MARKETING, docScrollHeight: 810 }], {
      offenders: [{ selector: 'main#content-main.flex-1', held: 15_000 }],
    })

    await expect(resolveScrollShell(page, { timeoutMs: 20, pollMs: 1 })).rejects.toThrow(
      /scroll root "#main-content" not found.*main#content-main.*15000px held.*Update SCROLL_SHELL_ROOT/s,
    )
  })

  it('names a page that never rendered as not-rendered, not as a selector problem', async () => {
    // The third cause, previously indistinguishable from the other two: a cold
    // `next dev` first compile (measured at 315s on this change's own machine),
    // a failed hydration, an error boundary. Telling a reader to update
    // SCROLL_SHELL_ROOT here sends them to a file that is not the problem.
    const page = fakePage([PROTECTED_ROUTE_NULL])
    const error = await resolveScrollShell(page, { timeoutMs: 20, pollMs: 1 }).catch((e) => e)

    expect(error.shellCause, 'an unrendered page is not a selector defect').toBe('not-rendered')
    expect(error.message).toMatch(/rendered almost nothing/)
    expect(error.message).toMatch(/next dev/)
    expect(
      error.message,
      'this message must NOT send the reader to the selector',
    ).not.toMatch(/Update SCROLL_SHELL_ROOT/)
  })

  it('does not grant no-scroll-shell to a page that is merely short', async () => {
    // Guard against the cheap version of this fix: "root missing → capture
    // anyway". A short page that clips is still the #1738 failure.
    const page = fakePage([{ ...PROTECTED_ROUTE_NULL, renderedChars: 4_000 }], {
      offenders: [{ selector: 'div.overflow-hidden', held: 900 }],
    })
    await expect(resolveScrollShell(page, { timeoutMs: 20, pollMs: 1 })).rejects.toThrow(
      /missing|not found/,
    )
  })

  it('does not mistake the ProtectedRoute LOADING state for a shell-less page', async () => {
    // The early exit is where this race could come back wearing a different
    // label: a still-loading authenticated page that satisfied it would be
    // captured at once and filed as `captured_without_unclip` — a deliberate
    // result, not a failure. Pinned against the REAL markup
    // (`src/components/ProtectedRoute.tsx`: a `min-h-screen` centred div
    // reading "Loading...") so a future change to that copy, or to the
    // thresholds, has to redden this rather than pass silently.
    const loading: FakeProbe = {
      found: false,
      renderedChars: 10,
      docScrollHeight: 800,
      viewportHeight: 800,
    }
    const page = fakePage([loading, loading, SHELL_MOUNTED])
    const result = await resolveScrollShell(page, { timeoutMs: 5_000, pollMs: 1 })

    expect(result.mode, 'a loading shell must be waited for, never captured as shell-less').toBe(
      'unclipped',
    )
    expect(result.raced, 'and the wait must be recorded').toBe(true)
  })

  it('does not end the wait for a page that is only marginally taller than the fold', async () => {
    // The height half of the same floor, and the half the "Loading..." fixture
    // above cannot reach — it is stopped by the character floor first, so
    // without this test the margin is shadowed and a mutation of it stays
    // green. A loading state that grew a header and a little overflow (400
    // characters, 900px against an 800px viewport) is the shape that would
    // slip through a bare `> viewportHeight`.
    const nearlyFold = {
      found: false,
      renderedChars: 400,
      docScrollHeight: 900,
      viewportHeight: 800,
    }
    const page = fakePage([nearlyFold, nearlyFold, SHELL_MOUNTED])
    const result = await resolveScrollShell(page, { timeoutMs: 5_000, pollMs: 1 })

    expect(
      result.mode,
      'one-and-a-bit viewports is not "unmistakably a scrolling page" — keep waiting for the shell',
    ).toBe('unclipped')
  })

  it('ignores a decorative overlay that holds a few pixels', async () => {
    // Measured, not imagined: the first real run of this fix against `/` and
    // `/investor-briefing` failed all four captures on
    // `div.pointer-events-none.absolute.inset-0` holding **32px** — a
    // background layer, not a scroll shell. "Any overflow counts" would have
    // re-created #1939 with a better error message.
    //
    // The page here is deliberately one that does NOT scroll natively, so the
    // document-scrolls short-circuit cannot answer this for us — otherwise the
    // threshold would be shadowed and this test would prove nothing.
    const page = fakePage([{ ...MARKETING, docScrollHeight: 800, viewportHeight: 800 }], {
      offenders: [{ selector: 'div.pointer-events-none.absolute.inset-0', held: 32 }],
    })
    const result = await resolveScrollShell(page, { timeoutMs: 20, pollMs: 1 })

    expect(
      result.mode,
      'a 32px decorative overlay is not a scroll shell — a blank-below-the-fold capture needs a screen of held content',
    ).toBe('no-scroll-shell')
  })

  it('names the renamed root when content lives in a scroller the document will not paint', async () => {
    // The REAL app-shell shape, and the one the first version of this
    // discriminator missed: `<main id="main-content">` is `overflow-y: auto`,
    // not hidden, so "count only hidden overflow" classified a genuinely
    // renamed root as "no scroll shell" and let the second guard catch it by
    // accident. Proven against the live app by renaming SCROLL_SHELL_ROOT.
    const page = fakePage([{ ...MARKETING, docScrollHeight: 800, viewportHeight: 800 }], {
      offenders: [{ selector: 'main#content-main.flex-1', held: 35_000 }],
    })
    const error = await resolveScrollShell(page, { timeoutMs: 20, pollMs: 1 }).catch((e) => e)

    expect(error.shellCause).toBe('missing-scroll-root')
    expect(error.message).toMatch(/hold a screen or more of content/)
    expect(error.message).toMatch(/main#content-main/)
  })
})

/**
 * ── Is this a picture of the route, or of its spinner? (#2036) ──────────────
 *
 * The measured defect: `/dashboard` captured on both viewports showing the app
 * shell and a body reading only `Loading...`, reported as a SUCCESS. Both
 * neighbouring guards are correct to pass it — a loading state is short so
 * `blank-below-fold` is out of scope, and `#main-content` really did mount so
 * the shell guards really did their job. The gap is that nothing asked whether
 * the region the PNG claims to show contains anything.
 *
 * These tests are deliberately written in BOTH directions. A guard for hollow
 * evidence that can only say "fine" is the joke telling itself; one that can
 * only say "no" is an alarm nobody keeps.
 */
type ContentProbe = {
  found: boolean
  docScrollHeight: number
  viewportHeight: number
  renderedChars: number
  contentChars: number | null
  contentElements: number | null
}

/**
 * The REAL loading fallback, transcribed from
 * `app/(authenticated)/dashboard/page.tsx`: a pulse dot and a `<span>` reading
 * `Loading...` inside a flex wrapper. Three elements, ten characters — and
 * `renderedChars` is in the THOUSANDS, because the shell around it (sidebar
 * nav, TopBar, account chip) rendered perfectly. That gap between the two
 * numbers is the whole defect.
 */
const DASHBOARD_LOADING: ContentProbe = {
  found: true,
  docScrollHeight: 800,
  viewportHeight: 800,
  renderedChars: 2_400,
  contentChars: 10,
  contentElements: 3,
}

/** A `/dashboard` that actually resolved — measured on the populated fixture. */
const DASHBOARD_RENDERED: ContentProbe = {
  found: true,
  docScrollHeight: 3_600,
  viewportHeight: 800,
  renderedChars: 4_800,
  contentChars: 2_100,
  contentElements: 460,
}

function fakeContentPage(probes: ContentProbe[]) {
  let index = 0
  const waits: number[] = []
  return {
    waits,
    async waitForTimeout(ms: number) {
      waits.push(ms)
    },
    async evaluate() {
      const probe = probes[Math.min(index, probes.length - 1)]
      index += 1
      return probe
    },
  }
}

describe('judgeContentSettled', () => {
  it('says NO to the real dashboard loading fallback — the capture #2036 was filed about', () => {
    const verdict = judgeContentSettled(DASHBOARD_LOADING)

    expect(verdict.settled).toBe(false)
    expect(verdict.reason).toBe('still-loading')
    // Both numbers survive into the verdict, because the error message quotes
    // them and a reader has to be able to see how far below the floor it was.
    expect(verdict.chars).toBe(10)
    expect(verdict.elements).toBe(3)
  })

  it('says YES to a route that genuinely rendered — the positive control', () => {
    // Without this the guard could be `() => ({ settled: false })` and every
    // other test here would still pass while the harness captured nothing ever
    // again.
    const verdict = judgeContentSettled(DASHBOARD_RENDERED)

    expect(verdict.settled).toBe(true)
    expect(verdict.reason).toBe('settled')
  })

  it('refuses a skeleton: many elements, almost no text', () => {
    // A shimmer placeholder is the loading state that is NOT short on DOM. It
    // has to fail on the text floor, or the guard only ever catches spinners.
    const verdict = judgeContentSettled({
      ...DASHBOARD_RENDERED,
      contentChars: 4,
      contentElements: 120,
    })

    expect(verdict.settled).toBe(false)
    expect(verdict.reason).toBe('still-loading')
  })

  it('refuses a bare sentence: enough text, almost no structure', () => {
    const verdict = judgeContentSettled({
      ...DASHBOARD_RENDERED,
      contentChars: 400,
      contentElements: 2,
    })

    expect(verdict.settled).toBe(false)
    expect(verdict.reason).toBe('still-loading')
  })

  it('separates "no content root" from "the content root is empty"', () => {
    // Two different facts, and the module whose entire subject is precise
    // causal reporting must not blur them: a marketing page has no
    // `#main-content` at all and is captured on purpose (#1939).
    const verdict = judgeContentSettled({ ...DASHBOARD_RENDERED, contentChars: null, contentElements: null })

    expect(verdict.settled).toBe(false)
    expect(verdict.reason).toBe('no-content-root')
  })

  it('is judged PER PAGE — a healthy route cannot excuse a still-loading one', () => {
    // The #1996 trap, restated: `unanswered_chain_reads` first aggregated per
    // CONTEXT, so a healthy `/dashboard` in the same sweep would have excused a
    // silent `/agents` — the guard rebuilding the bug it exists to catch. This
    // verdict holds no cross-page state at all, and that is asserted rather
    // than assumed.
    const sweep = [
      { route: '/dashboard', probe: DASHBOARD_RENDERED },
      { route: '/agents', probe: DASHBOARD_LOADING },
      { route: '/transactions', probe: DASHBOARD_RENDERED },
    ]

    const refused = sweep
      .filter(({ probe }) => !judgeContentSettled(probe).settled)
      .map(({ route }) => route)

    expect(refused).toEqual(['/agents'])
  })

  it('pins the floors against the markup they were measured from', () => {
    // If someone raises these to a number a real empty state cannot clear, this
    // is the test that should have to be edited deliberately.
    expect(MIN_CONTENT_CHARS).toBe(80)
    expect(MIN_CONTENT_ELEMENTS).toBe(8)
    // The floors must sit strictly above the real loading fallback and strictly
    // below the real rendered route, or they discriminate nothing.
    expect(DASHBOARD_LOADING.contentChars).toBeLessThan(MIN_CONTENT_CHARS)
    expect(DASHBOARD_RENDERED.contentChars).toBeGreaterThan(MIN_CONTENT_CHARS)
    expect(DASHBOARD_LOADING.contentElements).toBeLessThan(MIN_CONTENT_ELEMENTS)
    expect(DASHBOARD_RENDERED.contentElements).toBeGreaterThan(MIN_CONTENT_ELEMENTS)
  })
})

describe('resolveContentSettled', () => {
  it('waits out a late chunk and reports it as a wait, not a failure', async () => {
    // A cold `next dev` compiles the route chunk AFTER the shell is already on
    // screen. That is a slow machine, not a broken route, and refusing it would
    // make the guard an alarm that is always on.
    const page = fakeContentPage([DASHBOARD_LOADING, DASHBOARD_LOADING, DASHBOARD_RENDERED])

    const result = await resolveContentSettled(page, { timeoutMs: 5_000, pollMs: 1 })

    expect(result.settled).toBe(true)
    expect(result.raced).toBe(true)
    expect(result.polls).toBe(2)
    expect(result.chars).toBe(DASHBOARD_RENDERED.contentChars)
  })

  it('does not claim a race on a route that was ready on the first probe', async () => {
    const page = fakeContentPage([DASHBOARD_RENDERED])

    const result = await resolveContentSettled(page, { timeoutMs: 5_000, pollMs: 1 })

    expect(result.raced).toBe(false)
    expect(result.polls).toBe(0)
    expect(page.waits).toEqual([])
  })

  it('throws still-loading when the content never arrives, and names both numbers', async () => {
    const page = fakeContentPage([DASHBOARD_LOADING])

    const error = await resolveContentSettled(page, {
      timeoutMs: 20,
      pollMs: 1,
      label: '/dashboard · mobile',
    }).catch((e) => e)

    // `captureCause` is what `describeDeletedCapture` reads, so the manifest
    // records a cause of its own rather than folding this into 'unknown'.
    expect(error.name).toBe('ContentNotSettledError')
    expect(error.captureCause).toBe('still-loading')
    expect(error.message).toContain('/dashboard · mobile')
    expect(error.message).toContain('10 character(s)')
    expect(error.message).toContain('3 element(s)')
    // The floor is quoted, so the reader can judge the margin without opening
    // the source.
    expect(error.message).toContain(`${MIN_CONTENT_CHARS} characters`)
  })

  it('accepts a probe the caller already took instead of re-probing', async () => {
    // `captureFullPage` has just probed the page to resolve the shell; making
    // it pay for a second round-trip before the first poll would be waste.
    const page = fakeContentPage([DASHBOARD_LOADING])

    const result = await resolveContentSettled(page, {
      timeoutMs: 20,
      pollMs: 1,
      // The default is `null`, so TS infers the option as `null | undefined`
      // from the plain-JS signature. The cast says "a probe object", nothing
      // more — the runtime contract is the one the module documents.
      probe: DASHBOARD_RENDERED as unknown as null,
    })

    expect(result.settled).toBe(true)
    expect(result.polls).toBe(0)
  })
})
