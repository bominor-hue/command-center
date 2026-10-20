import { describe, expect, it } from 'vitest'
import { LAYOUTS, seasonFor } from './season'

describe('seasonFor', () => {
  it.each([
    ['2026-01-15', 'off'], ['2026-03-31', 'off'], ['2026-04-01', 'planting'], ['2026-05-15', 'planting'],
    ['2026-05-16', 'growing'], ['2026-08-31', 'growing'], ['2026-09-01', 'harvest'], ['2026-11-30', 'harvest'], ['2026-12-01', 'off'],
  ])('%s is %s', (d, s) => expect(seasonFor(new Date(`${d}T12:00:00`))).toBe(s))
})

describe('LAYOUTS', () => {
  it('every season has a lead panel and four others, no repeats', () => {
    for (const l of Object.values(LAYOUTS)) expect(new Set([l.lead, ...l.row]).size).toBe(5)
  })
  it('the water panel stays on the wall in the seasons pivots run', () => {
    for (const s of ['growing', 'harvest', 'planting'] as const) expect([LAYOUTS[s].lead, ...LAYOUTS[s].row]).toContain('water')
  })
})
