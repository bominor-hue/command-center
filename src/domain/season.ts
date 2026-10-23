import type { Season } from '../hub/types'

// The season bar: four seasons on a 12-month scale. Picking one reorders the wall to that season's
// layout (PRD, Screen requirements); the season for today's date is the default.

export const SEASONS: { id: Season; label: string; from: [number, number]; note: string }[] = [
  { id: 'off', label: 'Off-season', from: [12, 1], note: 'Off-season layout: deadlines, equipment service and next year’s crop plan lead. Money and markets join in v3.' },
  { id: 'planting', label: 'Planting', from: [4, 1], note: 'Planting layout: the planting tracker leads (planted vs plan by crop, pace per week), then weather windows and water.' },
  { id: 'growing', label: 'Growing', from: [5, 16], note: 'Growing layout: water balance and pivots lead, then weather and the field board.' },
  { id: 'harvest', label: 'Harvest', from: [9, 1], note: 'Harvest layout: the harvest workbook dashboards lead (peanuts, cotton, corn in turn), then the field board, weather and water.' },
]

/** Season for a date: Dec through Mar off-season, Apr to mid-May planting, mid-May through Aug growing, Sep through Nov harvest. */
export function seasonFor(d: Date): Season {
  const m = d.getMonth() + 1, day = d.getDate()
  if (m === 12 || m <= 3) return 'off'
  if (m === 4 || (m === 5 && day < 16)) return 'planting'
  if (m <= 8) return 'growing'
  return 'harvest'
}

/** Where a date sits on the bar, 0 to 100 (Jan 1 = 0). */
export function yearPercent(d: Date): number {
  const start = new Date(d.getFullYear(), 0, 1).getTime(), end = new Date(d.getFullYear() + 1, 0, 1).getTime()
  return ((d.getTime() - start) / (end - start)) * 100
}

/** Bar segments in percent of the year (off-season wraps: Jan–Mar and December). */
export const SEGMENTS: { id: Season; left: number; width: number }[] = [
  { id: 'off', left: 0, width: 24.7 },
  { id: 'planting', left: 24.7, width: 12.3 },
  { id: 'growing', left: 37, width: 29.6 },
  { id: 'harvest', left: 66.6, width: 25 },
  { id: 'off', left: 91.6, width: 8.4 },
]

export type PanelId = 'fieldboard' | 'needs' | 'water' | 'weather' | 'harvest' | 'crew' | 'fleet' | 'deadlines' | 'money' | 'harvestdash' | 'plantingdash'

/** The big panel in the middle, then the four small ones under it, per season. */
export const LAYOUTS: Record<Season, { lead: PanelId; row: [PanelId, PanelId, PanelId, PanelId] }> = {
  harvest: { lead: 'harvestdash', row: ['needs', 'fieldboard', 'weather', 'water'] },
  growing: { lead: 'water', row: ['needs', 'weather', 'fieldboard', 'deadlines'] },
  planting: { lead: 'plantingdash', row: ['needs', 'weather', 'fieldboard', 'water'] },
  off: { lead: 'fieldboard', row: ['needs', 'deadlines', 'fleet', 'money'] },
}
