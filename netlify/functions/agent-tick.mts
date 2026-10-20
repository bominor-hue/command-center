// Every minute: wake the agent runner when tasks are queued, and queue the Brief at 6 AM and 6 PM
// farm time. Scheduled functions stop at 30 s, so the work itself runs in agent-run-background.
import type { Config } from '@netlify/functions'
import { agentsPaused, cc, service } from '../lib/hub'

const farmHourMinute = () => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date())
  return [Number(p.find((x) => x.type === 'hour')!.value) % 24, Number(p.find((x) => x.type === 'minute')!.value)]
}

export default async function agentTick() {
  const db = service()
  if (await agentsPaused(db)) {
    await cc(db).from('agent').update({ status: 'paused' }).eq('enabled', true).neq('status', 'paused')
    return new Response('paused')
  }
  await cc(db).from('agent').update({ status: 'idle' }).eq('status', 'paused') // resumed
  const [h, m] = farmHourMinute()
  if ((h === 6 || h === 18) && m === 0) {
    await cc(db).from('task').insert({ agent_id: 'brief', text: h === 6 ? 'Morning brief' : 'Evening brief', created_by: 'schedule' })
  }
  const { count } = await cc(db).from('task').select('id', { count: 'exact', head: true }).eq('status', 'queued')
  if (count && process.env.URL && process.env.AGENT_TICK_KEY) {
    await fetch(`${process.env.URL}/.netlify/functions/agent-run-background`, { method: 'POST', headers: { 'x-agent-tick': process.env.AGENT_TICK_KEY } })
  }
  return new Response(`queued ${count ?? 0}`)
}

export const config: Config = { schedule: '* * * * *' }
