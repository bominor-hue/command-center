import type { EntryRow, PivotDoc } from '../hub/types'

// Which pivots are running now, which laps come around soon, and which have been on too long.
// Same rules as Pivot Log's runs (bominor-hue/pivot-log src/domain/runs.ts): a void entry cancels the
// one it corrects, the latest ON with no OFF after it is a running pivot, and a lap takes the dealer
// chart's hours per revolution at 100% scaled by the percent timer and the arc.

export interface RunningPivot {
  pivotId: string; name: string; since: string; hours: number
  passHours: number | null // one pass at its percent timer, when known
  dueAt: string | null // when it should reach its planned stop
  overdueHours: number | null // hours past dueAt (or past the no-lap-time limit)
  entryId: string; who: string
}

/** Hours after the planned stop before a red "still running?" alert (PRD: lap time plus 2 h). */
export const OVERDUE_AFTER_H = 2
/** With no lap time on the pivot profile, flag a run open this long. */
export const NO_LAP_LIMIT_H = 36

const num = (p: PivotDoc, key: string): number | null => {
  const v = p.profile?.[key]?.value
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

export function passHours(p: PivotDoc, pct: number | null): number | null {
  const h = num(p, 'hoursPerRev100')
  if (!h || !pct) return null
  return (h * 100) / pct * ((num(p, 'arcDeg') ?? 360) / 360)
}

function stopHours(on: EntryRow, pass: number | null): number | null {
  if (!pass) return null
  if (on.planned_stop === 'lap') return pass
  if (on.planned_stop === 'position' && on.start_deg != null && on.stop_deg != null) {
    const deg = on.direction === 'reverse' ? (on.start_deg - on.stop_deg + 360) % 360 : (on.stop_deg - on.start_deg + 360) % 360
    return (pass * (deg || 360)) / 360
  }
  return null // 'keep': runs until someone turns it off
}

export function runningPivots(entries: EntryRow[], pivots: PivotDoc[], now = new Date()): RunningPivot[] {
  const voided = new Set(entries.filter((e) => e.action === 'void' && e.corrects_id).map((e) => e.corrects_id!))
  const live = entries.filter((e) => (e.action === 'on' || e.action === 'off') && !voided.has(e.id))
  const latest = new Map<string, EntryRow>()
  for (const e of live) {
    const prev = latest.get(e.pivot_id)
    if (!prev || e.happened_at > prev.happened_at) latest.set(e.pivot_id, e)
  }
  const byId = new Map(pivots.map((p) => [p.id, p]))
  const out: RunningPivot[] = []
  for (const on of latest.values()) {
    if (on.action !== 'on') continue
    const p = byId.get(on.pivot_id)
    const hours = (now.getTime() - Date.parse(on.happened_at)) / 3600000
    const pass = p ? passHours(p, on.percent_timer) : null
    const toStop = stopHours(on, pass)
    const dueAt = toStop ? new Date(Date.parse(on.happened_at) + toStop * 3600000).toISOString() : null
    const overdueHours = dueAt
      ? Math.max(0, (now.getTime() - Date.parse(dueAt)) / 3600000)
      : on.planned_stop === 'keep' ? null : Math.max(0, hours - NO_LAP_LIMIT_H)
    out.push({ pivotId: on.pivot_id, name: p?.name ?? on.pivot_id, since: on.happened_at, hours, passHours: pass, dueAt, overdueHours, entryId: on.id, who: on.who_name })
  }
  return out.sort((a, b) => (b.overdueHours ?? -1) - (a.overdueHours ?? -1) || a.name.localeCompare(b.name, undefined, { numeric: true }))
}

export const isStillRunning = (r: RunningPivot) =>
  r.overdueHours != null && (r.dueAt ? r.overdueHours > OVERDUE_AFTER_H : r.overdueHours > 0)

export const lapsDueWithin = (rs: RunningPivot[], hours: number, now = new Date()) =>
  rs.filter((r) => r.dueAt && Date.parse(r.dueAt) >= now.getTime() && Date.parse(r.dueAt) - now.getTime() <= hours * 3600000)
