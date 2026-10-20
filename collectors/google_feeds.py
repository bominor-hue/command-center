"""Google feeds, every 15 minutes: Calendar deadlines, the weekly Deere operations CSV, filer heartbeats.

  Calendar   the next 60 days of events -> cc.event (kind 'calendar') for DEADLINES and the Brief
  Deere CSV  03_Ops Center/Field Operations/field_operations.csv (the Monday pull) -> per field, the
             latest operation and harvested acres -> cc.snapshot; names that match no Field Master
             field go to cc.exception, never dropped
  Filers     the Nutrien and Perry Brothers logs' last change -> a feed run, so the strip shows them

Read-only Google access with one OAuth refresh token for the farm's Google account (scopes
calendar.readonly and drive.readonly): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN.
Drive ids: data/feeds.json.

Usage:
  python3 collectors/google_feeds.py                    all three
  python3 collectors/google_feeds.py --only deere       one part (calendar | deere | filers)
  python3 collectors/google_feeds.py --deere-file x.csv --dry-run   parse a local CSV, print the result
"""
import argparse, csv, datetime as dt, io, json, os, re, sys, urllib.parse, urllib.request
sys.path.insert(0, os.path.dirname(__file__))
from hub import Hub, now

HERE = os.path.dirname(__file__)
CFG = json.load(open(os.path.join(HERE, "..", "data", "feeds.json")))


