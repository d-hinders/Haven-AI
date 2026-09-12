import { inflateSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BRAND_COLOURS } from '@/lib/brand-colours'
import { APP_ICONS } from '@/lib/installed-app'
import { appIconGeometry } from '@/components/brand/AppIconArtwork'

/**
 * The three icon routes, rendered for real and read back pixel by pixel
 * (#2729, raised by `haven-design-reviewer`: three new rendered surfaces had
 * no pixel coverage, so a satori bump or an artwork edit would reach a demo
 * phone's home screen with no gate saying anything moved).
 *
 * `next/og` runs here unmocked — satori + resvg, ~100 ms per icon — and the
 * PNG is decoded by the forty-line reader below (resvg writes 8-bit
 * non-interlaced RGBA, the one shape it handles; anything else throws) so
 * the test adds no dependency. Every assertion is against the same numbers
 * the artwork draws with (`appIconGeometry`), so the test pins the render to
 * its intent rather than to a snapshot:
 *
 * - the canvas is the size the manifest advertises;
 * - the field is `--v2-brand` (corner pixel), the mark is `--v2-ink-on-brand` (its
 *   centre pixel), the dev band is `--v2-warning` and prod has no band
 *   (bottom-centre pixel);
 * - the mark's white bounding box is `HavenMark`'s proportion — the finding
 *   the first cut failed, at a third of the tile instead of half;
 * - with a band, the mark is centred in the field that remains above it,
 *   which the first cut also got wrong (1.8 : 1 above : below).
 */

const ICON_ROUTES = {
  icon1: () => import('@/app/icon1'),
  icon2: () => import('@/app/icon2'),
  'apple-icon': () => import('@/app/apple-icon'),
} as const

type Rgb = readonly [number, number, number]

interface Png {
  width: number
  height: number
  /** RGBA, row-major, 4 bytes per pixel. */
  data: Buffer
}

/** Decode an 8-bit, non-interlaced RGB or RGBA PNG (what resvg emits). */
function decodePng(file: Buffer): Png {
  if (!file.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error('not a PNG')
  }
  let width = 0
  let height = 0
  let channels = 0
  const idat: Buffer[] = []
  for (let offset = 8; offset < file.length; ) {
    const length = file.readUInt32BE(offset)
    const type = file.toString('ascii', offset + 4, offset + 8)
    const body = file.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const bitDepth = body[8]
      const colourType = body[9]
      const interlace = body[12]
      if (bitDepth !== 8 || interlace !== 0 || (colourType !== 2 && colourType !== 6)) {
        throw new Error(`unsupported PNG shape: depth ${bitDepth}, colour type ${colourType}, interlace ${interlace}`)
      }
      channels = colourType === 6 ? 4 : 3
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const data = Buffer.alloc(width * height * 4)
  const previous = Buffer.alloc(stride)
  const current = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? current[i - channels] : 0
      const b = previous[i]
      const c = i >= channels ? previous[i - channels] : 0
      let predictor = 0
      if (filter === 1) predictor = a
      else if (filter === 2) predictor = b
      else if (filter === 3) predictor = (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else if (filter !== 0) throw new Error(`unknown PNG filter ${filter}`)
      current[i] = (line[i] + predictor) & 0xff
    }
    for (let x = 0; x < width; x++) {
      const src = x * channels
      const dst = (y * width + x) * 4
      data[dst] = current[src]
      data[dst + 1] = current[src + 1]
      data[dst + 2] = current[src + 2]
      data[dst + 3] = channels === 4 ? current[src + 3] : 0xff
    }
    current.copy(previous)
  }
  return { width, height, data }
}

function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

async function renderPng(file: keyof typeof ICON_ROUTES, environment: string | undefined): Promise<Png> {
  vi.resetModules()
  // `undefined` deletes the key — the production convention is UNSET, not empty.
  vi.stubEnv('NEXT_PUBLIC_HAVEN_ENV', environment)
  const route = await ICON_ROUTES[file]()
  const response: Response = route.default()
  expect(response.headers.get('content-type')).toBe('image/png')
  return decodePng(Buffer.from(await response.arrayBuffer()))
}

function pixel(png: Png, x: number, y: number): Rgb {
  const i = (y * png.width + x) * 4
  return [png.data[i], png.data[i + 1], png.data[i + 2]]
}

