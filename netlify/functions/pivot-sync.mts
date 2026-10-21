// Every 5 minutes: copy what the hub needs from Pivot Log (netlify/lib/pivotSync.ts). The PIVOT LOG
// light on the feed strip is this job; it goes red if the copy stops for 20 minutes.
import type { Config } from '@netlify/functions'
import { feedRun, service } from '../lib/hub'
import { pivotLog, syncPivotLog } from '../lib/pivotSync'

export default async function pivotSync() {
  const db = service()
  const startedAt = new Date().toISOString()
  try {
    const r = await syncPivotLog(db, await pivotLog())
    await feedRun(db, 'pivot-log', { ok: true, rows: r.rows, startedAt })
    return Response.json(r)
  } catch (e) {
    await feedRun(db, 'pivot-log', { ok: false, error: (e as Error).message, startedAt })
    return new Response('failed', { status: 500 })
  }
}

export const config: Config = { schedule: '*/5 * * * *' }
