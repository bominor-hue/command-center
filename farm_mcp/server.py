"""The farm data MCP server: the hub's read tools, for Claude and the agents.

Every answer comes from the hub (the `cc` schema, plus Pivot Log's tables for pivots), read with the
service key, and every answer names where it came from. Read only: nothing here writes to the farm's
systems. Each call is logged to cc.event (kind 'mcp_call') so the wall can show who asked what.

Run:
  pip install -r farm_mcp/requirements.txt
  SUPABASE_URL=... SUPABASE_SERVICE_KEY=... MCP_TOKEN=... python3 farm_mcp/server.py      # streamable HTTP on :8000/mcp

Clients send `Authorization: Bearer <MCP_TOKEN>`. Without MCP_TOKEN set the server refuses to start
unless --local is passed (localhost only, for testing).
"""
import argparse, datetime as dt, hmac, json, os, sys
from collections import defaultdict
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "collectors"))
from hub import Hub, farm_key, now  # noqa: E402
from mcp.server.fastmcp import FastMCP  # noqa: E402

YEAR = int(os.environ.get("CROP_YEAR", "2026"))

mcp = FastMCP("Minor Family Farms", stateless_http=True, json_response=True)
_hub = None


def hub():
    global _hub
    _hub = _hub or Hub()
    return _hub


def get(path, schema=None):
    return hub().call("GET", path, schema=schema) or []


def log(tool, args):
    try:
        hub().call("POST", "event", {"id": f"mcp|{now()}|{tool}", "kind": "mcp_call", "happened_at": now(), "title": tool,
                                     "detail": args, "source": "Farm MCP"}, prefer="return=minimal")
    except Exception:  # a failed log must never fail the answer
        pass


def match(value, q):
    return not q or q.lower() in (value or "").lower()


# Fields --------------------------------------------------------------------------------------------
def fields(farm=None, crop=None):
    rows = get(f"field?select=*&crop_year=eq.{YEAR}&order=farm,name")
    return [f for f in rows if match(f["farm"], farm) and match(f["crop"], crop)]


@mcp.tool()
def field_status(farm: str | None = None, crop: str | None = None, field: str | None = None) -> dict:
    """The status of the farm's fields this crop year: crop, water, planned acres, the last Deere
    operation, and harvested acres. Filter by farm (e.g. "A&B"), crop ("Cotton", "Peanuts", "Corn"), or
    field name. Fields with no Deere record yet show last_operation null."""
    log("field_status", {"farm": farm, "crop": crop, "field": field})
    rows = [f for f in fields(farm, crop) if match(f["name"], field)]
    snaps = {(s["key"], s["metric"]): s for s in get("snapshot?select=key,metric,value,as_of,source&key=like.field:*")}
    out = []
    for f in rows:
        op, hv = snaps.get((f"field:{f['id']}", "last_operation")), snaps.get((f"field:{f['id']}", "harvested_acres"))
        harvested = hv["value"]["acres"] if hv else 0
        out.append({"farm": f["farm"], "field": f["name"], "crop": f["crop"], "water": f["water"], "planned_acres": f["planned_acres"],
                    "harvested_acres": harvested, "harvested_pct": round(100 * harvested / f["planned_acres"]) if f["planned_acres"] else None,
                    "last_operation": op["value"] if op else None})
    return {"crop_year": YEAR, "fields": out, "count": len(out),
            "source": "Field Master 2026 (cc.field) and the weekly Deere Ops Center CSV (cc.snapshot)"}


@mcp.tool()
def acres(farm: str | None = None, crop: str | None = None, water: str | None = None) -> dict:
    """Planned acres from the Field Master, totaled by crop and water (Irrigated / Dryland), with
    harvested acres from Deere. These are PLANNED acres from the crop plan, not FSA reported acres
    and not Deere-measured boundary acres; say so when quoting them."""
    log("acres", {"farm": farm, "crop": crop, "water": water})
    rows = [f for f in fields(farm, crop) if match(f["water"], water)]
    hv = {s["key"]: s["value"]["acres"] for s in get("snapshot?select=key,value&metric=eq.harvested_acres")}
    by = defaultdict(lambda: {"fields": 0, "planned_acres": 0.0, "harvested_acres": 0.0})
    for f in rows:
        for k in ((f["crop"], f["water"]), (f["crop"], "All"), ("All", "All")):
            by[k]["fields"] += 1
            by[k]["planned_acres"] += f["planned_acres"] or 0
            by[k]["harvested_acres"] += hv.get(f"field:{f['id']}", 0)
    totals = [{"crop": c, "water": w, **{k: round(v, 1) if isinstance(v, float) else v for k, v in t.items()}} for (c, w), t in sorted(by.items())]
    return {"which_acres": "Planned acres (Field Master 2026 crop plan). Harvested acres come from Deere harvest operations.",
            "totals": totals, "source": "cc.field, cc.snapshot (harvested_acres)"}


# Water ---------------------------------------------------------------------------------------------
def docs(table):
    """Pivot Log keeps its master lists as {id, data} documents."""
    return [r["data"] for r in get(f"{table}?select=data", schema="public")]


