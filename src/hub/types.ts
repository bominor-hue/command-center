// Shapes the wall reads. Hub tables are in supabase/cc_hub.sql; Pivot Log's tables keep their own
// shapes (one JSON document per row in `data`, see bominor-hue/pivot-log src/db.ts).

export type Crop = 'Cotton' | 'Peanuts' | 'Corn' | string
export type Season = 'off' | 'planting' | 'growing' | 'harvest'

/** A source record behind a number: every number on the wall opens one of these. */
export interface SourceRef { source: string; id?: string | null; url?: string | null }

export interface FieldRow {
  id: string; cropYear: number; farm: string; name: string; crop: Crop
  water: 'Irrigated' | 'Dryland'; plannedAcres: number
  producer: string | null; fsn: string | null; county: string | null
}

/** The latest Deere operation on a field, from the weekly Ops Center CSV. */
export interface LastOperation { type: string; date: string; product: string | null; acres: number | null; source: SourceRef }

/** A spray or fertilizer pass on a field: from Deere Ops Center (application operations), or entered
 *  from the wall for passes Deere never sees (an airplane, a custom applicator). date is the farm-local day. */
export interface Application {
  date: string; products: string[]; acres: number | null
  rates?: { product: string; rate: number; unit: string }[] // Deere units, e.g. 'gal1ac-1'
  source: SourceRef
  wallId?: number // set when the office entered it on the wall, so it can be taken back
}
/** When a field was planted: the first Deere seeding operation of the season. */
export interface Planting { date: string; variety: string | null; source: SourceRef }

/** Pivot Log rows (the `data` document). */
export interface Sourced<T = number | string> { value: T; source: string; at: string }
export interface PivotDoc { id: string; farmId: string; name: string; lat?: number | null; lon?: number | null; profile: Record<string, Sourced> }
export interface PivotFieldDoc { id: string; farmId: string; name: string; pivotId: string | null }
export interface FarmDoc { id: string; name: string }
export interface EntryRow {
  id: string; pivot_id: string; action: 'on' | 'off' | 'run' | 'void' | 'note'
  happened_at: string; who_name: string; how: string
  percent_timer: number | null; planned_stop: 'lap' | 'position' | 'keep' | null
  start_deg: number | null; stop_deg: number | null; direction: 'forward' | 'reverse' | null
  start_at: string | null; stop_at: string | null; corrects_id: string | null
}
export interface RainDoc { pivotId: string; date: string; inches: number; source: string }

export interface ForecastDay { date: string; name: string; hi: number | null; lo: number | null; rainIn: number; pop: number | null; short: string }
export interface FarmForecast { farm: string; days: ForecastDay[]; sprayWindow: string | null; asOf: string; source: SourceRef }

export type Level = 'red' | 'amber' | 'info'
export interface Alert { id: string; rule: string; level: Level; title: string; why: string; key: string | null; records: SourceRef[]; openedAt: string }
export interface Brief { writtenAt: string; text: string; needsYou: { title: string; why: string }[] }

export type AgentStatus = 'idle' | 'working' | 'watching' | 'needs_you' | 'failed' | 'paused' | 'off'
export interface Agent { id: string; name: string; scope: string; schedule: string; enabled: boolean; status: AgentStatus; nowDoing: string | null }
export type StepState = 'done' | 'running' | 'waiting' | 'next'
export interface Step { state: StepState; label: string; detail: string }
export type TaskStatus = 'queued' | 'running' | 'needs_you' | 'done' | 'failed' | 'cancelled'
export interface Task {
  id: number; agentId: string; text: string; status: TaskStatus; steps: Step[]
  result: string | null; resultKind: 'note' | 'document' | 'approval' | null; resultUrl: string | null
  error: string | null; createdAt: string; finishedAt: string | null
}
export interface FeedHealth { id: string; name: string; lastOk: string | null; overdue: boolean; lastError: string | null }
export interface Deadline { id: string; title: string; date: string; url: string | null; source: string }
export interface NewsItem { id: string; title: string; source: string; tag: string; url: string; publishedAt: string }

/** A harvest workbook's dashboard (collectors/harvest_workbooks.py): Section A totals, the headline
 *  figures, and one row per field, with the columns the workbook shows. */
export type HarvestFmt = 'ac' | 'int' | 'dec1' | 'pct' | 'money' | 'money0' | 'signed' | 'text'
export interface HarvestCol { key: string; label: string; fmt: HarvestFmt }
/** not started, dug or defoliated, loads or modules coming in, finished but still estimated, final */
export type HarvestStatus = 'not_started' | 'staged' | 'harvesting' | 'harvested' | 'final'
export interface HarvestFieldRow {
  fsn: string | null; farm: string | null; field: string; water: string | null; acres: number | null; variety: string | null
  planted: string | null; staged: string | null; harvested: string | null; basis: string | null
  status: HarvestStatus; projected: boolean; cells: Record<string, number | null>
}
export interface CropHarvest {
  crop: Crop
  stage: string | null // the step before harvest: 'Dug' (peanuts), 'Defoliated' (cotton); corn has none
  unit: string; unitsLabel: string
  progress: { planted: number; staged: number | null; harvested: number }
  summaryCols: HarvestCol[]
  summary: ({ label: string } & Record<string, number | string | null>)[]
  kpis: { label: string; value: number | string | null; fmt: HarvestFmt; note?: string }[]
  fieldCols: HarvestCol[]
  fields: HarvestFieldRow[]
  note: string | null
  workbook: { name: string; url: string | null; modifiedAt: string } | null
  asOf: string; source: SourceRef
}
/** A Deere seeding operation (cc.deere_op), for the planting tracker. */
export interface SeedingOp { field: string; crop: string | null; date: string; acres: number | null; variety: string | null }

/** Everything the wall shows, and whether it came from the hub or the built-in sample. */
export interface HubState {
  live: boolean // false = sample data: every panel says so
  loadedAt: string
  error: string | null
  fields: FieldRow[]
  lastOps: Record<string, LastOperation> // by field id
  harvested: Record<string, { acres: number; asOf: string; source: SourceRef }> // by field id
  plantings: Record<string, Planting> // by field id
  applications: Record<string, Application[]> // by field id, every pass this crop year
  harvest: CropHarvest[] // the harvest workbooks' dashboards, one per crop
  seeding: SeedingOp[] // this crop year's Deere planting operations
  pivots: PivotDoc[]
  pivotFields: PivotFieldDoc[]
  farms: FarmDoc[]
  entries: EntryRow[]
  rain: RainDoc[]
  forecasts: FarmForecast[]
  alerts: Alert[]
  brief: Brief | null
  agents: Agent[]
  tasks: Task[]
  approvalsWaiting: number
  feeds: FeedHealth[]
  news: NewsItem[]
  deadlines: Deadline[] // Calendar, next 60 days
  agentsPaused: boolean
  signedInAsOffice: boolean
}
