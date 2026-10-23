-- Farm Command Center hub: the `cc` schema in its own Supabase project (the farm hub), apart from
-- Pivot Log's project.
--
-- Pivot Log stays its own app and database. What the hub needs from it (farms, pivots, pivot fields,
-- recent on/off entries, radar rain) is copied in every 5 minutes by netlify/functions/pivot-sync.mts
-- into the pl_* tables below, signing in to Pivot Log as a read-only viewer. The hub never writes to
-- Pivot Log. This file is applied by .github/workflows/hub-schema.yml with psql; every statement is
-- safe to run again.
--
-- Who can do what (the hub's own logins):
--   office    the first email-link sign-in claims it (same rule as Pivot Log); reads everything,
--             dispatches tasks, marks alerts handled, pauses agents. More office emails: add rows to
--             cc.office_user.
--   any other signed-in login (the wall's view-only login) reads everything
--   collectors, agents and the MCP server write with the service key, which skips row security

create schema if not exists cc;
grant usage on schema cc to authenticated, service_role;

-- Office logins -------------------------------------------------------------------------------------
create table if not exists cc.office_user (email text primary key, added_at timestamptz not null default now());

create or replace function cc.is_office() returns boolean language sql stable security definer set search_path = cc as $$
  select exists (select 1 from cc.office_user where email = lower(auth.jwt() ->> 'email'))
$$;

-- The first person to sign in by email link becomes the office. Never a password login (the wall).
create or replace function cc.claim_office() returns boolean language plpgsql security definer set search_path = cc as $$
declare me text := lower(auth.jwt() ->> 'email');
begin
  if me is null then return false; end if;
  if exists (select 1 from cc.office_user where email = me) then return true; end if;
  if exists (select 1 from cc.office_user) then return false; end if;
  if exists (select 1 from jsonb_array_elements(coalesce(auth.jwt() -> 'amr', '[]'::jsonb)) a where a ->> 'method' = 'password') then return false; end if;
  insert into cc.office_user (email) values (me);
  return true;
end $$;
revoke all on function cc.claim_office() from public, anon;
grant execute on function cc.is_office(), cc.claim_office() to authenticated;

-- Copied from Pivot Log ---------------------------------------------------------------------------------
-- Kept in Pivot Log's own shapes (its master lists are {id, data} documents) so the hub reads them with
-- the same rules as Pivot Log. Written only by the pivot sync.
create table if not exists cc.pl_farm (id text primary key, data jsonb not null, updated_at timestamptz not null);
create table if not exists cc.pl_pivot (id text primary key, data jsonb not null, updated_at timestamptz not null);
create table if not exists cc.pl_field (id text primary key, data jsonb not null, updated_at timestamptz not null);
create table if not exists cc.pl_rain_day (id text primary key, data jsonb not null, updated_at timestamptz not null, updated_by text);
create table if not exists cc.pl_entry (
  id uuid primary key,
  pivot_id text not null,
  action text not null,
  happened_at timestamptz not null,
  received_at timestamptz not null,
  who_name text not null,
  how text not null,
  percent_timer numeric,
  planned_stop text,
  start_deg numeric, stop_deg numeric,
  direction text,
  start_at timestamptz, stop_at timestamptz,
  corrects_id uuid
);
create index if not exists pl_entry_happened on cc.pl_entry (happened_at);
create index if not exists pl_entry_received on cc.pl_entry (received_at);

-- The farm's keys -----------------------------------------------------------------------------------
-- One row per field per crop year, loaded from the Field Master (collectors/field_master.py).
create table if not exists cc.field (
  id text primary key,                 -- '2026|A&B #5W'
  crop_year int not null,
  farm text not null,
  name text not null,
  crop text,
  water text check (water in ('Irrigated', 'Dryland')),
  planned_acres numeric,
  producer text,                       -- the FSA producer, as written in the crosswalk
  fsn text,
  county text,
  source text not null,                -- 'Field Master 2026.csv'
  updated_at timestamptz not null default now()
);
create index if not exists field_year on cc.field (crop_year, farm);

-- Latest value per key and metric (forecast by farm, harvest acres by field, last operation by field).
create table if not exists cc.snapshot (
  key text not null,                   -- 'farm:A&B Farm', 'field:2026|A&B #5W', 'farm-all'
  metric text not null,                -- 'forecast', 'harvested_acres', 'last_operation', ...
  value jsonb not null,
  source text not null,                -- system it came from: 'NWS', 'Deere CSV', 'Pivot Log'
  source_id text,                      -- its id there
  source_url text,                     -- a link that opens the source record
  as_of timestamptz not null,          -- when the source says this was true
  updated_at timestamptz not null default now(),
  primary key (key, metric)
);

-- Timestamped facts (an operation, a delivery, a filed document).
create table if not exists cc.event (
  id text primary key,                 -- source system + its id, so a re-run never duplicates
  kind text not null,
  key text,
  happened_at timestamptz not null,
  title text not null,
  detail jsonb not null default '{}',
  source text not null, source_id text, source_url text,
  created_at timestamptz not null default now()
);
create index if not exists event_kind_time on cc.event (kind, happened_at desc);

-- Alerts: red, amber, info. One open row per rule and key; re-firing updates it.
create table if not exists cc.alert (
  id text primary key,                 -- rule + key, e.g. 'pivot-running|<pivot id>'
  rule text not null,
  level text not null check (level in ('red', 'amber', 'info')),
  title text not null,
  why text not null,                   -- what fired it, in a sentence
  key text,
  records jsonb not null default '[]', -- [{source, id, url}] behind it
  opened_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  cleared_at timestamptz,              -- the rule stopped firing
  handled_at timestamptz, handled_by text,
  snoozed_until timestamptz
);
create index if not exists alert_open on cc.alert (level) where cleared_at is null and handled_at is null;

-- The Brief agent's three sentences, 6 AM and 6 PM.
create table if not exists cc.brief (
  id bigint generated always as identity primary key,
  written_at timestamptz not null default now(),
  text text not null,
  needs_you jsonb not null default '[]', -- [{title, why, source}]
  agent_run_id bigint
);

-- Agents and their work ------------------------------------------------------------------------------
create table if not exists cc.agent (
  id text primary key,                 -- 'brief', 'water', 'clerk', 'research', ...
  name text not null,
  scope text not null,
  schedule text not null,
  enabled boolean not null default true, -- false = not built yet (shown as "v2")
  status text not null default 'idle' check (status in ('idle', 'working', 'watching', 'needs_you', 'failed', 'paused', 'off')),
  now_doing text,
  sort int not null default 0,
  updated_at timestamptz not null default now()
);

-- Work Bo hands an agent from the TASK panel. A task given to two agents is two rows.
create table if not exists cc.task (
  id bigint generated always as identity primary key,
  agent_id text not null references cc.agent(id),
  text text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'needs_you', 'done', 'failed', 'cancelled')),
  steps jsonb not null default '[]',   -- [{state: done|running|waiting|next, label, detail}]
  result text,                          -- the write-up, for a note result
  result_kind text check (result_kind in ('note', 'document', 'approval')),
  result_url text,
  error text,
  created_by text,
  created_at timestamptz not null default now(),
  started_at timestamptz, finished_at timestamptz,
  cancel_requested boolean not null default false
);
create index if not exists task_recent on cc.task (created_at desc);

