"""Load the Field Master into cc.field: one row per field per crop year.

The Field Master is generated in Drive (AI/AI Data, build_context_tables.py); a copy lives in this repo
at data/field_master_2026.csv. Re-run after the crop plan changes (the Collectors workflow runs it
weekly and whenever the CSV changes on main).

Usage:
  python3 collectors/field_master.py                         load data/field_master_2026.csv
  python3 collectors/field_master.py --csv other.csv --year 2027
  python3 collectors/field_master.py --dry-run               print what would load
"""
import argparse, csv, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from hub import Hub, now

HERE = os.path.dirname(__file__)


def rows_from(path, year):
    out = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            name = r["Field"].strip()
            out.append({
                "id": f"{year}|{name}", "crop_year": year, "farm": r["Farm"].strip(), "name": name,
                "crop": r[f"{year} Crop"].strip(), "water": "Dryland" if r["Water"].strip() == "Dryland" else "Irrigated",
                "planned_acres": float(r["Planned Acres"] or 0), "producer": r.get("Producer (FSA)", "").strip() or None,
                "fsn": r.get("FSN", "").strip() or None, "county": r.get("County", "").strip() or None,
                "source": os.path.basename(path), "updated_at": now(),
            })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default=os.path.join(HERE, "..", "data", "field_master_2026.csv"))
    ap.add_argument("--year", type=int, default=2026)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    rows = rows_from(a.csv, a.year)
    acres = sum(r["planned_acres"] for r in rows)
    print(f"{len(rows)} fields, {acres:,.0f} planned acres")
    if a.dry_run:
        for r in rows[:5]:
            print("  ", r["farm"], "|", r["name"], r["crop"], r["planned_acres"])
        return
    hub = Hub()
    with hub.feed_run("field-master") as run:
        hub.upsert("field", rows)
        run["rows"] = len(rows)


if __name__ == "__main__":
    main()
