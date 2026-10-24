import { useEffect, useMemo, useState } from 'react'
import { LAYOUTS, SEASONS, SEGMENTS, seasonFor, yearPercent, type PanelId } from './domain/season'
import { cancelTask, dispatchTask, hideStory, hubConfigured, hubSetupError, markHandled, setAgentsPaused, supabase } from './hub/client'
import { SAMPLE_NOTE } from './hub/sample'
import type { FieldRow, Season } from './hub/types'
import { useHub, useLocal, useNow } from './hub/useHub'
import { AgentsPanels } from './ui/Agents'
import { ago, Pending, TZ } from './ui/common'
import { Launch } from './ui/Launch'
import { Deadlines, derive, FieldBoard, FieldSheet, Harvest, News, NeedsYou, Water, Weather } from './ui/Panels'

// The wall: header, ticker, season bar, three columns of panels, feed health footer (PRD, Screen
// requirements). A fixed 1920 x 1080 stage scaled to the screen; on a phone one column, most urgent first (styles.css).

const TABS = ['MAIN', 'OPS', 'WATER', 'HARVEST', 'FLEET', 'MONEY', 'MKTS', 'AGENTS']
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
/** Panels Visitor mode hides (PRD: money, markets, crew details and the agent queue), and what fills their place. */
const VISITOR_HIDES = new Set<PanelId>(['needs', 'crew', 'money', 'deadlines'])
const VISITOR_FILL: PanelId[] = ['harvest', 'weather', 'water', 'fieldboard']
const visitorPin = (import.meta.env.VITE_VISITOR_PIN as string | undefined) || ''

function useStageScale() {
  const [scale, setScale] = useState(1)
  useEffect(() => {
    const fit = () => setScale(Math.min(window.innerWidth / 1920, window.innerHeight / 1080))
    fit(); window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])
  return scale
}

