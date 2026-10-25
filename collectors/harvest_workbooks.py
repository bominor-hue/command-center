"""Harvest workbooks, every 30 minutes in season: the dashboards in the peanut, cotton and corn harvest
workbooks -> one cc.snapshot per crop (key 'crop:Peanuts', metric 'harvest_dashboard'), which the
wall's HARVEST view in the middle of the screen shows during harvest, and the PLANTING view reuses
for planting dates and varieties.

  Peanuts  '2026 Peanut Harvest.xlsx'  Dashboard Summary: Section A (irrigated / dryland totals,
           progress) and Section B (one row per field)
  Cotton   '2026 Cotton Harvest.xlsx'  Dashboard Summary: same two sections, modules and bales
  Corn     '2026 Corn Harvest.xlsm'    Dashboard (by entity, grain position, contracts) and Fields

The workbooks live in one Drive folder (data/feeds.json harvest_workbooks); the newest file with the
year's name is used, so next year's '2027 Peanut Harvest.xlsx' is picked up without a change here.
A file is only downloaded when Drive says it changed since the last snapshot. The peanut and cotton
workbooks are all formulas, and a copy saved without calculated values reads as blanks, so each
download is recalculated with LibreOffice (soffice) when it is installed. Sections are found by
their header text, not by cell address, so added rows and columns don't break the read.

Read-only Google access (the same token as collectors/google_feeds.py). Needs openpyxl.

Usage:
  python3 collectors/harvest_workbooks.py              read changed workbooks into the hub
  python3 collectors/harvest_workbooks.py --check      only say whether any workbook changed
                                                       (writes changed=true|false to $GITHUB_OUTPUT)
  python3 collectors/harvest_workbooks.py --file x.xlsx --crop Peanuts   parse a local copy, print it
"""
import argparse, datetime as dt, json, os, re, shutil, subprocess, sys, tempfile, urllib.parse
sys.path.insert(0, os.path.dirname(__file__))
from hub import Hub

HERE = os.path.dirname(__file__)
CFG = json.load(open(os.path.join(HERE, "..", "data", "feeds.json")))["harvest_workbooks"]
METRIC = "harvest_dashboard"


# Cells -> plain values ---------------------------------------------------------------------------------
def clean(v):
    """A cell value as JSON: dates as YYYY-MM-DD, floats rounded, blank strings as None."""
    if isinstance(v, dt.datetime):
        return v.date().isoformat()
    if isinstance(v, dt.date):
        return v.isoformat()
    if isinstance(v, float):
        return round(v, 4)
    if isinstance(v, str):
        v = v.strip()
        return v or None
    return v


def num(v):
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def text(v):
    """FSNs and similar ids: 4334 and '4334/2344' both as text."""
    if v is None:
        return None
    return str(int(v)) if isinstance(v, float) and v.is_integer() else str(v)


def norm(s):
    return re.sub(r"\s+", " ", str(s or "").strip().lower())


def grid(ws):
    """The sheet as a list of rows of cleaned values (data_only workbook)."""
    return [[clean(c) for c in row] for row in ws.iter_rows(values_only=True)]


def find_row(rows, first, col=0, start=0):
    """Index of the first row whose cell `col` reads `first` (case and spacing ignored)."""
    want = norm(first)
    for i in range(start, len(rows)):
        if col < len(rows[i]) and norm(rows[i][col]) == want:
            return i
    return None


def table(rows, header_at, stop, key_col=0, stop_col=None):
    """Rows under a header row as dicts keyed by header text, until a row whose `stop_col` cell reads
    `stop` (that row is returned separately as the totals row). Blank rows are skipped."""
    head = [norm(h) for h in rows[header_at]]
    out, total = [], None
    stop_col = key_col if stop_col is None else stop_col
    for r in rows[header_at + 1:]:
        if not any(x not in (None, "") for x in r):
            continue
        d = {head[i]: r[i] for i in range(min(len(head), len(r))) if head[i]}
        if stop_col < len(r) and norm(r[stop_col]) == norm(stop):
            total = d
            break
        out.append(d)
    return out, total


