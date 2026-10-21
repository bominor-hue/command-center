import { describe, expect, it } from 'vitest'
import { syncPivotLog } from './pivotSync'

// A stand-in for supabase-js over in-memory tables: just the calls the sync makes.
function fakeDb(tables: Record<string, any[]>) {
  const q = (table: string) => {
    let rows = () => tables[table] ?? (tables[table] = [])
    const filters: ((r: any) => boolean)[] = []
    let sort: [string, boolean] | null = null, lim: [number, number] | null = null
    const run = () => {
      let out = rows().filter((r) => filters.every((f) => f(r)))
      if (sort) { const [c, asc] = sort; out = [...out].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1)) }
      if (lim) out = out.slice(lim[0], lim[1] + 1)
      return { data: out, error: null }
    }
    const b: any = {
      select: () => b,
      gte: (c: string, v: string) => (filters.push((r) => r[c] >= v), b),
      order: (c: string, o?: { ascending?: boolean }) => ((sort = [c, o?.ascending !== false]), b),
      range: (a: number, z: number) => ((lim = [a, z]), b),
      limit: (n: number) => ((lim = [0, n - 1]), b),
      upsert: async (rs: any[]) => {
        for (const r of rs) { const i = rows().findIndex((x) => x.id === r.id); i >= 0 ? (rows()[i] = r) : rows().push(r) }
        return { error: null }
      },
      delete: () => ({ in: async (_c: string, ids: string[]) => { tables[table] = rows().filter((r) => !ids.includes(r.id)); return { error: null } } }),
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    }
    return b
  }
  const db: any = { from: q, schema: () => db, tables }
  return db
}

const now = new Date('2026-10-20T18:00:00Z')
const entry = (id: string, received_at: string) => ({ id, pivot_id: 'p1', action: 'on', happened_at: received_at, received_at, who_name: 'Jose', how: 'app' })

describe('syncPivotLog', () => {
  it('copies master lists whole, removing rows Pivot Log dropped', async () => {
    const pl = fakeDb({ farm: [{ id: 'f1', data: {}, updated_at: 'x' }], pivot: [{ id: 'p1', data: { name: 'Hodges 4' }, updated_at: 'x' }], field: [], entry: [], rain_day: [] })
    const hub = fakeDb({ pl_pivot: [{ id: 'old', data: {}, updated_at: 'x' }] })
    await syncPivotLog(hub, pl, now)
    expect(hub.tables.pl_pivot.map((r: any) => r.id)).toEqual(['p1'])
    expect(hub.tables.pl_farm).toHaveLength(1)
  })

  it('first copy takes 60 days of entries; later copies only what arrived since (with an hour of overlap)', async () => {
    const pl = fakeDb({ farm: [], pivot: [], field: [], rain_day: [], entry: [
      entry('e-old', '2026-07-01T00:00:00Z'), entry('e1', '2026-10-01T00:00:00Z'), entry('e2', '2026-10-20T12:00:00Z'),
    ] })
    const hub = fakeDb({})
    const first = await syncPivotLog(hub, pl, now)
    expect(first.entries).toBe(2)
    expect(hub.tables.pl_entry.map((r: any) => r.id).sort()).toEqual(['e1', 'e2'])
    pl.tables.entry.push(entry('e3', '2026-10-20T17:30:00Z'))
    const second = await syncPivotLog(hub, pl, now)
    expect(second.entries).toBe(2) // e3, plus e2 again (within the hour before the newest copied entry)
    expect(hub.tables.pl_entry).toHaveLength(3) // upserted, never doubled
  })
})
