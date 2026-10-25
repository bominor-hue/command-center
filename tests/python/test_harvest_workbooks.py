"""Fixture checks for collectors/harvest_workbooks.py: small workbooks laid out like the farm's peanut,
cotton and corn harvest dashboards (values only, so no LibreOffice recalculation is needed)."""
import datetime as dt, os, sys

import pytest

openpyxl = pytest.importorskip("openpyxl")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "collectors"))
import harvest_workbooks as hw  # noqa: E402

D = dt.datetime


def put(ws, at, rows):
    for i, r in enumerate(rows):
        for j, v in enumerate(r):
            if v is not None:
                ws.cell(row=at + i, column=1 + j, value=v)


def peanut_book(path):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Dashboard Summary"
    ws["A1"] = "2026 Peanut Harvest — Dashboard Summary"
    ws["A2"] = "Live from the Load Ledger · 12 loads"
    put(ws, 5, [
        ["Irr / Dry", "Planted Acres", "Acres Dug", "Acres Harvested", "Acres to Pick", "Total Net Lbs", "Avg Grade TSMK % (wtd)", "Avg LSK % (wtd)", "Yield (lbs/ac)", None, "% Dug", None, "% Harvested", None, "Actual Field Value", None, "Actual Value / Acre"],
        ["Irrigated", 160, 160, 100, 60, 480000, 72.5, 3.1, 4800, None, 1, None, .625, None, 130000, None, 1300],
        ["Dryland", 40, 0, 0, 0, 0],
        ["Total", 200, 160, 100, 60, 480000, 72.5, 3.1, 4800, None, "160 of 200 ac", None, "100 of 200 ac", None, "fields harvested & fully weighed", None, "100 actual ac"],
    ])
    ws["A10"] = "SECTION B — 2026 FIELD RESULTS"
    put(ws, 11, [
        ["FSN", "Farm", "Field", "Irr / Dry", "Planted Acres", "Variety", "Planting Date", "DAP at digging", "Digging Date", "Harvested Date", "Loads", "Avg Grade (wtd)", "Avg LSK (wtd)", "Total Pounds", "Yield (lbs/ac)", "Yield Basis", "Field Value $", "Value / Acre $"],
        [4334, "Akin", "Akin #3", "Irrigated", 100, "TifNV-HG", D(2026, 4, 23), 145, D(2026, 9, 15), D(2026, 9, 18), 7, 72.5, 3.1, 480000, 4800, "Actual", 130000, 1300],
        [2073, "Hodges", "Hodges #7", "Irrigated", 60, "GA 06G", D(2026, 5, 19), 148, D(2026, 10, 14), None, 3, 74.5, 2.7, 300000, 5000, "Projected (2 of 3 weighed)"],
        ["4334/2344", "Akin", "Akin Dryland", "Dryland", 40, "GA 06G", D(2026, 5, 20), 150, None, None, 0],
        [None, None, "Totals", None, 200, None, None, None, None, None, 10, 72.5, 3.1, 780000, 4800, None, 130000, 1300],
    ])
    wb.save(path)


def test_peanut_dashboard(tmp_path):
    p = tmp_path / "2026 Peanut Harvest.xlsx"
    peanut_book(p)
    d = hw.parse_file(str(p), "Peanuts", do_recalc=False)
    assert d["progress"] == {"planted": 200, "staged": 160, "harvested": 100}
    assert [s["label"] for s in d["summary"]] == ["Irrigated", "Dryland", "Total"]
    assert d["summary"][2]["actual field value"] is None  # text on the Total row is not a number
    kpi = {k["label"]: k["value"] for k in d["kpis"]}
    assert kpi["Field value"] == 130000 and kpi["Value / ac"] == 1300  # from Section B's Totals row
    by = {f["field"]: f for f in d["fields"]}
    assert len(by) == 3
    assert by["Akin #3"]["status"] == "final" and by["Akin #3"]["planted"] == "2026-04-23" and by["Akin #3"]["fsn"] == "4334"
    assert by["Hodges #7"]["status"] == "harvesting" and by["Hodges #7"]["projected"]
    assert by["Akin Dryland"]["status"] == "not_started" and by["Akin Dryland"]["fsn"] == "4334/2344"
    assert by["Akin #3"]["cells"]["value / acre $"] == 1300
    assert d["note"].startswith("Live from")


