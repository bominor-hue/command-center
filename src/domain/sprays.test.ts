import { describe, expect, it } from 'vitest'
import type { Application, FieldRow } from '../hub/types'
import { bySprayNeed, farmDay, fertRow, nLbPerAc, productKind, PROGRAMS, programRows, sprayRow, unclassified } from './sprays'

const src = { source: 'Deere Ops Center' }
const app = (date: string, products: string[], rates?: Application['rates']): Application => ({ date, products, acres: 60, rates, source: src })
const peanut = PROGRAMS.find((p) => p.id === 'peanut-fungicide')!
const pix = PROGRAMS.find((p) => p.id === 'cotton-pgr')!
const planted = { date: '2026-04-23', variety: 'TifNV-HG', source: src }
const field = (name: string, crop: string): FieldRow => ({ id: `2026|${name}`, cropYear: 2026, farm: 'Akin Farm', name, crop, water: 'Irrigated', plannedAcres: 60, producer: null, fsn: null, county: null })

describe('productKind', () => {
  it('matches the start of a name, as Deere writes them', () => {
    expect(productKind('Pix 6x')).toBe('pgr')
    expect(productKind('Warrant~6')).toBe('herbicide')
    expect(productKind('Reflex (1)')).toBe('herbicide')
    expect(productKind('Bidrin 8')).toBe('insecticide')
    expect(productKind('19-11-0Z')).toBe('fertilizer')
    expect(productKind('28-0-0-5')).toBe('fertilizer')
    expect(productKind('Bravo WeatherStik')).toBe('fungicide')
    expect(productKind('Choice Trio')).toBe('adjuvant')
  })
  it('a name ending in a letter must end a word, and unknown names stay unknown', () => {
    expect(productKind('Pixel')).toBeNull()
    expect(productKind('Reign')).toBeNull()
    expect(unclassified([app('2026-06-10', ['Choice Trio', 'Reign', 'Liberty', 'Vertento'])])).toEqual(['Reign', 'Vertento'])
  })
})

describe('sprayRow (peanut fungicide, 45 DAP then every 15)', () => {
  it('first pass due 45 days after planting; the buckets match Bo\'s sheet', () => {
    expect(sprayRow(peanut, planted, [], '2026-05-20')).toMatchObject({ status: 'ontrack', dap: 27, next: { n: 1, dap: 45, date: '2026-06-07', inDays: 18 } })
    expect(sprayRow(peanut, planted, [], '2026-05-26').status).toBe('soon')
    expect(sprayRow(peanut, planted, [], '2026-06-03').status).toBe('due')
    expect(sprayRow(peanut, planted, [], '2026-06-10')).toMatchObject({ status: 'overdue', next: { inDays: -3 } })
  })
  it('the n-th pass sprayed fills the n-th slot; herbicides and pre-plant passes do not count', () => {
    const apps = [app('2026-04-20', ['Bravo']), app('2026-06-08', ['Elatus', 'Bravo WeatherStik']), app('2026-06-12', ['Liberty']), app('2026-06-24', ['Provost Silver'])]
    const r = sprayRow(peanut, planted, apps, '2026-07-02')
    expect(r).toMatchObject({ done: 2, total: 7, sinceLast: 8, next: { n: 3, dap: 75, date: '2026-07-07' }, status: 'due' })
    expect(r.last?.products).toEqual(['Provost Silver'])
  })
  it('two operations on the same day are one pass', () => {
    expect(sprayRow(peanut, planted, [app('2026-06-08', ['Elatus']), app('2026-06-08', ['Bravo'])], '2026-06-10').done).toBe(1)
  })
  it('complete after the last pass, and no planting means no due dates', () => {
    const all = [45, 60, 75, 90, 105, 120, 135].map((d) => app(new Date(Date.parse('2026-04-23') + d * 86400000).toISOString().slice(0, 10), ['Bravo']))
    expect(sprayRow(peanut, planted, all, '2026-09-20').status).toBe('complete')
    expect(sprayRow(peanut, undefined, [], '2026-06-10')).toMatchObject({ status: 'unplanted', next: null })
  })
  it('a program without timings shows passes on file and days since the last one', () => {
    const r = sprayRow(pix, planted, [app('2026-06-11', ['Choice Trio', 'Liberty', 'Pix', 'Warrant']), app('2026-07-13', ['Bidrin 8', 'Full-bor', 'Pix 6x'])], '2026-07-20')
    expect(r).toMatchObject({ status: 'unset', done: 2, total: null, sinceLast: 7 })
  })
})

describe('programRows', () => {
  it('only the program\'s crop, most urgent first', () => {
    const fields = [field('Akin #3', 'Peanuts'), field('Akin #8', 'Peanuts'), field('Akin #1N', 'Cotton')]
    const plantings = { '2026|Akin #3': planted, '2026|Akin #8': { ...planted, date: '2026-05-20' } }
    const rows = programRows(peanut, fields, plantings, {}, '2026-06-20')
    expect(rows.map((r) => r.field.name)).toEqual(['Akin #3', 'Akin #8'])
    expect(rows.map((r) => r.row.status)).toEqual(['overdue', 'soon'])
    expect([...rows].sort(bySprayNeed)[0].field.name).toBe('Akin #3')
  })
})

describe('fertilizer', () => {
  it('lb N per acre from the analysis and the rate', () => {
    expect(nLbPerAc('28-0-0-5', 10, 'gal1ac-1')).toBeCloseTo(29.85, 1) // 10 gal x 10.66 lb x 28%
    expect(nLbPerAc('11-52-0', 100, 'lb1ac-1')).toBe(11)
    expect(nLbPerAc('24-0-0-3', 10, 'gal1ac-1')).toBeNull() // weight per gallon not on the list
    expect(nLbPerAc('Full-bor', 1, 'qt1ac-1')).toBeNull()
  })
  it('fertRow adds up the passes; a pass without a rate leaves the total a floor', () => {
    const f = field('Sheppherd #1W', 'Corn')
    const r = fertRow(f, [app('2026-04-01', ['19-11-0Z']), app('2026-05-20', ['28-0-0-5'], [{ product: '28-0-0-5', rate: 30, unit: 'gal1ac-1' }]), app('2026-05-01', ['Roundup'])])
    expect(r).toMatchObject({ nLbAc: 90, nKnown: false })
    expect(r.passes.map((a) => a.date)).toEqual(['2026-04-01', '2026-05-20'])
  })
})

it('farmDay is the Georgia calendar day', () => {
  expect(farmDay(new Date('2026-06-06T02:00:00Z'))).toBe('2026-06-05')
})
