import { useState } from 'react'
import { useLocal } from '../hub/useHub'
import { Panel } from './common'
import { BRANDS } from './brandIcons'

// LAUNCH: icon tiles for every farm site, opening in a new tab. Kept on this screen (not in the hub)
// so the tiles work even when the hub is down. Edit adds, removes and moves tiles.

export interface Tile { name: string; url: string; icon: IconName }
type IconName = 'tractor' | 'drop' | 'gauge' | 'chart' | 'book' | 'leaf' | 'peanut' | 'fuel' | 'flag' | 'news' | 'radar' | 'mail' | 'drive' | 'calendar' | 'link'

const pivotLog = (import.meta.env.VITE_PIVOT_LOG_URL as string | undefined) || ''

// Sign-in links still needed from Bo (PRD open question): AgSense, eNuts, Tecalemit. Blank url = dashed tile.
export const DEFAULT_TILES: Tile[] = [
  { name: 'Ops Center', url: 'https://operationscenter.deere.com', icon: 'tractor' },
  { name: 'Pivot Log', url: pivotLog, icon: 'drop' },
  { name: 'AgSense', url: '', icon: 'gauge' },
  { name: 'Harvest Profit', url: 'https://app.harvestprofit.com', icon: 'chart' },
  { name: 'QuickBooks', url: 'https://qbo.intuit.com', icon: 'book' },
  { name: 'Nutrien', url: 'https://www.nutrienagsolutions.com', icon: 'leaf' },
  { name: 'eNuts', url: '', icon: 'peanut' },
  { name: 'Tecalemit', url: '', icon: 'fuel' },
  { name: 'farmers.gov', url: 'https://www.farmers.gov', icon: 'flag' },
  { name: 'DTN', url: 'https://www.dtnpf.com', icon: 'news' },
  { name: 'NWS radar', url: 'https://radar.weather.gov/station/KTLH/standard', icon: 'radar' },
  { name: 'Gmail', url: 'https://mail.google.com', icon: 'mail' },
  { name: 'Shared Drive', url: 'https://drive.google.com/drive/shared-drives', icon: 'drive' },
  { name: 'Calendar', url: 'https://calendar.google.com', icon: 'calendar' },
]

const P: Record<IconName, string> = {
  tractor: '<circle cx="7" cy="17" r="3"/><circle cx="18" cy="18" r="2"/><path d="M4 14V8h7l2 6h5l2 2M11 8V5h3"/>',
  drop: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
  gauge: '<path d="M4 16a8 8 0 1 1 16 0"/><path d="M12 16l4-5"/>',
  chart: '<path d="M4 20V4M4 20h16M8 16v-4M12 16V8M16 16v-6"/>',
  book: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11"/>',
  leaf: '<path d="M5 19C5 10 11 5 20 4c0 9-5 15-14 15z"/><path d="M5 19l8-8"/>',
  peanut: '<path d="M12 3c2.6 0 4 2 4 4.3 0 2-1 3-1 4.7s1.3 2.8 1.3 4.8c0 2.6-1.9 4.2-4.3 4.2s-4.3-1.6-4.3-4.2c0-2 1.3-3 1.3-4.8S8 9.3 8 7.3C8 5 9.4 3 12 3z"/>',
  fuel: '<path d="M5 20V5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v15M3 20h13M14 9h2l2 2v6a1.5 1.5 0 0 0 3 0V9l-3-3"/><path d="M7 8h5"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  news: '<path d="M4 5h13v14H6a2 2 0 0 1-2-2zM17 9h3v8a2 2 0 0 1-2 2"/><path d="M7 9h7M7 13h7M7 16h4"/>',
  radar: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><path d="M12 12l5-5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  drive: '<path d="M8 4h8l5 9-4 7H7l-4-7z"/><path d="M8 4l5 9h8M7 20l5-7"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M8 3v4M16 3v4"/>',
  link: '<path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1"/>',
}
const Icon = ({ name }: { name: IconName }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: P[name] ?? P.link }} />
)

/** The tile's app icon: the site's real mark. Bundled brand glyphs first (they work offline), then the
 *  site's own favicon, then the line icon if neither is there. */
function AppIcon({ t }: { t: Tile }) {
  const [failed, setFailed] = useState(false)
  let host = ''
  try { host = t.url ? new URL(t.url).hostname : '' } catch { /* not a URL */ }
  const brand = BRANDS[host]
  if (brand) return (
    <span className="appicon" style={{ background: brand.bg }}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d={brand.d} fill={brand.fg} /></svg>
    </span>
  )
  if (host && !failed) return (
    <span className="appicon fav">
      <img src={`https://www.google.com/s2/favicons?domain=${host}&sz=64`} alt="" onError={() => setFailed(true)}
        onLoad={(e) => { if (e.currentTarget.naturalWidth <= 16) setFailed(true) }} />
    </span>
  )
  return <span className="appicon line"><Icon name={t.icon} /></span>
}

export function Launch({ canEdit }: { canEdit: boolean }) {
  const [tiles, setTiles] = useLocal<Tile[]>('launch', DEFAULT_TILES)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(''), [url, setUrl] = useState('')
  const add = () => {
    if (!name.trim() || !/^https:\/\//.test(url.trim())) return
    setTiles([...tiles, { name: name.trim(), url: url.trim(), icon: 'link' }]); setName(''); setUrl('')
  }
  const move = (i: number) => { if (i === 0) return; const t = [...tiles]; [t[i - 1], t[i]] = [t[i], t[i - 1]]; setTiles(t) }
  return (
    <Panel code="LAUNCH" label="Quick launch" sub={editing ? 'tap a tile to move it left' : 'opens in a new tab'}
      right={canEdit ? <button className="btn small" onClick={() => setEditing(!editing)}>{editing ? 'Done' : 'Edit'}</button> : undefined}>
      <div className="tiles">
        {tiles.map((t, i) => editing ? (
          <div key={t.name + i} className="tile">
            <button onClick={() => move(i)} aria-label={`Move ${t.name} left`} style={{ display: 'contents' }}><AppIcon t={t} /><span className="tn">{t.name}</span></button>
            <button className="x" aria-label={`Remove ${t.name}`} onClick={() => setTiles(tiles.filter((_, j) => j !== i))}>×</button>
          </div>
        ) : t.url ? (
          <a key={t.name + i} className="tile" href={t.url} target="_blank" rel="noopener"><AppIcon t={t} /><span className="tn">{t.name}</span></a>
        ) : (
          <span key={t.name + i} className="tile todo" title="Needs its sign-in link: Edit, remove it and add it back with the link"><AppIcon t={t} /><span className="tn">{t.name}</span></span>
        ))}
      </div>
      {editing && (
        <div className="tile-form">
          <input aria-label="Tile name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <input aria-label="Link" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn small gold" onClick={add}>Add tile</button>
            <button className="btn small" onClick={() => setTiles(DEFAULT_TILES)}>Reset to the farm list</button>
          </div>
        </div>
      )}
    </Panel>
  )
}
