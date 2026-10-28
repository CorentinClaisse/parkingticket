#!/usr/bin/env python3
"""
Builds the data for the parking ticket map from NYC Open Data.

Runs automatically in GitHub Actions. It:
  1. finds the newest "Parking Violations Issued" datasets,
  2. downloads tickets for one borough (written by an agent, not cameras),
  3. drops everything personal (plates, vehicle details, ticket numbers),
  4. swaps each agent's real code for a random ID that resets every month,
  5. holds back the most recent weeks of data,
  6. turns addresses into map points (cached, so each address is looked up once),
  7. writes small JSON files that the website reads in the visitor's browser.

No AI calls, no paid services.
"""
import base64
import datetime as dt
import hashlib
import hmac
import json
import os
import re
import shutil
import sys
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = json.load(open(os.path.join(ROOT, "config.json")))
OUT = os.path.join(ROOT, "site", "data")
CACHE_PATH = os.path.join(ROOT, "cache", "geocode_cache.json")
DOMAIN = "data.cityofnewyork.us"
GEOSEARCH = "https://geosearch.planninglabs.nyc/v2/search"

SESSION = requests.Session()
SESSION.headers["User-Agent"] = "nyc-parking-ticket-map (open-source, GitHub Actions)"
if os.environ.get("SOCRATA_APP_TOKEN"):
    SESSION.headers["X-App-Token"] = os.environ["SOCRATA_APP_TOKEN"]

SALT = os.environ.get("AGENT_ID_SALT", "").encode()

# Only these columns are ever downloaded. summons_number is used to drop
# duplicates and is never written out.
FIELDS = ["summons_number", "issue_date", "violation_time", "violation_code",
          "violation_description", "issuer_code", "house_number", "street_name",
          "violation_precinct", "violation_county"]
REQUIRED = ["issue_date", "violation_time", "violation_code", "issuer_code",
            "house_number", "street_name", "violation_county"]


def log(*a):
    print(*a, flush=True)


def get_json(url, params=None, tries=5):
    for i in range(tries):
        try:
            r = SESSION.get(url, params=params, timeout=180)
            if r.status_code == 200:
                return r.json()
            log("HTTP", r.status_code, url, r.text[:300])
        except requests.RequestException as e:
            log("Request error:", e)
        time.sleep(10 * (i + 1))
    raise RuntimeError(f"Could not download {url}")


# ---------------------------------------------------------------- datasets

def discover_datasets():
    """Newest two fiscal-year datasets, newest first."""
    if CFG.get("dataset_ids"):
        return CFG["dataset_ids"]
    try:
        res = get_json("https://api.us.socrata.com/api/catalog/v1", {
            "domains": DOMAIN, "search_context": DOMAIN,
            "q": "Parking Violations Issued Fiscal Year", "only": "datasets", "limit": 100})
        found = {}
        for r in res.get("results", []):
            name = r["resource"]["name"].strip()
            m = re.match(r"^Parking Violations Issued - Fiscal Year (\d{4})$", name)
            if m:
                found[int(m.group(1))] = r["resource"]["id"]
        if found:
            years = sorted(found)[-2:]
            log("Datasets:", {y: found[y] for y in years})
            return [found[y] for y in reversed(years)]
    except Exception as e:
        log("Dataset discovery failed:", e)
    log("Using fallback dataset ids from config.json")
    return CFG.get("fallback_dataset_ids", [])


def columns(ds):
    meta = get_json(f"https://{DOMAIN}/api/views/{ds}.json")
    return {c["fieldName"]: c.get("dataTypeName", "text") for c in meta.get("columns", [])}


def is_date_col(t):
    return t in ("calendar_date", "floating_timestamp", "date")


def base_where(cols):
    counties = ",".join(f"'{c}'" for c in CFG["county_codes"])
    w = [f"violation_county in ({counties})", "house_number IS NOT NULL"]
    w.append("issuer_code != 0" if cols["issuer_code"] == "number" else "issuer_code != '0'")
    return w


