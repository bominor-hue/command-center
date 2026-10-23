import cfg from '../../data/spray_programs.json'
import type { Application, FieldRow, Planting } from '../hub/types'

// Growing-season spray and fertilizer programs (data/spray_programs.json): what each product counts
// as, which passes are planned at how many days after planting, and where each field stands. The status
// buckets are the ones in Bo's Peanut Spray Schedule sheet: Overdue, Due (5 days or less), Coming up
// (14 days or less), On track, Complete.

export type Kind = 'herbicide' | 'fungicide' | 'insecticide' | 'pgr' | 'fertilizer' | 'adjuvant'
export interface Program { id: string; code: string; crop: string; kinds: Kind[]; passes: number[]; source?: string }
export type SprayStatus = 'overdue' | 'due' | 'soon' | 'ontrack' | 'complete' | 'unset' | 'unplanted'

export const PROGRAMS = cfg.programs as Program[]
export const N_TARGET = cfg.fertilizer.n_target_lb_ac as Record<string, number | null>
export const DUE_DAYS = 5, SOON_DAYS = 14

const KEYS: { key: string; kind: Kind }[] = Object.entries(cfg.products as Record<string, string[]>)
  .flatMap(([kind, names]) => names.map((n) => ({ key: n.toLowerCase(), kind: kind as Kind })))
  .sort((a, b) => b.key.length - a.key.length)

/** What a product name counts as. Matches the start of the name, so 'Pix 6x' is Pix, 'Warrant~6' is
 *  Warrant and '19-11-0Z' is 19-11-0; a key ending in a letter must end a word ('Pix', not 'Pixel'). */
export function productKind(name: string): Kind | null {
  const n = name.trim().toLowerCase()
  for (const { key, kind } of KEYS) {
    if (!n.startsWith(key)) continue
    const next = n.charAt(key.length)
    if (/[a-z]$/.test(key) && /[a-z]/.test(next)) continue
    return kind
  }
  return null
}

export const kindsOf = (a: Application) => new Set(a.products.map(productKind).filter((k): k is Kind => !!k))
/** Product names on file that the program list does not know yet, so Bo can say what they are. */
export const unclassified = (apps: Application[]) =>
  [...new Set(apps.flatMap((a) => a.products.filter((p) => !productKind(p)).map((p) => p.trim())))].sort()

// Dates are farm-local calendar days, 'YYYY-MM-DD'.
export const farmDay = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
export const days = (from: string, to: string) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000)
export const addDays = (day: string, n: number) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10)

export interface SprayRow {
  status: SprayStatus
  planted: string | null
  dap: number | null          // days after planting, today
  done: number                // passes on file since planting (one per day)
  total: number | null        // passes in the program; null when the timing is not set
  last: Application | null
  sinceLast: number | null    // days since the last pass
  next: { n: number; dap: number; date: string; inDays: number } | null
}

/** One field on one program. The n-th pass sprayed after planting fills the n-th planned pass, and
 *  Next always points to the first unfilled one (same rule as Bo's sheet). */
export function sprayRow(p: Program, planting: Planting | undefined, apps: Application[], today: string): SprayRow {
  const planted = planting?.date ?? null
  const mine = apps.filter((a) => (!planted || a.date >= planted) && [...kindsOf(a)].some((k) => p.kinds.includes(k)))
    .sort((a, b) => a.date.localeCompare(b.date))
  const done = new Set(mine.map((a) => a.date)).size
  const last = mine[mine.length - 1] ?? null
  const base = { planted, dap: planted ? days(planted, today) : null, done, last, sinceLast: last ? days(last.date, today) : null }
  if (!p.passes.length) return { ...base, status: 'unset', total: null, next: null }
  if (!planted) return { ...base, status: 'unplanted', total: p.passes.length, next: null }
  if (done >= p.passes.length) return { ...base, status: 'complete', total: p.passes.length, next: null }
  const dap = p.passes[done], date = addDays(planted, dap), inDays = days(today, date)
  const status: SprayStatus = inDays < 0 ? 'overdue' : inDays <= DUE_DAYS ? 'due' : inDays <= SOON_DAYS ? 'soon' : 'ontrack'
  return { ...base, status, total: p.passes.length, next: { n: done + 1, dap, date, inDays } }
}