-- Every agent run (scheduled or a task): what it read, decided, wrote and asked for.
create table if not exists cc.agent_run (
  id bigint generated always as identity primary key,
  agent_id text not null references cc.agent(id),
  task_id bigint references cc.task(id),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean,
  log jsonb not null default '[]',     -- [{at, kind: read|decide|write|ask|error, text}]
  tokens_in int, tokens_out int
);

-- Outside actions wait here for Bo (v2: the Books agent). Kept in v1 so the count shows on the wall.
create table if not exists cc.approval (
  id bigint generated always as identity primary key,
  agent_id text not null references cc.agent(id),
  task_id bigint references cc.task(id),
  action text not null,                -- 'email', 'filing', 'bill', 'price_alert'
  summary text not null,
  preview jsonb not null default '{}',
  status text not null default 'waiting' check (status in ('waiting', 'approved', 'rejected', 'expired', 'done')),
  created_at timestamptz not null default now(),
  decided_at timestamptz, decided_by text
);

-- One row: the Pause all agents switch.
create table if not exists cc.control (
  id int primary key default 1 check (id = 1),
  agents_paused boolean not null default false,
  paused_at timestamptz, paused_by text
);
insert into cc.control (id) values (1) on conflict do nothing;

-- Pipeline health --------------------------------------------------------------------------------------
create table if not exists cc.feed (
  id text primary key,                 -- 'nws', 'news', 'field-master', 'deere-csv', 'nutrien-filer', ...
  name text not null,
  every_minutes int not null,          -- expected schedule; overdue at twice this
  sort int not null default 0
);
create table if not exists cc.feed_run (
  id bigint generated always as identity primary key,
  feed_id text not null references cc.feed(id),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean,
  rows int,
  error text
);
create index if not exists feed_run_latest on cc.feed_run (feed_id, started_at desc);

