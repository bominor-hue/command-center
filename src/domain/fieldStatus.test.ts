import { describe, expect, it } from 'vitest'
import type { FarmForecast, FieldRow, LastOperation } from '../hub/types'
import { byNeed, farmKey, fieldState, heavyRainAhead } from './fieldStatus'

const field: FieldRow = { id: '2026|A&B #5W', cropYear: 2026, farm: 'A&B Farm', name: 'A&B #5W', crop: 'Cotton', water: 'Irrigated', plannedAcres: 100, producer: null, fsn: null, county: null }
const op = (type: string, date: string, product: string | null = null): LastOperation => ({ type, date, product, acres: null, source: { source: 'Deere CSV' } as any })
const now = new Date('2026-10-20T12:00:00Z')
const rain = { name: 'THU', inches: 1.4 }

describe('fieldState', () => {
  it('done at 95% harvested', () => {
    expect(fieldState(field, { harvestedAcres: 96, season: 'harvest', now }).status).toBe('DONE')
  })
  it('harvesting, and at risk when heavy rain is coming', () => {
    expect(fieldState(field, { harvestedAcres: 40, season: 'harvest', now })).toMatchObject({ status: 'HARVESTING', next: '40% harvested' })
    expect(fieldState(field, { harvestedAcres: 40, rain, season: 'harvest', now })).toMatchObject({ status: 'RAIN THU', tone: 'risk' })
  })
  it('ready after a defoliant in harvest season', () => {
    const s = fieldState(field, { lastOp: op('application', '2026-10-05', 'Folex 6EC'), season: 'harvest', now })
    expect(s).toMatchObject({ status: 'READY', next: 'Harvest when a crew is free' })
  })
  it('a spring burndown is not harvest prep', () => {
    const s = fieldState(field, { lastOp: op('application', '2026-03-20', 'Sharpen'), season: 'planting', now: new Date('2026-04-01T12:00:00Z') })
    expect(s.status).toBe('IN SEASON')
  })
  it('rain only changes the status in harvest season', () => {
    expect(fieldState(field, { lastOp: op('seeding', '2026-05-01'), rain, season: 'growing', now }).status).toBe('GROWING')
  })
  it('irrigating, and no data', () => {
    expect(fieldState(field, { irrigating: true, season: 'growing', now }).status).toBe('IRRIGATING')
    expect(fieldState(field, { season: 'growing', now }).status).toBe('NO DATA')
  })
})

describe('helpers', () => {
  it('farmKey matches across spellings (same as collectors/hub.py farm_key)', () => {
    expect(farmKey('A&B Farm')).toBe('a&b')
    expect(farmKey('Brown Small Farm')).toBe('brownsmall')
  })
  it('heavyRainAhead looks 3 days out', () => {
    const f = { days: [{ name: 'Tuesday', rainIn: 0.2 }, { name: 'Wednesday', rainIn: 0 }, { name: 'Thursday', rainIn: 1.4 }, { name: 'Friday', rainIn: 2 }] } as unknown as FarmForecast
    expect(heavyRainAhead(f)).toEqual({ name: 'THU', inches: 1.4 })
    expect(heavyRainAhead({ ...f, days: f.days.slice(0, 2) })).toBeNull()
  })
  it('byNeed puts risk first, done last', () => {
    const rows = (['done', 'risk', 'wait'] as const).map((tone) => ({ field, state: { tone, status: '', last: '', next: '' } }))
    expect(rows.sort(byNeed).map((r) => r.state.tone)).toEqual(['risk', 'wait', 'done'])
  })
})
