import { FIELD_MASTER, FIELD_MASTER_SOURCE } from './fieldMaster'
import type { HubState, LastOperation } from './types'

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
    fields: FIELD_MASTER, lastOps, harvested,
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

export const SAMPLE_NOTE = `Sample data on the real ${FIELD_MASTER_SOURCE} field list. Connect the hub to see live values.`
