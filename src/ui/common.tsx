import type { ReactNode } from 'react'
import type { SourceRef } from '../hub/types'

// Pieces every panel uses: the panel frame (code name, subtitle, age of its data), source links,
// and time formatting in farm time.

export const TZ = 'America/New_York'

export function ago(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return 'never'
  const m = Math.round((now.getTime() - Date.parse(iso)) / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}

export const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ })
export const shortDay = (iso: string) => new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: TZ })
export const isToday = (iso: string, now = new Date()) =>
  new Date(iso).toLocaleDateString('en-US', { timeZone: TZ }) === now.toLocaleDateString('en-US', { timeZone: TZ })
export const ac = (n: number) => Math.round(n).toLocaleString('en-US')

export function Panel(props: { code: string; sub?: ReactNode; age?: string | null; sample?: boolean; flash?: boolean; label: string; className?: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className={`panel${props.flash ? ' flash' : ''}${props.className ? ' ' + props.className : ''}`} aria-label={props.label}>
      <div className="ph">
        <span className="code">{props.code}</span>
        {props.sub && <span className="sub">{props.sub}</span>}
        <span className="grow" />
        {props.right}
        {props.sample && <span className="badge sample">SAMPLE</span>}
        {props.age !== undefined && <span className="age" title="Time of this panel's latest data">{props.age ?? '—'}</span>}
      </div>
      {props.children}
    </section>
  )
}

/** A number or label that opens its source record (PRD: every number links to its source). */
export function Src({ s, children }: { s: SourceRef | null | undefined; children: ReactNode }) {
  if (!s?.url) return <span title={s ? `Source: ${s.source}${s.id ? ` · ${s.id}` : ''}` : undefined}>{children}</span>
  return <a href={s.url} target="_blank" rel="noopener" title={`Open in ${s.source}`}>{children}</a>
}

/** Placeholder for a panel whose feed is not built yet: says exactly what it waits on. */
export function Pending({ code, label, waits, then }: { code: string; label: string; waits: string; then: string }) {
  return (
    <Panel code={code} label={label} sub="not connected yet">
      <div className="pb pending">
        <span>Waits on: <b>{waits}</b></span>
        <span>{then}</span>
      </div>
    </Panel>
  )
}