def pick(d, *names):
    """The first of several possible header names that has a value."""
    for n in names:
        v = d.get(norm(n))
        if v not in (None, ""):
            return v
    return None


# Peanut and cotton: Dashboard Summary -------------------------------------------------------------------
SPEC = {
    "Peanuts": {
        "stage": "Dug", "stage_col": "acres dug", "stage_date": "digging date", "unit": "lbs/ac", "amount_label": "Net lbs",
        "units_label": "Loads", "units_col": "loads",
        "summary_cols": [("planted acres", "Planted", "ac"), ("acres dug", "Dug", "ac"), ("acres harvested", "Harvested", "ac"),
                         ("acres to pick", "To pick", "ac"), ("total net lbs", "Net lbs", "int"), ("avg grade tsmk % (wtd)", "TSMK", "dec1"),
                         ("avg lsk % (wtd)", "LSK", "dec1"), ("yield (lbs/ac)", "Yield", "int"), ("actual field value", "Value", "money"),
                         ("actual value / acre", "$/ac", "money")],
        "field_cols": [("loads", "Loads", "int"), ("avg grade (wtd)", "TSMK", "dec1"), ("avg lsk (wtd)", "LSK", "dec1"),
                       ("total pounds", "Lbs", "int"), ("yield (lbs/ac)", "Yield", "int"), ("value / acre $", "$/ac", "money")],
    },
    "Cotton": {
        "stage": "Defoliated", "stage_col": "acres defoliated", "stage_date": "defoliation date", "unit": "lint lbs/ac", "amount_label": "Lint lbs",
        "units_label": "Modules", "units_col": "modules picked",
        "summary_cols": [("planted acres", "Planted", "ac"), ("acres defoliated", "Defoliated", "ac"), ("acres harvested", "Harvested", "ac"),
                         ("acres left to pick", "Left", "ac"), ("modules picked", "Modules", "int"), ("modules ginned", "Ginned", "int"),
                         ("bales (est. until ginned)", "Bales", "int"), ("lint yield (lbs/ac)", "Lint yield", "int")],
        "field_cols": [("modules picked", "Mods", "int"), ("modules ginned", "Gin", "int"), ("bales", "Bales", "int"),
                       ("turnout %", "Turn", "pct"), ("lint yield (lbs/ac)", "Yield", "int"), ("2025 yield", "2025", "int"),
                       ("vs 2025 (lbs/ac)", "vs 25", "signed")],
    },
}


def field_status(harvested, staged, units, basis, final_words=("actual", "final", "ginned")):
    """not_started | staged (dug or defoliated) | harvesting (loads or modules in, not finished) |
    harvested (finished, still projected) | final (finished and every load weighed or module ginned)."""
    b = norm(basis)
    if harvested:
        return "final" if any(b.startswith(w) for w in final_words) else "harvested"
    if units and units > 0:
        return "harvesting"
    return "staged" if staged else "not_started"


