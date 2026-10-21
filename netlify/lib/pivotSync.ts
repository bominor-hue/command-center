// Copies what the hub needs from Pivot Log into the hub's pl_* tables (supabase/cc_hub.sql). Pivot Log
// stays its own project: the sync signs in there as a read-only viewer login (a person with role
// 'viewer' in Pivot Log's people list), so it can read everything and change nothing.
//
// Farms, pivots and pivot fields are small and copied whole (rows gone from Pivot Log are removed
// here). Entries are append-only in Pivot Log, so only the ones received since the last copy are
// fetched. Rain days are fetched by updated_at.
//
// Netlify environment: PIVOT_LOG_SUPABASE_URL, PIVOT_LOG_ANON_KEY, PIVOT_LOG_SYNC_EMAIL, PIVOT_LOG_SYNC_PASSWORD.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { cc } from './hub'

const ENTRY_COLS = 'id,pivot_id,action,happened_at,received_at,who_name,how,percent_timer,planned_stop,start_deg,stop_deg,direction,start_at,stop_at,corrects_id'
const FIRST_COPY_DAYS = 60
/** Re-read a little before the last copy, so an entry that arrived mid-copy is never missed. */
const OVERLAP_MS = 60 * 60 * 1000
const PAGE = 1000

export async function pivotLog(): Promise<SupabaseClient> {
  const { PIVOT_LOG_SUPABASE_URL: url, PIVOT_LOG_ANON_KEY: anon, PIVOT_LOG_SYNC_EMAIL: email, PIVOT_LOG_SYNC_PASSWORD: password } = process.env
  if (!url || !anon || !email || !password) throw new Error('Pivot sync not set up: needs PIVOT_LOG_SUPABASE_URL, PIVOT_LOG_ANON_KEY, PIVOT_LOG_SYNC_EMAIL and PIVOT_LOG_SYNC_PASSWORD in Netlify.')
  const pl = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } })
  const { error } = await pl.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`Pivot Log sign-in failed: ${error.message}`)
  return pl
}

async function all<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await q(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    out.push(...(data ?? []))
    if (!data || data.length < PAGE) return out
  }
}

/** Upsert in chunks; PostgREST takes a few hundred rows comfortably per request. */
async function put(hub: SupabaseClient, table: string, rows: object[]) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await cc(hub).from(table).upsert(rows.slice(i, i + 500))
    if (error) throw new Error(`${table}: ${error.message}`)
  }
}

async function since(hub: SupabaseClient, table: string, col: string, now: Date): Promise<string> {
  const { data } = await cc(hub).from(table).select(col).order(col, { ascending: false }).limit(1)
  const last = (data?.[0] as any)?.[col] as string | undefined
  return new Date(last ? Date.parse(last) - OVERLAP_MS : now.getTime() - FIRST_COPY_DAYS * 86400000).toISOString()
}

export async function syncPivotLog(hub: SupabaseClient, pl: SupabaseClient, now = new Date()) {
  let rows = 0
  for (const [from, to] of [['farm', 'pl_farm'], ['pivot', 'pl_pivot'], ['field', 'pl_field']] as const) {
    const docs = await all<any>((a, b) => pl.from(from).select('id,data,updated_at').order('id').range(a, b))
    await put(hub, to, docs)
    const ids = new Set(docs.map((d) => d.id))
    const { data: here } = await cc(hub).from(to).select('id')
    const gone = (here ?? []).map((r: any) => r.id as string).filter((id) => !ids.has(id))
    if (gone.length) await cc(hub).from(to).delete().in('id', gone)
    rows += docs.length
  }
  const entriesSince = await since(hub, 'pl_entry', 'received_at', now)
  const entries = await all<any>((a, b) => pl.from('entry').select(ENTRY_COLS).gte('received_at', entriesSince).order('received_at').range(a, b))
  await put(hub, 'pl_entry', entries)
  const rainSince = await since(hub, 'pl_rain_day', 'updated_at', now)
  const rain = await all<any>((a, b) => pl.from('rain_day').select('id,data,updated_at,updated_by').gte('updated_at', rainSince).order('updated_at').range(a, b))
  await put(hub, 'pl_rain_day', rain)
  return { rows: rows + entries.length + rain.length, entries: entries.length, rain: rain.length }
}
