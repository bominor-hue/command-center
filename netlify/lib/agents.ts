// The agents that run on Claude: Brief (a short read of the whole farm, 6 AM and 6 PM and on demand)
// and Research (web search plus the hub, on demand). Each run writes its steps to its task row as it
// goes, so the FLOW panel shows them live, and a log of what it read, decided and wrote to cc.agent_run.
// Agents only write inside the hub; nothing here sends, files or enters anything outside it.
import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { Step } from '../../src/hub/types'
import { agentsPaused, cc } from './hub'
import { farmDigest, fieldLookup } from './digest'

const MODEL = 'claude-opus-5-5'
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
const MAX_TURNS = 12

type LogLine = { at: string; kind: 'read' | 'decide' | 'write' | 'ask' | 'error'; text: string }
class Stopped extends Error {}

/** One running task: keeps its steps and log in the hub, and stops when Bo cancels or pauses. */
class Run {
  steps: Step[]
  log: LogLine[] = []
  runId: number | null = null
  constructor(private db: SupabaseClient, public taskId: number, public agentId: string, labels: [string, string][]) {
    this.steps = labels.map(([label, detail]) => ({ state: 'next', label, detail }))
  }
  async start() {
    const { data } = await cc(this.db).from('agent_run').insert({ agent_id: this.agentId, task_id: this.taskId }).select('id').single()
    this.runId = data?.id ?? null
    await cc(this.db).from('task').update({ status: 'running', started_at: new Date().toISOString(), steps: this.steps }).eq('id', this.taskId)
  }
  note(kind: LogLine['kind'], text: string) { this.log.push({ at: new Date().toISOString(), kind, text: text.slice(0, 2000) }) }
  async step(i: number, state: Step['state'], detail?: string) {
    for (let j = 0; j < i; j++) if (this.steps[j].state !== 'done') this.steps[j].state = 'done'
    this.steps[i] = { ...this.steps[i], state, detail: detail ?? this.steps[i].detail }
    await cc(this.db).from('task').update({ steps: this.steps }).eq('id', this.taskId)
    await this.checkStop()
  }
  async checkStop() {
    const { data } = await cc(this.db).from('task').select('cancel_requested').eq('id', this.taskId).single()
    if (data?.cancel_requested) throw new Stopped('Cancelled by the office')
    if (await agentsPaused(this.db)) throw new Stopped('Stopped: all agents were paused')
  }
  async finish(r: { ok: boolean; result?: string; error?: string; status?: 'done' | 'failed' | 'cancelled'; usage?: { in: number; out: number } }) {
    if (r.ok) this.steps = this.steps.map((s) => ({ ...s, state: 'done' }))
    await cc(this.db).from('task').update({
      status: r.status ?? (r.ok ? 'done' : 'failed'), steps: this.steps, result: r.result ?? null, result_kind: r.ok ? 'note' : null,
      error: r.error ?? null, finished_at: new Date().toISOString(),
    }).eq('id', this.taskId)
    if (this.runId) await cc(this.db).from('agent_run').update({ finished_at: new Date().toISOString(), ok: r.ok, log: this.log, tokens_in: r.usage?.in ?? null, tokens_out: r.usage?.out ?? null }).eq('id', this.runId)
  }
}

/** Polls every 4 s while a request is in flight and aborts it on cancel or pause (PRD: stop within 10 s). */
function watchStop(run: Run, ctrl: AbortController) {
  const t = setInterval(() => run.checkStop().catch(() => ctrl.abort()), 4000)
  return () => clearInterval(t)
}

/* Brief ---------------------------------------------------------------------------------------------- */
const BriefOut = z.object({
  text: z.string(), // three sentences
  needs_you: z.array(z.object({ title: z.string(), why: z.string() })),
})
const BRIEF_PROMPT = `You write the morning and evening brief for the owner of Minor Family Farms, a cotton, peanut and corn operation in southwest Georgia. It shows on the office wall screen in large type.
Below is the farm's current state from its own data hub (JSON). Write exactly three short sentences: the three things that matter most today, most important first, in plain farm language with field and pivot names. Use only facts in the data; never guess numbers. If a data feed is late, say so in one of the sentences only when it changes a decision.
Then list up to five items that need the owner personally (a decision, a call, a check), each with a title of a few words and one sentence on why. Leave the list empty if nothing needs him.`

