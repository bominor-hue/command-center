import { useEffect, useMemo, useState } from 'react'
import { buildPlanting, CROPS, daysSince, fmt, isMoney, pct, statusLabel, wallOrder } from '../domain/harvest'
import type { CropHarvest, HubState, HarvestStatus } from '../hub/types'
import { ac, ago, shortDay, Src } from './common'

// The middle of the wall in harvest and planting season: one crop at a time, laid out like the harvest
// workbooks' Dashboard Summary. Section A is the totals and progress, Section B one row per field. On
// the wall the crops take turns every 30 seconds; a tap on a crop holds it for two minutes.

const ROTATE_MS = 30_000, HOLD_MS = 120_000

function useCropTabs(crops: string[]) {
  const [crop, setCrop] = useState(crops[0])
  const [heldAt, setHeldAt] = useState(0)
  useEffect(() => {
    if (!crops.includes(crop)) setCrop(crops[0])
    const t = window.setInterval(() => {
      if (Date.now() - heldAt < HOLD_MS || crops.length < 2) return
      setCrop((c) => crops[(crops.indexOf(c) + 1) % crops.length])
    }, ROTATE_MS)
    return () => window.clearInterval(t)
  }, [crops.join('|'), heldAt]) // eslint-disable-line react-hooks/exhaustive-deps
  return [crops.includes(crop) ? crop : crops[0], (c: string) => { setCrop(c); setHeldAt(Date.now()) }] as const
}