def latest_date(ds, cols, cutoff):
    """Most recent ticket date in a dataset that is not after the cutoff."""
    if not is_date_col(cols["issue_date"]):
        return None
    where = base_where(cols) + [f"issue_date <= '{cutoff.isoformat()}T23:59:59'"]
    rows = get_json(f"https://{DOMAIN}/resource/{ds}.json",
                    {"$select": "max(issue_date) AS d", "$where": " AND ".join(where)})
    if rows and rows[0].get("d"):
        return parse_date(rows[0]["d"])
    return None


def fetch(ds, cols, start, end):
    sel = [f for f in FIELDS if f in cols]
    where = base_where(cols)
    if is_date_col(cols["issue_date"]):
        where.append(f"issue_date between '{start.isoformat()}T00:00:00' and '{end.isoformat()}T23:59:59'")
    page, offset = CFG.get("page_size", 50000), 0
    while True:
        rows = get_json(f"https://{DOMAIN}/resource/{ds}.json", {
            "$select": ",".join(sel), "$where": " AND ".join(where),
            "$order": ":id", "$limit": page, "$offset": offset})
        yield from rows
        offset += len(rows)
        log(f"  {ds}: {offset:,} rows downloaded")
        if len(rows) < page:
            break


# ---------------------------------------------------------------- parsing

TIME_RE = re.compile(r"^(\d{2})(\d{2})([AP])$")
HOUSE_RE = re.compile(r"^\d+[A-Z]?(-\d+[A-Z]?)?$")


def parse_date(s):
    s = (s or "").strip().split("T")[0]
    for fmt in ("%Y-%m-%d", "%m/%d/%Y"):
        try:
            return dt.datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    return None


def parse_time(s):
    """'0845A' -> minutes after midnight (525)."""
    m = TIME_RE.match((s or "").strip().upper())
    if not m:
        return None
    h, mi, ap = int(m[1]), int(m[2]), m[3]
    if mi > 59 or h > 23:
        return None
    if h > 12:                       # a few records use a 24-hour clock
        return h * 60 + mi
    if h == 12:
        h = 0
    if ap == "P":
        h += 12
    return h * 60 + mi


def addr_key(r):
    hn = re.sub(r"\s+", "", r.get("house_number") or "").upper()
    st = re.sub(r"\s+", " ", r.get("street_name") or "").strip().upper()
    if not hn or not st or not HOUSE_RE.match(hn):
        return None
    return f"{hn} {st}"


def agent_id(code, month):
    """Random-looking ID for an agent. Same agent + same month -> same ID.
    Without the secret salt nobody can map it back to the real code."""
    mac = hmac.new(SALT, f"{code}|{month}".encode(), hashlib.sha256).digest()
    return base64.b32encode(mac)[:6].decode()


# ---------------------------------------------------------------- geocoding

CACHE_VERSION = 3


def load_cache():
    try:
        cache = json.load(open(CACHE_PATH))
    except (FileNotFoundError, json.JSONDecodeError):
        cache = {}
    if cache.get("_version") != CACHE_VERSION:
        # Version 1 wrongly rejected good matches: retry everything it marked as a miss
        cache = {k: v for k, v in cache.items() if v and not k.startswith("_")}
        cache["_version"] = CACHE_VERSION
        log("Address cache upgraded; previous misses will be looked up again.")
    return cache


def save_cache(cache):
    os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
    tmp = CACHE_PATH + ".tmp"
    with open(tmp, "w") as f:   # one entry per line keeps git history small
        f.write("{\n")
        items = sorted(cache.items())
        for i, (k, v) in enumerate(items):
            f.write(json.dumps(k) + ":" + json.dumps(v, separators=(",", ":")))
            f.write(",\n" if i < len(items) - 1 else "\n")
        f.write("}\n")
    os.replace(tmp, CACHE_PATH)


