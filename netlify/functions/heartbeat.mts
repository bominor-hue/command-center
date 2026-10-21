// The filers and other outside jobs report each run here so the feed strip shows them:
//   POST /.netlify/functions/heartbeat   Authorization: Bearer <HEARTBEAT_KEY>
//   {"feed": "nutrien-filer", "ok": true, "rows": 3}            (or "error": "...")
// Feed ids are the rows of cc.feed (supabase/cc_hub.sql). Netlify environment: HEARTBEAT_KEY.
import { feedRun, service } from '../lib/hub'

export default async function heartbeat(req: Request) {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 })
  const key = process.env.HEARTBEAT_KEY
  if (!key || req.headers.get('authorization') !== `Bearer ${key}`) return new Response('Not allowed', { status: 403 })
  const b = (await req.json().catch(() => null)) as { feed?: string; ok?: boolean; rows?: number; error?: string } | null
  if (!b?.feed || !/^[a-z0-9-]{2,40}$/.test(b.feed)) return Response.json({ error: 'Send {"feed": "<feed id>", "ok": true}' }, { status: 400 })
  try {
    await feedRun(service(), b.feed, { ok: b.ok !== false, rows: b.rows, error: b.error?.slice(0, 500) })
    return Response.json({ ok: true })
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 })
  }
}
