"""News for the NEWS panel, hourly: farm press, USDA and UGA feeds, filtered to this farm.

Each story is tagged (MARKETS, WEATHER, USDA, PEANUTS, COTTON, GEORGIA, PESTS) by keyword and scored
by how much it could change a decision here: crop and place words up, recency up, and anything like
the stories the office thumbed down (hidden) on the wall down. Stories that score under the bar are
not posted. Sources: data/news_sources.json.

Usage:
  python3 collectors/news.py             fetch, score and write to the hub
  python3 collectors/news.py --dry-run   print what would be posted
"""
import argparse, datetime as dt, email.utils, html, json, os, re, sys, urllib.request
import xml.etree.ElementTree as ET
sys.path.insert(0, os.path.dirname(__file__))
from hub import Hub

HERE = os.path.dirname(__file__)
MIN_SCORE = 2.0
MAX_AGE_DAYS = 7

# Tag rules in order; the first that matches wins.
TAGS = [
    ("PESTS", r"\b(whitefl|stink bug|aphid|thrips|nematode|white mold|leaf spot|tswv|tomato spotted|target spot|boll ?worm|armyworm|disease|fungicide|pest)"),
    ("WEATHER", r"\b(rain|drought|hurricane|tropical storm|frost|freeze|forecast|weather|heat)"),
    ("PEANUTS", r"\bpeanut"),
    ("COTTON", r"\bcotton|\bgin\b|\bginn"),
    ("MARKETS", r"\b(futures|prices?|basis|export sales|market|wasde|bids?|fertili[sz]er|diesel)"),
    ("USDA", r"\b(usda|fsa|nrcs|rma|crop insurance|farm bill|eqip|arc\b|plc\b|acreage report)"),
    ("GEORGIA", r"\b(georgia|sumter|lee county|macon|americus|tifton|albany|uga\b|flint river)"),
]
WEIGHTS = [
    (r"\bpeanut", 3), (r"\bcotton", 3), (r"\bcorn\b", 1.5), (r"\b(georgia|sumter|americus|tifton|flint river)", 2.5),
    (r"\b(southeast|alabama|florida)", 1), (r"\b(usda|fsa|crop insurance|farm bill)", 1.5), (r"\b(price|basis|futures|wasde|export)", 1.5),
    (r"\b(irrigat|pivot|water)", 1), (r"\b(harvest|defoliat|digging|picker)", 1.5), (r"\b(pest|disease|nematode|whitefl)", 1.5),
    (r"\b(dairy|cattle|hog|beef|wheat|ethanol|soybean oil)", -1.5),
]


def text_of(el, *names):
    for n in names:
        x = el.find(n)
        if x is not None and (x.text or x.get("href")):
            return (x.text or x.get("href")).strip()
    return ""


def parse_feed(raw):
    root = ET.fromstring(raw)
    ns = {"a": "http://www.w3.org/2005/Atom"}
    items = root.findall(".//item") or root.findall(".//a:entry", ns)
    for it in items:
        title = html.unescape(re.sub(r"<[^>]+>", "", text_of(it, "title", "{http://www.w3.org/2005/Atom}title")))
        link = text_of(it, "link", "{http://www.w3.org/2005/Atom}link")
        if it.find("{http://www.w3.org/2005/Atom}link") is not None:
            link = it.find("{http://www.w3.org/2005/Atom}link").get("href") or link
        summary = re.sub(r"<[^>]+>", " ", text_of(it, "description", "{http://www.w3.org/2005/Atom}summary"))[:600]
        when = text_of(it, "pubDate", "{http://www.w3.org/2005/Atom}updated", "{http://www.w3.org/2005/Atom}published")
        try:
            published = email.utils.parsedate_to_datetime(when) if "," in when else dt.datetime.fromisoformat(when.replace("Z", "+00:00"))
        except Exception:
            published = None
        if title and link:
            yield {"title": title, "url": link, "summary": html.unescape(summary), "published": published}


def tag_for(text, default):
    for tag, rx in TAGS:
        if re.search(rx, text, re.I):
            return tag
    return default


def score(story, now, disliked):
    t = f"{story['title']} {story['summary']}".lower()
    s = sum(w for rx, w in WEIGHTS if re.search(rx, t))
    age_h = (now - story["published"]).total_seconds() / 3600 if story["published"] else 48
    s += max(0, 2 - age_h / 24)  # up to +2 for today's news
    words = set(re.findall(r"[a-z]{5,}", story["title"].lower()))
    s -= 0.5 * len(words & disliked["words"]) + (1.5 if story["source"] in disliked["sources"] else 0)
    return round(s, 2)


def disliked_from(hub):
    """Words and sources common in stories the office hid on the wall: the thumbs-down training."""
    if not hub:
        return {"words": set(), "sources": set()}
    rows = hub.call("GET", "news?select=title,source&hidden=eq.true&order=published_at.desc&limit=200") or []
    counts, srcs = {}, {}
    for r in rows:
        for w in set(re.findall(r"[a-z]{5,}", r["title"].lower())):
            counts[w] = counts.get(w, 0) + 1
        srcs[r["source"]] = srcs.get(r["source"], 0) + 1
    return {"words": {w for w, n in counts.items() if n >= 2}, "sources": {s for s, n in srcs.items() if n >= 5}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    sources = json.load(open(os.path.join(HERE, "..", "data", "news_sources.json")))["sources"]
    hub = None if a.dry_run else Hub()
    now = dt.datetime.now(dt.timezone.utc)
    disliked = disliked_from(hub)

    def collect():
        rows, failed = [], []
        for src in sources:
            try:
                req = urllib.request.Request(src["url"], headers={"User-Agent": "MinorFarmCommand/0.1"})
                raw = urllib.request.urlopen(req, timeout=30).read()
                stories = list(parse_feed(raw))
            except Exception as e:
                failed.append(f"{src['name']}: {e}")
                continue
            for st in stories:
                st["source"] = src["name"]
                if st["published"] and (now - st["published"]).days > MAX_AGE_DAYS:
                    continue
                sc = score(st, now, disliked)
                if sc < MIN_SCORE:
                    continue
                rows.append({"id": st["url"], "title": st["title"][:300], "source": src["name"],
                             "tag": tag_for(f"{st['title']} {st['summary']}", src["tag"]), "url": st["url"],
                             "published_at": (st["published"] or now).isoformat(), "score": sc})
        if failed:
            print("feeds that failed:", *failed, sep="\n  ", file=sys.stderr)
        if not rows and len(failed) == len(sources):
            raise RuntimeError("Every news feed failed: " + "; ".join(failed)[:300])
        return rows

    if a.dry_run:
        for r in sorted(collect(), key=lambda r: -r["score"])[:20]:
            print(f"{r['score']:5.1f} {r['tag']:8} {r['source']:14} {r['title'][:90]}")
        return
    with hub.feed_run("news") as run:
        rows = collect()
        if rows:  # never un-hide: 'hidden' is not in the upsert
            hub.upsert("news", rows)
        run["rows"] = len(rows)
        hub.call("PATCH", "agent?id=eq.news", {"status": "watching", "now_doing": f"Posted {len(rows)} stories this hour"}, prefer="return=minimal")
    print(f"{len(rows)} stories posted")


if __name__ == "__main__":
    main()