STREET_TYPES = {"ST", "STREET", "AVE", "AV", "AVENUE", "PL", "PLACE", "RD", "ROAD", "BLVD", "BOULEVARD",
                "PKWY", "PARKWAY", "CT", "COURT", "DR", "DRIVE", "LN", "LANE", "TER", "TERRACE", "PLZ", "PLAZA",
                "SQ", "SQUARE", "HWY", "HIGHWAY", "EXPY", "EXPRESSWAY", "WAY", "WALK", "LOOP", "ROW", "CIR", "CIRCLE"}
DIRECTIONS = {"E", "EAST", "W", "WEST", "N", "NORTH", "S", "SOUTH"}


def street_words(s):
    """Distinctive words of a street name: 'E 19TH ST' -> {'19'}, 'AVE J' -> {'J'}."""
    words = set()
    for w in re.findall(r"[A-Z0-9]+", (s or "").upper()):
        w = re.sub(r"^(\d+)(ST|ND|RD|TH)$", r"\1", w)
        if w not in STREET_TYPES and w not in DIRECTIONS:
            words.add(w)
    return words


def good_match(key, p):
    """The service always returns its best guess, so check it is the same address:
    same house number and at least one distinctive street word in common."""
    hn_q, _, st_q = key.partition(" ")
    hn_r = p.get("housenumber") or p.get("house_number") or (p.get("name") or "").split(" ")[0]
    if re.sub(r"\s+", "", str(hn_r)).upper() != hn_q:
        return False
    st_r = p.get("street") or (p.get("name") or "").partition(" ")[2]
    q, r = street_words(st_q), street_words(st_r)
    return bool(q & r) if q else True


GEO_SESSION = requests.Session()
GEO_SESSION.headers["User-Agent"] = SESSION.headers["User-Agent"]


def geocode_one(key):
    """Returns (key, value, reason, sample).
    value is [lon, lat, label] on a match, 0 on a definite miss,
    None on a temporary error (retried next run)."""
    b = CFG["bbox"]
    try:
        r = GEO_SESSION.get(GEOSEARCH, params={"text": f"{key}, {CFG['borough_name']}, NY", "size": 5}, timeout=30)
        if r.status_code != 200:
            return key, None, f"http {r.status_code}", r.text[:200]
        feats = r.json().get("features") or []
        if not feats:
            return key, 0, "no results", ""
        reason = "no result matched"
        for f in feats:
            p = f.get("properties", {})
            lon, lat = f["geometry"]["coordinates"][:2]
            if (p.get("borough") or CFG["borough_name"]).lower() != CFG["borough_name"].lower():
                reason = "other borough"
                continue
            if not (b[0] <= lon <= b[2] and b[1] <= lat <= b[3]):
                reason = "outside map area"
                continue
            if not good_match(key, p):
                reason = "different address"
                continue
            return key, [round(lon, 5), round(lat, 5), (p.get("name") or key).upper()], "found", ""
        sample = json.dumps({k: feats[0].get("properties", {}).get(k) for k in
                             ("name", "label", "housenumber", "house_number", "street", "borough", "layer", "match_type")})
        return key, 0, reason, sample
    except Exception as e:
        return key, None, f"error {type(e).__name__}", str(e)[:200]