/** Bounding box of every pixel within `tolerance` of `colour`, over rows [top, bottom). */
function boundingBox(png: Png, colour: Rgb, top = 0, bottom = png.height, tolerance = 8) {
  let minX = png.width
  let minY = png.height
  let maxX = -1
  let maxY = -1
  for (let y = top; y < bottom; y++) {
    for (let x = 0; x < png.width; x++) {
      const [r, g, b] = pixel(png, x, y)
      if (
        Math.abs(r - colour[0]) <= tolerance &&
        Math.abs(g - colour[1]) <= tolerance &&
        Math.abs(b - colour[2]) <= tolerance
      ) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

const BRAND = hexToRgb(BRAND_COLOURS.brand)
const ON_BRAND = hexToRgb(BRAND_COLOURS.onBrand)
const WARNING = hexToRgb(BRAND_COLOURS.warning)

const CASES = [
  ['icon1', APP_ICONS.small.size],
  ['icon2', APP_ICONS.large.size],
  ['apple-icon', APP_ICONS.apple.size],
] as const

describe('rendered home-screen icons (#2729)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe.each(CASES)('%s', (file, size) => {
    it('production: brand field, on-brand H at HavenMark proportion, no band', async () => {
      expect(BRAND_COLOURS.onBrand).not.toBe(BRAND_COLOURS.brand)
      const png = await renderPng(file, undefined)
      expect([png.width, png.height]).toEqual([size, size])
      expect(pixel(png, 2, 2)).toEqual(BRAND)
      expect(pixel(png, size - 3, size - 3)).toEqual(BRAND)
      // Bottom-centre is still field on prod — the band exists only off production.
      expect(pixel(png, Math.floor(size / 2), size - 3)).toEqual(BRAND)
      // The crossbar passes through the canvas centre.
      expect(pixel(png, Math.floor(size / 2), Math.floor(size / 2))).toEqual(ON_BRAND)

      const geometry = appIconGeometry(size, false)
      const mark = boundingBox(png, ON_BRAND)
      expect(Math.abs(mark.width - geometry.crossbarWidth)).toBeLessThanOrEqual(2)
      expect(Math.abs(mark.height - geometry.uprightHeight)).toBeLessThanOrEqual(2)
      // HavenMark's H is 50% × 55% of its inset tile; on a full-bleed field
      // that is 10 × 11 of 24. A third of the tile is the defect, not a pass.
      expect(mark.width / size).toBeGreaterThan(0.4)
      expect(mark.height / size).toBeGreaterThan(0.45)
      // And a ceiling, so the symmetric defect (an H that swallows the tile,
      // which every centring check would still pass) fails too.
      expect(mark.width / size).toBeLessThan(0.6)
      expect(mark.height / size).toBeLessThan(0.6)
      // Centred both ways.
      expect(Math.abs(mark.minX - (size - 1 - mark.maxX))).toBeLessThanOrEqual(2)
      expect(Math.abs(mark.minY - (size - 1 - mark.maxY))).toBeLessThanOrEqual(2)
    })

    it('dev: the same mark, lifted to the centre of the field above a warning band', async () => {
      const png = await renderPng(file, 'dev')
      expect([png.width, png.height]).toEqual([size, size])
      const geometry = appIconGeometry(size, true)
      const bandTop = size - geometry.badgeHeight
      expect(pixel(png, 2, 2)).toEqual(BRAND)
      expect(pixel(png, Math.floor(size / 2), size - 3)).toEqual(WARNING)
      expect(pixel(png, 2, bandTop + 2)).toEqual(WARNING)
      expect(pixel(png, 2, bandTop - 2)).toEqual(BRAND)

      // Only look for the H above the band: the badge text is white too.
      const mark = boundingBox(png, ON_BRAND, 0, bandTop)
      expect(mark.width / size).toBeGreaterThan(0.4)
      expect(Math.abs(mark.width - geometry.crossbarWidth)).toBeLessThanOrEqual(2)
      // Gap above the mark equals the gap between the mark and the band.
      const above = mark.minY
      const below = bandTop - 1 - mark.maxY
      expect(Math.abs(above - below)).toBeLessThanOrEqual(3)
      // And the band carries white text (the environment name), centred.
      const text = boundingBox(png, ON_BRAND, bandTop, size)
      expect(text.width).toBeGreaterThan(size * 0.2)
      expect(Math.abs(text.minX - (size - 1 - text.maxX))).toBeLessThanOrEqual(3)
    })

    it('a long environment name shrinks to fit the band instead of overflowing it', async () => {
      const png = await renderPng(file, 'pull-request-preview')
      const geometry = appIconGeometry(size, true)
      const bandTop = size - geometry.badgeHeight
      const text = boundingBox(png, ON_BRAND, bandTop, size)
      // An empty box reports minX = width, maxX = -1 and would pass the
      // containment checks vacuously — so first, there IS text.
      expect(text.width).toBeGreaterThan(0)
      // Inside the canvas with a margin on both sides, and vertically inside the band.
      expect(text.minX).toBeGreaterThan(size * 0.02)
      expect(text.maxX).toBeLessThan(size * 0.98)
      expect(text.minY).toBeGreaterThanOrEqual(bandTop)
      expect(text.maxY).toBeLessThan(size)
      // And it is the whole word, not a clipped one: wider than the three-letter badge.
      const dev = boundingBox(await renderPng(file, 'dev'), ON_BRAND, bandTop, size)
      expect(text.width).toBeGreaterThan(dev.width)
    })
  })
})
