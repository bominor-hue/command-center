// Water agent and feed watchdog, every 15 minutes (PRD alerts):
//   red    Pivot still running: a run open past its lap time plus 2 h (Pivot Log entries)
//   red    Feed or agent failed: no successful run in twice its schedule
// It also records Pivot Log's and the nightly rain job's latest activity in the feed strip, since
// those run in the Pivot Log repo and do not report here themselves.
import type { Config } from '@netlify/functions'
import { isStillRunning, runningPivots } from '../../src/domain/water'
import type { EntryRow, PivotDoc } from '../../src/hub/types'
import { agentsPaused, cc, feedRun, service, syncAlerts, type AlertIn } from '../lib/hub'

const ENTRY_COLS = 'id,pivot_id,action,happened_at,who_name,how,percent_timer,planned_stop,start_deg,stop_deg,direction,start_at,stop_at,corrects_id'

export default async function waterWatch() {
  const db = service()
  const started = new Date().toISOString()
  if (await agentsPaused(db)) {
    await cc(db).from('agent').update({ status: 'paused', now_doing: 'Paused with all agents', updated_at: started }).eq('id', 'water')
    return new Response('paused')
  }
  try {
    const since = new Date(Date.now() - 21 * 86400000).toISOString()
    const [{ data: entries, error: e1 }, { data: pivots, error: e2 }] = await Promise.all([
      db.from('entry').select(ENTRY_COLS).gte('happened_at', since),
      db.from('pivot').select('data'),
    ])
    if (e1 || e2) throw new Error((e1 ?? e2)!.message)
    const running = runningPivots((entries ?? []) as EntryRow[], (pivots ?? []).map((p) => p.data as PivotDoc))
    const stuck = running.filter(isStillRunning)
    await syncAlerts(db, 'pivot-running', stuck.map((r): AlertIn => ({
      id: `pivot-running|${r.pivotId}`, rule: 'pivot-running', level: 'red', key: `pivot:${r.pivotId}`,
      title: `${r.name} still running? ${r.hours.toFixed(1)} h`,
      why: r.dueAt
        ? `Turned on by ${r.who} and should have come around ${r.overdueHours!.toFixed(1)} h ago (lap time plus 2 h has passed).`
        : `Turned on by ${r.who} ${r.hours.toFixed(0)} h ago with no lap time on its profile and no OFF logged.`,
      records: [{ source: 'Pivot Log', id: r.entryId }],
    })))
    const now = stuck.length ? `Flagged ${stuck.map((r) => r.name).join(', ')}` : `${running.length} pivot${running.length === 1 ? '' : 's'} running, none overdue`
    await cc(db).from('agent').update({ status: 'watching', now_doing: now, updated_at: new Date().toISOString() }).eq('id', 'water')
    // The same list for the farm MCP server (farm_mcp/server.py pivots_running), so the rules live in one place.
    await cc(db).from('snapshot').upsert({
      key: 'farm-all', metric: 'pivots_running', source: 'Pivot Log', source_id: 'entry', as_of: started, updated_at: started,
      value: running.map((r) => ({ ...r, stillRunning: isStillRunning(r) })),
    })
    await feedRun(db, 'water-rules', { ok: true, rows: running.length, startedAt: started })

    // Pivot Log and the nightly rain job: report their latest activity as feed runs.
    const latestEntry = (entries ?? []).reduce<string | null>((a, e: any) => (!a || e.happened_at > a ? e.happened_at : a), null)
    await reportExternal(db, 'pivot-log', latestEntry)
    const { data: rain } = await db.from('rain_day').select('updated_at').eq('updated_by', 'nightly rain').order('updated_at', { ascending: false }).limit(1)
    await reportExternal(db, 'noaa-rain', rain?.[0]?.updated_at ?? null)

    // Feeds that are overdue.
    const { data: feeds } = await cc(db).from('feed_health').select('*')
    await syncAlerts(db, 'feed-overdue', (feeds ?? []).filter((f) => f.overdue && f.last_ok).map((f): AlertIn => ({
      id: `feed-overdue|${f.id}`, rule: 'feed-overdue', level: 'red', key: `feed:${f.id}`,
      title: `${f.name} feed is late`,
      why: `No successful run since ${new Date(f.last_ok).toLocaleString('en-US', { timeZone: 'America/New_York' })}; it should run every ${f.every_minutes >= 1440 ? `${Math.round(f.every_minutes / 1440)} day(s)` : `${f.every_minutes} min`}.${f.last_error ? ` Last error: ${f.last_error}` : ''}`,
      records: [{ source: 'Feed runs', id: f.id }],
    })))
    return new Response('ok')
  } catch (e) {
    await cc(db).from('agent').update({ status: 'failed', now_doing: (e as Error).message.slice(0, 200), updated_at: new Date().toISOString() }).eq('id', 'water')
    await feedRun(db, 'water-rules', { ok: false, error: (e as Error).message, startedAt: started })
    return new Response('failed', { status: 500 })
  }
}

/** A run record for an outside job, written only when its latest activity moved. */
async function reportExternal(db: ReturnType<typeof service>, feedId: string, latest: string | null) {
  if (!latest) return
  const { data } = await cc(db).from('feed_run').select('finished_at').eq('feed_id', feedId).order('finished_at', { ascending: false }).limit(1)
  if (data?.[0] && Date.parse(data[0].finished_at) >= Date.parse(latest)) return
  await feedRun(db, feedId, { ok: true, startedAt: latest, finishedAt: latest })
}

export const config: Config = { schedule: '*/15 * * * *' }
