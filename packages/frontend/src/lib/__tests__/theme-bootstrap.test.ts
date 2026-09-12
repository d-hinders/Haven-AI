import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { THEME_BOOTSTRAP_SCRIPT, THEME_STORAGE_KEY } from '../theme-bootstrap'

/**
 * The no-flash bootstrap (#2927).
 *
 * The script is a constant string inlined into <head>; these tests execute
 * it (via `new Function`) against the real jsdom document so the parse +
 * behaviour claims hold on the exact text that ships.
 */

function runBootstrap() {
  // eslint-disable-next-line no-new-func
  new Function(THEME_BOOTSTRAP_SCRIPT)()
}

function storedTheme(): string | null {
  return window.localStorage.getItem(THEME_STORAGE_KEY)
}

describe('THEME_BOOTSTRAP_SCRIPT', () => {
  beforeEach(() => {
    window.localStorage.clear()
    delete document.documentElement.dataset.theme
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete document.documentElement.dataset.theme
  })

  it('parses as JavaScript', () => {
    expect(() => new Function(THEME_BOOTSTRAP_SCRIPT)).not.toThrow()
  })

  it('with haven.theme = dark it stamps data-theme="dark"', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    runBootstrap()
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('with haven.theme = light it stamps data-theme="light"', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light')
    runBootstrap()
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('with system, or with nothing stored, it stamps nothing', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'system')
    runBootstrap()
    expect(document.documentElement.dataset.theme).toBeUndefined()

    delete document.documentElement.dataset.theme
    window.localStorage.removeItem(THEME_STORAGE_KEY)
    runBootstrap()
    expect(document.documentElement.dataset.theme).toBeUndefined()
  })

  it('a stale/unknown stored value stamps nothing', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'banana')
    runBootstrap()
    expect(document.documentElement.dataset.theme).toBeUndefined()
  })

  it('storage throwing does not crash first paint', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(() => runBootstrap()).not.toThrow()
    expect(document.documentElement.dataset.theme).toBeUndefined()
  })

  it('touches only documentElement.dataset.theme — no classes, no styles, no other attributes', () => {
    const root = document.documentElement
    root.className = 'canary-class'
    root.setAttribute('lang', 'en')
    const before = {
      classes: root.className,
      lang: root.getAttribute('lang'),
      attributeNames: [...root.getAttributeNames()].sort(),
    }

    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    runBootstrap()

    expect(root.className).toBe(before.classes)
    expect(root.getAttribute('lang')).toBe(before.lang)
    expect([...root.getAttributeNames()].sort()).toEqual(
      [...before.attributeNames, 'data-theme'].sort(),
    )
    expect(root.getAttribute('style')).toBeNull()
  })
})
