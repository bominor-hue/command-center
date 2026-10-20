import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { FIELD_MASTER, FIELD_MASTER_SOURCE } from './fieldMaster'
import type { Agent, Alert, Deadline, EntryRow, FarmForecast, FeedHealth, FieldRow, HubState, LastOperation, NewsItem, Task } from './types'

// The hub is the `cc` schema in the farm's Supabase project (supabase/cc_hub.sql); Pivot Log's tables
// sit beside it in `public`. The wall only reads, plus the few office actions row security allows.

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
export const hubConfigured = !!(url && anon)
export const supabase: SupabaseClient | null = hubConfigured ? createClient(url!, anon!, { auth: { persistSession: true } }) : null
const cc = () => supabase!.schema('cc')

async function rows<T>(q: PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return data ?? []
}

const ENTRY_COLS = 'id,pivot_id,action,happened_at,who_name,how,percent_timer,planned_stop,start_deg,stop_deg,direction,start_at,stop_at,corrects_id'

export async function loadHub(now = new Date()): Promise<HubState> {
  if (!supabase) throw new Error('Hub not configured')
  const { data: session } = await supabase.auth.getSession()
  if (!session.session) throw new Error('Sign in to load the hub')
  const since21 = new Date(now.getTime() - 21 * 86400000).toISOString()
  const since2 = new Date(now.getTime() - 2 * 86400000).toISOString().slice(0, 10)

  const [fieldRows, snaps, alerts, briefs, agents, tasks, approvals, feeds, news, control, cal, pivots, pivotFields, farms, entries, rain, office] = await Promise.all([
    rows<any>(cc().from('field').select('*').eq('crop_year', now.getFullYear())),
    rows<any>(cc().from('snapshot').select('key,metric,value,source,source_id,source_url,as_of').in('metric', ['forecast', 'last_operation', 'harvested_acres'])),
    rows<any>(cc().from('alert').select('*').is('cleared_at', null).is('handled_at', null).order('opened_at', { ascending: false })),
    rows<any>(cc().from('brief').select('*').order('written_at', { ascending: false }).limit(1)),
    rows<any>(cc().from('agent').select('*').order('sort')),
    rows<any>(cc().from('task').select('*').order('created_at', { ascending: false }).limit(30)),
    rows<any>(cc().from('approval').select('id').eq('status', 'waiting')),
    rows<any>(cc().from('feed_health').select('*').order('sort')),
    rows<any>(cc().from('news').select('*').eq('hidden', false).order('published_at', { ascending: false }).limit(40)),
    rows<any>(cc().from('control').select('*')),
    rows<any>(cc().from('event').select('id,title,happened_at,source,source_url').eq('kind', 'calendar').gte('happened_at', now.toISOString()).lte('happened_at', new Date(now.getTime() + 60 * 86400000).toISOString()).order('happened_at').limit(30)),
    rows<any>(supabase.from('pivot').select('data')),
    rows<any>(supabase.from('field').select('data')),
    rows<any>(supabase.from('farm').select('data')),
    rows<EntryRow>(supabase.from('entry').select(ENTRY_COLS).gte('happened_at', since21)),
    rows<any>(supabase.from('rain_day').select('data').gte('data->>date', since2)),
    supabase.rpc('is_office').then((r) => r.data === true, () => false),
  ])

  const fields: FieldRow[] = fieldRows.length
    ? fieldRows.map((r) => ({ id: r.id, cropYear: r.crop_year, farm: r.farm, name: r.name, crop: r.crop, water: r.water, plannedAcres: Number(r.planned_acres) || 0, producer: r.producer, fsn: r.fsn, county: r.county }))
    : FIELD_MASTER // not loaded into the hub yet: the bundled copy
  const src = (r: any) => ({ source: r.source, id: r.source_id, url: r.source_url })
  const lastOps: Record<string, LastOperation> = {}
  const harvested: HubState['harvested'] = {}
  const forecasts: FarmForecast[] = []
  for (const s of snaps) {
    const id = s.key.replace(/^field:/, '')
    if (s.metric === 'last_operation') lastOps[id] = { ...s.value, source: src(s) }
    else if (s.metric === 'harvested_acres') harvested[id] = { acres: Number(s.value.acres) || 0, asOf: s.as_of, source: src(s) }
    else if (s.metric === 'forecast') forecasts.push({ farm: s.key.replace(/^farm:/, ''), days: s.value.days, sprayWindow: s.value.sprayWindow ?? null, asOf: s.as_of, source: src(s) })
  }
  const b = briefs[0]
  return {
    live: true, loadedAt: now.toISOString(), error: null,
    fields, lastOps, harvested, forecasts,
    pivots: pivots.map((r) => r.data), pivotFields: pivotFields.map((r) => r.data), farms: farms.map((r) => r.data),
    entries, rain: rain.map((r) => r.data),
    alerts: alerts.filter((a) => !a.snoozed_until || Date.parse(a.snoozed_until) < now.getTime())
      .map((a): Alert => ({ id: a.id, rule: a.rule, level: a.level, title: a.title, why: a.why, key: a.key, records: a.records ?? [], openedAt: a.opened_at })),
    brief: b ? { writtenAt: b.written_at, text: b.text, needsYou: b.needs_you ?? [] } : null,
    agents: agents.map((a): Agent => ({ id: a.id, name: a.name, scope: a.scope, schedule: a.schedule, enabled: a.enabled, status: a.status, nowDoing: a.now_doing })),
    tasks: tasks.map((t): Task => ({ id: t.id, agentId: t.agent_id, text: t.text, status: t.status, steps: t.steps ?? [], result: t.result, resultKind: t.result_kind, resultUrl: t.result_url, error: t.error, createdAt: t.created_at, finishedAt: t.finished_at })),
    approvalsWaiting: approvals.length,
    feeds: feeds.map((f): FeedHealth => ({ id: f.id, name: f.name, lastOk: f.last_ok, overdue: f.overdue, lastError: f.last_error })),
    news: news.map((n): NewsItem => ({ id: n.id, title: n.title, source: n.source, tag: n.tag, url: n.url, publishedAt: n.published_at })),
    deadlines: cal.map((e): Deadline => ({ id: e.id, title: e.title, date: e.happened_at, url: e.source_url, source: e.source })),
    agentsPaused: control[0]?.agents_paused ?? false,
    signedInAsOffice: office,
  }
}

