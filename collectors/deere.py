"""John Deere Operations Center, every 2 hours: field operations straight from the API -> the hub.

  Sign-in    the refresh token in cc.deere_token, put there by netlify/functions/deere-auth.mts when the
             office signs in to Deere. When Deere hands back a new refresh token it is saved at once.
  Operations every field of the org (data/feeds.json deere_api), this crop season -> cc.deere_op. An
             operation whose modifiedTime has not changed is not fetched again, so a run costs about
             one API call per field.
  Snapshots  per Field Master field, the latest operation, harvested acres, the planting date and every
             spray or fertilizer pass (with rates where Deere has them) -> cc.snapshot (same
             rows as the weekly CSV, which stops while this feed is current); Deere field names that
             match no Field Master field go to cc.exception.

Read only: only GET requests go to Deere. Needs DEERE_CLIENT_ID, DEERE_CLIENT_SECRET, SUPABASE_URL and
SUPABASE_SERVICE_KEY. Without the Deere secrets it says so and exits cleanly.

Usage:
  python3 collectors/deere.py
  python3 collectors/deere.py --year 2026
"""
import argparse, base64, datetime as dt, json, os, sys, time, urllib.error, urllib.parse, urllib.request
sys.path.insert(0, os.path.dirname(__file__))
from hub import Hub, now
from google_feeds import ops_to_snaps

HERE = os.path.dirname(__file__)
CFG = json.load(open(os.path.join(HERE, "..", "data", "feeds.json")))["deere_api"]
TOKEN_URL = "https://signin.johndeere.com/oauth2/aus78tnlaysMraFhC1t7/v1/token"
API = "https://partnerapi.deere.com/platform"
ACCEPT = "application/vnd.deere.axiom.v3+json"
SCOPES = "openid profile offline_access ag1 ag2 ag3 eq1 org1"
ACRES = {"ha": 2.47105, "ac": 1.0}


