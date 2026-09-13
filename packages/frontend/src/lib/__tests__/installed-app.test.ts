import { readFileSync } from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { BRAND_COLOURS, BRAND_COLOUR_TOKENS, DARK_BRAND_COLOUR_TOKENS } from '../brand-colours'
import { PRODUCTION_ENVIRONMENT } from '../env'
import {
  APP_ICONS,
  INSTALLED_APP_SCOPE,
  INSTALLED_APP_START_URL,
  INSTALLED_APP_VIEWPORT,
  buildWebManifest,
  installedAppIdentity,
  installedAppMetadata,
} from '../installed-app'

/**
 * The installed-app shell's builders (#2729), per environment.
 *
 * Three things are proven by execution rather than by reading source:
 * the colours the manifest carries are the `globals.css` tokens (parsed from
 * the stylesheet, so the pinned copy in `brand-colours.ts` cannot drift); the
 * icon routes render the size the manifest advertises; and the dev icon
 * carries its badge while the prod icon does not — asserted over the element
 * tree each route hands `ImageResponse`, which is stubbed so the test needs
 * neither satori nor its wasm.
 */

const FRONTEND_ROOT = path.resolve(__dirname, '../../..')
const GLOBALS_CSS = readFileSync(path.join(FRONTEND_ROOT, 'src/app/globals.css'), 'utf8')

/** The `:root` (light palette) block of globals.css, comments stripped. */
function rootBlock(): string {
  const css = GLOBALS_CSS.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const open = css.indexOf(':root {')
  if (open < 0) throw new Error('globals.css: :root block not found')
  let depth = 0
  const brace = css.indexOf('{', open)
  for (let i = brace; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}') {
      depth--
      if (depth === 0) return css.slice(brace + 1, i)
    }
  }
  throw new Error('globals.css: unbalanced :root block')
}

function cssToken(name: string): string {
  // Exactly one definition INSIDE the :root (light) block: #2927 added two
  // dark re-declaration blocks, so a whole-file search would find each colour
  // token three times — and the manifest's value is the LIGHT one (the
  // installed shell's theme_color is slice 2's OS-follow work). Scoping the
  // parse to :root keeps "exactly once" meaningful: the day a token vanishes
  // from the light palette, this is where that shows.
  const matches = [...rootBlock().matchAll(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`, 'g'))]
  if (matches.length !== 1) throw new Error(`globals.css :root defines ${name} ${matches.length} times, expected once`)
  return matches[0][1].toLowerCase()
}

/**
 * The dark re-declaration block of globals.css, comments stripped (#2928).
 *
 * #2927 shipped TWO dark blocks — the `@media (prefers-color-scheme: dark)`
 * one and the `:root[data-theme="dark"]` one — and its review verified them
 * byte-identical (60 declarations each), so parsing either is correct. The
 * media block is the one pinned here because it is what a browser with no
 * `data-theme` stamp reads, and an unstamped document is exactly the state
 * the OS-decides half of the status-bar pair describes. The selectors also
 * occur in prose (the block's own docstring names them), so the comment
 * strip runs before the search: a parser over the raw text would find each
 * selector twice and have no way to tell the block from the prose about it.
 */
function darkBlock(): string {
  const css = GLOBALS_CSS.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const atMedia = css.indexOf('@media (prefers-color-scheme: dark)')
  if (atMedia < 0) throw new Error('globals.css: dark @media block not found')
  // Brace-match the @media block itself, then its single inner rule. The
  // brace count is asserted rather than assumed: a second rule inside the
  // block (a nested @media, a second selector) would make "the inner block"
  // a lie, and this is the test that says so.
  let depth = 0
  const blockOpen = css.indexOf('{', atMedia)
  let i = blockOpen
  for (; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}') {
      depth--
      if (depth === 0) break
    }
  }
  const body = css.slice(blockOpen + 1, i)
  const braces = (body.match(/[{}]/g) ?? []).length
  if (braces !== 2) throw new Error(`dark @media block holds ${braces} braces, expected one rule (2)`)
  const open = body.indexOf('{')
  depth = 0
  for (let j = open; j < body.length; j++) {
    if (body[j] === '{') depth++
    else if (body[j] === '}') {
      depth--
      if (depth === 0) return body.slice(open + 1, j)
    }
  }
  throw new Error('globals.css: unbalanced dark block rule')
}

function darkCssToken(name: string): string {
  // Exactly one definition inside the block. The token is the same `--v2-bg`
  // the light parser reads from `:root`; the two parsers disagree by design,
  // because the status-bar pair (#2928) exists to carry both values.
  const matches = [...darkBlock().matchAll(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`, 'g'))]
  if (matches.length !== 1) {
    throw new Error(`globals.css dark block defines ${name} ${matches.length} times, expected once`)
  }
  return matches[0][1].toLowerCase()
}