class Google:
    def __init__(self):
        e = os.environ
        if not all(e.get(k) for k in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN")):
            sys.exit("Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN.")
        body = urllib.parse.urlencode({"client_id": e["GOOGLE_CLIENT_ID"], "client_secret": e["GOOGLE_CLIENT_SECRET"],
                                       "refresh_token": e["GOOGLE_REFRESH_TOKEN"], "grant_type": "refresh_token"}).encode()
        with urllib.request.urlopen("https://oauth2.googleapis.com/token", body, timeout=30) as r:
            self.token = json.loads(r.read())["access_token"]

    def get(self, url, raw=False):
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {self.token}"})
        with urllib.request.urlopen(req, timeout=120) as r:
            data = r.read()
        return data if raw else json.loads(data)


# Calendar -------------------------------------------------------------------------------------------
def calendar(g, hub):
    t0 = dt.datetime.now(dt.timezone.utc)
    q = urllib.parse.urlencode({"timeMin": t0.isoformat(), "timeMax": (t0 + dt.timedelta(days=60)).isoformat(),
                                "singleEvents": "true", "orderBy": "startTime", "maxResults": 100})
    cal = urllib.parse.quote(CFG["calendar_id"])
    events = g.get(f"https://www.googleapis.com/calendar/v3/calendars/{cal}/events?{q}").get("items", [])
    rows = []
    for ev in events:
        start = ev.get("start", {})
        when = start.get("dateTime") or (start.get("date") and f"{start['date']}T12:00:00-05:00")
        if not when or ev.get("status") == "cancelled":
            continue
        rows.append({"id": f"gcal|{ev['id']}", "kind": "calendar", "key": None, "happened_at": when,
                     "title": (ev.get("summary") or "(no title)")[:200], "detail": {"allDay": "date" in start},
                     "source": "Google Calendar", "source_id": ev["id"], "source_url": ev.get("htmlLink")})
    hub.upsert("event", rows)
    return len(rows)


# Deere weekly CSV -----------------------------------------------------------------------------------
norm = lambda s: re.sub(r"\s+", " ", s.strip().lower())


def deere_fields(text, fields, year):
    """Latest operation and harvested acres per Field Master field, from the Ops Center operations CSV.

    The CSV has one row per product per operation, so operations are de-duplicated by operation_id.
    Returns (snapshots, unmatched field names)."""
    by_name = {norm(f["name"]): f for f in fields}
    ops = {}
    for r in csv.DictReader(io.StringIO(text.lstrip("﻿"))):
        if r.get("crop_season") and r["crop_season"] != str(year):
            continue
        oid = r["operation_id"]
        op = ops.setdefault(oid, {"field": r["field_name"], "type": r["operation_type"], "start": r["start_date"], "end": r["end_date"] or r["start_date"],
                                  "acres": float(r["op_area_acres"] or 0) if r.get("op_area_acres") else None, "products": [], "modified": r.get("modified_time")})
        p = (r.get("product_name") or r.get("tank_mix_name") or "").strip()
        if p and p not in op["products"]:
            op["products"].append(p)
    last, harvested, unmatched = {}, {}, set()
    for oid, op in ops.items():
        f = by_name.get(norm(op["field"]))
        if not f:
            unmatched.add(op["field"])
            continue
        if f["id"] not in last or op["end"] > last[f["id"]][1]["end"]:
            last[f["id"]] = (oid, op)
        if op["type"] == "harvest" and op["acres"]:
            harvested[f["id"]] = harvested.get(f["id"], 0) + op["acres"]
    snaps = []
    for fid, (oid, op) in last.items():
        snaps.append({"key": f"field:{fid}", "metric": "last_operation", "source": "Deere CSV", "source_id": oid,
                      "source_url": "https://operationscenter.deere.com", "as_of": op["end"],
                      "value": {"type": op["type"], "date": op["end"], "product": ", ".join(op["products"][:2]) or None, "acres": op["acres"]}})
    for fid, acres in harvested.items():
        snaps.append({"key": f"field:{fid}", "metric": "harvested_acres", "source": "Deere CSV", "source_id": f"harvest ops {year}",
                      "source_url": "https://operationscenter.deere.com", "as_of": last[fid][1]["end"], "value": {"acres": round(acres, 1)}})
    return snaps, sorted(unmatched)


def deere(g, hub, year):
    c = CFG["deere_csv"]
    q = urllib.parse.urlencode({"q": f"'{c['folder_id']}' in parents and name = '{c['file_name']}' and trashed = false",
                                "fields": "files(id,modifiedTime)", "supportsAllDrives": "true", "includeItemsFromAllDrives": "true"})
    files = g.get(f"https://www.googleapis.com/drive/v3/files?{q}").get("files", [])
    if not files:
        raise RuntimeError(f"No {c['file_name']} in the Field Operations folder")
    f = files[0]
    text = g.get(f"https://www.googleapis.com/drive/v3/files/{f['id']}?alt=media&supportsAllDrives=true", raw=True).decode("utf-8")
    fields = hub.call("GET", f"field?select=id,name&crop_year=eq.{year}") or []
    snaps, unmatched = deere_fields(text, fields, year)
    hub.snapshot(snaps)
    for name in unmatched:
        hub.exception("deere-csv", name, "Deere field name matches no Field Master field", {"field_name": name, "file_id": f["id"]})
    print(f"Deere CSV ({f['modifiedTime']}): {len(snaps)} snapshots, {len(unmatched)} unmatched names")
    return len(snaps)


# Filer heartbeats -------------------------------------------------------------------------------------
def filers(g, hub):
    n = 0
    for x in CFG["filer_logs"]:
        meta = g.get(f"https://www.googleapis.com/drive/v3/files/{x['file_id']}?fields=modifiedTime&supportsAllDrives=true")
        changed = meta["modifiedTime"]
        last = hub.call("GET", f"feed_run?select=finished_at&feed_id=eq.{x['feed']}&ok=eq.true&order=finished_at.desc&limit=1")
        if last and last[0]["finished_at"] and dt.datetime.fromisoformat(last[0]["finished_at"]) >= dt.datetime.fromisoformat(changed.replace("Z", "+00:00")):
            continue
        hub.call("POST", "feed_run", {"feed_id": x["feed"], "started_at": changed, "finished_at": changed, "ok": True}, prefer="return=minimal")
        n += 1
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["calendar", "deere", "filers"])
    ap.add_argument("--year", type=int, default=dt.date.today().year)
    ap.add_argument("--deere-file"); ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if a.deere_file:  # local check of the CSV parser against the bundled Field Master
        sys.path.insert(0, HERE)
        from field_master import rows_from
        fields = rows_from(os.path.join(HERE, "..", "data", "field_master_2026.csv"), a.year)
        snaps, unmatched = deere_fields(open(a.deere_file, encoding="utf-8-sig").read(), fields, a.year)
        for s in snaps[:15]:
            print(s["key"], s["metric"], json.dumps(s["value"]))
        print(f"{len(snaps)} snapshots; unmatched: {unmatched}")
        return
    g, hub = Google(), Hub()
    failed = []
    for part, feed, fn in [("calendar", "calendar", lambda: calendar(g, hub)), ("deere", "deere-csv", lambda: deere(g, hub, a.year)), ("filers", None, lambda: filers(g, hub))]:
        if a.only and a.only != part:
            continue
        try:
            if feed:
                with hub.feed_run(feed) as run:
                    run["rows"] = fn()
            else:
                fn()
        except Exception as e:
            failed.append(f"{part}: {e}")
    if failed:
        sys.exit("failed: " + "; ".join(failed))


if __name__ == "__main__":
    main()
