import { FIELD_MASTER, FIELD_MASTER_SOURCE } from './fieldMaster'
import type { Application, CropHarvest, HarvestFieldRow, HarvestStatus, HubState, LastOperation } from './types'

// What the wall shows before the hub is connected: the real field list, with made-up statuses,
// pivots, weather and agent work so the layout can be judged. Every panel is labeled SAMPLE.

const at = (h: number, now: Date) => new Date(now.getTime() - h * 3600000).toISOString()
const dayIso = (d: number, now: Date) => new Date(now.getTime() + d * 86400000).toISOString().slice(0, 10)
const dayName = (d: number, now: Date) => new Date(now.getTime() + d * 86400000).toLocaleDateString('en-US', { weekday: 'long' })

export function sampleState(now = new Date()): HubState {
  const src = { source: 'Sample' }
  const op = (type: string, daysAgo: number, product: string | null): LastOperation => ({ type, date: at(daysAgo * 24, now), product, acres: null, source: src })
  const lastOps: HubState['lastOps'] = {}
  const harvested: HubState['harvested'] = {}
  for (const f of FIELD_MASTER) {
    const n = f.name.length + Math.round(f.plannedAcres)
    if (f.crop === 'Corn') { lastOps[f.id] = op('harvest', 40 + (n % 20), null); harvested[f.id] = { acres: f.plannedAcres, asOf: at(48, now), source: src } }
    else if (f.crop === 'Peanuts') {
      if (n % 3 === 0) { lastOps[f.id] = op('harvest', 2 + (n % 9), null); harvested[f.id] = { acres: f.plannedAcres * (n % 2 ? 1 : 0.6), asOf: at(20, now), source: src } }
      else lastOps[f.id] = op('application', 20 + (n % 15), 'Provost Silver')
    } else {
      if (n % 5 === 0) { lastOps[f.id] = op('harvest', 1, null); harvested[f.id] = { acres: f.plannedAcres * 0.55, asOf: at(10, now), source: src } }
      else if (n % 3 === 0) lastOps[f.id] = op('application', 8 + (n % 6), 'Folex + Dropp')
      else lastOps[f.id] = op('application', 25 + (n % 10), 'Prep')
    }
  }
  // Plantings and passes a few weeks into the season whatever today is, so the SPRAYS board and FERT
  // panel can be judged out of season too.
  const plantings: HubState['plantings'] = {}
  const applications: HubState['applications'] = {}
  for (const f of FIELD_MASTER) {
    const n = f.name.length * 7 + Math.round(f.plannedAcres)
    const planted = dayIso(-(38 + (n % 55)), now)
    plantings[f.id] = { date: planted, variety: f.crop === 'Peanuts' ? 'GA-06G' : f.crop === 'Cotton' ? 'DP 2333 B3XF' : 'DKC68-35', source: src }
    const apps: Application[] = []
    const add = (dap: number, products: string[], rates?: Application['rates']) => {
      const date = new Date(Date.parse(planted + 'T12:00:00Z') + dap * 86400000).toISOString().slice(0, 10)
      if (date <= dayIso(0, now)) apps.push({ date, products, acres: f.plannedAcres, rates, source: src })
    }
    if (f.crop === 'Peanuts') {
      const fungicides = [['Elatus', 'Bravo WeatherStik'], ['Provost Silver'], ['Miravis', 'Tebuconazole'], ['Bravo WeatherStik']]
      ;[45, 60, 75, 90, 105].forEach((d, i) => { if (!(n % 4 === 0 && i >= 1)) add(d + (n % 4), fungicides[i % 4]) })
    } else if (f.crop === 'Cotton') {
      add(-1, ['Reflex', 'Warrant'])
      add(26 + (n % 5), ['Choice Trio', 'Liberty', 'Dual Magnum', 'Strut'])
      add(35 + (n % 4), ['28-0-0-5'], [{ product: '28-0-0-5', rate: 10 + (n % 4), unit: 'gal1ac-1' }])
      add(48 + (n % 6), ['Choice Trio', 'Liberty', 'Pix 6x', 'Warrant'])
      if (n % 2) add(58, ['Bidrin 8', 'Full-bor', 'Pix 6x'])
    } else {
      add(0, ['19-11-0Z'])
      add(18 + (n % 5), ['Roundup', 'Atrazine 4L', 'Mesotrione', 'Choice Trio'])
      add(30 + (n % 6), ['28-0-0-5'], [{ product: '28-0-0-5', rate: 28 + (n % 8), unit: 'gal1ac-1' }])
    }
    applications[f.id] = apps
  }
  const pivots: HubState['pivots'] = [
    { id: 'p47', farmId: 'hodges', name: 'Hodges 7', profile: { hoursPerRev100: { value: 18, source: 'Sample', at: at(0, now) } } },
    { id: 'p12', farmId: 'ab', name: 'A&B 12', profile: { hoursPerRev100: { value: 14, source: 'Sample', at: at(0, now) } } },
    { id: 'p31', farmId: 'akin', name: 'Akin 3', profile: {} },
  ]
  const entry = (id: string, pivot: string, h: number, pct: number) => ({
    id, pivot_id: pivot, action: 'on' as const, happened_at: at(h, now), who_name: 'Sample', how: 'app',
    percent_timer: pct, planned_stop: 'lap' as const, start_deg: null, stop_deg: null, direction: 'forward' as const, start_at: null, stop_at: null, corrects_id: null,
  })
  const days = (rains: number[]) => rains.map((r, i) => ({ date: dayIso(i, now), name: i === 0 ? 'Today' : dayName(i, now), hi: [76, 78, 69, 66, 71][i], lo: [55, 58, 60, 50, 48][i], rainIn: r, pop: r ? 80 : 10, short: r >= 1 ? 'Rain, heavy at times' : r ? 'Showers' : 'Sunny' }))
  return {
    live: false, loadedAt: now.toISOString(), error: null,
    fields: FIELD_MASTER, lastOps, harvested, plantings, applications, harvest: sampleHarvest(now), seeding: [],
    pivots, pivotFields: [], farms: [],
    entries: [entry('e1', 'p47', 20, 100), entry('e2', 'p12', 13.4, 100), entry('e3', 'p31', 5, 50)],
    rain: [],
    forecasts: ['A&B Farm', 'Akin Farm', 'Hodge\'s Farm', 'Fletcher Farm', 'Deseret Farm'].map((farm) => ({
      farm, days: days([0, 0.1, 1.4, 0.2, 0]), sprayWindow: 'Until 2 PM today (wind under 10 mph)', asOf: at(1, now), source: src,
    })),
    alerts: [
      { id: 'a1', rule: 'feed-overdue', level: 'red', title: 'Deere connector down', why: 'No successful Deere pull since Oct 3.', key: null, records: [src], openedAt: at(400, now) },
      { id: 'a2', rule: 'heavy-rain', level: 'amber', title: '1.4 in. rain Thursday, cotton ready', why: 'NWS forecast over 1 in. in 24 h with defoliated fields not picked.', key: null, records: [src], openedAt: at(3, now) },
    ],
    brief: { writtenAt: at(1.7, now), text: 'Sample brief: pick the defoliated cotton before Thursday’s rain. Check Hodges 7, it is past its lap time. Deere data has not come in since Oct 3.', needsYou: [] },
    agents: [
      { id: 'brief', name: 'Brief', scope: 'Every hub table, weather, calendar', schedule: '6 AM and 6 PM', enabled: true, status: 'idle', nowDoing: 'Next brief at 6 PM' },
      { id: 'water', name: 'Water', scope: 'Pivot Log (copied every 5 min), NOAA rain', schedule: 'Every 15 minutes', enabled: true, status: 'watching', nowDoing: 'Flagged Hodges 7, past its lap time' },
      { id: 'clerk', name: 'Filing clerk', scope: 'Gmail, Downloads, AI Data', schedule: 'Every 15 minutes', enabled: true, status: 'watching', nowDoing: 'Nutrien filer ran 6:00 AM' },
      { id: 'news', name: 'News', scope: 'USDA, UGA, NWS, farm press', schedule: 'Hourly', enabled: true, status: 'working', nowDoing: 'Picked 9 stories this morning' },
      { id: 'research', name: 'Research', scope: 'Web, the hub', schedule: 'On demand', enabled: true, status: 'working', nowDoing: 'Comparing 2027 peanut contract offers' },
      { id: 'field', name: 'Field ops', scope: 'Deere Ops Center', schedule: 'Every 15 minutes in season', enabled: false, status: 'off', nowDoing: 'Waits on the Deere connector' },
      { id: 'books', name: 'Books', scope: 'QuickBooks, Nutrien, Perry Bros.', schedule: 'Daily', enabled: false, status: 'off', nowDoing: 'Comes with the approval queue (v2)' },
      { id: 'markets', name: 'Markets', scope: 'Prices, marketing sheet', schedule: 'Market hours', enabled: false, status: 'off', nowDoing: 'Comes with the price feed (v3)' },
    ],
    tasks: [
      { id: 2, agentId: 'research', text: 'Compare 2027 peanut contract offers', status: 'running', createdAt: at(0.3, now), finishedAt: null, result: null, resultKind: null, resultUrl: null, error: null,
        steps: [{ state: 'done', label: 'Plan', detail: 'What to compare: price, grade, delivery' }, { state: 'running', label: 'Gather', detail: 'Buying point and sheller offers' }, { state: 'next', label: 'Write up', detail: 'One page, sources linked' }, { state: 'next', label: 'Deliver', detail: 'Note in the hub' }] },
      { id: 1, agentId: 'brief', text: 'Morning brief', status: 'done', createdAt: at(1.8, now), finishedAt: at(1.7, now), result: null, resultKind: 'note', resultUrl: null, error: null,
        steps: [{ state: 'done', label: 'Read', detail: 'Fields, water, weather, alerts, calendar' }, { state: 'done', label: 'Write', detail: 'Three sentences' }] },
    ],
    approvalsWaiting: 0,
    feeds: [
      { id: 'field-master', name: 'FIELD MASTER', lastOk: at(72, now), overdue: false, lastError: null },
      { id: 'pivot-log', name: 'PIVOT LOG', lastOk: at(0.2, now), overdue: false, lastError: null },
      { id: 'noaa-rain', name: 'RAIN+ETO', lastOk: at(3, now), overdue: false, lastError: null },
      { id: 'nws', name: 'NWS FORECAST', lastOk: at(0.5, now), overdue: false, lastError: null },
      { id: 'deere-csv', name: 'DEERE CSV', lastOk: at(190, now), overdue: true, lastError: null },
      { id: 'nutrien-filer', name: 'NUTRIEN', lastOk: at(2, now), overdue: false, lastError: null },
      { id: 'perry-filer', name: 'PERRY BROS', lastOk: at(30, now), overdue: false, lastError: null },
      { id: 'calendar', name: 'CALENDAR', lastOk: at(0.1, now), overdue: false, lastError: null },
      { id: 'news', name: 'NEWS', lastOk: at(0.4, now), overdue: false, lastError: null },
    ],
    news: [
      ['MARKETS', 'DTN', 'Cotton futures steady ahead of weekly export sales', 1],
      ['USDA', 'USDA NASS', 'Crop Progress: Georgia cotton harvested and peanuts dug', 2],
      ['WEATHER', 'NWS Tallahassee', 'Front brings 1 to 1.5 in. of rain to southwest Georgia Thursday', 3],
      ['PEANUTS', 'UGA Extension', 'Digging decisions when rain is forecast within 48 hours', 5],
      ['PESTS', 'UGA Extension', 'Late-season whitefly pressure in cotton', 20],
      ['GEORGIA', 'Southeast Farm Press', 'Southwest Georgia harvest roundup', 26],
    ].map(([tag, source, title, h], i) => ({ id: `s${i}`, tag: tag as string, source: source as string, title: `${title}`, url: '#', publishedAt: at(h as number, now) })),
    deadlines: [
      { id: 'd1', title: '[Deadline from Calendar]', date: at(-6 * 24, now), url: null, source: 'Sample' },
      { id: 'd2', title: '[Lease payment]', date: at(-20 * 24, now), url: null, source: 'Sample' },
    ],
    agentsPaused: false,
    signedInAsOffice: false,
  }
}