def parse_summary(wb, crop):
    spec = SPEC[crop]
    rows = grid(wb["Dashboard Summary"])
    a = find_row(rows, "Irr / Dry")
    b = find_row(rows, "FSN", start=(a or 0) + 1)
    if a is None or b is None:
        raise ValueError("Dashboard Summary: Section A or B header not found")
    sec_a, total_a = table(rows, a, "Total")
    totals = sec_a + ([dict(total_a, **{"irr / dry": "Total"})] if total_a else [])
    # Progress text cells ('1,679 of 1,926 ac') sit on the Total row; the figures come from the acres.
    summary = [{"label": pick(r, "irr / dry"), **{k: num(r.get(k)) for k, _, _ in spec["summary_cols"]}} for r in totals]
    head_b = [norm(h) for h in rows[b]]
    fields_raw, total_b = table(rows, b, "Totals", stop_col=head_b.index("field") if "field" in head_b else 2)
    fields = []
    for r in fields_raw:
        name = pick(r, "field")
        if not name:
            continue
        units = num(pick(r, spec["units_col"]))
        basis = pick(r, "yield basis")
        staged, harvested = pick(r, spec["stage_date"]), pick(r, "harvested date")
        status = field_status(harvested, staged, units, basis)
        fields.append({
            "fsn": text(pick(r, "fsn")), "farm": pick(r, "farm"), "field": name, "water": pick(r, "irr / dry"),
            "acres": num(pick(r, "planted acres")), "variety": pick(r, "variety"), "planted": pick(r, "planting date"),
            "staged": staged, "harvested": harvested, "basis": basis, "status": status,
            # Blue italic in the workbook: yield and pounds still estimated (loads unweighed, modules not ginned)
            "projected": status in ("harvesting", "harvested"),
            "cells": {k: num(r.get(k)) for k, _, _ in spec["field_cols"]},
        })
    t = next((s for s in summary if norm(s["label"]) == "total"), {})
    planted, staged, harvested = t.get("planted acres"), t.get(spec["stage_col"]), t.get("acres harvested")
    return {
        "stage": spec["stage"], "unit": spec["unit"], "unitsLabel": spec["units_label"],
        "progress": {"planted": planted or 0, "staged": staged, "harvested": harvested or 0},
        "summaryCols": [{"key": k, "label": l, "fmt": f} for k, l, f in spec["summary_cols"]],
        "summary": summary,
        "fieldCols": [{"key": k, "label": l, "fmt": f} for k, l, f in spec["field_cols"]],
        "fields": fields,
        "kpis": kpis_for(crop, t, rows, total_b or {}),
        "note": next((r[0] for r in rows[:4] if r and isinstance(r[0], str) and r[0].startswith("Live from")), None),
    }


def kpis_for(crop, t, rows, tb):
    """The headline figures. Section A's Total row holds some of them as text ('1,200 actual ac'), so
    the dollar figures come from Section B's Totals row, which the workbook keeps numeric."""
    if crop == "Peanuts":
        return [
            {"label": "Net lbs", "value": t.get("total net lbs"), "fmt": "int"},
            {"label": "Yield lbs/ac", "value": t.get("yield (lbs/ac)"), "fmt": "int", "note": "complete fields"},
            {"label": "Grade TSMK", "value": t.get("avg grade tsmk % (wtd)"), "fmt": "dec1", "note": "weighted"},
            {"label": "LSK", "value": t.get("avg lsk % (wtd)"), "fmt": "dec1"},
            {"label": "Field value", "value": num(tb.get("field value $")), "fmt": "money0", "note": "harvested and weighed"},
            {"label": "Value / ac", "value": num(tb.get("value / acre $")), "fmt": "money0"},
        ]
    # Cotton: 'Yield vs 2025' sits on the Total row as text ('993 vs 1,192 lbs/ac ...'); the figure is on
    # the irrigated row as a fraction, so the KPI is the Total row text.
    a = find_row(rows, "Irr / Dry")
    head = [norm(h) for h in rows[a]] if a is not None else []
    tot = next((r for r in rows[(a or 0) + 1:(a or 0) + 6] if r and norm(r[0]) == "total"), [])
    vs = tot[head.index("yield vs 2025")] if "yield vs 2025" in head and head.index("yield vs 2025") < len(tot) else None
    return [
        {"label": "Modules picked", "value": t.get("modules picked"), "fmt": "int"},
        {"label": "Ginned", "value": t.get("modules ginned"), "fmt": "int"},
        {"label": "Bales", "value": t.get("bales (est. until ginned)"), "fmt": "int", "note": "est. until ginned"},
        {"label": "Lint lbs/ac", "value": t.get("lint yield (lbs/ac)"), "fmt": "int"},
        {"label": "vs 2025", "value": vs, "fmt": "text"},
    ]