def geocode_all(keys_by_priority, cache):
    todo = [k for k in keys_by_priority if k not in cache][: CFG["max_new_geocodes_per_run"]]
    log(f"Addresses: {len(keys_by_priority):,} total, {len(todo):,} new to locate this run")
    deadline = time.time() + CFG["geocode_minutes"] * 60
    done = 0
    outcomes = Counter()
    samples = {}
    new_misses = []
    with ThreadPoolExecutor(CFG["geocode_threads"]) as ex:
        for i in range(0, len(todo), 1000):
            if time.time() > deadline:
                log("Geocoding time budget reached; the rest continues next run.")
                break
            for key, val, reason, sample in ex.map(geocode_one, todo[i:i + 1000]):
                outcomes[reason] += 1
                if reason != "found" and len(samples.get(reason, [])) < 3:
                    samples.setdefault(reason, []).append(f"{key} -> {sample}")
                if val is not None:
                    cache[key] = val
                if val == 0:
                    new_misses.append(key)
            done += len(todo[i:i + 1000])
            save_cache(cache)
            log(f"  looked up {done:,}/{len(todo):,}: " + ", ".join(f"{n:,} {r}" for r, n in outcomes.most_common()))
            if done >= 2000 and outcomes["found"] == 0:
                log("Stopping lookups early: nothing is matching, so something is wrong. Examples below.")
                for k in new_misses:      # don't remember these misses; retry after a fix
                    cache.pop(k, None)
                save_cache(cache)
                break
    for reason, ex_list in samples.items():
        log(f"Examples of '{reason}':")
        for x in ex_list:
            log("    " + x)


# ---------------------------------------------------------------- main