/** Calls `onChange` when any hub table the wall shows changes (Supabase Realtime), or a pivot entry lands. */
export function watchHub(onChange: () => void): () => void {
  if (!supabase) return () => {}
  const ch = supabase.channel('wall')
  for (const table of ['alert', 'brief', 'agent', 'task', 'control', 'feed_run', 'news', 'snapshot']) {
    ch.on('postgres_changes', { event: '*', schema: 'cc', table }, onChange)
  }
  ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'entry' }, onChange)
  ch.subscribe()
  return () => { supabase.removeChannel(ch) }
}

// Office actions ---------------------------------------------------------------------------------------

/** Dispatch one task to each picked agent. The agent-run function picks queued tasks up within seconds. */
export async function dispatchTask(text: string, agentIds: string[]): Promise<void> {
  const { data: s } = await supabase!.auth.getSession()
  const who = s.session?.user.email ?? 'office'
  const { error } = await cc().from('task').insert(agentIds.map((agent_id) => ({ agent_id, text, created_by: who })))
  if (error) throw new Error(error.message)
  // Wake the runner now rather than at its next scheduled pass.
  await fetch('/.netlify/functions/agent-run-background', { method: 'POST', headers: { authorization: `Bearer ${s.session?.access_token ?? ''}` } }).catch(() => {})
}

export async function cancelTask(id: number) {
  const { error } = await cc().from('task').update({ cancel_requested: true }).eq('id', id)
  if (error) throw new Error(error.message)
}

export async function markHandled(alertId: string) {
  const { data: s } = await supabase!.auth.getSession()
  const { error } = await cc().from('alert').update({ handled_at: new Date().toISOString(), handled_by: s.session?.user.email ?? 'office' }).eq('id', alertId)
  if (error) throw new Error(error.message)
}

export async function hideStory(id: string) {
  const { error } = await cc().from('news').update({ hidden: true }).eq('id', id)
  if (error) throw new Error(error.message)
}

export async function setAgentsPaused(paused: boolean) {
  const { data: s } = await supabase!.auth.getSession()
  const { error } = await cc().from('control').update({ agents_paused: paused, paused_at: paused ? new Date().toISOString() : null, paused_by: paused ? s.session?.user.email ?? 'office' : null }).eq('id', 1)
  if (error) throw new Error(error.message)
}

export const FIELD_SOURCE = { source: FIELD_MASTER_SOURCE }
