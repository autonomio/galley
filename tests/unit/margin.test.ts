// The comments column's cards: level with their passages, never over one another, never above the page.
import { describe, expect, it } from 'vitest'
import { stack } from '../../src/editor/margin.js'

describe('stack', () => {
  it('puts each card level with its passage, or just below the card before it', () => {
    expect(stack([{ top: 10, height: 50 }, { top: 30, height: 20 }, { top: 200, height: 10 }])).toEqual([10, 68, 200])
  })

  it('keeps the open card level with its passage, the cards before it moving up, but never above the page', () => {
    expect(stack([{ top: 100, height: 40 }, { top: 110, height: 40 }], 1)).toEqual([62, 110])
    expect(stack([{ top: 10, height: 40 }, { top: 20, height: 40 }], 1)).toEqual([0, 48])
  })
})