describe('brand colours are the globals.css tokens', () => {
  // The two maps are split by BLOCK, not by token: every entry here is a
  // custom property read out of the stylesheet, and the file declares the
  // colour tokens in three blocks (the light :root and the two dark
  // re-declarations #2927 shipped). A key that asked the wrong block would
  // get a real colour that is wrong for its purpose, and only the status bar
  // would ever show it — on a phone. So light entries parse cssToken, dark
  // entries darkCssToken, and the maps decide which.
  it.each(Object.keys(BRAND_COLOUR_TOKENS) as Array<keyof typeof BRAND_COLOUR_TOKENS>)(
    '%s is pinned to its --v2 token in the :root block',
    (key) => {
      expect(BRAND_COLOURS[key]).toBe(cssToken(BRAND_COLOUR_TOKENS[key]))
    },
  )

  // #2928: the status-bar pair carries BOTH palettes' --v2-bg. The dark half
  // is pinned to the dark block, because a "background" string copied from
  // the light palette into the dark entry would be a white status bar above
  // a dark app and no local gate but this one could see it.
  it.each(Object.keys(DARK_BRAND_COLOUR_TOKENS) as Array<keyof typeof DARK_BRAND_COLOUR_TOKENS>)(
    '%s is pinned to its --v2 token in the dark block',
    (key) => {
      expect(BRAND_COLOURS[key]).toBe(darkCssToken(DARK_BRAND_COLOUR_TOKENS[key]))
    },
  )

  it('the dark background is the DARK one — the two halves of the pair differ', () => {
    // The load-bearing assertion of the pair: if a refactor ever copies the
    // light token into the dark entry, every other assertion here still
    // passes (both are '#ffffff', both parse), and only the phone notices.
    // This one catches it before the status bar shows it.
    expect(BRAND_COLOURS.darkBackground).not.toBe(BRAND_COLOURS.background)
    expect(darkCssToken('--v2-bg')).toBe(BRAND_COLOURS.darkBackground)
  })

  it('the parser can say no — an unknown token throws rather than matching nothing', () => {
    expect(() => cssToken('--v2-no-such-token')).toThrow(/0 times/)
    expect(() => darkCssToken('--v2-no-such-token')).toThrow(/0 times/)
  })
})

describe('installedAppIdentity', () => {
  it('production is plain "Haven" with no badge', () => {
    expect(installedAppIdentity(PRODUCTION_ENVIRONMENT)).toEqual({ id: 'haven', name: 'Haven', badge: null })
  })

  it('dev is a distinct app: its own id, a suffixed name, an upper-case badge', () => {
    expect(installedAppIdentity('dev')).toEqual({ id: 'haven-dev', name: 'Haven Dev', badge: 'DEV' })
  })

  it('a third environment gets its own identity without a code change', () => {
    expect(installedAppIdentity('staging')).toEqual({
      id: 'haven-staging',
      name: 'Haven Staging',
      badge: 'STAGING',
    })
  })
})