const ORDER: Record<SprayStatus, number> = { overdue: 0, due: 1, soon: 2, ontrack: 3, unset: 4, unplanted: 5, complete: 6 }
/** Most urgent first: overdue by how late, then due soonest; programs without timings by longest since a pass. */
export function bySprayNeed(a: { row: SprayRow }, b: { row: SprayRow }) {
  return ORDER[a.row.status] - ORDER[b.row.status]
    || (a.row.next?.inDays ?? 0) - (b.row.next?.inDays ?? 0)
    || (b.row.sinceLast ?? 9999) - (a.row.sinceLast ?? 9999)
}

export const STATUS_LABEL: Record<SprayStatus, string> = {
  overdue: 'Overdue', due: 'Due', soon: 'Coming up', ontrack: 'On track', complete: 'Complete', unset: 'No timing', unplanted: 'No planting',
}

export function programRows(p: Program, fields: FieldRow[], plantings: Record<string, Planting>, apps: Record<string, Application[]>, today: string) {
  return fields.filter((f) => f.crop === p.crop)
    .map((field) => ({ field, row: sprayRow(p, plantings[field.id], apps[field.id] ?? [], today) }))
    .sort(bySprayNeed)
}

// Fertilizer --------------------------------------------------------------------------------------------
const NITRO = cfg.nitrogen as Record<string, { n_pct: number; lb_per_gal: number } | string>
const PER_AC: Record<string, { to: 'gal' | 'lb'; f: number }> = {
  'gal1ac-1': { to: 'gal', f: 1 }, 'l1ha-1': { to: 'gal', f: 0.106907 },
  'lb1ac-1': { to: 'lb', f: 1 }, 'kg1ha-1': { to: 'lb', f: 0.892179 },
}

/** Pounds of N per acre in one product at one rate, or null when it can't be worked out: the analysis
 *  comes from the name (28-0-0-5 is 28% N), and a liquid needs its weight per gallon from the list. */
export function nLbPerAc(product: string, rate: number, unit: string): number | null {
  const m = product.trim().match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)/)
  const u = PER_AC[unit]
  if (!m || !u || !(rate > 0)) return null
  const pct = Number(m[1]) / 100, amount = rate * u.f
  if (u.to === 'lb') return amount * pct
  const dens = Object.entries(NITRO).find(([k, v]) => typeof v === 'object' && product.trim().startsWith(k))?.[1] as { lb_per_gal: number } | undefined
  return dens ? amount * dens.lb_per_gal * pct : null
}

export interface FertRow { passes: Application[]; nLbAc: number | null; nKnown: boolean; target: number | null; last: Application | null }

/** Fertilizer passes on a field this crop year, and the N they add up to where the rates are on file. */
export function fertRow(field: FieldRow, apps: Application[]): FertRow {
  const passes = apps.filter((a) => kindsOf(a).has('fertilizer')).sort((a, b) => a.date.localeCompare(b.date))
  let n = 0, any = false, all = true
  for (const a of passes) {
    for (const p of a.products.filter((x) => productKind(x) === 'fertilizer')) {
      const r = a.rates?.find((x) => x.product === p)
      const v = r ? nLbPerAc(p, r.rate, r.unit) : null
      if (v != null) { n += v; any = true } else if (/^\d/.test(p.trim())) all = false
    }
  }
  return { passes, nLbAc: any ? Math.round(n) : null, nKnown: any && all, target: N_TARGET[field.crop] ?? null, last: passes[passes.length - 1] ?? null }
}