# Corn: Dashboard + Fields -------------------------------------------------------------------------------
def parse_corn(wb):
    dash = grid(wb["Dashboard"])
    e = find_row(dash, "Entity", col=1)
    if e is None:
        raise ValueError("Dashboard: 'Entity' header not found")
    ent, total = table(dash, e, "Total", key_col=1)
    cols = [("planted ac", "Planted", "ac"), ("harvested ac", "Harvested", "ac"), ("% done", "Done", "pct"),
            ("combine bu", "Combine bu", "int"), ("yield", "Yield", "dec1")]
    summary = [{"label": pick(r, "entity"), **{k: num(r.get(k)) for k, _, _ in cols}} for r in ent if pick(r, "entity")]
    if total:
        summary.append({"label": "Total", **{k: num(total.get(k)) for k, _, _ in cols}})

    def label_value(label):  # 'Combine bushels (Fields tab)' -> the number to its right
        i = find_row(dash, label, col=1)
        return num(dash[i][2]) if i is not None and len(dash[i]) > 2 else None

    def startswith_value(prefix):
        for r in dash:
            if len(r) > 2 and isinstance(r[1], str) and norm(r[1]).startswith(norm(prefix)):
                return num(r[2])
        return None

    kpis = [
        {"label": "Combine bu", "value": startswith_value("Combine bushels"), "fmt": "int"},
        {"label": "Yield bu/ac", "value": total and num(total.get("yield")), "fmt": "dec1"},
        {"label": "In bins", "value": startswith_value("Est. in storage"), "fmt": "int"},
        {"label": "Delivered", "value": label_value("Delivered to buyers"), "fmt": "int"},
        {"label": "Contracted", "value": startswith_value("Contracted"), "fmt": "int"},
        {"label": "Unpriced", "value": startswith_value("Unpriced"), "fmt": "int"},
    ]
    fr = grid(wb["Fields"])
    h = find_row(fr, "Entity")
    if h is None:
        raise ValueError("Fields: 'Entity' header not found")
    head = [norm(x) for x in fr[h]]
    raw, _ = table(fr, h, "Total", stop_col=head.index("field") if "field" in head else 2)
    fields = []
    for r in raw:
        name = pick(r, "field")
        if not name:
            continue
        st = norm(pick(r, "status"))
        harvested = pick(r, "harvest date")
        loads = num(pick(r, "loads"))
        status = "final" if st == "harvested" or (harvested and num(pick(r, "combine bu"))) else ("harvesting" if loads else "not_started")
        fields.append({
            "fsn": text(pick(r, "fsn")), "farm": pick(r, "entity"), "field": name, "water": None,
            "acres": num(pick(r, "planted ac")), "variety": pick(r, "variety"), "planted": pick(r, "planting date"),
            "staged": None, "harvested": harvested, "basis": pick(r, "status"), "status": status, "projected": False,
            "cells": {k: num(r.get(k)) for k in ("harvested ac", "combine bu", "combine yield", "hauled bu", "loads")},
        })
    p = summary[-1] if summary and summary[-1]["label"] == "Total" else {}
    return {
        "stage": None, "unit": "bu/ac", "unitsLabel": "Loads",
        "progress": {"planted": p.get("planted ac") or 0, "staged": None, "harvested": p.get("harvested ac") or 0},
        "summaryCols": [{"key": k, "label": l, "fmt": f} for k, l, f in cols],
        "summary": summary,
        "fieldCols": [{"key": "harvested ac", "label": "Harv ac", "fmt": "ac"}, {"key": "loads", "label": "Loads", "fmt": "int"},
                      {"key": "combine bu", "label": "Bushels", "fmt": "int"}, {"key": "combine yield", "label": "Yield", "fmt": "dec1"},
                      {"key": "hauled bu", "label": "Hauled", "fmt": "int"}],
        "fields": fields, "kpis": kpis,
        "note": f"Last load entered {dash[2][3]}" if len(dash) > 2 and len(dash[2]) > 3 and dash[2][3] not in (None, "—") else None,
    }