describe('buildWebManifest', () => {
  it('production: standalone at /dashboard, scoped to /, coloured from the tokens', () => {
    const manifest = buildWebManifest(PRODUCTION_ENVIRONMENT)
    expect(manifest).toMatchObject({
      id: 'haven',
      name: 'Haven',
      short_name: 'Haven',
      start_url: INSTALLED_APP_START_URL,
      scope: INSTALLED_APP_SCOPE,
      display: 'standalone',
      background_color: cssToken('--v2-bg'),
      theme_color: cssToken('--v2-brand'),
    })
    expect(INSTALLED_APP_START_URL).toBe('/dashboard')
    expect(INSTALLED_APP_SCOPE).toBe('/')
  })

  it('dev: same shape, different id and name, so iOS installs it beside prod', () => {
    const prod = buildWebManifest(PRODUCTION_ENVIRONMENT)
    const dev = buildWebManifest('dev')
    expect(dev.id).not.toBe(prod.id)
    expect(dev.name).not.toBe(prod.name)
    expect(dev).toMatchObject({ id: 'haven-dev', name: 'Haven Dev', short_name: 'Haven Dev' })
    // Everything that is not identity is identical between the two installs.
    const { id: _pi, name: _pn, short_name: _ps, ...prodRest } = prod
    const { id: _di, name: _dn, short_name: _ds, ...devRest } = dev
    expect(devRest).toEqual(prodRest)
  })

  it('advertises PNG icons at the Chrome install floor (192 and 512), each a route that exists', () => {
    const icons = buildWebManifest(PRODUCTION_ENVIRONMENT).icons ?? []
    expect(icons.map((icon) => icon.sizes)).toEqual(['192x192', '512x512'])
    for (const icon of icons) {
      expect(icon.type).toBe('image/png')
      expect(icon.src).toMatch(/^\/icon\d$/)
      // `/icon1` is served by `src/app/icon1.tsx`, and so on.
      expect(() => readFileSync(path.join(FRONTEND_ROOT, 'src/app', `${icon.src.slice(1)}.tsx`))).not.toThrow()
    }
  })
})

describe('installedAppMetadata and viewport', () => {
  it('names the iOS install after the environment and marks it capable, both spellings', () => {
    expect(installedAppMetadata('dev')).toEqual({
      applicationName: 'Haven Dev',
      appleWebApp: { capable: true, title: 'Haven Dev', statusBarStyle: 'default' },
      other: { 'apple-mobile-web-app-capable': 'yes' },
    })
    expect(installedAppMetadata(PRODUCTION_ENVIRONMENT).appleWebApp).toMatchObject({ title: 'Haven' })
  })

  it('carries the themeColor MEDIA PAIR, the default viewport, and viewport-fit (#2730, #2928)', () => {
    // #2928 replaced the single brand colour with the two-query pair: the
    // status bar follows the palette, and a manifest (build-time, one value)
    // cannot. The pair is asserted WHOLE, not as a `toMatchObject`, so a third
    // entry — a hand-written 'system' row, which would be wrong: system means
    // "no stamp from the app", the pair already answers it — reddens here.
    expect(INSTALLED_APP_VIEWPORT).toEqual({
      width: 'device-width',
      initialScale: 1,
      viewportFit: 'cover',
      themeColor: [
        { media: '(prefers-color-scheme: light)', color: BRAND_COLOURS.background },
        { media: '(prefers-color-scheme: dark)', color: BRAND_COLOURS.darkBackground },
      ],
    })
    // And both entries are the tokens, read out of their OWN blocks by the
    // parsers above — the light half from `:root`, the dark half from the dark
    // re-declaration. `theme_color` in the manifest stays brand indigo (a
    // manifest cannot vary by scheme); only the viewport meta follows.
    const [light, dark] = INSTALLED_APP_VIEWPORT.themeColor as Array<{ media: string; color: string }>
    expect(light).toEqual({ media: '(prefers-color-scheme: light)', color: cssToken('--v2-bg') })
    expect(dark).toEqual({ media: '(prefers-color-scheme: dark)', color: darkCssToken('--v2-bg') })
    expect(buildWebManifest(PRODUCTION_ENVIRONMENT).theme_color).toBe(cssToken('--v2-brand'))
  })

  it('viewport-fit and the safe-area rules are one change, and neither is safe alone (#2730)', () => {
    // #2729 asserted `not.toHaveProperty('viewportFit')` here, deliberately, so
    // that the day it appeared somebody had to come back to this file. This is
    // that visit. `cover` is what extends the page under the notch and the home
    // indicator — and therefore what makes `env(safe-area-inset-*)` report
    // anything but 0 — so shipping it without the padding puts controls under
    // the status bar, and shipping the padding without it leaves the padding
    // permanently 0. The stylesheet half is asserted here rather than left to
    // prose: `globals.css` must declare all four insets, and it is what every
    // rule and every Playwright inset test reads.
    expect(INSTALLED_APP_VIEWPORT.viewportFit).toBe('cover')
    for (const side of ['top', 'right', 'bottom', 'left']) {
      expect(GLOBALS_CSS, `--v2-safe-${side} must read env(safe-area-inset-${side})`).toContain(
        `--v2-safe-${side}: env(safe-area-inset-${side}, 0px);`,
      )
    }
  })
})