class Deere:
    """GET-only Ops Center client. The access token lasts about 12 h; one is fetched per run."""

    def __init__(self, hub, client_id, secret):
        self.hub, self.calls = hub, 0
        self.basic = "Basic " + base64.b64encode(f"{client_id}:{secret}".encode()).decode()
        row = hub.call("GET", "deere_token?select=refresh_token&id=eq.1")
        if not row:
            raise RuntimeError("Not signed in to Deere yet: open the wall's Deere sign-in link (README, Deere).")
        body = urllib.parse.urlencode({"grant_type": "refresh_token", "refresh_token": row[0]["refresh_token"], "scope": SCOPES}).encode()
        req = urllib.request.Request(TOKEN_URL, body, headers={"Authorization": self.basic, "Accept": "application/json",
                                                               "Content-Type": "application/x-www-form-urlencoded"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                tok = json.loads(r.read())
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"Deere sign-in expired or was revoked (HTTP {e.code}): sign in again from the wall's Deere link.") from None
        if tok.get("refresh_token") and tok["refresh_token"] != row[0]["refresh_token"]:
            hub.upsert("deere_token", [{"id": 1, "refresh_token": tok["refresh_token"], "updated_at": now()}])
        self.token = tok["access_token"]

    def get(self, url, params=None):
        if not url.startswith("http"):
            url = API + url
        if params:
            url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
        for attempt in range(5):
            self.calls += 1
            req = urllib.request.Request(url, headers={"Authorization": f"Bearer {self.token}", "Accept": ACCEPT})
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    txt = r.read()
                return json.loads(txt) if txt else {}
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    return {}
                if e.code == 429 or e.code >= 500:
                    time.sleep(int(e.headers.get("Retry-After") or 2 * (attempt + 1)))
                    continue
                raise RuntimeError(f"Deere GET {urllib.parse.urlparse(url).path} -> {e.code}: {e.read()[:200]!r}") from None
        raise RuntimeError(f"Deere GET {urllib.parse.urlparse(url).path}: still failing after 5 tries")

    def paged(self, url, params=None):
        page = self.get(url, {"itemLimit": 100, **(params or {})})
        while page:
            yield from page.get("values", [])
            nxt = link(page, "nextPage")
            page = self.get(nxt) if nxt else None


def link(item, rel):
    return next((l["uri"] for l in item.get("links", []) if l.get("rel") == rel), None)


def names(embedded, key):
    items = embedded.get(key, []) if isinstance(embedded, dict) else (embedded or [])
    return [str(x.get("name")) for x in items if isinstance(x, dict) and x.get("name")]


def area_acres(measurements):
    """Area worked, in acres: a Result measurement's area if there is one, else the first area given."""
    best = None
    for m in measurements:
        a = m.get("area")
        if isinstance(a, dict) and a.get("value") is not None and (best is None or (m.get("measurementCategory") == "Result" and best[1] != "Result")):
            best = (a, m.get("measurementCategory"))
    if not best:
        return None
    return round(float(best[0]["value"]) * ACRES.get(str(best[0].get("unitId", "ha")).lower(), 1.0), 2)


def rates(measurements):
    """Average rate per product from an application's ApplicationRateResult, in Deere's units
    ('gal1ac-1', 'lb1ac-1', ...): the FERT panel turns nitrogen products into lb N per acre."""
    out = []
    for m in measurements:
        if m.get("measurementName") != "ApplicationRateResult":
            continue
        for p in m.get("productTotals") or []:
            avg = p.get("averageMaterial") or {}
            if p.get("name") and avg.get("value") is not None and avg.get("unitId"):
                out.append({"product": str(p["name"]), "rate": round(float(avg["value"]), 3), "unit": str(avg["unitId"])})
    return out


def products(op):
    """Products for an application (tank-mix components by name), varieties for seeding and harvest."""
    out = []
    for p in op.get("products") or []:
        for c in p.get("components") or [p]:
            out.append(c.get("name"))
    for v in op.get("varieties") or []:
        out.append(v.get("name"))
    return list(dict.fromkeys(n for n in out if n and n != "---"))


def op_row(op, org_id, field):
    return {"id": op["id"], "org_id": str(org_id), "field_id": field["id"], "field_name": field["name"],
            "operation_type": op.get("fieldOperationType") or "unknown", "crop_season": op.get("cropSeason"),
            "crop_name": op.get("cropName"), "start_at": op.get("startDate"), "end_at": op.get("endDate") or op.get("startDate"),
            "products": products(op), "modified_at": op.get("modifiedTime"), "updated_at": now()}


def pull(deere, hub, year):
    """Read this season's operations for every field into cc.deere_op. Returns the number of operations."""
    known = {r["id"]: r for r in hub.call("GET", f"deere_op?select=id,modified_at,area_acres,rates&crop_season=eq.{year}") or []}
    client = CFG.get("client_name", "").strip().lower()
    rows = []
    for org in CFG["org_ids"]:
        for f in deere.paged(f"/organizations/{org}/fields", {"embed": "clients,farms"}):
            if f.get("archived") or (client and client not in [c.lower() for c in names(f.get("clients"), "clients")]):
                continue
            for op in deere.paged(f"/organizations/{org}/fields/{f['id']}/fieldOperations", {"cropSeason": str(year)}):
                row = op_row(op, org, f)
                old = known.get(op["id"])
                if old and old["modified_at"] == row["modified_at"]:
                    row["area_acres"], row["rates"] = old["area_acres"], old.get("rates") or []
                else:
                    uri = link(op, "measurementTypes") or f"/fieldOperations/{op['id']}/measurementTypes"
                    meas = deere.get(uri).get("values", [])
                    row["area_acres"], row["rates"] = area_acres(meas), rates(meas)
                rows.append(row)
    hub.upsert("deere_op", rows, on_conflict="id")
    return len(rows)


def snapshots(hub, year):
    """Per Field Master field, from cc.deere_op: last operation, harvested acres, planting and spray passes."""
    ops = {r["id"]: {"field": r["field_name"], "type": r["operation_type"], "end": r["end_at"] or "",
                     "acres": float(r["area_acres"]) if r["area_acres"] is not None else None, "products": r["products"] or [],
                     "rates": r.get("rates") or []}
           for r in hub.call("GET", f"deere_op?select=id,field_name,operation_type,end_at,area_acres,products,rates&crop_season=eq.{year}") or []}
    fields = hub.call("GET", f"field?select=id,name&crop_year=eq.{year}") or []
    return ops_to_snaps(ops, fields, year, "Deere Ops Center")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, default=dt.date.today().year)
    a = ap.parse_args()
    cid, secret = os.environ.get("DEERE_CLIENT_ID"), os.environ.get("DEERE_CLIENT_SECRET")
    if not cid or not secret:
        print("Deere: DEERE_CLIENT_ID and DEERE_CLIENT_SECRET are not set; skipping (README, Deere).")
        return
    hub = Hub()
    with hub.feed_run("deere") as run:
        deere = Deere(hub, cid, secret)
        n = pull(deere, hub, a.year)
        snaps, unmatched = snapshots(hub, a.year)
        hub.snapshot(snaps)
        for name in unmatched:
            hub.exception("deere", name, "Deere field name matches no Field Master field", {"field_name": name})
        hub.call("PATCH", "agent?id=eq.field", {"status": "watching", "enabled": True, "updated_at": now(),
                                               "now_doing": f"{n} operations this season, {len(unmatched)} unmatched field names"}, prefer="return=minimal")
        run["rows"] = len(snaps)
        print(f"Deere: {n} operations, {len(snaps)} snapshots, {len(unmatched)} unmatched names, {deere.calls} API calls")


if __name__ == "__main__":
    main()
