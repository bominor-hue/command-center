# Farm Command Center

The war room wall for Minor Family Farms: one screen that shows what needs attention across 112 fields
and about 7,981 planned acres, with the season deciding what is up front. It reads the farm's existing
systems and never replaces them. Every number on the wall links back to where it came from.

This is **v1** of the PRD (target Nov 14): the wall, the hub it reads, the first agents, and the farm
data MCP server. Harvest by crew, the fleet panel, and the crew panel wait on answers below.

## What's in v1

| Part | Where | What it does |
|---|---|---|
| Wall | `src/` (React, Vite) | 1920×1080 stage scaled to the screen; stacks on a phone. Season bar reorders panels. Launch tiles, NEEDS YOU, field board, water, weather by farm, harvest by crop, deadlines, news, agents (roster, task flow, assign a task). Visitor mode hides farm numbers; a PIN turns it off. With no Supabase settings it runs on the real Field Master with made-up statuses, labeled SAMPLE. |
| Hub | `supabase/cc_hub.sql` | The `cc` schema in the same Supabase project as Pivot Log: fields, snapshots, events, alerts, briefs, agents, tasks, feed runs, news. Pivot Log's own tables are read as they are. |
| Water watch | `netlify/functions/water-watch.mts` | Every 15 min: red alert when a pivot runs past its lap time + 2 h (36 h with no lap time), red alert when a feed misses two runs. Same rules as Pivot Log. |
| Agents | `netlify/functions/agent-*.mts`, `netlify/lib/agents.ts` | Brief (6 am and 6 pm, and on demand) and Research (web search plus the hub). Pause all agents stops them within seconds. |
| Collectors | `collectors/*.py`, `.github/workflows/collectors.yml` | Field Master (weekly), NWS forecast by farm (hourly), news (hourly), Google Calendar, the weekly Deere CSV, and the Nutrien and Perry Brothers filer logs (every 15 min). |
| Farm MCP | `farm_mcp/server.py` | Read-only tools for Claude: `field_status`, `acres`, `pivots_running`, `rain`, `forecast`, `alerts`, `brief`, `why`, `feeds`. Each answer names its source. |

## Setup

1. **Schema.** Add the repository secret `SUPABASE_DB_URL` (Supabase > Connect > Session pooler, with
   the database password) and run the **Hub schema** workflow. It is safe to run again. It uses psql, not
   `supabase db push`, because Pivot Log owns that project's migration history.
2. **Expose the schema.** Supabase > Project Settings > Data API > Exposed schemas: add `cc`. Without
   this the wall and collectors get "schema must be one of public".
3. **Collectors.** Repository secrets `SUPABASE_PROJECT_REF`, `SUPABASE_SERVICE_KEY` (same as Pivot
   Log's), and `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` for an OAuth client
   with the read-only Drive and Calendar scopes. Run **Collectors** once by hand with `all`.
4. **Netlify.** New site from this repo. Environment variables: `VITE_SUPABASE_URL`,
   `VITE_SUPABASE_ANON_KEY`, `VITE_PIVOT_LOG_URL`, `VITE_VISITOR_PIN`, `SUPABASE_SERVICE_KEY`,
   `ANTHROPIC_API_KEY`, `AGENT_TICK_KEY` and `HEARTBEAT_KEY` (any long random strings).
5. **Wall login.** In Supabase > Authentication, add a user for the wall with a password (for example
   `wall@…`). It can read everything and change nothing. Office logins sign in with an email link and
   are the same as in Pivot Log.
6. **Kiosk.** On the wall PC, open the site full screen (Chrome `--kiosk`), sign in once with the wall
   login, and leave it. It reloads data live and every 2 minutes, and shows a STALE banner if it loses
   the hub.
7. **MCP server.** `pip install -r farm_mcp/requirements.txt`, then run `farm_mcp/server.py` with
   `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` and `MCP_TOKEN` set, wherever the Deere connector runs. Add it
   to Claude as a custom connector at `https://<host>/mcp` with the token as a bearer header.

## Development

```
npm install
npm run dev          # the wall, on sample data unless .env has the Supabase settings
npm test             # domain rules and the schema's row security (in-memory Postgres)
python3 -m pytest tests/python
python3 collectors/nws.py --dry-run
```

## Still open

- **Which gin** gets the cotton, and how its tickets arrive. Needed for harvest by crop and modules.
- **Crew hours**: which timekeeping or payroll system. The crew panel shows no pay or SSNs either way.
- **Deere connector** has been down since Oct 3 and needs a reconnect with production access. Until
  then field operations come from the weekly CSV, so the field board can be up to a week behind.
- **Entity codes** (JAMFF, MBFP, …) are not mapped to FSA producers yet; producers show as written.
- The news source URLs in `data/news_sources.json` have not been checked against the live feeds.

## Not built yet

Texts for red alerts, Research write-ups saved to AI Data in Drive, Gmail digests, the price ticker,
and the approval queue (v2). The FIELD, BOOKS and MARKETS agents show on the roster as off.
