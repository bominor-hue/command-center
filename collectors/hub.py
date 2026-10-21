"""The hub's REST API (Supabase PostgREST) for the collectors, with the service key.

Same small client as Pivot Log's nightly jobs (bominor-hue/pivot-log jobs/nightly_rain.py), pointed at
the `cc` schema. Every collector records its run in cc.feed_run so the wall's footer shows it.

Needs SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.
"""
import contextlib, datetime as dt, json, os, sys, urllib.request


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


class Hub:
    def __init__(self, url=None, key=None, schema="cc"):
        url, key = url or os.environ.get("SUPABASE_URL"), key or os.environ.get("SUPABASE_SERVICE_KEY")
        if not url or not key:
            sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_KEY (or pass --dry-run).")
        self.url = url.rstrip("/") + "/rest/v1/"
        self.h = {"apikey": key, "Content-Type": "application/json",
                  "Accept-Profile": schema, "Content-Profile": schema}
        if key.startswith("eyJ"):  # legacy service_role JWT also goes in Authorization
            self.h["Authorization"] = "Bearer " + key

    def call(self, method, path, body=None, prefer=None, schema=None):
        h = dict(self.h, **({"Prefer": prefer} if prefer else {}))
        if schema:
            h["Accept-Profile"] = h["Content-Profile"] = schema
        req = urllib.request.Request(self.url + path, method=method, headers=h,
                                     data=None if body is None else json.dumps(body).encode())
        with urllib.request.urlopen(req, timeout=60) as r:
            txt = r.read()
        return json.loads(txt) if txt else None

    def upsert(self, table, rows, on_conflict=None):
        for i in range(0, len(rows), 500):
            q = table + (f"?on_conflict={on_conflict}" if on_conflict else "")
            self.call("POST", q, rows[i:i + 500], prefer="resolution=merge-duplicates,return=minimal")

    def snapshot(self, rows):
        """rows: [{key, metric, value, source, source_id, source_url, as_of}]"""
        for r in rows:
            r["updated_at"] = now()
        self.upsert("snapshot", rows, on_conflict="key,metric")

    def exception(self, feed_id, rid, reason, record):
        self.upsert("exception", [{"id": f"{feed_id}|{rid}", "feed_id": feed_id, "reason": reason, "record": record, "seen_at": now()}])

    @contextlib.contextmanager
    def feed_run(self, feed_id):
        """with hub.feed_run('nws') as run: ... run['rows'] = n"""
        run = {"rows": None}
        started = now()
        try:
            yield run
        except Exception as e:
            self.call("POST", "feed_run", {"feed_id": feed_id, "started_at": started, "finished_at": now(),
                                           "ok": False, "error": str(e)[:500]}, prefer="return=minimal")
            raise
        self.call("POST", "feed_run", {"feed_id": feed_id, "started_at": started, "finished_at": now(),
                                       "ok": True, "rows": run["rows"]}, prefer="return=minimal")


def http_json(url, headers=None, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "MinorFarmCommand/0.1 (github.com/bominor-hue/command-center)", **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def farm_key(farm):
    """Same farm key as the wall (src/domain/fieldStatus.ts farmKey)."""
    import re
    return re.sub(r"[^a-z0-9&]", "", re.sub(r" farm$", "", farm.lower()))