@mcp.tool()
def pivots_running() -> dict:
    """Pivots running right now, from Pivot Log on/off entries: who turned each on, when, how long it
    has run, when it should come around, and whether it is past the "still running?" alert (lap time
    plus 2 h, or 36 h when the pivot has no lap time). Refreshed every 15 minutes by the water watch."""
    log("pivots_running", {})
    s = get("snapshot?select=value,as_of&key=eq.farm-all&metric=eq.pivots_running")
    if not s:
        return {"error": "The water watch has not run yet, so there is no running list."}
    rows = [{"pivot": r["name"], "on_since": r["since"], "turned_on_by": r["who"], "running_hours": round(r["hours"], 1),
             "due_around": r["dueAt"], "still_running_alert": r["stillRunning"]} for r in s[0]["value"]]
    return {"as_of": s[0]["as_of"], "running": rows, "count": len(rows),
            "source": "Pivot Log entries, read by the water watch (cc.snapshot farm-all / pivots_running)"}


def rain_rows(rain, pivots, farms, farm=None):
    pv = {p["id"]: p for p in pivots}
    fm = {f["id"]: f["name"] for f in farms}
    out = []
    for r in rain:
        p = pv.get(r["pivotId"], {})
        name = fm.get(p.get("farmId"), "")
        if match(name, farm):
            out.append({"day": r["date"], "farm": name, "pivot": p.get("name", r["pivotId"]), "inches": r["inches"]})
    return sorted(out, key=lambda x: (x["day"], x["farm"], x["pivot"]), reverse=True)


@mcp.tool()
def rain(days: int = 7, farm: str | None = None) -> dict:
    """Rain by pivot for the last N days (NOAA radar, from the Pivot Log nightly job). Use forecast()
    for rain ahead."""
    log("rain", {"days": days, "farm": farm})
    since = (dt.date.today() - dt.timedelta(days=max(1, min(days, 60)))).isoformat()
    rain = [r["data"] for r in get(f"rain_day?select=data&data->>date=gte.{since}", schema="public")]
    return {"rain": rain_rows(rain, docs("pivot"), docs("farm"), farm),
            "source": "NOAA MRMS radar via Pivot Log nightly rain (public.rain_day)"}


@mcp.tool()
def forecast(farm: str | None = None) -> dict:
    """The NWS 7-day forecast by farm (high, low, rain chance, forecast rain inches) and today's spray
    window (wind under 10 mph, rain chance under 30%)."""
    log("forecast", {"farm": farm})
    snaps = get("snapshot?select=key,value,as_of,source_url&metric=eq.forecast&key=like.farm:*")
    out = [{"farm": s["key"][5:], "as_of": s["as_of"], **s["value"], "link": s["source_url"]} for s in snaps
           if not farm or farm_key(farm) in farm_key(s["key"][5:])]
    return {"forecasts": out, "source": "National Weather Service (cc.snapshot, refreshed hourly)"}


# Alerts and the brief --------------------------------------------------------------------------------
@mcp.tool()
def alerts(include_handled: bool = False) -> dict:
    """Open alerts on the wall (red, amber, info): what fired, why, and the records behind it."""
    log("alerts", {"include_handled": include_handled})
    q = "alert?select=id,rule,level,title,why,records,opened_at,last_seen_at,handled_at,handled_by&cleared_at=is.null&order=opened_at.desc"
    rows = get(q if include_handled else q + "&handled_at=is.null")
    return {"alerts": rows, "count": len(rows), "source": "cc.alert"}


@mcp.tool()
def brief() -> dict:
    """The latest morning or evening brief the Brief agent wrote, with its "needs you" items."""
    log("brief", {})
    rows = get("brief?select=written_at,text,needs_you&order=written_at.desc&limit=1")
    return {"brief": rows[0] if rows else None, "source": "cc.brief (Brief agent, 6 am and 6 pm)"}


@mcp.tool()
def why(alert_id: str) -> dict:
    """Explain one alert: the rule, why it fired, when it opened and was last seen, and the source
    records behind it (with links), so an answer can be checked."""
    log("why", {"alert_id": alert_id})
    rows = get(f"alert?select=*&id=eq.{alert_id}")
    if not rows:
        return {"error": f"No alert {alert_id}. Call alerts() for the open ones."}
    return {"alert": rows[0], "source": "cc.alert"}


@mcp.tool()
def feeds() -> dict:
    """Which data feeds are current and which are overdue (no good run in twice their schedule)."""
    log("feeds", {})
    return {"feeds": get("feed_health?select=*"), "source": "cc.feed_health"}


# Server ----------------------------------------------------------------------------------------------
def with_token(app, token):
    async def guarded(scope, receive, send):
        if scope["type"] == "http":
            auth = dict(scope.get("headers") or []).get(b"authorization", b"").decode()
            if not hmac.compare_digest(auth, f"Bearer {token}"):
                await send({"type": "http.response.start", "status": 401, "headers": [(b"content-type", b"application/json")]})
                await send({"type": "http.response.body", "body": json.dumps({"error": "unauthorized"}).encode()})
                return
        await app(scope, receive, send)
    return guarded


def main():
    import uvicorn
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    ap.add_argument("--local", action="store_true", help="no token, bind to 127.0.0.1 only")
    a = ap.parse_args()
    token = os.environ.get("MCP_TOKEN")
    if not token and not a.local:
        sys.exit("Set MCP_TOKEN (clients send it as a bearer token), or pass --local.")
    app = mcp.streamable_http_app()
    uvicorn.run(app if a.local else with_token(app, token), host="127.0.0.1" if a.local else "0.0.0.0", port=a.port)


if __name__ == "__main__":
    main()