/** Made-up harvest workbook dashboards on the real field list (no real yields or dollars: the public
 *  site shows the sample before anyone signs in). */
function sampleHarvest(now: Date): CropHarvest[] {
  const src = { source: 'Sample' }
  const y = now.getFullYear()
  const date = (m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10)
  const book = (crop: 'Peanuts' | 'Cotton' | 'Corn'): CropHarvest => {
    const fs = FIELD_MASTER.filter((f) => f.crop === crop)
    const corn = crop === 'Corn', cotton = crop === 'Cotton'
    const share = corn ? 1 : cotton ? 0.35 : 0.7 // of fields finished
    const rows: HarvestFieldRow[] = fs.map((f, i) => {
      const n = (f.name.length * 7 + i * 13) % 100
      const planted = corn ? date(3, 5 + Math.floor((i / fs.length) * 24)) : date(4, 15 + Math.floor((i / fs.length) * 50))
      const done = i / fs.length < share
      const status: HarvestStatus = done ? (n % 6 === 0 && !corn ? 'harvested' : 'final') : i / fs.length < share + 0.12 ? 'harvesting' : !corn && i / fs.length < share + 0.35 ? 'staged' : 'not_started'
      const yld = corn ? 180 + (n % 60) : cotton ? 850 + (n % 9) * 60 : 3600 + (n % 12) * 150
      const has = status !== 'not_started' && status !== 'staged'
      const cells: Record<string, number | null> = {}
      const units = has ? Math.max(1, Math.round((f.plannedAcres * yld) / (corn ? 1000 : cotton ? 2100 : 45000))) : null
      return {
        fsn: f.fsn, farm: f.farm.replace(/ farm$/i, ''), field: f.name, water: f.water, acres: f.plannedAcres,
        variety: corn ? ['DKC 68-35', 'P18216PWE'][n % 2] : cotton ? ['DP 2537', 'DP 2618'][n % 2] : ['GA 06G', 'TifNV-HG'][n % 2],
        planted, staged: status === 'not_started' || corn ? null : date(9, 12 + (i % 30)), harvested: done ? date(corn ? 8 : 9, 20 + (i % 30)) : null,
        basis: corn ? (done ? 'Harvested' : null) : null, status, projected: status === 'harvesting' || status === 'harvested',
        cells: Object.assign(cells, corn
          ? { 'harvested ac': has ? f.plannedAcres : null, loads: units, 'combine bu': has ? f.plannedAcres * yld : null, 'combine yield': has ? yld : null, 'hauled bu': has ? f.plannedAcres * yld * 1.01 : null }
          : cotton
            ? { 'modules picked': units, 'modules ginned': null, bales: has ? (f.plannedAcres * yld) / 480 : null, 'turnout %': null, 'lint yield (lbs/ac)': has ? yld : null, '2025 yield': 1000 + (n % 5) * 80, 'vs 2025 (lbs/ac)': has ? yld - (1000 + (n % 5) * 80) : null }
            : { loads: units, 'avg grade (wtd)': has ? 70 + (n % 6) : null, 'avg lsk (wtd)': has ? 2 + (n % 4) * 0.5 : null, 'total pounds': has ? f.plannedAcres * yld : null, 'yield (lbs/ac)': has ? yld : null, 'value / acre $': status === 'final' ? yld * 0.29 : null }),
      }
    })
    const sum = (pred: (r: HarvestFieldRow) => boolean, w?: string) => rows.filter((r) => pred(r) && (!w || r.water === w)).reduce((a, r) => a + (r.acres ?? 0), 0)
    const planted = sum(() => true), staged = corn ? null : sum((r) => r.status !== 'not_started'), harvestedAc = sum((r) => r.status === 'final' || r.status === 'harvested')
    const lbs = rows.reduce((a, r) => a + (r.cells[corn ? 'combine bu' : cotton ? 'lint yield (lbs/ac)' : 'total pounds'] ?? 0) * (cotton ? r.acres ?? 0 : 1), 0)
    const yieldAc = harvestedAc ? lbs / harvestedAc : null
    const totalRow = (label: string, w?: string): CropHarvest['summary'][number] => {
      const pl = sum(() => true, w), st = sum((r) => r.status !== 'not_started', w), hv = sum((r) => r.status === 'final' || r.status === 'harvested', w)
      return corn
        ? { label, 'planted ac': pl, 'harvested ac': hv, '% done': pl ? hv / pl : null, 'combine bu': hv * (yieldAc ?? 0), yield: yieldAc }
        : cotton
          ? { label, 'planted acres': pl, 'acres defoliated': st, 'acres harvested': hv, 'acres left to pick': pl - hv, 'modules picked': null, 'modules ginned': 0, 'bales (est. until ginned)': (hv * (yieldAc ?? 0)) / 480, 'lint yield (lbs/ac)': yieldAc }
          : { label, 'planted acres': pl, 'acres dug': st, 'acres harvested': hv, 'acres to pick': st - hv, 'total net lbs': hv * (yieldAc ?? 0), 'avg grade tsmk % (wtd)': 72.4, 'avg lsk % (wtd)': 3.1, 'yield (lbs/ac)': yieldAc, 'actual field value': null, 'actual value / acre': null }
    }
    return {
      crop, stage: corn ? null : cotton ? 'Defoliated' : 'Dug', unit: corn ? 'bu/ac' : cotton ? 'lint lbs/ac' : 'lbs/ac', unitsLabel: cotton ? 'Modules' : 'Loads',
      progress: { planted, staged, harvested: harvestedAc },
      summaryCols: corn
        ? [{ key: 'planted ac', label: 'Planted', fmt: 'ac' }, { key: 'harvested ac', label: 'Harvested', fmt: 'ac' }, { key: '% done', label: 'Done', fmt: 'pct' }, { key: 'combine bu', label: 'Combine bu', fmt: 'int' }, { key: 'yield', label: 'Yield', fmt: 'dec1' }]
        : cotton
          ? [{ key: 'planted acres', label: 'Planted', fmt: 'ac' }, { key: 'acres defoliated', label: 'Defoliated', fmt: 'ac' }, { key: 'acres harvested', label: 'Harvested', fmt: 'ac' }, { key: 'acres left to pick', label: 'Left', fmt: 'ac' }, { key: 'bales (est. until ginned)', label: 'Bales', fmt: 'int' }, { key: 'lint yield (lbs/ac)', label: 'Lint yield', fmt: 'int' }]
          : [{ key: 'planted acres', label: 'Planted', fmt: 'ac' }, { key: 'acres dug', label: 'Dug', fmt: 'ac' }, { key: 'acres harvested', label: 'Harvested', fmt: 'ac' }, { key: 'acres to pick', label: 'To pick', fmt: 'ac' }, { key: 'total net lbs', label: 'Net lbs', fmt: 'int' }, { key: 'avg grade tsmk % (wtd)', label: 'TSMK', fmt: 'dec1' }, { key: 'avg lsk % (wtd)', label: 'LSK', fmt: 'dec1' }, { key: 'yield (lbs/ac)', label: 'Yield', fmt: 'int' }],
      summary: corn ? [totalRow('Sample entity'), totalRow('Total')] : [totalRow('Irrigated', 'Irrigated'), totalRow('Dryland', 'Dryland'), totalRow('Total')],
      kpis: corn
        ? [{ label: 'Combine bu', value: lbs, fmt: 'int' }, { label: 'Yield bu/ac', value: yieldAc, fmt: 'dec1' }, { label: 'In bins', value: lbs * 0.4, fmt: 'int' }]
        : cotton
          ? [{ label: 'Modules picked', value: rows.reduce((a, r) => a + (r.cells['modules picked'] ?? 0), 0), fmt: 'int' }, { label: 'Bales', value: (harvestedAc * (yieldAc ?? 0)) / 480, fmt: 'int', note: 'est. until ginned' }, { label: 'Lint lbs/ac', value: yieldAc, fmt: 'int' }]
          : [{ label: 'Net lbs', value: lbs, fmt: 'int' }, { label: 'Yield lbs/ac', value: yieldAc, fmt: 'int' }, { label: 'Grade TSMK', value: 72.4, fmt: 'dec1' }, { label: 'LSK', value: 3.1, fmt: 'dec1' }, { label: 'Field value', value: lbs * 0.29, fmt: 'money0' }, { label: 'Value / ac', value: (yieldAc ?? 0) * 0.29, fmt: 'money0' }],
      fieldCols: corn
        ? [{ key: 'harvested ac', label: 'Harv ac', fmt: 'ac' }, { key: 'loads', label: 'Loads', fmt: 'int' }, { key: 'combine bu', label: 'Combine bu', fmt: 'int' }, { key: 'combine yield', label: 'Yield', fmt: 'dec1' }]
        : cotton
          ? [{ key: 'modules picked', label: 'Mods', fmt: 'int' }, { key: 'bales', label: 'Bales', fmt: 'int' }, { key: 'lint yield (lbs/ac)', label: 'Yield', fmt: 'int' }, { key: '2025 yield', label: '2025', fmt: 'int' }, { key: 'vs 2025 (lbs/ac)', label: 'vs 2025', fmt: 'signed' }]
          : [{ key: 'loads', label: 'Loads', fmt: 'int' }, { key: 'avg grade (wtd)', label: 'TSMK', fmt: 'dec1' }, { key: 'avg lsk (wtd)', label: 'LSK', fmt: 'dec1' }, { key: 'total pounds', label: 'Lbs', fmt: 'int' }, { key: 'yield (lbs/ac)', label: 'Yield', fmt: 'int' }, { key: 'value / acre $', label: '$/ac', fmt: 'money' }],
      fields: rows, note: 'sample figures, not the workbook', workbook: { name: `${y} ${crop === 'Peanuts' ? 'Peanut' : crop} Harvest (sample)`, url: null, modifiedAt: at(3, now) },
      asOf: at(3, now), source: src,
    }
  }
  return [book('Peanuts'), book('Cotton'), book('Corn')]
}

export const SAMPLE_NOTE = `Sample data on the real ${FIELD_MASTER_SOURCE} field list. Connect the hub to see live values.`
