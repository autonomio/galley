// Line diffs: the runs of lines that changed between two versions of a document.
import { describe, expect, it } from 'vitest'
import { lineHunks } from '../../src/core/diff.js'

const lines = (s: string) => s.split('\n')

describe('lineHunks', () => {
  it('finds nothing when nothing changed', () => {
    expect(lineHunks(lines('a\nb'), lines('a\nb'))).toEqual([])
  })

  it('finds a section written at the end', () => {
    expect(lineHunks(lines('# T\n\n## Methods'), lines('# T\n\n## Methods\n\nWe measured.'))).toEqual([{ a: 3, aEnd: 3, b: 3, bEnd: 5 }])
  })

  it('keeps a line changed in place apart from lines added elsewhere', () => {
    expect(lineHunks(lines('a\nb\nc\nd'), lines('a\nB\nc\nd\ne'))).toEqual([{ a: 1, aEnd: 2, b: 1, bEnd: 2 }, { a: 4, aEnd: 4, b: 4, bEnd: 5 }])
  })

  it('finds lines that are gone', () => {
    expect(lineHunks(lines('a\nb\nc'), lines('a\nc'))).toEqual([{ a: 1, aEnd: 2, b: 1, bEnd: 1 }])
  })

  it('covers everything when every line changed', () => {
    expect(lineHunks(lines('a\nb'), lines('x\ny\nz'))).toEqual([{ a: 0, aEnd: 2, b: 0, bEnd: 3 }])
  })
})
