// Runs queued agent tasks (Netlify background function: up to 15 minutes). Woken by a dispatch from
// the wall and every minute by agent-tick. Tasks run in parallel; each task row is claimed first so a
// second wake-up never runs the same task twice. Netlify environment: ANTHROPIC_API_KEY,
// SUPABASE_SERVICE_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, AGENT_TICK_KEY.
import Anthropic from '@anthropic-ai/sdk'
import { agentsPaused, cc, isOfficeCaller, service } from '../lib/hub'
import { runBrief, runResearch } from '../lib/agents'

export default async function agentRun(req: Request) {
  const tick = process.env.AGENT_TICK_KEY && req.headers.get('x-agent-tick') === process.env.AGENT_TICK_KEY
  if (!tick && !(await isOfficeCaller(req))) return new Response('Not allowed', { status: 403 })
  const db = service()
  if (await agentsPaused(db)) return
  if (!process.env.ANTHROPIC_API_KEY) {
    await cc(db).from('task').update({ status: 'failed', error: 'Agents are not set up yet: add ANTHROPIC_API_KEY in Netlify.', finished_at: new Date().toISOString() }).eq('status', 'queued')
    return
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2 })
  const { data: queued } = await cc(db).from('task').select('id,agent_id,text,cancel_requested').eq('status', 'queued').order('created_at').limit(6)
  const jobs: Promise<void>[] = []
  for (const t of queued ?? []) {
    if (t.cancel_requested) { await cc(db).from('task').update({ status: 'cancelled', finished_at: new Date().toISOString() }).eq('id', t.id); continue }
    // Claim it: only one runner moves a task out of queued.
    const { data: claimed } = await cc(db).from('task').update({ status: 'running' }).eq('id', t.id).eq('status', 'queued').select('id')
    if (!claimed?.length) continue
    if (t.agent_id === 'research') jobs.push(runResearch(db, client, t.id, t.text))
    else if (t.agent_id === 'brief') jobs.push(runBrief(db, client, t.id))
    else await cc(db).from('task').update({ status: 'failed', error: 'This agent takes no typed tasks yet.', finished_at: new Date().toISOString() }).eq('id', t.id)
  }
  await Promise.allSettled(jobs)
}
