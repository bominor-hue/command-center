import type { CropHarvest, FieldRow, HarvestFieldRow, HarvestFmt, HarvestStatus, SeedingOp } from '../hub/types'

// The HARVEST and PLANTING views in the middle of the wall. Harvest shows each crop's workbook dashboard
// as the workbook computes it; planting is built here from the same field rows (planting date, variety,
// acres), Deere seeding operations and the Field Master's planned acres.

export const CROPS = ['Peanuts', 'Cotton', 'Corn'] as const

/** Field names match across the workbooks, Deere and the Field Master ignoring case and spaces ('Fletcher # 6'). */
export const nameKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9&#]/g, '')

export function fmt(v: number | string | null | undefined, f: HarvestFmt): string {
  if (v == null || v === '') return '—'
  if (typeof v === 'string') return v
  switch (f) {
    case 'ac': case 'int': return Math.round(v).toLocaleString('en-US')
    case 'dec1': return v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
    case 'pct': return `${Math.round(v * 100)}%`
    case 'money': return `$${Math.round(v).toLocaleString('en-US')}`
    case 'money0': return v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : `$${Math.round(v).toLocaleString('en-US')}`
    case 'signed': return `${v > 0 ? '+' : ''}${Math.round(v).toLocaleString('en-US')}`
    case 'text': return String(v)
  }
}

/** Money stays off the wall in Visitor mode (PRD): value columns and KPIs are dropped. */
export const isMoney = (f: HarvestFmt) => f === 'money' || f === 'money0'

export function statusLabel(st: HarvestStatus, h: Pick<CropHarvest, 'stage' | 'crop'>): string {
  switch (st) {
    case 'not_started': return 'Not started'
    case 'staged': return h.stage ?? 'Ready'
    case 'harvesting': return h.crop === 'Cotton' ? 'Picking' : h.crop === 'Peanuts' ? 'Picking' : 'Combining'
    case 'harvested': return h.crop === 'Cotton' ? 'Picked out' : 'Weighing'
    case 'final': return 'Done'
  }
}

const ORDER: Record<HarvestStatus, number> = { harvesting: 0, staged: 1, harvested: 2, not_started: 3, final: 4 }

/** The wall's order: fields being harvested now, then ready (dug or defoliated, oldest first, the ones
 *  waiting longest), then finished-but-estimated, then not started (earliest planted first), then done
 *  (latest finished first). */
export function wallOrder(rows: HarvestFieldRow[]): HarvestFieldRow[] {
  return [...rows].sort((a, b) => {
    const d = ORDER[a.status] - ORDER[b.status]
    if (d) return d
    if (a.status === 'staged') return (a.staged ?? '').localeCompare(b.staged ?? '')
    if (a.status === 'final' || a.status === 'harvested') return (b.harvested ?? '').localeCompare(a.harvested ?? '')
    return (a.planted ?? '9').localeCompare(b.planted ?? '9')
  })
}

export const pct = (part: number | null | undefined, whole: number) => (whole > 0 && part != null ? Math.min(100, (part / whole) * 100) : 0)

/* Planting ---------------------------------------------------------------------------------------- */
export interface PlantRow {
  field: string; farm: string | null; water: string | null; acres: number; variety: string | null
  planted: string | null // YYYY-MM-DD
  source: 'Deere' | 'Workbook' | null
}
export interface CropPlanting {
  crop: string
  planned: number // acres: Field Master, plus workbook fields the Field Master does not list
  planted: number
  fieldsPlanted: number; fields: number
  first: string | null; last: string | null
  weeks: { start: string; acres: number }[] // acres planted per week (weeks start Monday)
  rows: PlantRow[] // not planted first (largest first), then planted, latest first
}

const day = (iso: string) => iso.slice(0, 10)
function monday(d: string): string {
  const t = new Date(`${d}T12:00:00Z`)
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7))
  return t.toISOString().slice(0, 10)
}

export function buildPlanting(crop: string, fields: FieldRow[], harvest: CropHarvest | undefined, seeding: SeedingOp[]): CropPlanting {
  const rows = new Map<string, PlantRow>()
  for (const f of fields.filter((x) => x.crop === crop)) {
    rows.set(nameKey(f.name), { field: f.name, farm: f.farm.replace(/ farm$/i, ''), water: f.water, acres: f.plannedAcres, variety: null, planted: null, source: null })
  }
  // The workbook is the record once it has a planting date: its acres and varieties are what was planted.
  // A name the Field Master spells a little differently ('LC Dryland', 'L&C Dryland') joins the closest
  // unmatched Field Master field, so one field is never counted twice.
  const wbKeys = new Set((harvest?.fields ?? []).map((w) => nameKey(w.field)))
  const spare = [...rows.keys()].filter((k) => !wbKeys.has(k))
  for (const w of harvest?.fields ?? []) {
    let k = nameKey(w.field)
    if (!rows.has(k)) {
      const near = spare.find((x) => digits(x) === digits(k) && editDistance(x, k) <= 2) // never a different pivot number
      if (near) { k = near; spare.splice(spare.indexOf(near), 1) }
    }
    const had = rows.get(k)
    rows.set(k, {
      field: had?.field ?? w.field, farm: had?.farm ?? w.farm, water: had?.water ?? w.water,
      acres: w.acres ?? had?.acres ?? 0, variety: w.variety ?? had?.variety ?? null,
      planted: w.planted ? day(w.planted) : had?.planted ?? null, source: w.planted ? 'Workbook' : had?.source ?? null,
    })
  }
  // Deere seeding fills in what the workbook does not have yet (the planter reports before anyone types).
  const byField = new Map<string, SeedingOp>()
  for (const o of seeding) {
    if (o.crop && !o.crop.toLowerCase().startsWith(crop.toLowerCase().replace(/s$/, ''))) continue
    const k = nameKey(o.field), had = byField.get(k)
    if (!had || o.date > had.date) byField.set(k, o)
  }
  for (const [k, o] of byField) {
    const r = rows.get(k)
    if (!r) continue // a Deere name the field list does not know: the field board's exceptions cover it
    if (!r.planted) { r.planted = day(o.date); r.source = 'Deere' }
    if (!r.variety && o.variety) r.variety = o.variety
  }
  const all = [...rows.values()]
  const done = all.filter((r) => r.planted)
  const weeks = new Map<string, number>()
  for (const r of done) weeks.set(monday(r.planted!), (weeks.get(monday(r.planted!)) ?? 0) + r.acres)
  const dates = done.map((r) => r.planted!).sort()
  return {
    crop,
    planned: all.reduce((a, r) => a + r.acres, 0),
    planted: done.reduce((a, r) => a + r.acres, 0),
    fieldsPlanted: done.length, fields: all.length,
    first: dates[0] ?? null, last: dates[dates.length - 1] ?? null,
    weeks: [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([start, acres]) => ({ start, acres })),
    rows: [...all.filter((r) => !r.planted).sort((a, b) => b.acres - a.acres), ...done.sort((a, b) => b.planted!.localeCompare(a.planted!))],
  }
}

const digits = (s: string) => s.replace(/\D/g, '')

/** Levenshtein distance, for near-miss field names. */
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]
}

/** Days from a YYYY-MM-DD date to now (days after planting). */
export const daysSince = (d: string, now: Date) => Math.floor((now.getTime() - Date.parse(`${d}T12:00:00`)) / 86400000)