def main():
    if len(SALT) < 16:
        sys.exit("AGENT_ID_SALT is missing or too short. Add it as a repository secret "
                 "(any long random text). Stopping so real agent codes are never published.")

    today = dt.date.today()
    cutoff = today - dt.timedelta(days=CFG["delay_days"])
    datasets = discover_datasets()
    if not datasets:
        sys.exit("No datasets found. Put a dataset id in config.json -> dataset_ids.")

    cols_by_ds = {}
    for ds in datasets:
        c = columns(ds)
        missing = [f for f in REQUIRED if f not in c]
        if missing:
            log(f"Skipping {ds}: missing columns {missing}")
            continue
        cols_by_ds[ds] = c

    latest = [d for d in (latest_date(ds, c, cutoff) for ds, c in cols_by_ds.items()) if d]
    end = min(max(latest), cutoff) if latest else cutoff
    start = end - dt.timedelta(days=CFG["window_days"] - 1)
    route_start = end - dt.timedelta(days=CFG["route_days"] - 1)
    log(f"Window: {start} to {end} (agent rounds from {route_start})")

    loc_counts = defaultdict(Counter)   # address -> Counter(hour_of_week*100 + code)
    loc_prec = defaultdict(Counter)
    code_desc = defaultdict(Counter)
    routes = []                         # (day ordinal, minute, address, code, agent id)
    seen = set()
    kept = 0

    for ds, c in cols_by_ds.items():
        for r in fetch(ds, c, start, end):
            sn = r.get("summons_number")
            if sn:
                if sn in seen:
                    continue
                seen.add(sn)
            d = parse_date(r.get("issue_date"))
            if not d or d < start or d > end:
                continue
            m = parse_time(r.get("violation_time"))
            key = addr_key(r)
            code = (r.get("issuer_code") or "").strip()
            if m is None or key is None or not code.strip("0"):
                continue
            try:
                v = int(r.get("violation_code"))
            except (TypeError, ValueError):
                continue
            if not 1 <= v <= 99:
                continue
            how = d.weekday() * 24 + m // 60
            loc_counts[key][how * 100 + v] += 1
            if r.get("violation_precinct"):
                loc_prec[key][str(r["violation_precinct"]).strip()] += 1
            if r.get("violation_description"):
                code_desc[v][r["violation_description"].strip()] += 1
            if d >= route_start:
                routes.append((d.toordinal(), m, key, v, agent_id(code, d.strftime("%Y-%m"))))
            kept += 1
    seen.clear()
    log(f"Tickets kept: {kept:,}")

    # --- geocode, most-ticketed addresses first
    totals = {k: sum(cn.values()) for k, cn in loc_counts.items()}
    cache = load_cache()
    geocode_all(sorted(totals, key=lambda k: -totals[k]), cache)

    # --- merge addresses that resolve to the same place
    merged = {}
    addr_to_label = {}
    for key, cn in loc_counts.items():
        g = cache.get(key)
        if not g:
            continue
        lon, lat, label = g
        addr_to_label[key] = label
        slot = merged.setdefault(label, {"p": [lon, lat], "c": Counter(), "pr": Counter()})
        slot["c"].update(cn)
        slot["pr"].update(loc_prec.get(key, {}))

    labels = sorted(merged, key=lambda l: -sum(merged[l]["c"].values()))
    idx = {l: i for i, l in enumerate(labels)}
    mapped = sum(sum(merged[l]["c"].values()) for l in labels)

    # --- agent rounds
    by_agent = defaultdict(list)
    loc_agents = defaultdict(Counter)
    for o, m, key, v, aid in routes:
        lab = addr_to_label.get(key)
        if lab is None:
            continue
        li = idx[lab]
        by_agent[aid].append((o, m, li, v))
    prec_of = [merged[l]["pr"].most_common(1)[0][0] if merged[l]["pr"] else "" for l in labels]
    agents_dir = os.path.join(OUT, "agents")
    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(agents_dir)

    agent_index = []
    for aid, rows in by_agent.items():
        if len(rows) < CFG["min_agent_tickets"]:
            continue
        rows.sort()
        days = defaultdict(list)
        wd = [0] * 7
        hours = Counter()
        precs = Counter()
        for o, m, li, v in rows:
            day = dt.date.fromordinal(o)
            days[day.isoformat()].append([m, li, v])
            wd[day.weekday()] += 1
            hours[m // 60] += 1
            precs[prec_of[li]] += 1
            loc_agents[li][aid] += 1
        busy = sorted(h for h, n in hours.items() if n >= 0.05 * len(rows)) or sorted(hours)
        write(os.path.join(agents_dir, f"{aid}.json"), {"id": aid, "days": days})
        agent_index.append({"id": aid, "n": len(rows), "d": len(days), "wd": wd,
                            "h": [busy[0], busy[-1]],
                            "pr": [p for p, _ in precs.most_common(3) if p]})
    agent_index.sort(key=lambda a: -a["n"])

    # --- locations file
    loc = {"p": [], "l": [], "pr": [], "e": [], "a": []}
    code_totals = Counter()
    for l in labels:
        s = merged[l]
        loc["p"].append(s["p"])
        loc["l"].append(l.title())
        loc["pr"].append(prec_of[idx[l]])
        flat = []
        for k, n in sorted(s["c"].items()):
            flat += [k, n]
            code_totals[k % 100] += n
        loc["e"].append(flat)
        top = loc_agents.get(idx[l], Counter()).most_common(4)
        loc["a"].append([x for pair in top for x in pair])
    write(os.path.join(OUT, "locations.json"), loc)
    write(os.path.join(agents_dir, "index.json"), agent_index)

    names = CFG.get("violation_labels", {})
    violations = []
    for v, n in code_totals.most_common():
        label = names.get(str(v)) or (code_desc[v].most_common(1)[0][0].title() if code_desc[v] else f"Code {v}")
        violations.append({"c": v, "l": label, "n": n})

    write(os.path.join(OUT, "meta.json"), {
        "built": today.isoformat(), "from": start.isoformat(), "to": end.isoformat(),
        "route_from": route_start.isoformat(), "borough": CFG["borough_name"],
        "tickets": kept, "mapped": mapped, "locations": len(labels), "agents": len(agent_index),
        "delay_days": CFG["delay_days"], "window_days": CFG["window_days"],
        "route_days": CFG["route_days"], "center": CFG["center"], "bbox": CFG["bbox"],
        "violations": violations})
    pct = 100 * mapped / kept if kept else 0
    log(f"Done: {len(labels):,} places, {len(agent_index):,} agents, {pct:.0f}% of tickets on the map")


def write(path, obj):
    with open(path, "w") as f:
        json.dump(obj, f, separators=(",", ":"))


if __name__ == "__main__":
    main()
