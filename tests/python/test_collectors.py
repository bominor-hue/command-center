"""Fixture checks for the collectors' parsing (no network): Deere CSV, NWS rain, news, Field Master,
and the MCP server's rain join."""
import datetime as dt, os, sys

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
sys.path[:0] = [os.path.join(ROOT, "collectors"), os.path.join(ROOT, "farm_mcp")]

from field_master import rows_from  # noqa: E402
from google_feeds import deere_fields  # noqa: E402
from hub import farm_key  # noqa: E402
import news, nws  # noqa: E402

COLS = "org_id,field_name,operation_id,operation_type,crop_season,start_date,end_date,op_area_acres,product_name,tank_mix_name"
FIELDS = [{"id": "2026|A&B #5W", "name": "A&B #5W"}, {"id": "2026|Akin 2", "name": "Akin 2"}]


def test_deere_dedupes_operations_and_sums_harvest():
    csv = "\n".join([COLS,
        "1,A&B #5W,op1,application,2026,2026-09-28,2026-09-28,80,Folex 6EC,",
        "1,A&B #5W,op1,application,2026,2026-09-28,2026-09-28,80,Dropp,",       # same op, second product
        "1,a&b  #5w,op2,harvest,2026,2026-10-10,2026-10-11,30,,",               # name spacing and case differ
        "1,A&B #5W,op3,harvest,2026,2026-10-14,2026-10-14,25.5,,",
        "1,Akin 2,op4,seeding,2025,2025-05-01,2025-05-01,50,,",                 # last year's season: skipped
        "1,Mystery Field,op5,harvest,2026,2026-10-01,2026-10-01,10,,"])
    snaps, unmatched = deere_fields("﻿" + csv, FIELDS, 2026)
    by = {(s["key"], s["metric"]): s for s in snaps}
    last = by[("field:2026|A&B #5W", "last_operation")]
    assert last["source_id"] == "op3" and last["value"]["type"] == "harvest"
    assert by[("field:2026|A&B #5W", "harvested_acres")]["value"] == {"acres": 55.5}
    assert ("field:2026|Akin 2", "last_operation") not in by
    assert unmatched == ["Mystery Field"]


def test_deere_products_listed_once():
    csv = "\n".join([COLS, "1,Akin 2,op9,application,2026,2026-08-01,,40,Roundup,", "1,Akin 2,op9,application,2026,2026-08-01,,40,Roundup,"])
    snaps, _ = deere_fields(csv, FIELDS, 2026)
    assert snaps[0]["value"]["product"] == "Roundup" and snaps[0]["value"]["date"] == "2026-08-01"


def test_nws_rain_split_across_farm_days():
    # 25.4 mm over 6 h from 2 am to 8 am Eastern on Oct 21, and 12.7 mm over 6 h straddling midnight.
    grid = {"quantitativePrecipitation": {"values": [
        {"validTime": "2026-10-21T06:00:00+00:00/PT6H", "value": 25.4},
        {"validTime": "2026-10-22T01:00:00+00:00/PT6H", "value": 12.7},
        {"validTime": "2026-10-23T12:00:00+00:00/P1DT0H", "value": None}]}}
    r = nws.rain_by_day(grid)
    assert r["2026-10-21"] == 1.0 + 0.25  # 9 pm-midnight Oct 21 Eastern is 3 of the 6 hours
    assert r["2026-10-22"] == 0.25
    assert r["2026-10-23"] == 0.0


def test_nws_spray_window():
    now = dt.datetime(2026, 10, 20, 14, tzinfo=dt.timezone.utc)  # 10 am Eastern
    hrs = lambda vals: {"values": [{"validTime": f"2026-10-20T{14 + i:02d}:00:00+00:00/PT1H", "value": v} for i, v in enumerate(vals)]}
    grid = {"windSpeed": hrs([8, 9, 10, 20, 5]), "probabilityOfPrecipitation": hrs([0, 10, 20, 10, 0])}
    assert nws.spray_window(grid, now) == "Until 1 PM today (wind under 10 mph)"
    grid["windSpeed"] = hrs([30])
    assert nws.spray_window(grid, now) is None


def test_news_tags_and_scores():
    rss = b"""<rss><channel>
      <item><title>Georgia peanut harvest nears halfway</title><link>https://a</link><description>Digging in Sumter</description><pubDate>Tue, 20 Oct 2026 12:00:00 GMT</pubDate></item>
      <item><title>Cattle on feed report</title><link>https://b</link><description>beef</description><pubDate>Tue, 20 Oct 2026 12:00:00 GMT</pubDate></item>
    </channel></rss>"""
    items = list(news.parse_feed(rss))
    assert [i["url"] for i in items] == ["https://a", "https://b"]
    now = dt.datetime(2026, 10, 20, 14, tzinfo=dt.timezone.utc)
    none = {"words": set(), "sources": set()}
    a, b = ({**i, "source": "UGA"} for i in items)
    assert news.tag_for(a["title"] + a["summary"], "GEORGIA") == "PEANUTS"
    assert news.score(a, now, none) >= news.MIN_SCORE > news.score(b, now, none)
    assert news.score(a, now, {"words": {"peanut", "harvest"}, "sources": {"UGA"}}) < news.score(a, now, none)