export async function runBrief(db: SupabaseClient, client: Anthropic, taskId: number) {
  const run = new Run(db, taskId, 'brief', [['Read', 'Fields, water, weather, alerts, calendar'], ['Write', 'Three sentences'], ['Post', 'NEEDS YOU panel']])
  await run.start()
  const ctrl = new AbortController(), stop = watchStop(run, ctrl)
  try {
    await cc(db).from('agent').update({ status: 'working', now_doing: 'Writing the brief', updated_at: new Date().toISOString() }).eq('id', 'brief')
    await run.step(0, 'running')
    const digest = await farmDigest(db)
    run.note('read', `Farm digest: ${digest.fields.count} fields, ${digest.alerts.length} open alerts, ${digest.water.running} pivots running`)
    await run.step(1, 'running')
    const msg = await client.beta.messages.parse({
      model: MODEL, max_tokens: 16000, ...FALLBACK,
      output_config: { effort: 'medium', format: betaZodOutputFormat(BriefOut) },
      messages: [{ role: 'user', content: `${BRIEF_PROMPT}\n\n<farm_state>\n${JSON.stringify(digest)}\n</farm_state>` }],
    }, { signal: ctrl.signal })
    if (msg.stop_reason === 'refusal' || !msg.parsed_output) throw new Error('The brief could not be written this time.')
    const out = msg.parsed_output
    run.note('decide', out.text)
    await run.step(2, 'running')
    const { data: b } = await cc(db).from('brief').insert({ text: out.text, needs_you: out.needs_you, agent_run_id: run.runId }).select('id').single()
    run.note('write', `cc.brief ${b?.id}`)
    await run.finish({ ok: true, result: out.text, usage: { in: msg.usage.input_tokens, out: msg.usage.output_tokens } })
    const next = new Date().getHours() < 12 ? '6 PM' : '6 AM'
    await cc(db).from('agent').update({ status: 'idle', now_doing: `Brief posted; next at ${next}`, updated_at: new Date().toISOString() }).eq('id', 'brief')
  } catch (e) {
    await fail(db, run, 'brief', e)
  } finally { stop() }
}

/* Research ------------------------------------------------------------------------------------------- */
const RESEARCH_SYSTEM = `You are the Research agent for Minor Family Farms, a row-crop farm (cotton, peanuts, corn; about 8,000 acres, 112 fields) in Sumter, Lee and Macon Counties, southwest Georgia. The owner hands you questions from the office wall screen.
Find the answer with web search and, when the question is about this farm, the hub tools (the farm's own data). Prefer primary sources: USDA, UGA Extension, NWS, buyers' and shellers' own pages, farm press.
Write the result as a short note the owner can read on a wall screen: the answer first in one or two sentences, then up to eight short lines of supporting facts, each with its source name and date, then a "Sources" list of the links you used. Plain words, no tables. If the answer is uncertain or the sources disagree, say so plainly. You cannot send email, file documents or contact anyone; if the task asks for that, write what you would send and say it needs the owner.`

const HUB_TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  { name: 'hub_farm_state', description: 'The farm right now from its own data hub: harvest progress by crop, fields that need action, pivots running, the forecast, open alerts, the next 14 days of calendar, top news, late data feeds. No input.', input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'hub_fields', description: 'Fields from the 2026 Field Master: name, farm, crop, irrigated or dryland, planned acres, FSA producer, FSN, county. Filter by crop (Cotton, Peanuts, Corn) and/or a farm name.', input_schema: { type: 'object', properties: { crop: { type: 'string' }, farm: { type: 'string' } }, additionalProperties: false } },
]

