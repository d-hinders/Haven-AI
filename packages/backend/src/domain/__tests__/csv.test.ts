import { describe, it, expect } from 'vitest'
import { csvField, toCsv, CSV_BOM } from '../csv.js'

describe('csvField', () => {
  it('always quotes, so a comma never splits a field', () => {
    expect(csvField('Acme, Inc')).toBe('"Acme, Inc"')
  })

  it('doubles embedded quotes per RFC 4180', () => {
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
  })

  it('keeps an embedded newline inside the quoted field', () => {
    expect(csvField('line1\nline2')).toBe('"line1\nline2"')
  })

  it('neutralises leading formula characters', () => {
    // A counterparty name comes from the user-controlled address book, so a
    // value starting with one of these must not execute in Excel/Sheets.
    expect(csvField('=1+1')).toBe('"\'=1+1"')
    expect(csvField('+cmd')).toBe('"\'+cmd"')
    expect(csvField('-2')).toBe('"\'-2"')
    expect(csvField('@SUM(A1)')).toBe('"\'@SUM(A1)"')
    expect(csvField('\tx')).toBe('"\'\tx"')
    expect(csvField('\rx')).toBe('"\'\rx"')
  })

  it('leaves an ordinary value alone apart from the quotes', () => {
    expect(csvField('0.50')).toBe('"0.50"')
    expect(csvField('')).toBe('""')
  })
})

describe('toCsv', () => {
  const columns = ['a', 'b'] as const

  it('writes the header first and CRLF between records', () => {
    expect(toCsv(columns, [{ a: '1', b: '2' }])).toBe('a,b\r\n"1","2"')
  })

  it('writes a header-only file for no rows', () => {
    expect(toCsv(columns, [])).toBe('a,b')
  })

  it('writes a missing value as an empty field rather than throwing', () => {
    expect(toCsv(columns, [{ a: '1' }])).toBe('a,b\r\n"1",""')
  })

  it('quotes every field of a row containing separators', () => {
    expect(toCsv(columns, [{ a: 'x,y', b: 'q"z' }])).toBe('a,b\r\n"x,y","q""z"')
  })
})

describe('CSV_BOM', () => {
  it('is the UTF-8 byte-order mark Excel needs to read the file as UTF-8', () => {
    expect(CSV_BOM).toBe('﻿')
    expect(Buffer.from(CSV_BOM, 'utf8')).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
  })
})