def test_field_master_csv():
    rows = rows_from(os.path.join(ROOT, "data", "field_master_2026.csv"), 2026)
    assert len(rows) == 112
    assert round(sum(r["planned_acres"] for r in rows)) == 7981
    assert len({r["id"] for r in rows}) == 112
    assert {r["water"] for r in rows} <= {"Irrigated", "Dryland"}


def test_farm_key_matches_the_wall():
    assert farm_key("A&B Farm") == "a&b" and farm_key("Brown Small Farm") == "brownsmall"


def test_mcp_rain_join():
    import server
    rows = server.rain_rows([{"pivotId": "p1", "date": "2026-10-19", "inches": 0.4}, {"pivotId": "p2", "date": "2026-10-19", "inches": 1.1}],
                            [{"id": "p1", "farmId": "f1", "name": "Hodges 4"}, {"id": "p2", "farmId": "f2", "name": "Akin 1"}],
                            [{"id": "f1", "name": "Hodges Farm"}, {"id": "f2", "name": "Akin Farm"}], farm="akin")
    assert rows == [{"day": "2026-10-19", "farm": "Akin Farm", "pivot": "Akin 1", "inches": 1.1}]


def test_deere_api_operation_rows():
    import deere
    op = {"id": "op7", "fieldOperationType": "application", "cropSeason": "2026", "cropName": "COTTON",
          "startDate": "2026-09-28T13:00:00Z", "endDate": "2026-09-28T17:00:00Z", "modifiedTime": "2026-09-29T01:00:00Z",
          "products": [{"name": "Defol mix", "components": [{"name": "Folex 6EC"}, {"name": "Dropp"}]}, {"name": "---"}]}
    row = deere.op_row(op, 3630, {"id": "f1", "name": "A&B #5W"})
    assert row["products"] == ["Folex 6EC", "Dropp"] and row["org_id"] == "3630" and row["end_at"] == "2026-09-28T17:00:00Z"
    assert deere.products({"varieties": [{"name": "DP 2537 B3TXF"}]}) == ["DP 2537 B3TXF"]
    # The Result area wins over a target, and hectares become acres.
    meas = [{"measurementCategory": "Target", "area": {"value": 50, "unitId": "ac"}},
            {"measurementCategory": "Result", "area": {"value": 20, "unitId": "ha"}}]
    assert deere.area_acres(meas) == 49.42 and deere.area_acres([]) is None


def test_deere_api_snapshots_share_the_csv_rules():
    from google_feeds import ops_to_snaps
    ops = {"op1": {"field": "Akin 2", "type": "harvest", "end": "2026-10-19", "acres": 40.0, "products": ["DP 2328 B3TXF"]},
           "op2": {"field": "akin  2", "type": "harvest", "end": "2026-10-20", "acres": 15.5, "products": []}}
    snaps, unmatched = ops_to_snaps(ops, FIELDS, 2026, "Deere Ops Center")
    by = {s["metric"]: s for s in snaps}
    assert by["last_operation"]["source_id"] == "op2" and by["last_operation"]["source"] == "Deere Ops Center"
    assert by["harvested_acres"]["value"] == {"acres": 55.5} and unmatched == []


def test_snapshots_carry_planting_and_spray_passes():
    from google_feeds import farm_day, ops_to_snaps
    assert farm_day("2026-06-06T01:00:00Z") == "2026-06-05" and farm_day("2026-06-05") == "2026-06-05"
    ops = {"s1": {"field": "Akin 2", "type": "seeding", "end": "2026-04-24T20:00:00Z", "acres": 40.0, "products": ["TifNV-HG"]},
           "s0": {"field": "Akin 2", "type": "seeding", "end": "2026-04-23T20:00:00Z", "acres": 20.0, "products": ["GA-06G"]},
           "a2": {"field": "Akin 2", "type": "application", "end": "2026-06-22T15:00:00Z", "acres": 60.0, "products": ["Provost Silver"]},
           "a1": {"field": "Akin 2", "type": "application", "end": "2026-06-08T15:00:00Z", "acres": 60.0, "products": ["28-0-0-5"],
                  "rates": [{"product": "28-0-0-5", "rate": 10.0, "unit": "gal1ac-1"}]}}
    snaps, _ = ops_to_snaps(ops, FIELDS, 2026, "Deere Ops Center")
    by = {s["metric"]: s for s in snaps}
    assert by["planted"]["value"] == {"date": "2026-04-23", "variety": "GA-06G"} and by["planted"]["source_id"] == "s0"
    passes = by["applications"]["value"]["passes"]
    assert [p["id"] for p in passes] == ["a1", "a2"] and passes[0]["rates"][0]["unit"] == "gal1ac-1" and "rates" not in passes[1]
    assert by["applications"]["as_of"] == "2026-06-22" and by["last_operation"]["value"]["date"] == "2026-06-22"


def test_deere_api_application_rates():
    import deere
    meas = [{"measurementName": "ApplicationRateResult", "measurementCategory": "Result",
             "productTotals": [{"name": "28-0-0-5", "averageMaterial": {"value": 10.04, "unitId": "gal1ac-1"}},
                               {"name": "Water", "averageMaterial": {"value": None, "unitId": "gal1ac-1"}}]},
            {"measurementName": "AreaResult", "area": {"value": 20, "unitId": "ac"}}]
    assert deere.rates(meas) == [{"product": "28-0-0-5", "rate": 10.04, "unit": "gal1ac-1"}] and deere.rates([]) == []