export default function App() {
  const { state: s, reload, staleSince, needsSignIn } = useHub()
  const now = useNow()
  const scale = useStageScale()
  const [pickedSeason, setPickedSeason] = useLocal<Season | null>('season', null)
  const [visitor, setVisitor] = useLocal('visitor', false)
  const [pinAsk, setPinAsk] = useState(false)
  const [field, setField] = useState<FieldRow | null>(null)
  const [signIn, setSignIn] = useState(false)
  const season = pickedSeason ?? seasonFor(now)
  const d = useMemo(() => derive(s, season, now), [s, season, Math.floor(now.getTime() / 60000)]) // eslint-disable-line react-hooks/exhaustive-deps
  const office = s.live && s.signedInAsOffice
  const act = (f: () => Promise<void>) => f().then(reload, (e) => alertLater(e))

  let { lead, row } = LAYOUTS[season]
  if (visitor) {
    const fill = VISITOR_FILL.filter((p) => p !== lead && !row.includes(p))
    row = row.map((p) => (VISITOR_HIDES.has(p) ? fill.shift() ?? 'weather' : p)) as typeof row
  }
  const panel = (p: PanelId, big = false) => {
    switch (p) {
      case 'fieldboard': return <FieldBoard key={p} s={s} d={d} compact={!big} onPick={setField} />
      case 'needs': return <NeedsYou key={p} s={s} office={office} onHandle={(id) => act(() => markHandled(id))} />
      case 'water': return <Water key={p} s={s} d={d} lead={big} />
      case 'weather': return <Weather key={p} s={s} d={d} lead={big} />
      case 'harvest': return <Harvest key={p} s={s} />
      case 'deadlines': return <Deadlines key={p} s={s} />
      case 'crew': return <Pending key={p} code="CREW" label="Crew" waits="which system records hours" then="Then: who is on today, operator by machine and field, week hours, license renewals. Never pay or SSNs." />
      case 'fleet': return <Pending key={p} code="FLEET" label="Fleet" waits="the Deere connector (down since Oct 3) and Tecalemit exports" then="Then: machines working, idle and due for service; fuel tank levels." />
      case 'money': return <Pending key={p} code="MONEY" label="Money" waits="QuickBooks and Harvest Profit exports (v3)" then="Then: cash by entity, bills due in 14 days, cost per acre vs budget." />
    }
  }
  const segLeft = yearPercent(now)

  return (
    <div className="stage-wrap">
      <div className="stage" style={{ transform: `scale(${scale})` }}>
        <header className="hdr">
          <span className="mark">MINOR</span><span className="name">FARM COMMAND</span>
          <nav aria-label="Screens">
            {TABS.map((t) => <button key={t} aria-current={t === 'MAIN' ? 'page' : undefined} disabled={t !== 'MAIN'} title={t === 'MAIN' ? undefined : 'Its own screen comes in v2 and v3'}>{t}</button>)}
          </nav>
          <span className="grow" />
          {s.live ? <span className="badge live">LIVE · HUB</span> : <span className="badge sample" title={SAMPLE_NOTE}>SAMPLE DATA</span>}
          <span className="clock">
            <span>{now.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: TZ })}</span>
            <span className="time">{now.toLocaleTimeString('en-US', { hour12: false, timeZone: TZ })}</span><span className="tz">ET</span>
          </span>
          <button className="btn small" onClick={() => (visitor ? (visitorPin ? setPinAsk(true) : setVisitor(false)) : setVisitor(true))}>{visitor ? 'Leave visitor mode' : 'Visitor mode'}</button>
          {office && <button className={`btn small${s.agentsPaused ? ' gold' : ' rust'}`} onClick={() => act(() => setAgentsPaused(!s.agentsPaused))}>{s.agentsPaused ? 'Resume agents' : 'Pause all agents'}</button>}
          {hubConfigured && !office && <button className="btn small" onClick={() => setSignIn(true)}>{needsSignIn ? 'Sign in' : 'Office sign-in'}</button>}
        </header>

        <div className="ticker" aria-label="Market ticker">
          <span className="k">MKTS</span>
          <div className="run">{[0, 1].map((k) => (
            <span key={k} aria-hidden={k === 1 || undefined}>Cotton, corn, soybean and peanut quotes, diesel and basis join this strip with the price feed (v3).</span>))}</div>
        </div>

        {s.agentsPaused && <div className="banner paused">All agents are paused{office ? '. Resume agents in the header turns them back on.' : '.'}</div>}
        {hubSetupError && <div className="banner stale">Hub settings need fixing in Netlify: {hubSetupError}. Showing sample data until then.</div>}
        {staleSince && <div className="banner stale">Hub not answering since {ago(staleSince, now)}: showing the last data. {s.error}</div>}

        <section className="season" aria-label="Time of year">
          <div className="lbl"><span>SEASON MODE</span><span>{SEASONS.find((x) => x.id === season)!.label}</span></div>
          <div className="track">
            <div className="segs">
              {SEGMENTS.map((g, i) => (
                <button key={i} className="seg" style={{ left: `${g.left}%`, width: `calc(${g.width}% - 4px)` }} aria-pressed={g.id === season}
                  onClick={() => setPickedSeason(g.id === seasonFor(now) ? null : g.id)}>{i === 4 ? '' : SEASONS.find((x) => x.id === g.id)!.label}</button>))}
              <div className="today" style={{ left: `${segLeft}%` }} aria-hidden="true" />
            </div>
            <div className="months">{MONTHS.map((m, i) => <span key={m} className={i === now.getMonth() ? 'now' : undefined}>{i === now.getMonth() ? `${m} ${now.getDate()}` : m}</span>)}</div>
          </div>
          <p className="note">{SEASONS.find((x) => x.id === season)!.note}{pickedSeason && pickedSeason !== seasonFor(now) ? ' (picked; tap it again for today’s season)' : ''}</p>
        </section>

        <main className="main">
          <div className="col">
            <Launch canEdit={!visitor} />
            <News s={s} office={office && !visitor} onHide={(n) => act(() => hideStory(n.id))} />
          </div>
          <div className="col">
            {lead === 'fieldboard' ? panel('fieldboard', true) : <div className="lead" style={{ flex: '0 0 470px', display: 'flex', minHeight: 0 }}>{panel(lead, true)}</div>}
            <div className="row4">{row.map((p) => panel(p))}</div>
          </div>
          <div className="col">
            {visitor ? <>{panel('weather', true)}{panel('harvest')}</> : (
              <AgentsPanels s={s} office={office} onDispatch={async (text, ids) => { await dispatchTask(text, ids); await reload() }} onCancel={(t) => act(() => cancelTask(t.id))} />
            )}
          </div>
        </main>

        <footer className="ftr" aria-label="Feed health">
          <span className="k">FEEDS</span>
          {s.feeds.map((f) => (
            <span key={f.id} title={f.lastError ?? undefined}><span className={f.overdue ? 'bad' : 'ok'}>●</span> {f.name} {f.lastOk ? (f.overdue ? `LATE ${ago(f.lastOk, now).toUpperCase()}` : ago(f.lastOk, now).toUpperCase()) : 'NEVER'}</span>))}
          <span className="grow" />
          <span>{s.live ? `HUB SUPABASE · LIVE · ${ago(s.loadedAt, now).toUpperCase()}` : 'HUB NOT CONNECTED · SAMPLE'}</span>
        </footer>
      </div>

      {field && <FieldSheet f={field} s={s} d={d} onClose={() => setField(null)} />}
      {pinAsk && <PinSheet onClose={() => setPinAsk(false)} onOk={() => { setVisitor(false); setPinAsk(false) }} />}
      {signIn && <SignInSheet onClose={() => setSignIn(false)} />}
    </div>
  )
}

