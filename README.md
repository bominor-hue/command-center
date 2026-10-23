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
| Sprays (growing season) | `src/ui/Sprays.tsx`, `src/domain/sprays.ts`, `data/spray_programs.json` | The growing season's lead panel. One tab per program: peanut fungicide, cotton herbicide, cotton Pix, cotton insecticide, corn, and fertilizer. Each field shows its planting date, days after planting, passes done, the last pass and the next one due, with the status buckets from the Peanut Spray Schedule sheet (Overdue, Due within 5 days, Coming up within 14, On track, Complete). Passes and planting dates come from Deere application and seeding operations. The office can record a pass Deere never sees (an airplane, a custom applicator) from a field's sheet. FERT, the small panel, shows fertilizer passes and lb N/acre by crop where Deere has the rate. |
| Hub | `supabase/cc_hub.sql` | The `cc` schema in the farm hub's own Supabase project: fields, snapshots, events, alerts, briefs, agents, tasks, feed runs, news, its own office logins, and the copy of Pivot Log's data (`pl_*`). |
| Pivot sync | `netlify/functions/pivot-sync.mts` | Every 5 min: copies farms, pivots, pivot fields, new on/off entries and radar rain from Pivot Log, signed in there as a read-only viewer. Pivot Log stays its own project and is never written to. |
| Water watch | `netlify/functions/water-watch.mts` | Every 15 min: red alert when a pivot runs past its lap time + 2 h (36 h with no lap time), red alert when a feed misses two runs. Same rules as Pivot Log. |
| Agents | `netlify/functions/agent-*.mts`, `netlify/lib/agents.ts` | Brief (6 am and 6 pm, and on demand) and Research (web search plus the hub). Pause all agents stops them within seconds. |
| Collectors | `collectors/*.py`, `.github/workflows/collectors.yml` | Field Master (weekly), NWS forecast by farm (hourly), news (hourly), Google Calendar, the weekly Deere CSV, and the Nutrien and Perry Brothers filer logs (every 15 min). Deere Ops Center straight from the API (every 2 hours, `collectors/deere.py`); while it is current the weekly CSV is skipped. |
| Farm MCP | `farm_mcp/server.py` | Read-only tools for Claude: `field_status`, `acres`, `pivots_running`, `rain`, `forecast`, `alerts`, `brief`, `why`, `feeds`. Each answer names its source. |

## Setup

The step-by-step version, with where to click, is the "Command center setup steps" doc in the project.

1. **Farm hub project.** Create a new Supabase project (for example `farm-hub`). Pivot Log keeps its own.
2. **Schema.** Add the repository secret `SUPABASE_DB_URL` (farm hub > Connect > Session pooler, with
   the database password) and run the **Hub schema** workflow. It is safe to run again.
3. **Expose the schema.** Farm hub > Project Settings > Data API > Exposed schemas: add `cc`. Without
   this the wall and collectors get "schema must be one of public".
4. **Read-only login in Pivot Log.** In Pivot Log's Supabase, add a user with a password (for example
   `hub-sync@…`), then in the Pivot Log app add that email to the people list as a **Viewer**. Viewers
   read everything and can't add entries or change lists.
5. **Collectors.** Repository secrets `SUPABASE_PROJECT_REF` and `SUPABASE_SERVICE_KEY` (the farm hub
   project's), and later `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` for an OAuth
   client with the read-only Drive and Calendar scopes.
6. **Netlify.** New site from this repo. Environment variables: `VITE_SUPABASE_URL`,
   `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` (farm hub), `VITE_PIVOT_LOG_URL`, `VITE_VISITOR_PIN`,
   `ANTHROPIC_API_KEY`, `AGENT_TICK_KEY` and `HEARTBEAT_KEY` (any long random strings), and for the
   Pivot Log copy `PIVOT_LOG_SUPABASE_URL`, `PIVOT_LOG_ANON_KEY`, `PIVOT_LOG_SYNC_EMAIL`,
   `PIVOT_LOG_SYNC_PASSWORD`.
7. **Logins.** In the farm hub's Authentication, add your own email, and a wall user with a password
   (for example `wall@…`). The first email-link sign-in on the wall claims the office; the wall login
   can read everything and change nothing. Add more office emails as rows in `cc.office_user`.
8. **Kiosk.** On the wall PC, open the site full screen (Chrome `--kiosk`), sign in once with the wall
   login, and leave it. It reloads data live and every 2 minutes, and shows a STALE banner if it loses
   the hub.
9. **Deere.** At developer.deere.com, on the app the Deere connector uses (production access), add the
   redirect URI `https://<site>/.netlify/functions/deere-auth`. Put the app's ID and secret in two places:
   repository secrets `DEERE_CLIENT_ID` and `DEERE_CLIENT_SECRET`, and the same two names in Netlify.
   Then open `https://<site>/.netlify/functions/deere-auth?key=<HEARTBEAT_KEY>` and sign in with your
   John Deere ID. The page lists your orgs and links any that still have to approve the app. The
   refresh token goes into `cc.deere_token`, which no login can read, and never shows on screen. If
   the DEERE light on the feed strip goes red with "sign-in expired", open the link again.
10. **MCP server.** `pip install -r farm_mcp/requirements.txt`, then run `farm_mcp/server.py` with
   `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (farm hub) and `MCP_TOKEN` set, wherever the Deere connector
   runs. Add it to Claude as a custom connector at `https://<host>/mcp` with the token as a bearer header.

## Development

```
npm install
npm run dev          # the wall, on sample data unless .env has the Supabase settings
npm test             # domain rules and the schema's row security (in-memory Postgres)
python3 -m pytest tests/python
python3 collectors/nws.py --dry-run
```

## Spray programs

`data/spray_programs.json` holds the programs and what each product counts as. A program's `passes` are
target days after planting; the n-th pass sprayed after planting fills the n-th one, and Next points at
the first one not sprayed (the same rule as Bo's sheet). A program with no `passes` shows passes on file
and days since the last one. Product names match by their start (`Pix 6x` is Pix). Names the list does
not know are listed under the board as "Not sorted yet". Fertilizer N targets by crop live in the same file.

## Still open

- **Which gin** gets the cotton, and how its tickets arrive. Needed for harvest by crop and modules.
- **Crew hours**: which timekeeping or payroll system. The crew panel shows no pay or SSNs either way.
- **Deere Harvest ID** module counts (cotton modules by field) are not pulled yet; the Deere feed covers
  field operations. Operations deleted in Ops Center stay in `cc.deere_op` until removed by hand.
- **Entity codes** (JAMFF, MBFP, …) are not mapped to FSA producers yet; producers show as written.
- **Spray timings**: only the peanut fungicide program has timings (45 DAP, then every 15 days to 135).
  Cotton herbicide, Pix, insecticide, corn, and the N targets wait on Bo. So does where the peanut
  fungicide passes are recorded, since they are not in Deere.
- The news source URLs in `data/news_sources.json` have not been checked against the live feeds.

## Not built yet

Texts for red alerts, Research write-ups saved to AI Data in Drive, Gmail digests, the price ticker,
and the approval queue (v2). The FIELD, BOOKS and MARKETS agents show on the roster as off.
