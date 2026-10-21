"""NWS forecast by farm, hourly, into cc.snapshot (key 'farm:<name>', metric 'forecast').

For each farm center in data/farms.json: the National Weather Service 7-day forecast (highs, lows,
chance of rain, short text) and its gridded rain amounts summed per farm day (QPF), plus today's spray
window: the hours from now with wind under 10 mph and rain chance under 30%. Free; no key.

Usage:
  python3 collectors/nws.py              every farm, written to the hub
  python3 collectors/nws.py --dry-run    print the first farms' forecast
"""
import argparse, collections, datetime as dt, json, os, re, sys, urllib.error
from zoneinfo import ZoneInfo
sys.path.insert(0, os.path.dirname(__file__))
from hub import Hub, http_json

HERE = os.path.dirname(__file__)
TZ = ZoneInfo("America/New_York")
SPRAY_WIND_MPH, SPRAY_POP = 10, 30


def intervals(values):
    """NWS grid values [{validTime: '2026-10-20T12:00:00+00:00/PT6H', value}] -> (start, hours, value)."""
    for v in values:
        start, dur = v["validTime"].split("/")
        m = re.match(r"P(?:(\d+)D)?T?(?:(\d+)H)?", dur)
        hours = int(m.group(1) or 0) * 24 + int(m.group(2) or 0)
        yield dt.datetime.fromisoformat(start), max(hours, 1), v["value"]


def rain_by_day(grid):
    """Sum QPF (mm) into farm-time days, splitting each interval evenly by hour; inches."""
    days = collections.defaultdict(float)
    for start, hours, mm in intervals(grid["quantitativePrecipitation"]["values"]):
        for h in range(hours):
            days[(start + dt.timedelta(hours=h)).astimezone(TZ).date().isoformat()] += (mm or 0) / hours
    return {d: round(v / 25.4, 2) for d, v in days.items()}


def hourly(grid, name):
    out = {}
    for start, hours, v in intervals(grid[name]["values"]):
        for h in range(hours):
            out[start + dt.timedelta(hours=h)] = v
    return out


def spray_window(grid, now):
    wind, pop = hourly(grid, "windSpeed"), hourly(grid, "probabilityOfPrecipitation")
    end_of_day = now.astimezone(TZ).replace(hour=19, minute=0, second=0, microsecond=0)
    t = now.replace(minute=0, second=0, microsecond=0)
    last_ok = None
    while t <= end_of_day:
        kmh, p = wind.get(t), pop.get(t)
        if kmh is None or kmh * 0.621 >= SPRAY_WIND_MPH or (p or 0) >= SPRAY_POP:
            break
        last_ok = t
        t += dt.timedelta(hours=1)
    if not last_ok:
        return None
    until = (last_ok + dt.timedelta(hours=1)).astimezone(TZ)
    return f"Until {until.strftime('%-I %p')} today (wind under {SPRAY_WIND_MPH} mph)"


def farm_forecast(lat, lon, now):
    pt = http_json(f"https://api.weather.gov/points/{lat},{lon}")["properties"]
    fc = http_json(pt["forecast"])["properties"]
    grid = http_json(pt["forecastGridData"])["properties"]
    rain = rain_by_day(grid)
    days = {}
    for p in fc["periods"]:
        d = dt.datetime.fromisoformat(p["startTime"]).astimezone(TZ).date().isoformat()
        x = days.setdefault(d, {"date": d, "name": None, "hi": None, "lo": None, "pop": None, "short": p["shortForecast"]})
        pop = (p.get("probabilityOfPrecipitation") or {}).get("value")
        if pop is not None:
            x["pop"] = max(x["pop"] or 0, pop)
        if p["isDaytime"]:
            x["hi"], x["short"], x["name"] = p["temperature"], p["shortForecast"], p["name"]
        else:
            x["lo"] = p["temperature"]
            x["name"] = x["name"] or p["name"]
    today = now.astimezone(TZ).date().isoformat()
    out = []
    for d in sorted(days):
        x = days[d]
        x["name"] = "Today" if d == today else dt.date.fromisoformat(d).strftime("%A")
        x["rainIn"] = rain.get(d, 0.0)
        out.append(x)
    return {"days": out[:7], "sprayWindow": spray_window(grid, now)}, fc.get("updateTime") or fc.get("generatedAt"), pt["forecast"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    farms = json.load(open(os.path.join(HERE, "..", "data", "farms.json")))["farms"]
    now = dt.datetime.now(dt.timezone.utc)
    hub = None if a.dry_run else Hub()

    def run():
        rows, failed = [], []
        for f in (farms[:2] if a.dry_run else farms):
            try:
                value, as_of, url = farm_forecast(f["lat"], f["lon"], now)
            except (urllib.error.URLError, KeyError, ValueError) as e:
                failed.append(f"{f['farm']}: {e}")
                continue
            rows.append({"key": f"farm:{f['farm']}", "metric": "forecast", "value": value, "source": "NWS",
                         "source_id": f"{f['lat']},{f['lon']}", "source_url": f"https://forecast.weather.gov/MapClick.php?lat={f['lat']}&lon={f['lon']}",
                         "as_of": as_of or now.isoformat()})
            if a.dry_run:
                print(f["farm"], json.dumps(value)[:600])
        if failed:
            print("failed:", *failed, sep="\n  ", file=sys.stderr)
        if not rows:
            raise RuntimeError("No farm forecast could be read: " + "; ".join(failed)[:300])
        return rows

    if a.dry_run:
        run()
        return
    with hub.feed_run("nws") as r:
        rows = run()
        hub.snapshot(rows)
        r["rows"] = len(rows)
    print(f"{len(rows)} farm forecasts written")


if __name__ == "__main__":
    main()