function alertLater(e: unknown) { console.error(e) }

function PinSheet({ onOk, onClose }: { onOk: () => void; onClose: () => void }) {
  const [pin, setPin] = useState(''), [bad, setBad] = useState(false)
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label="Leave visitor mode" onClick={(e) => e.stopPropagation()}>
        <h2>Leave visitor mode</h2>
        <label htmlFor="pin">PIN</label>
        <input id="pin" inputMode="numeric" autoFocus value={pin} onChange={(e) => { setPin(e.target.value); setBad(false) }}
          onKeyDown={(e) => { if (e.key === 'Enter') (pin === visitorPin ? onOk() : setBad(true)) }} />
        {bad && <span className="err">That PIN is not right.</span>}
        <div className="row"><button className="btn" onClick={onClose}>Cancel</button><button className="btn gold" onClick={() => (pin === visitorPin ? onOk() : setBad(true))}>Unlock</button></div>
      </div>
    </div>
  )
}

/** The hub's logins: the office by email link (the first one claims the office); the wall's view-only login by email and password. */
function SignInSheet({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState(''), [password, setPassword] = useState('')
  const [msg, setMsg] = useState<string | null>(null), [err, setErr] = useState<string | null>(null)
  const go = async () => {
    setErr(null); setMsg(null)
    if (password) {
      const { error } = await supabase!.auth.signInWithPassword({ email, password })
      if (error) setErr(error.message); else onClose()
    } else {
      const { error } = await supabase!.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: window.location.href } })
      if (error) setErr(error.message); else setMsg('Check your email for the sign-in link.')
    }
  }
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label="Sign in" onClick={(e) => e.stopPropagation()}>
        <h2>Sign in</h2>
        <span className="muted">The office signs in with an email link. The wall screen uses its view-only login and password.</span>
        <label htmlFor="em">Email</label><input id="em" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <label htmlFor="pw">Password (wall login only)</label><input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {err && <span className="err">{err}</span>}{msg && <span>{msg}</span>}
        <div className="row"><button className="btn" onClick={onClose}>Cancel</button><button className="btn gold" onClick={go} disabled={!email}>{password ? 'Sign in' : 'Email me a link'}</button></div>
      </div>
    </div>
  )
}
