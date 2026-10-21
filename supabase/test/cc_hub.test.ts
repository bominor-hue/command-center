import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

// Runs supabase/cc_hub.sql on an in-memory Postgres with stand-ins for Supabase's roles and auth
// schema. Checks it runs twice cleanly, that the first email-link sign-in claims the office, and that
// only the office can change the few things the wall lets it change.
const STUB = `
create role anon; create role authenticated; create role service_role;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('test.jwt', true), ''), '{}')::jsonb $$;
grant usage on schema auth to authenticated;
`
const sql = readFileSync(new URL('../cc_hub.sql', import.meta.url), 'utf8')

async function setup() {
  const pg = new PGlite()
  await pg.exec(STUB)
  await pg.exec(sql)
  await pg.exec(`insert into cc.alert (id, rule, level, title, why) values ('a1', 'pivot-running', 'red', 'Hodges 4 still running?', 'test')`)
  await pg.exec(`insert into cc.news (id, title, source, tag, url, published_at) values ('n1', 'Peanut prices', 'USDA', 'MARKETS', 'https://x', now())`)
  return pg
}
const signIn = (pg: PGlite, email: string, method: 'otp' | 'password') =>
  pg.exec(`reset role; select set_config('test.jwt', '${JSON.stringify({ email, amr: [{ method }] })}', false); set role authenticated;`)
const claim = async (pg: PGlite) => (await pg.query<{ c: boolean }>('select cc.claim_office() c')).rows[0].c
const as = async (pg: PGlite, office: boolean) => {
  await signIn(pg, 'office@farm.test', 'otp'); await claim(pg)
  if (!office) await signIn(pg, 'wall@farm.test', 'password')
}

describe('cc hub schema', { timeout: 30000 }, () => {
  it('applies twice without error and seeds agents and feeds', async () => {
    const pg = await setup()
    await pg.exec(sql)
    expect((await pg.query<{ n: number }>('select count(*)::int n from cc.agent')).rows[0].n).toBe(8)
    expect((await pg.query<{ n: number }>('select count(*)::int n from cc.feed')).rows[0].n).toBe(10)
    expect((await pg.query<{ n: number }>('select count(*)::int n from cc.control')).rows[0].n).toBe(1)
  })

  it('the first email-link sign-in claims the office; the wall password login never can', async () => {
    const pg = await setup()
    await signIn(pg, 'wall@farm.test', 'password')
    expect(await claim(pg)).toBe(false)
    await signIn(pg, 'Bo@Farm.test', 'otp')
    expect(await claim(pg)).toBe(true)
    await signIn(pg, 'someone@else.test', 'otp')
    expect(await claim(pg)).toBe(false)
    expect((await pg.query<{ o: boolean }>('select cc.is_office() o')).rows[0].o).toBe(false)
  })

  it('the Pivot Log copies are readable by any login and writable by none', async () => {
    const pg = await setup()
    await pg.exec(`insert into cc.pl_pivot (id, data, updated_at) values ('p1', '{"name":"Hodges 4"}', now())`)
    await as(pg, true)
    expect((await pg.query('select * from cc.pl_pivot')).rows).toHaveLength(1)
    await expect(pg.exec(`insert into cc.pl_pivot (id, data, updated_at) values ('p2', '{}', now())`)).rejects.toThrow()
  })

  it('a feed with no good run in twice its schedule is overdue', async () => {
    const pg = await setup()
    await pg.exec(`insert into cc.feed_run (feed_id, finished_at, ok) values ('nws', now() - interval '30 minutes', true), ('calendar', now() - interval '45 minutes', true)`)
    const rows = (await pg.query<{ id: string; overdue: boolean }>(`select id, overdue from cc.feed_health where id in ('nws', 'calendar', 'news') order by id`)).rows
    expect(rows).toEqual([{ id: 'calendar', overdue: true }, { id: 'news', overdue: true }, { id: 'nws', overdue: false }])
  })

  it('any login reads; only the office dispatches, cancels, handles, hides and pauses', async () => {
    const pg = await setup()
    await as(pg, false)
    expect((await pg.query('select * from cc.alert')).rows).toHaveLength(1)
    await expect(pg.exec(`insert into cc.task (agent_id, text) values ('research', 'x')`)).rejects.toThrow()
    await pg.exec(`update cc.alert set handled_at = now()`) // row security: changes nothing
    await pg.exec(`update cc.control set agents_paused = true`)
    await pg.exec(`update cc.news set hidden = true`)
    await pg.exec('reset role')
    expect((await pg.query(`select * from cc.alert where handled_at is not null`)).rows).toHaveLength(0)
    expect((await pg.query(`select * from cc.control where agents_paused`)).rows).toHaveLength(0)
    expect((await pg.query(`select * from cc.news where hidden`)).rows).toHaveLength(0)

    await as(pg, true)
    await pg.exec(`insert into cc.task (agent_id, text) values ('research', 'Compare peanut contract offers')`)
    await expect(pg.exec(`insert into cc.task (agent_id, text, status) values ('research', 'x', 'done')`)).rejects.toThrow()
    await pg.exec(`update cc.task set cancel_requested = true`)
    await expect(pg.exec(`update cc.task set status = 'done'`)).rejects.toThrow() // only cancel_requested
    await expect(pg.exec(`update cc.alert set title = 'x'`)).rejects.toThrow() // only handled / snoozed
    await pg.exec(`update cc.alert set handled_at = now(), handled_by = 'office'`)
    await pg.exec(`update cc.control set agents_paused = true`)
    await pg.exec(`update cc.news set hidden = true`)
    await expect(pg.exec(`delete from cc.alert`)).rejects.toThrow()
    await pg.exec('reset role')
    expect((await pg.query(`select * from cc.task where cancel_requested and status = 'queued'`)).rows).toHaveLength(1)
    expect((await pg.query(`select * from cc.alert where handled_at is not null`)).rows).toHaveLength(1)
    expect((await pg.query(`select * from cc.control where agents_paused`)).rows).toHaveLength(1)
  })
})
