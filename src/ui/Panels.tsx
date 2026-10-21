import { useMemo, useState } from 'react'
import { byNeed, farmKey, fieldState, heavyRainAhead, HEAVY_RAIN_IN, type FieldState, type Tone } from '../domain/fieldStatus'
import { isStillRunning, lapsDueWithin, runningPivots, type RunningPivot } from '../domain/water'
import { FIELD_MASTER_SOURCE, FIELD_MASTER_URL } from '../hub/fieldMaster'
import type { FarmForecast, FieldRow, HubState, NewsItem, Season } from '../hub/types'
import { ac, ago, clock, isToday, Panel, shortDay, Src } from './common'

// The panels in the middle and on the left. Each one reads the hub state App passes down and shows
// the time of its newest data; in sample mode each says SAMPLE.

export interface Derived {
  rows: { field: FieldRow; state: FieldState }[]
  running: RunningPivot[]
  forecastByFarm: Map<string, FarmForecast>
  farmWide: FarmForecast | undefined // the farm used for the headline forecast (most fields)
}

export function derive(s: HubState, season: Season, now: Date): Derived {
  const forecastByFarm = new Map(s.forecasts.map((f) => [farmKey(f.farm), f]))
  const running = runningPivots(s.entries, s.pivots, now)
  const runningPivotIds = new Set(running.map((r) => r.pivotId))
  const irrigatingNames = new Set(s.pivotFields.filter((f) => f.pivotId && runningPivotIds.has(f.pivotId)).map((f) => f.name.toLowerCase()))
  const rows = s.fields.map((field) => ({
    field,
    state: fieldState(field, {
      harvestedAcres: s.harvested[field.id]?.acres, lastOp: s.lastOps[field.id], irrigating: irrigatingNames.has(field.name.toLowerCase()),
      rain: heavyRainAhead(forecastByFarm.get(farmKey(field.farm))), season, now,
    }),
  })).sort(byNeed)
  const counts = new Map<string, number>()
  for (const f of s.fields) counts.set(farmKey(f.farm), (counts.get(farmKey(f.farm)) ?? 0) + 1)
  const farmWide = [...s.forecasts].sort((a, b) => (counts.get(farmKey(b.farm)) ?? 0) - (counts.get(farmKey(a.farm)) ?? 0))[0]
  return { rows, running, forecastByFarm, farmWide }
}

const TONE_LABEL: Record<Tone, string> = { risk: 'Before rain', active: 'Working', need: 'Needs water', wait: 'Waiting', none: 'No data', done: 'Done' }

