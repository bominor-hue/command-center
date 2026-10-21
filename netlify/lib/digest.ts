// A compact, plain-numbers picture of the farm right now, built from the hub: what the Brief agent
// writes from and what the Research agent can look up. Same rules as the wall (src/domain).
import type { SupabaseClient } from '@supabase/supabase-js'
import { byNeed, farmKey, fieldState, heavyRainAhead } from '../../src/domain/fieldStatus'
import { seasonFor } from '../../src/domain/season'
import { isStillRunning, runningPivots } from '../../src/domain/water'
import type { EntryRow, FarmForecast, FieldRow, LastOperation, PivotDoc } from '../../src/hub/types'
import { cc } from './hub'

const ENTRY_COLS = 'id,pivot_id,action,happened_at,who_name,how,percent_timer,planned_stop,start_deg,stop_deg,direction,start_at,stop_at,corrects_id'

export async function farmDigest(db: SupabaseClient, now = new Date()) {
  const year = now.getFullYear()
  const since = new Date(now.getTime() - 21 * 86400000).toISOString()
  const [fields, snaps, alerts, entries, pivots, cal, news, feeds] = await Promise.all([
    cc(db).from('field').select('*').eq('crop_year', year),
    cc(db).from('snapshot').select('key,metric,value,source,as_of'),
    cc(db).from('alert').select('level,title,why,opened_at').is('cleared_at', null).is('handled_at', null),
    db.from('entry').select(ENTRY_COLS).gte('happened_at', since),
    db.from('pivot').select('data'),
    cc(db).from('event').select('title,happened_at').eq('kind', 'calendar').gte('happened_at', now.toISOString()).lte('happened_at', new Date(now.getTime() + 14 * 86400000).toISOString()).order('happened_at').limit(15),
    cc(db).from('news').select('title,tag,source,published_at').eq('hidden', false).order('score', { ascending: false }).limit(8),
    cc(db).from('feed_health').select('name,last_ok,overdue'),
  ])
  const fs: FieldRow[] = (fields.data ?? []).map((r: any) => ({ id: r.id, cropYear: r.crop_year, farm: r.farm, name: r.name, crop: r.crop, water: r.water, plannedAcres: Number(r.planned_acres) || 0, producer: r.producer, fsn: r.fsn, county: r.county }))
  const lastOps: Record<string, LastOperation> = {}, harvested: Record<string, number> = {}, forecasts: FarmForecast[] = []
  for (const s of snaps.data ?? []) {
    const id = s.key.replace(/^field:/, '')
    if (s.metric === 'last_operation') lastOps[id] = { ...s.value, source: { source: s.source } }
    if (s.metric === 'harvested_acres') harvested[id] = Number(s.value.acres) || 0
    if (s.metric === 'forecast') forecasts.push({ farm: s.key.replace(/^farm:/, ''), days: s.value.days, sprayWindow: s.value.sprayWindow ?? null, asOf: s.as_of, source: { source: s.source } })
  }
  const season = seasonFor(now)
  const fc = new Map(forecasts.map((f) => [farmKey(f.farm), f]))
  const rows = fs.map((field) => ({ field, state: fieldState(field, { harvestedAcres: harvested[field.id], lastOp: lastOps[field.id], rain: heavyRainAhead(fc.get(farmKey(field.farm))), season, now }) })).sort(byNeed)
  const running = runningPivots((entries.data ?? []) as EntryRow[], (pivots.data ?? []).map((p: any) => p.data as PivotDoc), now)
  const byCrop = ['Cotton', 'Peanuts', 'Corn'].map((crop) => {
    const f = fs.filter((x) => x.crop === crop)
    const planned = f.reduce((a, x) => a + x.plannedAcres, 0), done = f.reduce((a, x) => a + Math.min(x.plannedAcres, harvested[x.id] ?? 0), 0)
    return { crop, plannedAcres: Math.round(planned), harvestedAcres: Math.round(done) }
  })
  const top = forecasts.sort((a, b) => b.days.reduce((s, d) => s + d.rainIn, 0) - a.days.reduce((s, d) => s + d.rainIn, 0))[0]
  return {
    asOf: now.toISOString(), season,
    fields: { count: fs.length, plannedAcres: Math.round(fs.reduce((a, f) => a + f.plannedAcres, 0)), harvestByCrop: byCrop,
      needAction: rows.filter((r) => r.state.tone === 'risk' || r.state.tone === 'need').slice(0, 15).map((r) => ({ field: r.field.name, crop: r.field.crop, acres: r.field.plannedAcres, status: r.state.status, next: r.state.next })),
      working: rows.filter((r) => r.state.tone === 'active').slice(0, 10).map((r) => ({ field: r.field.name, status: r.state.status, next: r.state.next })) },
    water: { running: running.length, stillRunning: running.filter(isStillRunning).map((r) => ({ pivot: r.name, hoursOn: Math.round(r.hours * 10) / 10 })) },
    weather: top ? { wettestFarm: top.farm, days: top.days.slice(0, 5).map((d) => ({ day: d.name, hi: d.hi, rainIn: d.rainIn, short: d.short })), sprayWindow: top.sprayWindow } : null,
    alerts: (alerts.data ?? []).map((a: any) => ({ level: a.level, title: a.title, why: a.why })),
    calendarNext14Days: (cal.data ?? []).map((e: any) => ({ title: e.title, at: e.happened_at })),
    topNews: (news.data ?? []).map((n: any) => ({ title: n.title, tag: n.tag, source: n.source })),
    lateFeeds: (feeds.data ?? []).filter((f: any) => f.overdue).map((f: any) => ({ feed: f.name, lastOk: f.last_ok })),
  }
}

/** Field rows for the Research agent's lookup tool, filtered by crop or farm. */
export async function fieldLookup(db: SupabaseClient, q: { crop?: string; farm?: string }) {
  let query = cc(db).from('field').select('name,farm,crop,water,planned_acres,producer,fsn,county').eq('crop_year', new Date().getFullYear())
  if (q.crop) query = query.ilike('crop', q.crop)
  if (q.farm) query = query.ilike('farm', `%${q.farm}%`)
  const { data, error } = await query.limit(200)
  if (error) throw new Error(error.message)
  return data
}