/**
 * The generated icon routes, executed. `ImageResponse` is replaced with a
 * recorder so the assertion is on what each route actually hands it: the
 * element tree (badge or no badge) and the size options.
 */
interface RecordedImage {
  element: ReactElement
  options: { width: number; height: number } | undefined
}
const recorded: RecordedImage[] = []
vi.mock('next/og', () => ({
  ImageResponse: class {
    constructor(element: ReactElement, options?: { width: number; height: number }) {
      recorded.push({ element, options })
    }
  },
}))

// Static import sites, so Vite can see them; the key is the route path.
const ICON_ROUTES = {
  icon1: () => import('@/app/icon1'),
  icon2: () => import('@/app/icon2'),
  'apple-icon': () => import('@/app/apple-icon'),
} as const

async function renderRoute(file: keyof typeof ICON_ROUTES, environment: string | undefined) {
  vi.resetModules()
  // `undefined` deletes the key — the production convention is UNSET, not empty.
  vi.stubEnv('NEXT_PUBLIC_HAVEN_ENV', environment)
  const route = await ICON_ROUTES[file]()
  recorded.length = 0
  route.default()
  expect(recorded).toHaveLength(1)
  return { route, markup: renderToStaticMarkup(recorded[0].element), options: recorded[0].options }
}

describe('generated icon routes', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.each([
    ['icon1', APP_ICONS.small],
    ['icon2', APP_ICONS.large],
    ['apple-icon', APP_ICONS.apple],
  ] as const)('%s renders a PNG at the size the manifest and the <link> advertise', async (file, icon) => {
    const { route, options } = await renderRoute(file, undefined)
    expect(route.contentType).toBe('image/png')
    expect(route.size).toEqual({ width: icon.size, height: icon.size })
    expect(options).toEqual({ width: icon.size, height: icon.size })
    expect(`/${file}`).toBe(icon.path)
  })

  it('the production icon carries no badge', async () => {
    const { markup } = await renderRoute('apple-icon', undefined)
    expect(markup).not.toContain('DEV')
    expect(markup).not.toContain(BRAND_COLOURS.warning)
    expect(markup).toContain(BRAND_COLOURS.brand)
  })

  it('the dev icon is visibly badged in the warning tone, so the two installs read apart', async () => {
    const { markup } = await renderRoute('apple-icon', 'dev')
    expect(markup).toContain('DEV')
    expect(markup).toContain(BRAND_COLOURS.warning)
  })
})
