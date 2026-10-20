import { describe, expect, it } from 'vitest'
import type { EntryRow, PivotDoc } from '../hub/types'
import { isStillRunning, lapsDueWithin, passHours, runningPivots } from './water'

const pivot = (id: string, hoursPerRev100?: number, arcDeg?: number): PivotDoc => ({
  id, farmId: 'f1', name: `Pivot ${id}`,
  profile: {
    ...(hoursPerRev100 ? { hoursPerRev100: { value: hoursPerRev100, source: 'dealer chart', at: '2026-01-01' } } : {}),
    ...(arcDeg ? { arcDeg: { value: arcDeg, source: 'map', at: '2026-01-01' } } : {}),
  },
})
let n = 0
const entry = (pivot_id: string, action: EntryRow['action'], happened_at: string, more: Partial<EntryRow> = {}): EntryRow => ({
  id: `e${++n}`, pivot_id, action, happened_at, who_name: 'Jose', how: 'app', percent_timer: 50, planned_stop: 'lap',
  start_deg: null, stop_deg: null, direction: null, start_at: null, stop_at: null, corrects_id: null, ...more,
})
const now = new Date('2026-10-20T18:00:00Z')

describe('passHours', () => {
  it('scales the dealer chart by percent timer and arc', () => {
    expect(passHours(pivot('a', 20), 50)).toBe(40)
    expect(passHours(pivot('a', 20, 180), 50)).toBe(20)
    expect(passHours(pivot('a'), 50)).toBeNull()
    expect(passHours(pivot('a', 20), null)).toBeNull()
  })
})

describe('runningPivots', () => {
  it('a pivot turned on and not off is running; one turned off is not', () => {
    const rs = runningPivots([
      entry('a', 'on', '2026-10-20T10:00:00Z'),
      entry('b', 'on', '2026-10-20T08:00:00Z'), entry('b', 'off', '2026-10-20T12:00:00Z'),
    ], [pivot('a', 20), pivot('b', 20)], now)
    expect(rs.map((r) => r.pivotId)).toEqual(['a'])
    expect(rs[0].hours).toBe(8)
    expect(rs[0].dueAt).toBe('2026-10-22T02:00:00.000Z') // 40 h lap at 50%
  })

  it('a void cancels the entry it corrects', () => {
    const off = entry('a', 'off', '2026-10-20T12:00:00Z')
    const rs = runningPivots([entry('a', 'on', '2026-10-20T10:00:00Z'), off, entry('a', 'void', '2026-10-20T12:05:00Z', { corrects_id: off.id })], [pivot('a', 20)], now)
    expect(rs).toHaveLength(1)
  })

  it('flags a run past lap time plus 2 h, not one just past lap time', () => {
    const p = pivot('a', 10) // 20 h lap at 50%
    const late = runningPivots([entry('a', 'on', '2026-10-19T19:00:00Z')], [p], now)[0] // 23 h in
    const close = runningPivots([entry('a', 'on', '2026-10-19T21:00:00Z')], [p], now)[0] // 21 h in
    expect(isStillRunning(late)).toBe(true)
    expect(isStillRunning(close)).toBe(false)
  })

  it('with no lap time, flags after 36 h; a "keep" run is never flagged', () => {
    const at = '2026-10-18T12:00:00Z' // 54 h ago
    expect(isStillRunning(runningPivots([entry('a', 'on', at)], [pivot('a')], now)[0])).toBe(true)
    expect(isStillRunning(runningPivots([entry('a', 'on', at, { planned_stop: 'keep' })], [pivot('a', 10)], now)[0])).toBe(false)
  })

  it('a position stop uses the part of the circle it travels', () => {
    const r = runningPivots([entry('a', 'on', '2026-10-20T10:00:00Z', { planned_stop: 'position', start_deg: 0, stop_deg: 90 })], [pivot('a', 20)], now)[0]
    expect(r.dueAt).toBe('2026-10-20T20:00:00.000Z') // a quarter of a 40 h pass
    expect(lapsDueWithin([r], 3, now)).toHaveLength(1)
    expect(lapsDueWithin([r], 1, now)).toHaveLength(0)
  })
})