/* FIELD BOARD -------------------------------------------------------------------------------------- */
export function FieldBoard({ s, d, compact, onPick }: { s: HubState; d: Derived; compact?: boolean; onPick: (f: FieldRow) => void }) {
  const [crop, setCrop] = useState('all')
  const rows = d.rows.filter((r) => crop === 'all' || r.field.crop === crop)
  const total = s.fields.reduce((a, f) => a + f.plannedAcres, 0)
  const tones = useMemo(() => {
    const m = new Map<Tone, number>()
    for (const r of d.rows) m.set(r.state.tone, (m.get(r.state.tone) ?? 0) + 1)
    return m
  }, [d.rows])
  const latestOp = Object.values(s.lastOps).reduce<string | null>((a, o) => (!a || o.date > a ? o.date : a), null)
  const wx = d.farmWide
  const sub = `${s.fields[0]?.cropYear ?? ''} · ${s.fields.length} fields · ${ac(total)} planned ac`
  if (compact) {
    return (
      <Panel code="FIELD BOARD" label="Field board" sub={sub} sample={!s.live} age={latestOp ? ago(latestOp) : null}>
        <div className="pb">
          <div className="counts">{(['risk', 'active', 'need', 'wait', 'none', 'done'] as Tone[]).filter((t) => tones.get(t)).map((t) => (
            <span key={t} className={`st ${t}`}>{TONE_LABEL[t]} {tones.get(t)}</span>))}</div>
          <div className="lines">{d.rows.slice(0, 6).map((r) => (
            <button key={r.field.id} className="line" onClick={() => onPick(r.field)} style={{ width: '100%' }}>
              <b>{r.field.name}</b><span className={`next ${r.state.tone}`}>{r.state.status}</span>
            </button>))}</div>
        </div>
      </Panel>
    )
  }
  return (
    <section className="panel" aria-label="Field board" style={{ flex: '0 0 470px' }}>
      <div className="ph">
        <span className="code">FIELD BOARD</span><span className="sub">{sub}</span><span className="grow" />
        {wx && <span className="fb-wx">{wx.days.slice(0, 5).map((x, i) => (
          <span key={x.date}>{i > 0 && ' · '}<span className={x.rainIn >= HEAVY_RAIN_IN ? 'wet' : undefined}>{x.name.slice(0, 3).toUpperCase()} {x.hi ?? '–'}°{x.rainIn >= 0.1 ? ` ${x.rainIn.toFixed(1)} IN` : ''}</span></span>))}</span>}
        {!s.live && <span className="badge sample">SAMPLE</span>}
        <span className="age">{latestOp ? `ops ${ago(latestOp)}` : 'no ops yet'}</span>
      </div>
      <div className="tabs" role="group" aria-label="Filter by crop">
        {['all', 'Cotton', 'Peanuts', 'Corn'].map((c) => (
          <button key={c} aria-pressed={crop === c} onClick={() => setCrop(c)}>{c === 'all' ? 'ALL CROPS' : c.toUpperCase()}</button>))}
        <span className="hint">SORTED: NEEDS ACTION FIRST{wx && heavyRainAhead(wx) ? ` · RAIN ${heavyRainAhead(wx)!.name} = HARVEST BEFORE ${heavyRainAhead(wx)!.name}` : ''}</span>
      </div>
      <div className="pb flush">
        <div className="table" role="table" aria-label="Fields">
          <div className="tr th" role="row">
            {['FARM / FIELD', 'CROP', 'AC', 'WATER', 'STATUS', 'LAST OPERATION', 'NEXT'].map((h, i) => <span key={h} role="columnheader" className={i === 2 ? 'num' : undefined}>{h}</span>)}
          </div>
          {rows.map(({ field: f, state: st }) => (
            <button key={f.id} className="tr" role="row" onClick={() => onPick(f)}>
              <span role="cell"><span className="farm">{f.farm.replace(/ farm$/i, '')} · </span><b>{f.name}</b></span>
              <span role="cell">{f.crop}</span>
              <span role="cell" className="num"><Src s={{ source: FIELD_MASTER_SOURCE }}>{ac(f.plannedAcres)}</Src></span>
              <span role="cell">{f.water === 'Dryland' ? 'DRY' : 'IRR'}</span>
              <span role="cell"><span className={`st ${st.tone}`}>{st.status}</span></span>
              <span role="cell" className="muted">{st.last}</span>
              <span role="cell" className={`next ${st.tone}`}>{st.next}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="fb-foot">
        <span>One row per field from <a href={FIELD_MASTER_URL} target="_blank" rel="noopener">{FIELD_MASTER_SOURCE}</a>. Status from Deere Ops Center, Pivot Log and the NWS forecast.</span>
        <span>Tap a row for its history and sources.</span>
      </div>
    </section>
  )
}

export function FieldSheet({ f, s, d, onClose }: { f: FieldRow; s: HubState; d: Derived; onClose: () => void }) {
  const row = d.rows.find((r) => r.field.id === f.id)
  const op = s.lastOps[f.id], h = s.harvested[f.id]
  const wx = d.forecastByFarm.get(farmKey(f.farm))
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={f.name} onClick={(e) => e.stopPropagation()}>
        <h2>{f.name}</h2>
        <dl className="kv">
          <dt>Farm</dt><dd>{f.farm}</dd>
          <dt>Crop</dt><dd>{f.crop}, {f.water.toLowerCase()}</dd>
          <dt>Planned acres</dt><dd><a href={FIELD_MASTER_URL} target="_blank" rel="noopener">{ac(f.plannedAcres)}</a> <span className="muted">(planned, Field Master)</span></dd>
          <dt>FSA producer</dt><dd>{f.producer ?? '—'}{f.fsn ? ` · FSN ${f.fsn}` : ''}{f.county ? ` · ${f.county} Co.` : ''}</dd>
          <dt>Status</dt><dd>{row?.state.status} · {row?.state.next}</dd>
          <dt>Last operation</dt><dd>{op ? <Src s={op.source}>{row?.state.last}</Src> : 'None on file'}</dd>
          <dt>Harvested</dt><dd>{h ? <Src s={h.source}>{ac(h.acres)} ac, as of {shortDay(h.asOf)}</Src> : '—'}</dd>
          <dt>Forecast</dt><dd>{wx ? <Src s={wx.source}>{wx.days.slice(0, 3).map((x) => `${x.name.slice(0, 3)} ${x.rainIn.toFixed(1)} in`).join(' · ')}</Src> : '—'}</dd>
          <dt>Cost per acre</dt><dd className="muted">Harvest Profit export comes in v3</dd>
        </dl>
        <div className="row"><button className="btn" onClick={onClose}>Close</button></div>
      </div>
    </div>
  )
}

/* NEEDS YOU ------------------------------------------------------------------------------------------ */
export function NeedsYou({ s, office, onHandle }: { s: HubState; office: boolean; onHandle: (id: string) => void }) {
  const [open, setOpen] = useState<string | null>(null)
  const order = { red: 0, amber: 1, info: 2 }
  const alerts = [...s.alerts].filter((a) => a.level !== 'info').sort((a, b) => order[a.level] - order[b.level])
  return (
    <Panel code="NEEDS YOU" label="Needs you" sample={!s.live} flash={alerts.some((a) => a.level === 'red')}
      sub={s.brief ? `brief ${clock(s.brief.writtenAt)}${isToday(s.brief.writtenAt) ? '' : ` ${shortDay(s.brief.writtenAt)}`}` : 'no brief yet'}>
      <div className="pb">
        {s.brief ? <p className="brief">{s.brief.text}</p> : <p className="empty">The Brief agent writes here at 6 AM and 6 PM.</p>}
        {alerts.map((a) => (
          <div key={a.id}>
            <button className="alert" onClick={() => setOpen(open === a.id ? null : a.id)} aria-expanded={open === a.id}>
              <span className={`badge ${a.level}`}>{a.level === 'red' ? 'RED' : 'AMB'}</span>
              <span className="tt"><b>{a.title}</b>{open === a.id && <span>{a.why}</span>}</span>
              <span className="mono muted">{ago(a.openedAt)}</span>
            </button>
            {open === a.id && (
              <div style={{ display: 'flex', gap: 8, padding: '4px 0 8px 52px', flexWrap: 'wrap' }}>
                {a.records.map((r, i) => <Src key={i} s={r}><span className="badge info">{r.source}</span></Src>)}
                {office && <button className="btn small" onClick={() => onHandle(a.id)}>Mark handled</button>}
              </div>
            )}
          </div>
        ))}
        {s.approvalsWaiting > 0 && <div className="alert"><span className="badge info">APPR</span><span className="tt"><b>{s.approvalsWaiting} agent action{s.approvalsWaiting > 1 ? 's' : ''} to approve</b></span></div>}
        {!alerts.length && s.brief && <p className="empty">No open alerts.</p>}
      </div>
    </Panel>
  )
}

/* WATER ------------------------------------------------------------------------------------------------ */
const pivotLogUrl = (import.meta.env.VITE_PIVOT_LOG_URL as string | undefined) || null
export function Water({ s, d, lead }: { s: HubState; d: Derived; lead?: boolean }) {
  const now = new Date()
  const stuck = d.running.filter(isStillRunning)
  const due = lapsDueWithin(d.running, 1, now)
  const rain24 = s.rain.filter((r) => Date.parse(r.date) >= now.getTime() - 2 * 86400000)
  const latestRain = rain24.reduce<string | null>((a, r) => (!a || r.date > a ? r.date : a), null)
  const lastDay = rain24.filter((r) => r.date === latestRain)
  const maxRain = lastDay.reduce((a, r) => Math.max(a, r.inches), 0)
  const latestEntry = s.entries.reduce<string | null>((a, e) => (!a || e.happened_at > a ? e.happened_at : a), null)
  const lines = d.running.slice(0, lead ? 14 : 4)
  return (
    <Panel code="WATER" label="Water and pivots" sample={!s.live} flash={stuck.length > 0} age={latestEntry ? ago(latestEntry) : null}
      sub={pivotLogUrl ? <a href={pivotLogUrl} target="_blank" rel="noopener">open Pivot Log</a> : 'Pivot Log'}>
      <div className="pb">
        <div className="kpis">
          <div className="kpi"><div className="l">Running</div><div className="v">{d.running.length}</div></div>
          <div className="kpi"><div className="l">Laps in 1 h</div><div className="v">{due.length}</div></div>
          <div className={`kpi${stuck.length ? ' red' : ''}`}><div className="l">Still running?</div><div className="v">{stuck.length}</div></div>
        </div>
        <div className="lines">
          {lines.map((r) => (
            <div key={r.pivotId} className="line">
              <b>{r.name}</b>
              <span>ON {r.hours.toFixed(1)} H</span>
              {isStillRunning(r) ? <span className="red">CHECK</span> : r.dueAt ? <span>AROUND {clock(r.dueAt)}</span> : <span className="muted">NO LAP TIME</span>}
            </div>))}
          {!d.running.length && <div className="line"><span>No pivots running</span></div>}
          <div className="line"><span>RAIN {latestRain ? shortDay(latestRain + 'T12:00:00Z').toUpperCase() : '24H'} · MAX ANY PIVOT</span><b>{latestRain ? `${maxRain.toFixed(2)} IN` : '—'}</b></div>
        </div>
      </div>
    </Panel>
  )
}

/* WEATHER ---------------------------------------------------------------------------------------------- */
export function Weather({ s, d, lead }: { s: HubState; d: Derived; lead?: boolean }) {
  const f = d.farmWide
  const wet = s.forecasts.map((x) => ({ farm: x.farm, r: heavyRainAhead(x) })).filter((x) => x.r)
  return (
    <Panel code="WEATHER" label="Weather" sample={!s.live} age={f ? ago(f.asOf) : null} sub={f ? <Src s={f.source}>{f.farm.replace(/ farm$/i, '')} · NWS</Src> : 'NWS'}>
      <div className="pb">
        {f ? <>
          <div className="wx">{f.days.slice(0, 5).map((x) => (
            <div key={x.date} className={`d${x.rainIn >= HEAVY_RAIN_IN ? ' wet' : ''}`} title={x.short}>
              <div className="n">{x.name.slice(0, 3).toUpperCase()}</div>
              <div className="hi">{x.hi ?? '–'}°</div>
              <div className="r">{x.rainIn > 0 ? `${x.rainIn.toFixed(1)} in` : '0 in'}</div>
              {x.pop != null && <div className="p">{x.pop}%</div>}
            </div>))}</div>
          <div className="lines wx-farms">
            {f.sprayWindow && <div className="line"><span>SPRAY WINDOW</span><b>{f.sprayWindow}</b></div>}
            {wet.length ? wet.slice(0, lead ? 20 : 3).map((x) => <div key={x.farm} className="line"><span>{x.farm.replace(/ farm$/i, '').toUpperCase()}</span><span className="red">{x.r!.inches.toFixed(1)} IN {x.r!.name}</span></div>)
              : <div className="line"><span>No day over {HEAVY_RAIN_IN} in. in the next 3</span></div>}
          </div>
        </> : <p className="empty">The NWS forecast collector has not run yet.</p>}
      </div>
    </Panel>
  )
}

/* HARVEST ---------------------------------------------------------------------------------------------- */
export function Harvest({ s }: { s: HubState }) {
  const crops = ['Cotton', 'Peanuts', 'Corn'].map((crop) => {
    const fs = s.fields.filter((f) => f.crop === crop)
    const planned = fs.reduce((a, f) => a + f.plannedAcres, 0)
    const done = fs.reduce((a, f) => a + Math.min(f.plannedAcres, s.harvested[f.id]?.acres ?? 0), 0)
    return { crop, planned, done, pct: planned ? (done / planned) * 100 : 0 }
  })
  const asOf = Object.values(s.harvested).reduce<string | null>((a, h) => (!a || h.asOf > a ? h.asOf : a), null)
  return (
    <Panel code="HARVEST" label="Harvest progress" sample={!s.live} age={asOf ? ago(asOf) : null} sub="harvested of planned ac">
      <div className="pb">
        <div className="bars">{crops.map((c) => (
          <div key={c.crop} className="bar">
            <div className="top"><span>{c.crop}</span><span className="mono">{Math.round(c.pct)}% · {ac(c.done)} / {ac(c.planned)}</span></div>
            <div className="track"><div className="fill" style={{ width: `${Math.min(100, c.pct)}%` }} /></div>
          </div>))}</div>
        <p className="empty" style={{ marginTop: 8 }}>From Deere harvest operations (weekly CSV). Gin bales and peanut grades come in v2.</p>
        <p className="empty">CREW joins here once we know which system records hours (never pay or SSNs).</p>
      </div>
    </Panel>
  )
}

/* DEADLINES -------------------------------------------------------------------------------------------- */
export function Deadlines({ s }: { s: HubState }) {
  return (
    <Panel code="DEADLINES" label="Deadlines" sample={!s.live} sub="Calendar, next 60 days">
      <div className="pb lines">
        {s.deadlines.slice(0, 8).map((x) => (
          <div key={x.id} className="line"><Src s={{ source: x.source, url: x.url }}><b>{x.title}</b></Src><span>{shortDay(x.date).toUpperCase()}</span></div>))}
        {!s.deadlines.length && <p className="empty">Nothing on the calendar in the next 60 days.</p>}
      </div>
    </Panel>
  )
}

/* NEWS ---------------------------------------------------------------------------------------------------- */
const NEWS_TABS = ['ALL', 'MARKETS', 'WEATHER', 'USDA', 'PEANUTS', 'COTTON', 'GEORGIA', 'PESTS']
export function News({ s, office, onHide }: { s: HubState; office: boolean; onHide: (n: NewsItem) => void }) {
  const [tab, setTab] = useState('ALL')
  const items = s.news.filter((n) => tab === 'ALL' || n.tag === tab)
  const t = (iso: string) => isToday(iso) ? clock(iso).replace(/ [AP]M$/, '') : new Date(iso).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' }).toUpperCase()
  return (
    <Panel code="NEWS" label="News feed" sample={!s.live} sub="picked by the News agent" age={s.news[0] ? ago(s.news[0].publishedAt) : null} className="grow">
      <div className="tabs" role="group" aria-label="Filter news">
        {NEWS_TABS.map((x) => <button key={x} aria-pressed={tab === x} onClick={() => setTab(x)}>{x}</button>)}
      </div>
      <div className="pb flush news">
        {items.map((n) => (
          <div key={n.id} style={{ display: 'flex' }}>
            <a href={n.url} target="_blank" rel="noopener" style={{ flex: 1, minWidth: 0 }}>
              <span className="t">{t(n.publishedAt)}</span>
              <span><span className="h">{n.title}</span><span className="s">{n.tag} · {n.source}</span></span>
            </a>
            {office && <button className="down" aria-label={`Not useful: ${n.title}`} title="Not useful (hides it and teaches the filter)" onClick={() => onHide(n)}>✕</button>}
          </div>))}
        {!items.length && <p className="empty" style={{ padding: '8px 12px' }}>No stories in this filter yet.</p>}
      </div>
    </Panel>
  )
}