def test_cotton_dashboard_statuses(tmp_path):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Dashboard Summary"
    put(ws, 5, [
        ["Irr / Dry", "Planted Acres", "Acres Defoliated", "Acres Harvested", "Acres Left to Pick", "Modules Picked", "Modules Ginned", "Bales (est. until ginned)", "Lint Yield (lbs/ac)", None, "% Defoliated", None, "% Harvested", None, "Lint Lbs (from modules)", None, "Yield vs 2025"],
        ["Irrigated", 300, 200, 143, 157, 74, 0, 318.7, 1116.6, None, None, None, None, None, None, None, -0.1],
        ["Total", 300, 200, 143, 157, 74, 0, 318.7, 1116.6, None, None, None, None, None, None, None, "1,117 vs 1,240 lbs/ac"],
    ])
    put(ws, 11, [
        ["FSN", "Farm", "Field", "Irr / Dry", "Planted Acres", "Variety", "Planting Date", "Defoliation Date", "Harvested Date", "Modules Picked", "Modules Ginned", "Bales", "Turnout %", "Lint Lbs", "Lint Yield (lbs/ac)", "Yield Basis", "2025 Yield", "vs 2025 (lbs/ac)"],
        [2073, "A&B", "A&B #4", "Irrigated", 143, "DP 2537", D(2026, 4, 15), D(2026, 9, 16), D(2026, 9, 29), 74, None, 318.7, None, 159680, 1116.6, "Modules — 74 picked, 0 ginned (picked out)", 1240, -123],
        [2073, "A&B", "A&B #6", "Irrigated", 96, "DP 2537", D(2026, 4, 21), D(2026, 9, 23), None, None, None, None, None, None, None, "Not started"],
        [4334, "Akin", "Akin #5", "Irrigated", 61, "DP 2618", D(2026, 5, 4), None, None, None, None, None, None, None, None, "Not started"],
        [None, None, "Totals", None, 300],
    ])
    p = tmp_path / "c.xlsx"
    wb.save(p)
    d = hw.parse_file(str(p), "Cotton", do_recalc=False)
    st = {f["field"]: (f["status"], f["projected"]) for f in d["fields"]}
    assert st == {"A&B #4": ("harvested", True), "A&B #6": ("staged", False), "Akin #5": ("not_started", False)}
    assert {k["label"]: k["value"] for k in d["kpis"]}["vs 2025"] == "1,117 vs 1,240 lbs/ac"
    assert d["stage"] == "Defoliated" and d["progress"]["staged"] == 200


def test_corn_dashboard_and_fields(tmp_path):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Dashboard"
    ws["B2"] = "2026 Corn Harvest — Dashboard"
    ws["B3"], ws["D3"] = "Everything on this page is calculated. Last load entered:", D(2026, 9, 5)
    put(ws, 6, [
        [None, "Entity", "Planted Ac", "Harvested Ac", "% Done", "Combine Bu", "Yield", "% of Crop", None, "Bin", "In Bin (bu)"],
        [None, "JA Minor Family Farms GP", 200, 190, .95, 40000, 210.5, 1, None, "Leslie", 1000],
        [None, None, None, None, None, None, None, None, None, "Hines", 500],
        [None, "Total", 200, 190, .95, 40000, 210.5],
    ])
    put(ws, 14, [[None, "Combine bushels (Fields tab)", 40000], [None, "Delivered to buyers", 30000], [None, "Est. in storage (Bins tab)", 1500],
                 [None, "Contracted (Contracts tab)", 35000], [None, "Unpriced (combine − contracted)", 5000]])
    f = wb.create_sheet("Fields")
    put(f, 4, [
        ["Entity", "FSN", "Field", "Rate Group", "Variety", "Planted Ac", "Planting Date", "Harvest Date", "Harvested Ac", "Combine Bu", "Combine Yield", "DAP", "Status", "Hauled Bu", "Haul vs Combine", "Adjusted Bu", "Sold Yield", "Loads"],
        ["JA Minor Family Farms GP", None, "A&B #1", "A&B", "DKC 68-35", 140, D(2026, 3, 6), D(2026, 8, 4), 139.9, 28547, 203.9, 203, "Harvested", 32049, .12, 28547, 203.9, 30],
        ["JA Minor Family Farms GP", None, "A&B #2", "A&B", "DKC 66-06", 60, D(2026, 3, 9), None, None, None, None, None, "In progress", 4000, None, None, None, 4],
        [None, None, "Total", None, None, 200],
    ])
    p = tmp_path / "corn.xlsm"
    wb.save(p)
    d = hw.parse_file(str(p), "Corn", do_recalc=False)
    assert [s["label"] for s in d["summary"]] == ["JA Minor Family Farms GP", "Total"]
    assert d["progress"] == {"planted": 200, "staged": None, "harvested": 190}
    kpi = {k["label"]: k["value"] for k in d["kpis"]}
    assert kpi["In bins"] == 1500 and kpi["Unpriced"] == 5000 and kpi["Contracted"] == 35000
    st = {x["field"]: x["status"] for x in d["fields"]}
    assert st == {"A&B #1": "final", "A&B #2": "harvesting"}
    assert d["note"] == "Last load entered 2026-09-05"


def test_changed_only_when_drive_is_newer():
    found = [("Peanuts", {"id": "f1", "modifiedTime": "2026-10-22T23:38:50.166Z"}, "x"), ("Corn", None, "y")]
    assert hw.changed(found, {"crop:Peanuts": ("f1", "2026-10-22T23:38:50.166+00:00")}) == []
    assert [c for c, _ in hw.changed(found, {"crop:Peanuts": ("f1", "2026-10-20T00:00:00+00:00")})] == ["Peanuts"]
    assert [c for c, _ in hw.changed(found, {"crop:Peanuts": ("old", "2026-10-23T00:00:00+00:00")})] == ["Peanuts"]
    assert [c for c, _ in hw.changed(found, {})] == ["Peanuts"]
