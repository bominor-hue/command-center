import { describe, expect, it } from 'vitest'
import type { CropHarvest, FieldRow, HarvestFieldRow } from '../hub/types'
import { buildPlanting, fmt, nameKey, wallOrder } from './harvest'

const field = (name: string, crop: string, acres: number): FieldRow => ({
  id: `2026|${name}`, cropYear: 2026, farm: 'Akin Farm', name, crop, water: 'Irrigated', plannedAcres: acres, producer: null, fsn: null, county: null,
})
const row = (field: string, x: Partial<HarvestFieldRow>): HarvestFieldRow => ({
  fsn: null, farm: 'Akin', field, water: 'Irrigated', acres: 50, variety: null, planted: null, staged: null, harvested: null, basis: null,
  status: 'not_started', projected: false, cells: {}, ...x,
})
const book = (fields: HarvestFieldRow[]): CropHarvest => ({
  crop: 'Peanuts', stage: 'Dug', unit: 'lbs/ac', unitsLabel: 'Loads', progress: { planted: 0, staged: 0, harvested: 0 },
  summaryCols: [], summary: [], kpis: [], fieldCols: [], fields, note: null, workbook: null, asOf: '2026-10-22T00:00:00Z', source: { source: 'test' },
})

describe('fmt', () => {
  it('formats like the workbook', () => {
    expect(fmt(4257.46, 'int')).toBe('4,257')
    expect(fmt(72.325, 'dec1')).toBe('72.3')
    expect(fmt(0.9738, 'pct')).toBe('97%')
    expect(fmt(1484200.79, 'money0')).toBe('$1.48M')
    expect(fmt(-123.4, 'signed')).toBe('-123')
    expect(fmt(null, 'int')).toBe('—')
    expect(fmt('993 vs 1,192', 'text')).toBe('993 vs 1,192')
  })
})

describe('wallOrder', () => {
  it('puts fields being harvested first and finished fields last', () => {
    const order = wallOrder([
      row('Done early', { status: 'final', harvested: '2026-09-18' }),
      row('Dug late', { status: 'staged', staged: '2026-10-20' }),
      row('Picking', { status: 'harvesting' }),
      row('Done late', { status: 'final', harvested: '2026-10-19' }),
      row('Dug early', { status: 'staged', staged: '2026-10-14' }),
      row('Not yet', { status: 'not_started', planted: '2026-06-05' }),
    ]).map((r) => r.field)
    expect(order).toEqual(['Picking', 'Dug early', 'Dug late', 'Not yet', 'Done late', 'Done early'])
  })
})

describe('buildPlanting', () => {
  const fm = [field('Fletcher # 6', 'Peanuts', 35), field('Akin #3', 'Peanuts', 60), field('Hodges #7', 'Peanuts', 135), field('A&B #1', 'Corn', 140)]
  it('joins the workbook to the Field Master by name, with Deere filling dates the workbook lacks', () => {
    const p = buildPlanting('Peanuts', fm, book([
      row('Fletcher #6', { acres: 34, planted: '2026-05-23', variety: 'GA 06G' }), // same field, different spacing
      row('Akin #3', { acres: 60, planted: '2026-04-23' }),
      row('Workbook only', { acres: 20, planted: '2026-04-24' }),
    ]), [
      { field: 'Hodges #7', crop: 'PEANUTS', date: '2026-05-19T15:00:00Z', acres: 130, variety: 'GA 06G' },
      { field: 'Akin #3', crop: 'PEANUTS', date: '2026-04-22T15:00:00Z', acres: 60, variety: null }, // the workbook date stands
      { field: 'A&B #1', crop: 'CORN_WET', date: '2026-03-06T15:00:00Z', acres: 140, variety: null }, // other crop
    ])
    expect(p.fields).toBe(4)
    expect(p.fieldsPlanted).toBe(4)
    expect(p.planned).toBe(34 + 60 + 135 + 20)
    const by = Object.fromEntries(p.rows.map((r) => [r.field, r]))
    expect(by['Fletcher # 6']).toMatchObject({ acres: 34, planted: '2026-05-23', source: 'Workbook', variety: 'GA 06G' })
    expect(by['Akin #3']).toMatchObject({ planted: '2026-04-23', source: 'Workbook' })
    expect(by['Hodges #7']).toMatchObject({ planted: '2026-05-19', source: 'Deere', variety: 'GA 06G' })
    expect(p.first).toBe('2026-04-23')
    expect(p.last).toBe('2026-05-23')
    // Weeks start Monday: Apr 20 (Akin #3, Workbook only), May 18 (Hodges #7, Fletcher)
    expect(p.weeks).toEqual([{ start: '2026-04-20', acres: 80 }, { start: '2026-05-18', acres: 169 }])
  })
  it('lists fields not planted yet first', () => {
    const p = buildPlanting('Peanuts', fm, undefined, [{ field: 'Akin #3', crop: null, date: '2026-04-22T15:00:00Z', acres: 60, variety: null }])
    expect(p.rows.map((r) => r.field)).toEqual(['Hodges #7', 'Fletcher # 6', 'Akin #3'])
    expect(p.planted).toBe(60)
  })
  it('matches names ignoring case and spaces', () => expect(nameKey('Fletcher # 6')).toBe(nameKey('fletcher #6')))
  it('joins a near-miss spelling to the Field Master field instead of adding a second row', () => {
    const p = buildPlanting('Cotton', [field('L&C Dryland', 'Cotton', 90), field('Sheppherd #1W', 'Cotton', 124), field('Akin #1', 'Cotton', 10)],
      book([row('LC Dryland', { acres: 90, planted: '2026-06-05' }), row('Sheppard #1W', { acres: 124, planted: '2026-06-05' }), row('Akin #9', { acres: 5, planted: '2026-06-01' })]), [])
    expect(p.rows.map((r) => r.field).sort()).toEqual(['Akin #1', 'Akin #9', 'L&C Dryland', 'Sheppherd #1W'])
    expect(p.planted).toBe(90 + 124 + 5)
  })
})