# Reading a file --------------------------------------------------------------------------------------------
def recalc(path):
    """A recalculated copy of the workbook (LibreOffice), or the original when soffice is missing."""
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        return path
    out = tempfile.mkdtemp(prefix="recalc-")
    ext = os.path.splitext(path)[1].lstrip(".") or "xlsx"
    filt = "xlsx:Calc MS Excel 2007 XML" if ext == "xlsx" else f"{ext}:Calc MS Excel 2007 VBA XML"
    subprocess.run([soffice, "--headless", "--calc", "--convert-to", filt, "--outdir", out, path],
                   check=True, timeout=600, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    got = os.path.join(out, os.path.basename(path))
    return got if os.path.exists(got) else path


def parse_file(path, crop, do_recalc=True):
    import openpyxl, warnings
    warnings.filterwarnings("ignore", module="openpyxl")
    src = recalc(path) if do_recalc and crop != "Corn" else path  # corn saves its values (Excel, macros)
    wb = openpyxl.load_workbook(src, data_only=True, keep_vba=False)
    out = parse_corn(wb) if crop == "Corn" else parse_summary(wb, crop)
    out["crop"] = crop
    return out


# Drive ------------------------------------------------------------------------------------------------------
def find_workbooks(g, year):
    """The newest file per crop in the harvest folder whose name matches the year's pattern."""
    found = []
    for w in CFG["files"]:
        name = w["name"].format(year=year)
        q = urllib.parse.urlencode({"q": f"'{CFG['folder_id']}' in parents and name = '{name}' and trashed = false",
                                    "fields": "files(id,name,modifiedTime,webViewLink)", "orderBy": "modifiedTime desc",
                                    "supportsAllDrives": "true", "includeItemsFromAllDrives": "true"})
        files = g.get(f"https://www.googleapis.com/drive/v3/files?{q}").get("files", [])
        found.append((w["crop"], files[0] if files else None, name))
    return found


def last_seen(hub):
    rows = hub.call("GET", f"snapshot?select=key,source_id,as_of&metric=eq.{METRIC}") or []
    return {r["key"]: (r["source_id"], r["as_of"]) for r in rows}


def changed(found, seen):
    out = []
    for crop, f, _ in found:
        if not f:
            continue
        prev = seen.get(f"crop:{crop}")
        if not prev or prev[0] != f["id"] or dt.datetime.fromisoformat(prev[1]) < dt.datetime.fromisoformat(f["modifiedTime"].replace("Z", "+00:00")):
            out.append((crop, f))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, default=dt.date.today().year)
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--file"); ap.add_argument("--crop", choices=["Peanuts", "Cotton", "Corn"])
    ap.add_argument("--no-recalc", action="store_true")
    a = ap.parse_args()
    if a.file:
        print(json.dumps(parse_file(a.file, a.crop, not a.no_recalc), indent=1)[:6000])
        return
    from google_feeds import Google
    g, hub = Google(), Hub()
    found = find_workbooks(g, a.year)
    todo = changed(found, last_seen(hub))
    if a.check:
        print(f"{len(todo)} of {sum(1 for _, f, _ in found if f)} harvest workbooks changed")
        if os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a") as fh:
                fh.write(f"changed={'true' if todo else 'false'}\n")
        if not todo:  # nothing to read: still a good run, so the footer shows the feed as current
            with hub.feed_run("harvest-workbooks") as run:
                run["rows"] = 0
        return
    with hub.feed_run("harvest-workbooks") as run:
        for crop, _, name in found:
            if not any(c == crop for c, f, _ in found if f):
                hub.exception("harvest-workbooks", name, "Harvest workbook not found in the harvest folder", {"name": name, "folder_id": CFG["folder_id"]})
        snaps = []
        for crop, f in todo:
            with tempfile.TemporaryDirectory() as d:
                path = os.path.join(d, f["name"])
                with open(path, "wb") as fh:
                    fh.write(g.get(f"https://www.googleapis.com/drive/v3/files/{f['id']}?alt=media&supportsAllDrives=true", raw=True))
                value = parse_file(path, crop)
            value["workbook"] = {"name": f["name"], "url": f.get("webViewLink"), "modifiedAt": f["modifiedTime"]}
            snaps.append({"key": f"crop:{crop}", "metric": METRIC, "value": value, "source": "Harvest workbook",
                          "source_id": f["id"], "source_url": f.get("webViewLink"), "as_of": f["modifiedTime"]})
            print(f"{crop}: {f['name']} ({f['modifiedTime']}), {len(value['fields'])} fields")
        if snaps:
            hub.snapshot(snaps)
        run["rows"] = len(snaps)


if __name__ == "__main__":
    main()
