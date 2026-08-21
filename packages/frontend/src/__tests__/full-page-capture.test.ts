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
  PAINTED_SLACK,
  TALL_FACTOR,
  assertCaptureNotBlank,
  inspectCapture,
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
