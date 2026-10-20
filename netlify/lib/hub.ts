// Server side of the hub: a Supabase client with the service key (skips row security), for the
// agents and the water rules. Never sent to a browser. Netlify environment: VITE_SUPABASE_URL,
// VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export function service(): SupabaseClient {
  const { VITE_SUPABASE_URL: url, SUPABASE_SERVICE_KEY: key } = process.env
  if (!url || !key) throw new Error('Hub not set up: needs VITE_SUPABASE_URL and SUPABASE_SERVICE_KEY in Netlify.')
  return createClient(url, key, { auth: { persistSession: false } })
}
export const cc = (db: SupabaseClient) => db.schema('cc')

/** True when the request carries a signed-in office login (Pivot Log's is_office()). */
export async function isOfficeCaller(req: Request): Promise<boolean> {
  const { VITE_SUPABASE_URL: url, VITE_SUPABASE_ANON_KEY: anon } = process.env
  const token = req.headers.get('authorization')?.replace(/^Bearer /, '')
  if (!url || !anon || !token) return false
  const asCaller = createClient(url, anon, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${token}` } } })
  const { data } = await asCaller.rpc('is_office')
  return data === true
}

export async function agentsPaused(db: SupabaseClient): Promise<boolean> {
  const { data } = await cc(db).from('control').select('agents_paused').eq('id', 1).single()
  return !!data?.agents_paused
}

/** Record one run of a feed for the footer strip (cc.feed_run). */
export async function feedRun(db: SupabaseClient, feedId: string, r: { ok: boolean; rows?: number; error?: string; startedAt?: string; finishedAt?: string }) {
  const now = new Date().toISOString()
  await cc(db).from('feed_run').insert({ feed_id: feedId, started_at: r.startedAt ?? now, finished_at: r.finishedAt ?? now, ok: r.ok, rows: r.rows ?? null, error: r.error ?? null })
}

export interface AlertIn { id: string; rule: string; level: 'red' | 'amber' | 'info'; title: string; why: string; key?: string | null; records?: { source: string; id?: string; url?: string }[] }

/** Open or refresh the alerts a rule fires now; clear the rule's alerts that stopped firing. */
export async function syncAlerts(db: SupabaseClient, rule: string, firing: AlertIn[]) {
  const now = new Date().toISOString()
  const { data: open } = await cc(db).from('alert').select('id').eq('rule', rule).is('cleared_at', null)
  const ids = new Set(firing.map((a) => a.id))
  const gone = (open ?? []).map((a) => a.id).filter((id) => !ids.has(id))
  if (gone.length) await cc(db).from('alert').update({ cleared_at: now }).in('id', gone)
  for (const a of firing) {
    const { data: existing } = await cc(db).from('alert').select('id,cleared_at').eq('id', a.id).maybeSingle()
    if (existing && !existing.cleared_at) {
      await cc(db).from('alert').update({ title: a.title, why: a.why, records: a.records ?? [], last_seen_at: now, level: a.level }).eq('id', a.id)
    } else {
      // New, or fired again after it cleared: a fresh alert (handled flags reset).
      await cc(db).from('alert').upsert({ ...a, key: a.key ?? null, records: a.records ?? [], opened_at: now, last_seen_at: now, cleared_at: null, handled_at: null, handled_by: null, snoozed_until: null })
    }
  }
}