const shortDate = (d: string | null) => (d ? new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' }) : '—')

const TONE: Record<HarvestStatus, string> = { harvesting: 'active', staged: 'need', harvested: 'wait', not_started: 'none', final: 'done' }

/* HARVEST ------------------------------------------------------------------------------------------- */
export function HarvestView({ s, visitor }: { s: HubState; visitor: boolean }) {
  const books = CROPS.map((c) => s.harvest.find((h) => h.crop === c)).filter((h): h is CropHarvest => !!h)
  const [crop, pickCrop] = useCropTabs(books.map((b) => b.crop))
  const h = books.find((b) => b.crop === crop)
  return (
    <section className="panel season-view" aria-label="Harvest dashboard">
      <div className="ph">
        <span className="code">HARVEST</span>
        <span className="sub">{h?.workbook ? <Src s={{ source: 'Harvest workbook', url: h.workbook.url }}>{h.workbook.name}</Src> : 'harvest workbooks'}{h?.note ? ` · ${h.note}` : ''}</span>
        <span className="grow" />
        {!s.live && <span className="badge sample">SAMPLE</span>}
        <span className="age" title="When the workbook was last saved">{h ? `saved ${ago(h.asOf)}` : '—'}</span>
      </div>
      <div className="tabs crop-tabs" role="group" aria-label="Crop">
        {books.map((b) => (
          <button key={b.crop} aria-pressed={b.crop === crop} onClick={() => pickCrop(b.crop)}>
            {b.crop.toUpperCase()} <span className="mono">{Math.round(pct(b.progress.harvested, b.progress.planted))}%</span>
          </button>))}
        <span className="hint">SAME NUMBERS AS THE WORKBOOK DASHBOARD · BLUE = PROJECTED</span>
      </div>
      {h ? <HarvestBody h={h} visitor={visitor} /> : (
        <div className="pb"><p className="empty">No harvest workbook in the hub yet. The harvest collector reads the 2026 Peanut, Cotton and Corn Harvest workbooks from Drive every 30 minutes once the Google secrets are set.</p></div>
      )}
    </section>
  )
}

function HarvestBody({ h, visitor }: { h: CropHarvest; visitor: boolean }) {
  const p = h.progress
  const kpis = h.kpis.filter((k) => !(visitor && isMoney(k.fmt)))
  const sCols = h.summaryCols.filter((c) => !(visitor && isMoney(c.fmt)))
  const fCols = h.fieldCols.filter((c) => !(visitor && isMoney(c.fmt)))
  const rows = useMemo(() => wallOrder(h.fields), [h.fields])
  const counts = useMemo(() => {
    const m = new Map<HarvestStatus, number>()
    for (const f of h.fields) m.set(f.status, (m.get(f.status) ?? 0) + 1)
    return m
  }, [h.fields])
  const left = p.planted - p.harvested
  return (
    <div className="sv-body">
      <div className="sv-band">
        <div className="sv-progress">
          <div className="sv-big"><span className="v">{Math.round(pct(p.harvested, p.planted))}%</span><span className="l">harvested<br />{ac(p.harvested)} of {ac(p.planted)} ac</span></div>
          <div className="bars">
            {p.staged != null && h.stage && <Bar label={h.stage} part={p.staged} whole={p.planted} soft />}
            <Bar label="Harvested" part={p.harvested} whole={p.planted} />
          </div>
          <div className="sv-left">{ac(left)} ac left{p.staged != null && h.stage ? ` · ${ac(Math.max(0, p.staged - p.harvested))} ${h.stage.toLowerCase()}, not picked` : ''}</div>
        </div>
        <div className="sv-kpis" style={{ gridTemplateColumns: `repeat(${Math.min(3, kpis.length)}, minmax(0,1fr))` }}>
          {kpis.map((k) => (
            <div key={k.label} className="kpi" title={k.note}>
              <div className="l">{k.label}</div>
              <div className={`v${k.fmt === 'text' ? ' txt' : ''}`}>{fmt(k.value, k.fmt)}</div>
            </div>))}
        </div>
      </div>

      <div className="sv-a" role="table" aria-label="Section A: totals" style={{ gridTemplateColumns: `minmax(110px,1.4fr) repeat(${sCols.length}, minmax(0,1fr))` }}>
        <span className="th" role="columnheader">{h.crop === 'Corn' ? 'ENTITY' : 'IRR / DRY'}</span>
        {sCols.map((c) => <span key={c.key} className="th num" role="columnheader">{c.label.toUpperCase()}</span>)}
        {h.summary.map((r) => (
          <div key={r.label} className={`sv-a-row${r.label === 'Total' ? ' total' : ''}`} role="row" style={{ display: 'contents' }}>
            <span className="lbl" role="cell">{r.label}</span>
            {sCols.map((c) => <span key={c.key} className="num" role="cell">{fmt(r[c.key], c.fmt)}</span>)}
          </div>))}
      </div>

      <div className="sv-b-head">
        <span className="k">FIELD RESULTS</span>
        {(['harvesting', 'staged', 'harvested', 'not_started', 'final'] as HarvestStatus[]).filter((x) => counts.get(x)).map((x) => (
          <span key={x} className={`st ${TONE[x]}`}>{statusLabel(x, h)} {counts.get(x)}</span>))}
      </div>
      <div className="sv-b" role="table" aria-label="Section B: field results">
        <div className="tr th" role="row" style={{ gridTemplateColumns: fieldGrid(fCols.length, !!h.stage) }}>
          {['FIELD', 'STATUS', 'IRR', 'AC', 'VARIETY', 'PLANT', ...(h.stage ? [h.stage.slice(0, 5).toUpperCase()] : []), 'HARV', ...fCols.map((c) => c.label.toUpperCase())].map((x, i) => (
            <span key={i} role="columnheader" className={i === 3 || i > (h.stage ? 7 : 6) ? 'num' : undefined}>{x}</span>))}
        </div>
        {rows.map((f) => (
          <div key={f.field} className={`tr st-${f.status}`} role="row" style={{ gridTemplateColumns: fieldGrid(fCols.length, !!h.stage) }} title={f.basis ?? undefined}>
            <span role="cell"><b>{f.field}</b></span>
            <span role="cell"><span className={`st ${TONE[f.status]}`}>{statusLabel(f.status, h)}</span></span>
            <span role="cell" className="muted">{f.water ? (f.water.startsWith('Dry') ? 'DRY' : 'IRR') : '—'}</span>
            <span role="cell" className="num">{fmt(f.acres, 'ac')}</span>
            <span role="cell" className="muted">{f.variety ?? '—'}</span>
            <span role="cell" className="mono">{shortDate(f.planted)}</span>
            {h.stage && <span role="cell" className="mono">{shortDate(f.staged)}</span>}
            <span role="cell" className="mono">{shortDate(f.harvested)}</span>
            {fCols.map((c) => <span key={c.key} role="cell" className={`num${f.projected ? ' proj' : ''}`}>{fmt(f.cells[c.key], c.fmt)}</span>)}
          </div>))}
      </div>
    </div>
  )
}

/** Field, status, irr, acres, variety, planted, [dug / defoliated], harvested, then the crop's own columns. */
const fieldGrid = (n: number, stage: boolean) => `minmax(130px,1.5fr) 92px 28px 38px minmax(64px,.9fr) 50px ${stage ? '46px ' : ''}62px repeat(${n}, minmax(44px,.7fr))`

function Bar({ label, part, whole, soft }: { label: string; part: number; whole: number; soft?: boolean }) {
  const v = pct(part, whole)
  return (
    <div className={`bar${soft ? ' soft' : ''}`}>
      <div className="top"><span>{label}</span><span className="mono">{Math.round(v)}% · {ac(part)} / {ac(whole)} ac</span></div>
      <div className="track"><div className="fill" style={{ width: `${v}%` }} /></div>
    </div>
  )
}

/* PLANTING ------------------------------------------------------------------------------------------ */
export function PlantingView({ s, now }: { s: HubState; now: Date }) {
  const all = useMemo(() => CROPS.map((c) => buildPlanting(c, s.fields, s.harvest.find((h) => h.crop === c), s.seeding)).filter((p) => p.fields > 0),
    [s.fields, s.harvest, s.seeding])
  const [crop, pickCrop] = useCropTabs(all.map((p) => p.crop))
  const p = all.find((x) => x.crop === crop)
  const latestSeed = s.seeding.reduce<string | null>((a, o) => (!a || o.date > a ? o.date : a), null)
  const maxWeek = Math.max(1, ...(p?.weeks.map((w) => w.acres) ?? [1]))
  return (
    <section className="panel season-view" aria-label="Planting tracker">
      <div className="ph">
        <span className="code">PLANTING</span>
        <span className="sub">planted vs Field Master plan · dates from the planter (Deere) and the harvest workbooks</span>
        <span className="grow" />
        {!s.live && <span className="badge sample">SAMPLE</span>}
        <span className="age">{latestSeed ? `planter ${ago(latestSeed)}` : 'no Deere seeding yet'}</span>
      </div>
      <div className="tabs crop-tabs" role="group" aria-label="Crop">
        {all.map((x) => (
          <button key={x.crop} aria-pressed={x.crop === crop} onClick={() => pickCrop(x.crop)}>
            {x.crop.toUpperCase()} <span className="mono">{Math.round(pct(x.planted, x.planned))}%</span>
          </button>))}
        <span className="hint">NOT PLANTED FIRST, THEN LATEST PLANTED</span>
      </div>
      {p ? (
        <div className="sv-body">
          <div className="sv-band">
            <div className="sv-progress">
              <div className="sv-big"><span className="v">{Math.round(pct(p.planted, p.planned))}%</span><span className="l">planted<br />{ac(p.planted)} of {ac(p.planned)} ac</span></div>
              <div className="bars"><Bar label="Planted" part={p.planted} whole={p.planned} /></div>
              <div className="sv-left">{ac(Math.max(0, p.planned - p.planted))} ac left · {p.fields - p.fieldsPlanted} of {p.fields} fields to go</div>
            </div>
            <div className="sv-kpis" style={{ gridTemplateColumns: 'repeat(3, minmax(0,1fr))' }}>
              <div className="kpi"><div className="l">Fields planted</div><div className="v">{p.fieldsPlanted}<small> / {p.fields}</small></div></div>
              <div className="kpi"><div className="l">First planted</div><div className="v">{p.first ? shortDay(`${p.first}T12:00:00`).replace(/^\w+, /, '') : '—'}</div></div>
              <div className="kpi"><div className="l">Last planted</div><div className="v">{p.last ? shortDay(`${p.last}T12:00:00`).replace(/^\w+, /, '') : '—'}</div></div>
              <div className="kpi"><div className="l">Planting days</div><div className="v">{p.first && p.last ? daysSince(p.first, new Date(`${p.last}T12:00:00`)) + 1 : '—'}</div></div>
              <div className="kpi"><div className="l">Best week, ac</div><div className="v">{p.weeks.length ? ac(maxWeek) : '—'}</div></div>
              <div className="kpi"><div className="l">Varieties</div><div className="v">{new Set(p.rows.filter((r) => r.variety).map((r) => r.variety)).size || '—'}</div></div>
            </div>
          </div>
          <div className="sv-pace" aria-label="Acres planted per week">
            <span className="k">ACRES PER WEEK</span>
            <div className="weeks">{p.weeks.map((w) => (
              <div key={w.start} className="wk" title={`Week of ${shortDay(`${w.start}T12:00:00`)}: ${ac(w.acres)} ac`}>
                <div className="wbar"><div className="fill" style={{ height: `${(w.acres / maxWeek) * 100}%` }} /></div>
                <span className="n">{ac(w.acres)}</span><span className="d">{shortDate(w.start)}</span>
              </div>))}
              {!p.weeks.length && <span className="empty">Nothing planted yet.</span>}
            </div>
          </div>
          <div className="sv-b" role="table" aria-label="Fields">
            <div className="tr th" role="row" style={{ gridTemplateColumns: PLANT_GRID }}>
              {['FIELD', 'FARM', 'IRR', 'AC', 'VARIETY', 'PLANTED', 'DAP', 'FROM'].map((x, i) => <span key={x} role="columnheader" className={i === 3 || i === 6 ? 'num' : undefined}>{x}</span>)}
            </div>
            {p.rows.map((r) => (
              <div key={r.field} className="tr" role="row" style={{ gridTemplateColumns: PLANT_GRID }}>
                <span role="cell"><b>{r.field}</b> {!r.planted && <span className="st need">Not planted</span>}</span>
                <span role="cell" className="muted">{r.farm ?? '—'}</span>
                <span role="cell" className="muted">{r.water ? (r.water.startsWith('Dry') ? 'DRY' : 'IRR') : '—'}</span>
                <span role="cell" className="num">{ac(r.acres)}</span>
                <span role="cell" className="muted">{r.variety ?? '—'}</span>
                <span role="cell" className="mono">{shortDate(r.planted)}</span>
                <span role="cell" className="num">{r.planted ? daysSince(r.planted, now) : '—'}</span>
                <span role="cell" className="muted">{r.source ?? '—'}</span>
              </div>))}
          </div>
        </div>
      ) : <div className="pb"><p className="empty">No fields in the Field Master for this year yet.</p></div>}
    </section>
  )
}

const PLANT_GRID = 'minmax(200px,1.8fr) minmax(90px,1fr) 34px 52px minmax(90px,1.1fr) 66px 44px 76px'
