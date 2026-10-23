import { Fragment, useMemo, useState } from 'react'
import { DUE_DAYS, farmDay, fertRow, kindsOf, N_TARGET, PROGRAMS, programRows, productKind, SOON_DAYS, STATUS_LABEL, unclassified, type Program, type SprayRow, type SprayStatus } from '../domain/sprays'
import type { Application, FieldRow, HubState } from '../hub/types'
import { ac, ago, Panel, Src } from './common'
import type { Derived } from './Panels'

// The growing season's lead panel and its fertilizer panel. SPRAYS has one tab per program in
// data/spray_programs.json (peanut fungicide; cotton herbicide, Pix and insecticide; corn) plus
// FERTILIZER. Passes come from Deere Ops Center, and from the office for passes Deere never sees.

const TONE: Record<SprayStatus, string> = { overdue: 'risk', due: 'need', soon: 'wait', ontrack: 'ok', complete: 'done', unset: 'none', unplanted: 'none' }
const md = (day: string) => new Date(day + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const shortFarm = (f: FieldRow) => f.farm.replace(/ farm$/i, '')
const productList = (a: Application) => a.products.filter((p) => productKind(p) !== 'adjuvant').join(', ') || a.products.join(', ')

function nextText(r: SprayRow) {
  if (r.status === 'complete') return `All ${r.total} done`
  if (r.status === 'unplanted') return 'No planting on file'
  if (r.status === 'unset' || !r.next) return r.sinceLast != null ? `${r.sinceLast} d since last` : 'None on file'
  const when = r.next.inDays < 0 ? `${-r.next.inDays} d late` : r.next.inDays === 0 ? 'Today' : `In ${r.next.inDays} d`
  return `${when} · ${md(r.next.date)} · ${r.next.dap} DAP`
}

const latestPass = (s: HubState) => Object.values(s.applications).flat().reduce<string | null>((a, x) => (!a || x.date > a ? x.date : a), null)

export function SprayBoard({ s, d, office, onPick }: { s: HubState; d: Derived; office: boolean; onPick: (f: FieldRow) => void }) {
  const [tab, setTab] = useState<string>(PROGRAMS[0].id)
  const today = farmDay(new Date())
  const program = PROGRAMS.find((p) => p.id === tab)
  const byProgram = useMemo(() => new Map(PROGRAMS.map((p) => [p.id, programRows(p, s.fields, s.plantings, s.applications, today)])),
    [s.fields, s.plantings, s.applications, today])
  const latest = latestPass(s)
  const wx = d.farmWide
  const odd = unclassified(Object.values(s.applications).flat())
  return (
    <section className="panel" aria-label="Spray and fertilizer schedules" style={{ flex: 1 }}>
      <div className="ph">
        <span className="code">SPRAYS</span>
        <span className="sub">{s.fields[0]?.cropYear ?? ''} · by days after planting · Deere Ops Center{office ? ' + passes entered here' : ''}</span>
        <span className="grow" />
        {wx?.sprayWindow && <span className="fb-wx" title={`NWS, ${wx.farm}`}>SPRAY WINDOW <b>{wx.sprayWindow.toUpperCase()}</b></span>}
        {!s.live && <span className="badge sample">SAMPLE</span>}
        <span className="age">{latest ? `last pass ${ago(latest + 'T17:00:00Z')}` : 'no passes yet'}</span>
      </div>
      <div className="tabs" role="group" aria-label="Program">
        {PROGRAMS.map((p) => {
          const late = (byProgram.get(p.id) ?? []).filter((r) => r.row.status === 'overdue' || r.row.status === 'due').length
          return <button key={p.id} aria-pressed={tab === p.id} onClick={() => setTab(p.id)}>{p.code}{late ? <span className="tab-n">{late}</span> : null}</button>
        })}
        <button aria-pressed={tab === 'fert'} onClick={() => setTab('fert')}>FERTILIZER</button>
      </div>
      {program ? <ProgramTable p={program} rows={byProgram.get(program.id) ?? []} onPick={onPick} />
        : <FertTable s={s} onPick={onPick} />}
      <div className="fb-foot">
        <span>{program?.passes.length ? `Timings: ${program.source ?? 'data/spray_programs.json'}. Due within ${DUE_DAYS} days, coming up within ${SOON_DAYS}.`
          : program ? 'Timing not set for this program yet: showing passes on file and days since the last one.'
          : `Fertilizer passes this crop year. N per acre where Deere has the rate.`}
          {odd.length ? ` Not sorted yet: ${odd.slice(0, 6).join(', ')}${odd.length > 6 ? ` +${odd.length - 6}` : ''}.` : ''}</span>
        <span>{office ? 'Tap a field to see its passes or record one Deere doesn’t have.' : 'Tap a field for its passes and sources.'}</span>
      </div>
    </section>
  )
}

function ProgramTable({ p, rows, onPick }: { p: Program; rows: ReturnType<typeof programRows>; onPick: (f: FieldRow) => void }) {
  const counts = new Map<SprayStatus, number>()
  for (const r of rows) counts.set(r.row.status, (counts.get(r.row.status) ?? 0) + 1)
  const acres = rows.reduce((a, r) => a + r.field.plannedAcres, 0)
  return (
    <>
      <div className="spray-counts">
        {(p.passes.length ? ['overdue', 'due', 'soon', 'ontrack', 'complete', 'unplanted'] as SprayStatus[] : ['unset'] as SprayStatus[]).map((st) => (
          <span key={st} className={`st ${TONE[st]}`}>{counts.get(st) ?? 0} {STATUS_LABEL[st]}{st === 'due' ? ` ≤${DUE_DAYS} d` : st === 'soon' ? ` ≤${SOON_DAYS} d` : ''}</span>))}
        <span className="hint">{rows.length} {p.crop.toUpperCase()} FIELDS · {ac(acres)} AC{p.passes.length ? ` · PASSES AT ${p.passes.join(' · ')} DAP` : ''}</span>
      </div>
      <div className="pb flush">
        <div className="table sprays" role="table" aria-label={`${p.code} by field`}>
          <div className="tr th" role="row">
            {['FARM / FIELD', 'AC', 'PLANTED', 'DAP', 'PASSES', 'LAST PASS', 'NEXT', 'STATUS'].map((h, i) => <span key={h} role="columnheader" className={i === 1 || i === 3 || i === 4 ? 'num' : undefined}>{h}</span>)}
          </div>
          {rows.map(({ field: f, row: r }) => (
            <button key={f.id} className="tr" role="row" onClick={() => onPick(f)}>
              <span role="cell"><span className="farm">{shortFarm(f)} · </span><b>{f.name}</b>{f.water === 'Dryland' ? <span className="farm"> · DRY</span> : null}</span>
              <span role="cell" className="num">{ac(f.plannedAcres)}</span>
              <span role="cell" className="muted">{r.planted ? md(r.planted) : '—'}</span>
              <span role="cell" className="num">{r.dap ?? '—'}</span>
              <span role="cell" className="num">{r.total ? `${Math.min(r.done, r.total)} / ${r.total}` : r.done}</span>
              <span role="cell" className="muted">{r.last ? <Src s={r.last.source}>{md(r.last.date)} · {productList(r.last)}</Src> : '—'}</span>
              <span role="cell" className={`next ${TONE[r.status]}`}>{nextText(r)}</span>
              <span role="cell"><span className={`st ${TONE[r.status]}`}>{STATUS_LABEL[r.status]}</span></span>
            </button>
          ))}
          {!rows.length && <div className="tr"><span className="muted">No {p.crop.toLowerCase()} fields in the Field Master.</span></div>}
        </div>
      </div>
    </>
  )
}

function FertTable({ s, onPick }: { s: HubState; onPick: (f: FieldRow) => void }) {
  const [crop, setCrop] = useState('Corn')
  const rows = s.fields.filter((f) => f.crop === crop).map((f) => ({ f, r: fertRow(f, s.applications[f.id] ?? []) }))
    .sort((a, b) => a.r.passes.length - b.r.passes.length || (a.r.nLbAc ?? 0) - (b.r.nLbAc ?? 0))
  const target = N_TARGET[crop] ?? null
  return (
    <>
      <div className="spray-counts">
        {['Corn', 'Cotton', 'Peanuts'].map((c) => <button key={c} className="chip" aria-pressed={crop === c} onClick={() => setCrop(c)}>{c.toUpperCase()}</button>)}
        <span className="hint">{rows.filter((x) => !x.r.passes.length).length} OF {rows.length} FIELDS WITH NO FERTILIZER PASS · TARGET {target != null ? `${target} LB N/AC` : 'NOT SET'}</span>
      </div>
      <div className="pb flush">
        <div className="table fert" role="table" aria-label={`Fertilizer, ${crop}`}>
          <div className="tr th" role="row">
            {['FARM / FIELD', 'AC', 'PASSES', 'PRODUCTS', 'LB N / AC', 'VS TARGET', 'LAST PASS'].map((h, i) => <span key={h} role="columnheader" className={i === 1 || i === 2 || i === 4 ? 'num' : undefined}>{h}</span>)}
          </div>
          {rows.map(({ f, r }) => {
            const short = target != null && r.nLbAc != null ? r.nLbAc - target : null
            return (
              <button key={f.id} className="tr" role="row" onClick={() => onPick(f)}>
                <span role="cell"><span className="farm">{shortFarm(f)} · </span><b>{f.name}</b></span>
                <span role="cell" className="num">{ac(f.plannedAcres)}</span>
                <span role="cell" className="num">{r.passes.length}</span>
                <span role="cell" className="muted">{[...new Set(r.passes.flatMap((a) => a.products.filter((p) => productKind(p) === 'fertilizer')))].join(', ') || '—'}</span>
                <span role="cell" className="num">{r.nLbAc != null ? `${r.nKnown ? '' : '≥ '}${r.nLbAc}` : '—'}</span>
                <span role="cell" className={short == null ? 'muted' : short < 0 ? 'next need' : 'next ok'}>{short == null ? '—' : short < 0 ? `${-short} short` : 'met'}</span>
                <span role="cell" className="muted">{r.last ? <Src s={r.last.source}>{md(r.last.date)}</Src> : 'None on file'}</span>
              </button>
            )
          })}
        </div>
      </div>
    </>
  )
}

/** FERT, the small panel: fertilizer progress by crop. */
export function Fert({ s }: { s: HubState }) {
  const latest = Object.values(s.applications).flat().filter((a) => kindsOf(a).has('fertilizer')).reduce<string | null>((a, x) => (!a || x.date > a ? x.date : a), null)
  const crops = ['Corn', 'Cotton', 'Peanuts'].map((crop) => {
    const rows = s.fields.filter((f) => f.crop === crop).map((f) => fertRow(f, s.applications[f.id] ?? []))
    const withN = rows.filter((r) => r.nLbAc != null)
    return { crop, n: rows.length, fed: rows.filter((r) => r.passes.length).length, avgN: withN.length ? Math.round(withN.reduce((a, r) => a + r.nLbAc!, 0) / withN.length) : null }
  }).filter((c) => c.n)
  return (
    <Panel code="FERT" label="Fertilizer" sample={!s.live} age={latest ? ago(latest + 'T17:00:00Z') : null}>
      <div className="pb">
        <div className="lines">
          {crops.map((c) => (
            <div key={c.crop} className="line">
              <b>{c.crop}</b>
              <span>{c.fed} / {c.n} FIELDS</span>
              <span className={N_TARGET[c.crop] != null && c.avgN != null && c.avgN < N_TARGET[c.crop]! ? 'amber' : undefined}>
                {c.avgN != null ? `${c.avgN} LB N` : '—'}{N_TARGET[c.crop] != null ? ` / ${N_TARGET[c.crop]}` : ''}
              </span>
            </div>))}
        </div>
        <p className="empty">From Deere application records. Nutrien’s spreader loads and N targets come next.</p>
      </div>
    </Panel>
  )
}

/** One field's passes this crop year, with their sources; the office can record a pass Deere doesn't have. */
export function SpraySheet({ f, s, office, onClose, onRecord, onDelete }: {
  f: FieldRow; s: HubState; office: boolean; onClose: () => void
  onRecord: (a: { fieldId: string; date: string; products: string[]; acres: number | null; applicator: string | null; note: string | null }) => Promise<void>
  onDelete: (id: number) => Promise<void>
}) {
  const apps = [...(s.applications[f.id] ?? [])].sort((a, b) => b.date.localeCompare(a.date))
  const planted = s.plantings[f.id]
  const [date, setDate] = useState(farmDay(new Date())), [products, setProducts] = useState(''), [acres, setAcres] = useState(String(f.plannedAcres || ''))
  const [who, setWho] = useState(''), [note, setNote] = useState(''), [err, setErr] = useState<string | null>(null), [busy, setBusy] = useState(false)
  const save = async () => {
    const list = products.split(',').map((p) => p.trim()).filter(Boolean)
    if (!list.length) { setErr('Name at least one product.'); return }
    setBusy(true); setErr(null)
    try {
      await onRecord({ fieldId: f.id, date, products: list, acres: acres ? Number(acres) : null, applicator: who.trim() || null, note: note.trim() || null })
      setProducts(''); setNote('')
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  const programs = PROGRAMS.filter((p) => p.crop === f.crop)
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={`${f.name} sprays`} onClick={(e) => e.stopPropagation()}>
        <h2>{f.name}</h2>
        <dl className="kv">
          <dt>Crop</dt><dd>{f.crop}, {f.water.toLowerCase()} · {ac(f.plannedAcres)} ac</dd>
          <dt>Planted</dt><dd>{planted ? <Src s={planted.source}>{md(planted.date)}{planted.variety ? ` · ${planted.variety}` : ''}</Src> : 'No seeding operation on file'}</dd>
          {programs.map((p) => {
            const r = programRows(p, [f], s.plantings, s.applications, farmDay(new Date()))[0]?.row
            return r ? <Fragment key={p.id}><dt>{p.code.charAt(0) + p.code.slice(1).toLowerCase()}</dt><dd>{STATUS_LABEL[r.status]} · {nextText(r)}</dd></Fragment> : null
          })}
        </dl>
        <div className="lines">
          {apps.map((a, i) => (
            <div key={i} className="line">
              <span>{md(a.date)}</span>
              <b style={{ flex: 1 }}>{a.products.join(', ')}</b>
              <span className="muted"><Src s={a.source}>{a.source.source}</Src>{a.acres ? ` · ${ac(a.acres)} ac` : ''}</span>
              {office && a.wallId != null && <button className="btn small" onClick={() => onDelete(a.wallId!)}>Remove</button>}
            </div>))}
          {!apps.length && <div className="line"><span>No spray or fertilizer passes on file this year.</span></div>}
        </div>
        {office && <>
          <label htmlFor="sp-p">Record a pass Deere doesn’t have (products, comma between)</label>
          <input id="sp-p" value={products} onChange={(e) => setProducts(e.target.value)} placeholder="Elatus, Bravo WeatherStik" />
          <div className="row" style={{ justifyContent: 'stretch' }}>
            <input aria-label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <input aria-label="Acres" inputMode="decimal" value={acres} onChange={(e) => setAcres(e.target.value)} placeholder="Acres" style={{ width: 90 }} />
            <input aria-label="Applicator" value={who} onChange={(e) => setWho(e.target.value)} placeholder="Applicator" />
          </div>
          <input aria-label="Note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" />
          {err && <span className="err">{err}</span>}
        </>}
        <div className="row">
          <button className="btn" onClick={onClose}>Close</button>
          {office && <button className="btn gold" disabled={busy || !products.trim()} onClick={save}>Record pass</button>}
        </div>
      </div>
    </div>
  )
}
