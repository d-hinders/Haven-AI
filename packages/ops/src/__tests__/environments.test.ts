/**
 * The environment registry, under test (#3515).
 *
 * Every acceptance criterion that is pure data lives here: invalid or
 * non-https entries are dropped, an empty registry is an error the UI shows,
 * and `prod` exclusion is key-based.
 */
import { describe, expect, it } from 'vitest'
import {
  defaultEnvironment,
  excludeProd,
  parseEnvironments,
} from '../lib/environments'

describe('parseEnvironments', () => {
  it('accepts a registry of https origins', () => {
    const { environments, error } = parseEnvironments(
      '{"dev":"https://api.dev.example","prod":"https://api.example"}',
    )
    expect(error).toBeNull()
    expect(environments).toEqual([
      { key: 'dev', origin: 'https://api.dev.example' },
      { key: 'prod', origin: 'https://api.example' },
    ])
  })

  it('allows http for localhost only', () => {
    const { environments, error } = parseEnvironments(
      '{"dev":"http://localhost:3001","staging":"http://staging.example"}',
    )
    expect(error).toBeNull()
    expect(environments).toEqual([{ key: 'dev', origin: 'http://localhost:3001' }])
  })

  it('drops invalid entries and keeps the rest', () => {
    const { environments, error } = parseEnvironments(
      '{"broken":"not a url","insecure":"http://staging.example","empty":"","dev":"https://api.dev.example"}',
    )
    expect(error).toBeNull()
    expect(environments).toEqual([{ key: 'dev', origin: 'https://api.dev.example' }])
  })

  it('treats a missing, blank, or unparseable registry as a config error', () => {
    for (const raw of [undefined, null, '', '   ', '{oops']) {
      const { environments, error } = parseEnvironments(raw as string)
      expect(environments).toEqual([])
      expect(error).toBeTruthy()
    }
  })

  it('treats a non-object registry as a config error', () => {
    for (const raw of ['"dev"', '[]', 'null', '7']) {
      const { environments, error } = parseEnvironments(raw)
      expect(environments).toEqual([])
      expect(error).toBeTruthy()
    }
  })

  it('reports a config error when every entry was dropped', () => {
    const { environments, error } = parseEnvironments('{"insecure":"http://staging.example"}')
    expect(environments).toEqual([])
    expect(error).toBeTruthy()
  })
})

describe('excludeProd', () => {
  it('drops the prod key, whatever its origin', () => {
    const environments = [
      { key: 'prod', origin: 'https://api.example' },
      { key: 'dev', origin: 'https://api.dev.example' },
    ]
    expect(excludeProd(environments).map((e) => e.key)).toEqual(['dev'])
  })

  it('leaves a registry without prod untouched', () => {
    const environments = [{ key: 'dev', origin: 'https://api.dev.example' }]
    expect(excludeProd(environments)).toEqual(environments)
  })
})

describe('defaultEnvironment', () => {
  it('prefers prod when the registry offers it', () => {
    expect(
      defaultEnvironment([
        { key: 'dev', origin: 'https://api.dev.example' },
        { key: 'prod', origin: 'https://api.example' },
      ]),
    ).toBe('prod')
  })

  it('falls back to the first environment otherwise', () => {
    expect(defaultEnvironment([{ key: 'dev', origin: 'https://api.dev.example' }])).toBe('dev')
  })
})