-- Records a collector could not key to a farm or field: held, not dropped.
create table if not exists cc.exception (
  id text primary key,
  feed_id text not null,
  reason text not null,
  record jsonb not null,
  seen_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- News picked for the NEWS panel.
create table if not exists cc.news (
  id text primary key,                 -- the story's link
  title text not null,
  source text not null,
  tag text not null,                   -- MARKETS, WEATHER, USDA, PEANUTS, COTTON, GEORGIA, PESTS
  url text not null,
  published_at timestamptz not null,
  score numeric not null default 0,    -- higher is more useful to this farm
  hidden boolean not null default false, -- thumbs down
  created_at timestamptz not null default now()
);
create index if not exists news_recent on cc.news (published_at desc);

-- Deere Ops Center, pulled by collectors/deere.py every 2 hours. deere_op keeps each field operation
-- as Deere sent it, so an unchanged operation is not fetched again (Deere counts every API call).
create table if not exists cc.deere_op (
  id text primary key,                 -- Deere's field operation id
  org_id text not null,
  field_id text not null,              -- Deere's field id
  field_name text not null,
  operation_type text not null,        -- seeding, application, harvest, tillage
  crop_season text,
  crop_name text,
  start_at timestamptz,
  end_at timestamptz,
  area_acres numeric,                  -- area worked, from the operation's measurements
  products text[] not null default '{}', -- products, tank mixes or varieties
  modified_at text,                    -- Deere's modifiedTime; a change refetches the measurements
  updated_at timestamptz not null default now()
);
create index if not exists deere_op_field on cc.deere_op (field_name, end_at desc);

-- The Deere sign-in (one row). Written by netlify/functions/deere-auth.mts when the office signs in
-- to Deere, and by the collector whenever Deere hands back a new refresh token. Service key only: no
-- login can read it.
create table if not exists cc.deere_token (
  id int primary key default 1 check (id = 1),
  refresh_token text not null,
  signed_in_as text,
  updated_at timestamptz not null default now()
);
alter table cc.deere_token enable row level security;
revoke all on cc.deere_token from anon, authenticated;
grant all on cc.deere_token to service_role;

-- Latest successful and latest run per feed, for the footer strip.
create or replace view cc.feed_health with (security_invoker = true) as
select f.id, f.name, f.every_minutes, f.sort,
  (select max(r.finished_at) from cc.feed_run r where r.feed_id = f.id and r.ok) as last_ok,
  (select r.error from cc.feed_run r where r.feed_id = f.id order by r.started_at desc limit 1) as last_error,
  coalesce((select max(r.finished_at) from cc.feed_run r where r.feed_id = f.id and r.ok)
    < now() - make_interval(mins => 2 * f.every_minutes), true) as overdue
from cc.feed f;

-- Seed rows ----------------------------------------------------------------------------------------------
insert into cc.agent (id, name, scope, schedule, enabled, status, now_doing, sort) values
  ('brief', 'Brief', 'Every hub table, weather, calendar', '6 AM and 6 PM, and on demand', true, 'idle', null, 1),
  ('water', 'Water', 'Pivot Log (copied every 5 min), NOAA rain', 'Every 15 minutes', true, 'watching', null, 2),
  ('clerk', 'Filing clerk', 'Gmail, Downloads, AI Data (the existing filers)', 'Every 15 minutes', true, 'watching', null, 3),
  ('news', 'News', 'USDA, UGA, NWS, farm press', 'Hourly', true, 'watching', null, 4),
  ('research', 'Research', 'Web, the hub', 'On demand', true, 'idle', 'Ready for a task', 5),
  ('field', 'Field ops', 'Deere Ops Center', 'Every 2 hours', false, 'off', 'Waits on the Deere sign-in', 6),
  ('books', 'Books', 'QuickBooks, Nutrien, Perry Bros.', 'Daily', false, 'off', 'Comes with the approval queue (v2)', 7),
  ('markets', 'Markets', 'Prices, marketing sheet', 'Market hours', false, 'off', 'Comes with the price feed (v3)', 8)
on conflict (id) do update set name = excluded.name, scope = excluded.scope, schedule = excluded.schedule, sort = excluded.sort;

insert into cc.feed (id, name, every_minutes, sort) values
  ('field-master', 'FIELD MASTER', 10080, 1),
  ('pivot-log', 'PIVOT LOG', 10, 2),   -- the pivot sync runs every 5 min; late after 20
  ('noaa-rain', 'RAIN+ETO', 1440, 3),
  ('nws', 'NWS FORECAST', 60, 4),
  ('deere-csv', 'DEERE CSV', 10080, 5),
  ('nutrien-filer', 'NUTRIEN', 1440, 6),
  ('perry-filer', 'PERRY BROS', 10080, 7),
  ('calendar', 'CALENDAR', 15, 8),
  ('news', 'NEWS', 60, 9),
  ('water-rules', 'WATER AGENT', 15, 10),
  ('deere', 'DEERE', 120, 5),
  ('harvest-workbooks', 'HARVEST BOOKS', 60, 11)  -- checked every 30 min
on conflict (id) do update set name = excluded.name, every_minutes = excluded.every_minutes, sort = excluded.sort;

-- Row security ---------------------------------------------------------------------------------------------
do $$ declare t text; begin
  foreach t in array array['field','snapshot','event','alert','brief','agent','task','agent_run','approval','control','feed','feed_run','exception','news','office_user','pl_farm','pl_pivot','pl_field','pl_rain_day','pl_entry','deere_op'] loop
    execute format('alter table cc.%I enable row level security', t);
    execute format('drop policy if exists %I on cc.%I', t || '_read', t);
    execute format('create policy %I on cc.%I for select to authenticated using (true)', t || '_read', t);
    execute format('grant select on cc.%I to authenticated', t);
    execute format('grant all on cc.%I to service_role', t);
  end loop;
end $$;
grant select on cc.feed_health to authenticated, service_role;
grant usage on all sequences in schema cc to authenticated, service_role;

-- The office dispatches and cancels tasks, marks alerts handled, hides a story, flips Pause all agents.
drop policy if exists task_office_insert on cc.task;
create policy task_office_insert on cc.task for insert to authenticated with check (cc.is_office() and status = 'queued');
drop policy if exists task_office_cancel on cc.task;
create policy task_office_cancel on cc.task for update to authenticated using (cc.is_office()) with check (cc.is_office());
grant insert on cc.task to authenticated;
grant update (cancel_requested) on cc.task to authenticated;

drop policy if exists alert_office on cc.alert;
create policy alert_office on cc.alert for update to authenticated using (cc.is_office()) with check (cc.is_office());
grant update (handled_at, handled_by, snoozed_until) on cc.alert to authenticated;

drop policy if exists news_office on cc.news;
create policy news_office on cc.news for update to authenticated using (cc.is_office()) with check (cc.is_office());
grant update (hidden) on cc.news to authenticated;

drop policy if exists control_office on cc.control;
create policy control_office on cc.control for update to authenticated using (cc.is_office()) with check (cc.is_office());
grant update (agents_paused, paused_at, paused_by) on cc.control to authenticated;

-- Live updates to the wall (Supabase Realtime).
do $$ declare t text; begin
  foreach t in array array['alert','brief','agent','task','control','feed_run','news','snapshot','pl_entry'] loop
    begin
      execute format('alter publication supabase_realtime add table cc.%I', t);
    exception when duplicate_object then null; when undefined_object then null;
    end;
  end loop;
end $$;
