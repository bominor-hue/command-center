import type { FarmForecast, FieldRow, LastOperation, Season } from '../hub/types'

// One status line per field for the FIELD BOARD, worked out from what the hub knows:
// harvested acres and the last operation (weekly Deere CSV), pivots running (Pivot Log), and the
// NWS forecast for the field's farm. Sorted so the fields that need action come first.

export type Tone = 'risk' | 'active' | 'need' | 'wait' | 'done' | 'none'
export interface FieldState { status: string; tone: Tone; last: string; next: string }

/** Rain this heavy in a day changes harvest plans (PRD: over 1 in. in 24 h is highlighted everywhere). */
export const HEAVY_RAIN_IN = 1
/** Harvested share that counts as done. */
const DONE_SHARE = 0.95
/** Products whose application means the crop is being readied for harvest (defoliants, boll openers, desiccants). */
const HARVEST_PREP = /defol|def\b|folex|dropp|ginstar|finish|ethephon|prep|boll|harvade|gramoxone|paraquat|sharpen|aim\b|blizzard/i

const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })
const OPS: Record<string, string> = { application: 'Sprayed', seeding: 'Planted', harvest: 'Harvested', tillage: 'Tilled' }
const opLabel = (op: LastOperation) => `${OPS[op.type] ?? op.type} ${day(op.date)}${op.product ? ` · ${op.product}` : ''}`

export const farmKey = (farm: string) => farm.toLowerCase().replace(/ farm$/, '').replace(/[^a-z0-9&]/g, '')

/** The first day in the next 3 with heavy rain at this farm, e.g. "THU 1.4 IN". */
export function heavyRainAhead(f: FarmForecast | undefined): { name: string; inches: number } | null {
  const d = f?.days.slice(0, 3).find((x) => x.rainIn >= HEAVY_RAIN_IN)
  return d ? { name: d.name.slice(0, 3).toUpperCase(), inches: d.rainIn } : null
}

export function fieldState(
  f: FieldRow,
  o: { harvestedAcres?: number | null; lastOp?: LastOperation | null; irrigating?: boolean; rain?: { name: string; inches: number } | null; season: Season; now?: Date },
): FieldState {
  const now = o.now ?? new Date()
  const last = o.lastOp ? opLabel(o.lastOp) : 'No operations on file'
  const share = o.harvestedAcres && f.plannedAcres ? o.harvestedAcres / f.plannedAcres : 0
  if (share >= DONE_SHARE) return { status: 'DONE', tone: 'done', last, next: '—' }
  const rain = o.rain && o.season === 'harvest' ? o.rain : null
  if (share > 0) {
    const pct = `${Math.round(share * 100)}%`
    return rain
      ? { status: `RAIN ${rain.name}`, tone: 'risk', last, next: `${pct} harvested, finish before ${rain.name} rain` }
      : { status: 'HARVESTING', tone: 'active', last, next: `${pct} harvested` }
  }
  // Only in harvest season: some of these (Sharpen, Aim, paraquat) are also spring burndown products.
  const prepDays = o.season === 'harvest' && o.lastOp && o.lastOp.type === 'application' && HARVEST_PREP.test(o.lastOp.product ?? '')
    ? (now.getTime() - Date.parse(o.lastOp.date)) / 86400000 : null
  if (prepDays != null && prepDays <= 30) {
    if (rain) return { status: `RAIN ${rain.name}`, tone: 'risk', last, next: `Harvest before ${rain.name} rain` }
    return { status: 'READY', tone: 'wait', last, next: prepDays >= 10 ? 'Harvest when a crew is free' : `Harvest in about ${Math.ceil(10 - prepDays)} days` }
  }
  if (o.irrigating) return { status: 'IRRIGATING', tone: 'active', last, next: 'Pivot running now' }
  if (!o.lastOp) return { status: 'NO DATA', tone: 'none', last, next: 'Waits on the Deere feed' }
  return { status: o.lastOp.type === 'seeding' ? 'GROWING' : 'IN SEASON', tone: 'wait', last, next: o.season === 'harvest' ? 'Harvest prep not logged yet' : '—' }
}

const ORDER: Record<Tone, number> = { risk: 0, active: 1, need: 2, wait: 3, none: 4, done: 5 }
export const byNeed = (a: { state: FieldState; field: FieldRow }, b: { state: FieldState; field: FieldRow }) =>
  ORDER[a.state.tone] - ORDER[b.state.tone] || b.field.plannedAcres - a.field.plannedAcres || a.field.name.localeCompare(b.field.name, undefined, { numeric: true })