export async function runResearch(db: SupabaseClient, client: Anthropic, taskId: number, text: string) {
  const run = new Run(db, taskId, 'research', [['Plan', 'Read the task'], ['Gather', 'Web and the hub'], ['Write up', 'Short note, sources linked'], ['Deliver', 'Note in the hub']])
  await run.start()
  const ctrl = new AbortController(), stop = watchStop(run, ctrl)
  const usage = { in: 0, out: 0 }
  try {
    await cc(db).from('agent').update({ status: 'working', now_doing: text.slice(0, 120), updated_at: new Date().toISOString() }).eq('id', 'research')
    await run.step(0, 'running')
    const tools: Anthropic.Beta.BetaToolUnion[] = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 12, user_location: { type: 'approximate', region: 'Georgia', country: 'US', timezone: 'America/New_York' } }, ...HUB_TOOLS]
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: text }]
    let searches = 0, final: Anthropic.Beta.BetaMessage | null = null
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const res = await client.beta.messages.stream({
        model: MODEL, max_tokens: 32000, system: RESEARCH_SYSTEM, tools, messages, ...FALLBACK,
        thinking: { type: 'adaptive' }, output_config: { effort: 'high' },
      }, { signal: ctrl.signal }).finalMessage()
      usage.in += res.usage.input_tokens; usage.out += res.usage.output_tokens
      if (turn === 0) await run.step(1, 'running')
      for (const b of res.content) {
        if (b.type === 'server_tool_use' && b.name === 'web_search') { searches++; run.note('read', `Searched: ${(b.input as any)?.query ?? ''}`) }
      }
      if (searches) await run.step(1, 'running', `${searches} web search${searches > 1 ? 'es' : ''}`)
      if (res.stop_reason === 'refusal') throw new Error('Claude declined this task.')
      messages.push({ role: 'assistant', content: res.content })
      if (res.stop_reason === 'pause_turn') continue
      if (res.stop_reason !== 'tool_use') { final = res; break }
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
      for (const b of res.content) {
        if (b.type !== 'tool_use') continue
        try {
          const out = b.name === 'hub_farm_state' ? await farmDigest(db) : b.name === 'hub_fields' ? await fieldLookup(db, b.input as { crop?: string; farm?: string }) : null
          run.note('read', `Hub: ${b.name} ${JSON.stringify(b.input)}`)
          results.push({ type: 'tool_result', tool_use_id: b.id, content: out == null ? 'Unknown tool' : JSON.stringify(out), is_error: out == null })
        } catch (e) {
          results.push({ type: 'tool_result', tool_use_id: b.id, content: (e as Error).message, is_error: true })
        }
      }
      messages.push({ role: 'user', content: results })
    }
    if (!final) throw new Error(`Stopped after ${MAX_TURNS} rounds without finishing.`)
    await run.step(2, 'running')
    const note = final.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('\n').trim()
    if (!note) throw new Error('No write-up came back.')
    run.note('write', 'Note saved to the task')
    await run.step(3, 'running')
    await run.finish({ ok: true, result: note, usage })
    await cc(db).from('agent').update({ status: 'idle', now_doing: 'Ready for a task', updated_at: new Date().toISOString() }).eq('id', 'research')
  } catch (e) {
    await fail(db, run, 'research', e, usage)
  } finally { stop() }
}

async function fail(db: SupabaseClient, run: Run, agentId: string, e: unknown, usage?: { in: number; out: number }) {
  const stopped = e instanceof Stopped || (e instanceof Anthropic.APIUserAbortError)
  let msg = e instanceof Error ? e.message : String(e)
  if (e instanceof Anthropic.APIUserAbortError) msg = 'Stopped (cancelled or all agents paused)'
  else if (e instanceof Anthropic.RateLimitError) msg = 'Claude API is busy (rate limit); try again in a minute.'
  else if (e instanceof Anthropic.AuthenticationError) msg = 'The Claude API key in Netlify is missing or wrong.'
  run.note('error', msg)
  await run.finish({ ok: false, error: msg, status: stopped ? 'cancelled' : 'failed', usage })
  await cc(db).from('agent').update({ status: stopped ? 'idle' : 'failed', now_doing: msg.slice(0, 200), updated_at: new Date().toISOString() }).eq('id', agentId)
}
