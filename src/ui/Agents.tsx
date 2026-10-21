import { useState } from 'react'
import type { Agent, AgentStatus, HubState, Task } from '../hub/types'
import { ago, Panel } from './common'

// AGENTS (roster), FLOW (the selected agent's current task as steps) and TASK (dispatch work in plain
// words to one or more agents; the queue shows who has what). Agents not built yet show as off.

const STATUS: Record<AgentStatus, [string, string]> = {
  working: ['Working', 'ok'], watching: ['Watching', 'info'], idle: ['Idle', 'info'], needs_you: ['Needs you', 'amber'],
  failed: ['Failed', 'red'], paused: ['Paused', 'red'], off: ['Not yet', 'info'],
}
const TASK_STATUS: Record<Task['status'], string> = { queued: 'QUEUED', running: 'RUNNING', needs_you: 'NEEDS YOU', done: 'DONE', failed: 'FAILED', cancelled: 'CANCELLED' }
/** Agents that take typed tasks in v1. The rest run on their schedules. */
export const TASKABLE = new Set(['research', 'brief'])

export function AgentsPanels({ s, office, onDispatch, onCancel }: {
  s: HubState; office: boolean
  onDispatch: (text: string, agentIds: string[]) => Promise<void>
  onCancel: (t: Task) => void
}) {
  const [picked, setPicked] = useState<string>('research')
  const [focusTask, setFocusTask] = useState<number | null>(null)
  const [assign, setAssign] = useState<string[]>(['research'])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const agent = s.agents.find((a) => a.id === picked) ?? s.agents[0]
  const task = (focusTask != null ? s.tasks.find((t) => t.id === focusTask) : null) ?? s.tasks.find((t) => t.agentId === agent?.id)
  const shownAgent = task ? s.agents.find((a) => a.id === task.agentId) ?? agent : agent
  const dispatch = async () => {
    const text = draft.trim()
    if (!text || !assign.length) return
    setBusy(true); setErr(null)
    try { await onDispatch(text, assign); setDraft('') } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  const status = (a: Agent) => s.agentsPaused && a.enabled ? STATUS.paused : STATUS[a.status]
  return (
    <>
      <Panel code="AGENTS" label="Agents" sub="tap an agent to see its flow" sample={!s.live}>
        <div className="pb flush agents">
          {s.agents.map((a) => (
            <button key={a.id} className={`agent${a.enabled ? '' : ' off'}`} aria-pressed={a.id === agent?.id} onClick={() => { setPicked(a.id); setFocusTask(null) }}>
              <span className="an">{a.name}</span>
              <span className={`badge ${status(a)[1]}`}>{status(a)[0]}</span>
              <span className="now">{a.nowDoing ?? a.schedule}</span>
            </button>))}
        </div>
      </Panel>
      <section className="panel" aria-label="Agent flow" style={{ flex: '0 0 214px' }}>
        <div className="ph"><span className="code">FLOW · {(shownAgent?.name ?? '').toUpperCase()}</span><span className="sub">{shownAgent?.scope}</span><span className="grow" />
          {task && <span className="age">{ago(task.createdAt)}</span>}</div>
        <div className="pb">
          {task ? <>
            <div className="muted" style={{ marginBottom: 4 }}>{task.text}</div>
            <div className="flow">{task.steps.map((st, i) => (
              <div key={i} className="step"><span className={`s ${st.state}`}>{st.state.toUpperCase()}</span><span>{st.label}</span><span className="d">{st.detail}</span></div>))}</div>
            {task.error && <div className="err">{task.error}</div>}
            {task.result && <div className="result">{task.result}</div>}
          </> : <p className="empty">{shownAgent?.enabled ? `${shownAgent.name} has no task yet. It runs ${shownAgent.schedule.toLowerCase()}.` : shownAgent?.nowDoing}</p>}
        </div>
        <div className="flow-actions">
          <button className="btn small" disabled title="Approvals come with the Books agent in v2">Approve step</button>
          <button className="btn small" disabled={!office || !task || !['queued', 'running'].includes(task.status)} onClick={() => task && onCancel(task)}>Cancel task</button>
          {task?.resultUrl && <a className="btn small" href={task.resultUrl} target="_blank" rel="noopener">Open result</a>}
        </div>
      </section>
      <Panel code="TASK AN AGENT" label="Task an agent" sub="agents run in parallel" className="grow">
        <div className="task-form">
          <div className="who" role="group" aria-label="Assign to">
            <span>Assign to</span>
            {s.agents.filter((a) => a.enabled).map((a) => (
              <button key={a.id} disabled={!TASKABLE.has(a.id)} title={TASKABLE.has(a.id) ? undefined : `${a.name} runs on its schedule`}
                aria-pressed={assign.includes(a.id)} onClick={() => setAssign(assign.includes(a.id) ? assign.filter((x) => x !== a.id) : [...assign, a.id])}>{a.name}</button>))}
          </div>
          <label htmlFor="task">Task</label>
          <div className="in">
            <input id="task" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') dispatch() }}
              placeholder={office ? 'e.g. Find 2027 peanut contract offers and compare them' : 'Sign in as the office to dispatch'} disabled={!office || !s.live || s.agentsPaused} />
            <button className="btn gold" onClick={dispatch} disabled={!office || !s.live || busy || !draft.trim() || !assign.length || s.agentsPaused}>Dispatch</button>
          </div>
          {err && <span className="err">{err}</span>}
          {!s.live && <span className="muted">Dispatch works once the hub is connected.</span>}
        </div>
        <div className="pb flush queue">
          {s.tasks.slice(0, 12).map((t) => (
            <button key={t.id} className="q" aria-pressed={task?.id === t.id} onClick={() => setFocusTask(t.id)}>
              <span className="a">{s.agents.find((a) => a.id === t.agentId)?.name ?? t.agentId}</span>
              <span className="t">{t.text}</span>
              <span className={`s s-${t.status}`}>{TASK_STATUS[t.status]}</span>
              <span className="muted">›</span>
            </button>))}
          {!s.tasks.length && <p className="empty" style={{ padding: '8px 12px' }}>No tasks yet.</p>}
        </div>
      </Panel>
    </>
  )
}
