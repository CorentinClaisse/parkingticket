/* Brooklyn parking ticket map. Everything runs in the browser on pre-built
   JSON files, so searches, forecasts and the game cost nothing to serve. */
(() => {
  "use strict";

  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const STYLE = "https://tiles.openfreemap.org/styles/positron";
  const GEOSEARCH = "https://geosearch.planninglabs.nyc/v2/autocomplete";
  const RADIUS = 75;                       // metres: "within a block"
  const GAME_EPOCH = Date.UTC(2026, 9, 28); // puzzle #1
  const STORE = "ticketGuess.v1";

  const S = { days: [true, true, true, true, true, true, true], h0: 0, h1: 23, v: "all" };
  let META, LOC, AGENTS, P = {}, VLABEL = {}, COUNTS, WEEKS, map, agentData = null;
  let selection = null;                    // {i, c, label}
  const FC = nyNow();                      // forecast day/hour, defaults to now

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtH = (h) => { h = ((h % 24) + 24) % 24; return (h % 12 === 0 ? 12 : h % 12) + (h < 12 ? "am" : "pm"); };
  const fmtM = (m) => {
    const h = Math.floor(m / 60), mm = String(m % 60).padStart(2, "0");
    return (h % 12 === 0 ? 12 : h % 12) + ":" + mm + (h < 12 ? "am" : "pm");
  };
  const fmtDate = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const num = (n) => n.toLocaleString("en-US");

  function nyNow() {
    try {
      const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(new Date());
      return { d: Math.max(0, DAYS.indexOf(p.find((x) => x.type === "weekday").value)), h: (+p.find((x) => x.type === "hour").value) % 24 };
    } catch (e) {
      const n = new Date();
      return { d: (n.getDay() + 6) % 7, h: n.getHours() };
    }
  }

  // ---------------------------------------------------------------- data
  async function load() {
    const get = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(p); return r.json(); });
    try {
      [META, LOC, AGENTS] = await Promise.all([get("data/meta.json"), get("data/locations.json"), get("data/agents/index.json")]);
    } catch (e) {
      $("loading").textContent = "The map data hasn't been built yet. Run the “Update map” workflow on GitHub, then reload.";
      return;
    }
    P = await get("partners.json").catch(() => ({}));
    WEEKS = Math.max(1, META.window_days / 7);
    META.violations.forEach((v) => (VLABEL[v.c] = v.l));
    buildGrid();
    buildControls();
    initMap();
  }

  // Each location has a flat list [key, count, key, count...]
  // where key = (weekday*24 + hour) * 100 + violation code.
  const split = (k) => { const v = k % 100, how = (k - v) / 100; return [(how / 24) | 0, how % 24, v, how]; };
  const typeOk = (v) => S.v === "all" || v === S.v;

  function computeCounts() {
    const N = LOC.p.length, out = new Int32Array(N);
    let total = 0;
    for (let i = 0; i < N; i++) {
      const e = LOC.e[i];
      let s = 0;
      for (let j = 0; j < e.length; j += 2) {
        const [d, h, v] = split(e[j]);
        if (S.days[d] && h >= S.h0 && h <= S.h1 && typeOk(v)) s += e[j + 1];
      }
      out[i] = s;
      total += s;
    }
    COUNTS = out;
    return total;
  }

  function geojson() {
    const f = [];
    for (let i = 0; i < COUNTS.length; i++) {
      if (COUNTS[i] > 0) f.push({ type: "Feature", id: i, geometry: { type: "Point", coordinates: LOC.p[i] }, properties: { n: COUNTS[i], i } });
    }
    return { type: "FeatureCollection", features: f };
  }

  // ---------------------------------------------------------------- spatial lookups
  const CELL = 0.001;
  let GRID;
  const cellKey = (x, y) => Math.floor(x / CELL) + ":" + Math.floor(y / CELL);
  function buildGrid() {
    GRID = new Map();
    LOC.p.forEach(([x, y], i) => {
      const k = cellKey(x, y);
      if (!GRID.has(k)) GRID.set(k, []);
      GRID.get(k).push(i);
    });
  }
  // Ticketed spots within r metres of a point
  function near([lon, lat], r = RADIUS) {
    const out = [], kx = Math.cos(lat * Math.PI / 180) * 111320, ky = 110540;
    const cx = Math.floor(lon / CELL), cy = Math.floor(lat / CELL), reach = Math.ceil(r / 80);
    for (let dx = -reach; dx <= reach; dx++) for (let dy = -reach; dy <= reach; dy++) {
      const a = GRID.get((cx + dx) + ":" + (cy + dy));
      if (!a) continue;
      for (const i of a) {
        const ddx = (LOC.p[i][0] - lon) * kx, ddy = (LOC.p[i][1] - lat) * ky;
        if (ddx * ddx + ddy * ddy <= r * r) out.push(i);
      }
    }
    return out;
  }
  function nearest(c, r = 80) {
    let best = null, bd = Infinity;
    const kx = Math.cos(c[1] * Math.PI / 180) * 111320, ky = 110540;
    for (const i of near(c, r)) {
      const dx = (LOC.p[i][0] - c[0]) * kx, dy = (LOC.p[i][1] - c[1]) * ky, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  // Tickets per hour of the week (168 slots) across a set of spots
  function weekly(idxs, filterType) {
    const out = new Float64Array(168);
    for (const i of idxs) {
      const e = LOC.e[i];
      for (let j = 0; j < e.length; j += 2) {
        const [, , v, how] = split(e[j]);
        if (!filterType || typeOk(v)) out[how] += e[j + 1];
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- forecast
  // Tickets in a given hour, averaged per week, treated as a Poisson rate:
  // chance of at least one ticket = 1 - e^(-rate).
  const chance = (count) => 1 - Math.exp(-count / WEEKS);
  function level(p) {
    if (p < 0.1) return { name: "Low", cls: "low" };
    if (p < 0.35) return { name: "Medium", cls: "med" };
    return { name: "High", cls: "high" };
  }
  const pct = (p) => (p < 0.01 && p > 0 ? "<1" : Math.round(p * 100)) + "%";

  function forecastHTML(c) {
    const w = weekly(near(c), true);
    const slot = FC.d * 24 + FC.h, p = chance(w[slot]), lv = level(p);
    const dayOpts = DAY_NAMES.map((d, i) => `<option value="${i}"${i === FC.d ? " selected" : ""}>${d}</option>`).join("");
    const hourOpts = Array.from({ length: 24 }, (_, h) => `<option value="${h}"${h === FC.h ? " selected" : ""}>${fmtH(h)} to ${fmtH(h + 1)}</option>`).join("");
    const next = Array.from({ length: 6 }, (_, k) => {
      const s = (slot + k) % 168, q = chance(w[s]);
      return `<span class="${level(q).cls}" title="${DAY_NAMES[(s / 24) | 0]} ${fmtH(s % 24)}"><b>${fmtH(s % 24)}</b>${pct(q)}</span>`;
    }).join("");
    const what = S.v === "all" ? "a ticket" : `a ${esc((VLABEL[S.v] || "Code " + S.v).toLowerCase())} ticket`;
    return `<div class="forecast">
      <div class="fc-when">
        <label class="sr" for="fc-d">Day</label><select id="fc-d">${dayOpts}</select>
        <label class="sr" for="fc-h">Hour</label><select id="fc-h">${hourOpts}</select>
      </div>
      <div class="fc-big ${lv.cls}">${pct(p)}<span>${lv.name} risk</span></div>
      <p class="fc-note">Chance an agent writes ${what} within about a block of here in this hour, based on the last ${Math.round(WEEKS)} weeks.</p>
      <div class="fc-next">${next}</div>
      ${p >= ((P.garage && P.garage.min_risk) || 0.35) ? garageHTML(c) : ""}
    </div>`;
  }

  // ---------------------------------------------------------------- referrals
  // Next time the chosen forecast hour comes around, as local NYC time
  function nextSlot() {
    const now = nyNow();
    let ahead = (FC.d - now.d + 7) % 7;
    if (ahead === 0 && FC.h < now.h) ahead = 7;
    const start = Date.parse(nyDate() + "T00:00:00Z") + ahead * 864e5 + FC.h * 36e5;
    const iso = (t) => new Date(t).toISOString().slice(0, 16);
    return { start: iso(start), end: iso(start + 2 * 36e5) };
  }
  const hasSponsor = () => !!((P.garage && P.garage.enabled && P.garage.url) || (P.contest && (P.contest.partners || []).length));

  function garageHTML(c) {
    const g = P.garage || {}, when = nextSlot();
    const fill = (u) => u.replace(/\{lat\}/g, c[1].toFixed(5)).replace(/\{lon\}/g, c[0].toFixed(5))
      .replace(/\{address\}/g, encodeURIComponent(selection ? selection.label : ""))
      .replace(/\{start\}/g, encodeURIComponent(when.start)).replace(/\{end\}/g, encodeURIComponent(when.end));
    const sponsored = !!(g.enabled && g.url);
    const href = sponsored ? fill(g.url) : `https://www.google.com/maps/search/parking+garage/@${c[1].toFixed(5)},${c[0].toFixed(5)},17z`;
    const label = sponsored ? `Book a garage nearby on ${esc(g.name || "our partner")}` : "Find a garage nearby";
    return `<div class="garage">
      <p>Parking on the street here is a gamble at this hour. A garage might cost less than a ticket.</p>
      <a class="cta" href="${esc(href)}" target="_blank" rel="${sponsored ? "sponsored " : ""}noopener">${label}</a>
      ${sponsored ? `<p class="fine">Partner link: we may earn a commission.</p>` : ""}
    </div>`;
  }

  function contestHTML() {
    const ct = P.contest || {};
    const free = ct.free_url || "https://www.nyc.gov/site/finance/vehicles/dispute-a-ticket.page";
    const partners = (ct.partners || []).filter((x) => x && x.name && x.url).map((x) =>
      `<a href="${esc(x.url)}" target="_blank" rel="sponsored noopener">${esc(x.name)}</a>${x.blurb ? ` (${esc(x.blurb)})` : ""}`).join(", ");
    return `<div class="contest">
      <p class="strip-label">Already got a ticket?</p>
      <p>You can contest it for free with the city <a href="${esc(free)}" target="_blank" rel="noopener">online or in the NYC Pay or Dispute app</a>.</p>
      ${partners ? `<p>Or let a service fight it for you: ${partners}. <span class="fine">Partner links: we may earn a commission.</span></p>` : ""}
    </div>`;
  }

  // ---------------------------------------------------------------- filters
  let pending = 0;
  function refresh() {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      const total = computeCounts();
      const src = map && map.getSource("tix");
      if (src) src.setData(geojson());
      const days = S.days.every(Boolean) ? "every day" : DAYS.filter((_, i) => S.days[i]).join(", ") || "no days";
      const hrs = S.h0 === 0 && S.h1 === 23 ? "all day" : `${fmtH(S.h0)} to ${fmtH(S.h1 + 1)}`;
      $("total").textContent = `${num(total)} tickets, ${days}, ${hrs}`;
      $("hours-out").textContent = hrs;
      if (selection) showSelection();
    });
  }

  function buildControls() {
    const days = $("days");
    DAYS.forEach((d, i) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = d; b.setAttribute("aria-pressed", "true"); b.title = DAY_NAMES[i];
      b.onclick = () => { S.days[i] = !S.days[i]; b.setAttribute("aria-pressed", String(S.days[i])); refresh(); };
      days.appendChild(b);
    });

    const h0 = $("h0"), h1 = $("h1");
    const onRange = () => {
      let a = +h0.value, b = +h1.value;
      if (a > b) { if (document.activeElement === h0) h1.value = b = a; else h0.value = a = b; }
      S.h0 = a; S.h1 = b; refresh();
    };
    h0.oninput = h1.oninput = onRange;

    const vio = $("vio");
    META.violations.slice(0, 25).forEach((v) => {
      const o = document.createElement("option");
      o.value = v.c; o.textContent = `${v.l} (${num(v.n)})`;
      vio.appendChild(o);
    });
    vio.onchange = () => { S.v = vio.value === "all" ? "all" : +vio.value; refresh(); };

    const sel = $("agent");
    AGENTS.forEach((a) => {
      const o = document.createElement("option");
      o.value = a.id; o.textContent = `${a.id} (${num(a.n)} tickets, precinct ${a.pr.join("/") || "?"})`;
      sel.appendChild(o);
    });
    sel.onchange = () => loadAgent(sel.value);
    $("aday").onchange = () => drawRound();

    $("collapse").onclick = () => {
      const p = $("panel"), c = p.classList.toggle("collapsed");
      $("collapse").textContent = c ? "Show" : "Hide";
      $("collapse").setAttribute("aria-expanded", String(!c));
    };
    $("tab-explore").onclick = () => setTab("explore");
    $("tab-game").onclick = () => setTab("game");

    $("about").innerHTML =
      `<p>${num(META.mapped)} of ${num(META.tickets)} tickets written by agents in ${esc(META.borough)} between ${fmtDate(META.from)} and ${fmtDate(META.to)}. ` +
      `Rounds cover the last ${META.route_days} days of that. Updated ${fmtDate(META.built)}.</p>` +
      `<p>Source: <a href="https://data.cityofnewyork.us/browse?q=parking%20violations%20issued" target="_blank" rel="noopener">NYC Open Data</a>. ` +
      `No plates or personal details are shown. Agent IDs are random, reset monthly, and the newest ${META.delay_days} days are held back. ` +
      `Forecasts describe past patterns, not guarantees: always read the signs.</p>` +
      (hasSponsor() ? `<p>${esc(P.disclosure || "Some links on this site may earn a commission.")}</p>` : "");

    setupSearch();
  }

  // ---------------------------------------------------------------- map
  function initMap() {
    map = new maplibregl.Map({ container: "map", style: STYLE, center: META.center, zoom: 12, maxBounds: [[META.bbox[0] - 0.08, META.bbox[1] - 0.06], [META.bbox[2] + 0.08, META.bbox[3] + 0.06]] });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), "top-right");

    map.on("load", () => {
      computeCounts();
      map.addSource("tix", { type: "geojson", data: geojson() });
      map.addLayer({
        id: "heat", type: "heatmap", source: "tix", maxzoom: 15.5,
        paint: {
          "heatmap-weight": ["interpolate", ["linear"], ["get", "n"], 0, 0, 40, 1],
          "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 10, 0.6, 15, 1.4],
          "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 10, 6, 15, 22],
          "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 13.5, 0.85, 15.5, 0],
          "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"],
            0, "rgba(0,116,74,0)", 0.2, "rgba(0,116,74,0.55)", 0.5, "#f2c230", 0.8, "#e0642a", 1, "#c4122f"],
        },
      });
      map.addLayer({
        id: "dots", type: "circle", source: "tix", minzoom: 13.5,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["get", "n"], 1, 3.5, 10, 6, 50, 11, 200, 16],
          "circle-color": ["step", ["get", "n"], "#00744a", 5, "#f2c230", 20, "#e0642a", 60, "#c4122f"],
          "circle-stroke-color": "#ffffff", "circle-stroke-width": 1,
          "circle-opacity": ["interpolate", ["linear"], ["zoom"], 13.5, 0, 14.5, 0.9],
        },
      });
      map.addSource("pick", { type: "geojson", data: empty() });
      map.addLayer({ id: "pick", type: "circle", source: "pick", paint: { "circle-radius": 14, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#1d2024", "circle-stroke-width": 3 } });

      map.addSource("route", { type: "geojson", data: empty() });
      map.addLayer({ id: "route-line", type: "line", source: "route", filter: ["==", "$type", "LineString"],
        paint: { "line-color": "#1d2024", "line-width": 3, "line-dasharray": [2, 1.5] } });
      map.addLayer({ id: "route-stops", type: "circle", source: "route", filter: ["==", "$type", "Point"],
        paint: { "circle-radius": ["case", ["has", "label"], 10, 5], "circle-color": "#f2c230", "circle-stroke-color": "#1d2024", "circle-stroke-width": 2 } });
      map.addLayer({ id: "route-num", type: "symbol", source: "route", filter: ["has", "label"],
        layout: { "text-field": ["get", "label"], "text-size": 11, "text-font": ["Noto Sans Regular"], "text-allow-overlap": true },
        paint: { "text-color": "#1d2024" } });

      map.on("click", (e) => {
        if (tab !== "explore") return;
        const hit = map.queryRenderedFeatures(e.point, { layers: ["dots"] });
        if (hit.length) selectSpot(hit[0].properties.i);
        else selectPoint([e.lngLat.lng, e.lngLat.lat], "Spot you picked");
      });
      map.on("mouseenter", "dots", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "dots", () => (map.getCanvas().style.cursor = ""));
      $("loading").hidden = true;
      refresh();
    });
  }

  const empty = () => ({ type: "FeatureCollection", features: [] });
  function ring(c) { map.getSource("pick").setData(c ? { type: "Feature", geometry: { type: "Point", coordinates: c } } : empty()); }

  // ---------------------------------------------------------------- selection
  function selectSpot(i, fly) {
    selection = { i, c: LOC.p[i], label: LOC.l[i] };
    afterSelect(fly);
  }
  function selectPoint(c, label, fly) {
    const i = nearest(c, 30);
    if (i !== null) return selectSpot(i, fly);
    selection = { i: null, c, label };
    afterSelect(fly);
  }
  function afterSelect(fly) {
    ring(selection.c);
    if (fly) map.flyTo({ center: selection.c, zoom: 17 });
    showSelection();
    showAreaAgents(selection.c, selection.label);
    $("panel").classList.remove("collapsed");
  }

  function showSelection() {
    const { i, c, label } = selection;
    const el = $("place");
    el.hidden = false;
    let detail = "";
    if (i !== null) detail = spotDetail(i);
    else detail = `<p class="sub">No tickets recorded at this exact address. The forecast covers the surrounding block.</p>`;
    el.innerHTML = `<div class="plate">
      <h3>${esc(label)}</h3>
      ${i !== null ? `<p class="sub">Precinct ${esc(LOC.pr[i] || "unknown")}</p>` : ""}
      ${forecastHTML(c)}
      ${detail}
      ${contestHTML()}
    </div>`;
    $("fc-d").onchange = (ev) => { FC.d = +ev.target.value; showSelection(); };
    $("fc-h").onchange = (ev) => { FC.h = +ev.target.value; showSelection(); };
  }

  function spotDetail(i) {
    const e = LOC.e[i], hours = new Array(24).fill(0), wd = new Array(7).fill(0), types = {};
    let n = 0;
    for (let j = 0; j < e.length; j += 2) {
      const [d, h, v] = split(e[j]), c = e[j + 1];
      if (typeOk(v) && S.days[d]) hours[h] += c;
      if (typeOk(v) && h >= S.h0 && h <= S.h1) wd[d] += c;
      if (S.days[d] && h >= S.h0 && h <= S.h1) types[v] = (types[v] || 0) + c;
      if (S.days[d] && h >= S.h0 && h <= S.h1 && typeOk(v)) n += c;
    }
    const hm = Math.max(1, ...hours), dm = Math.max(1, ...wd);
    const shade = (x, m) => (x === 0 ? "" : `background: color-mix(in srgb, var(--red) ${Math.round(25 + 75 * x / m)}%, var(--plate))`);
    const hourCells = hours.map((x, h) => `<span title="${fmtH(h)}: ${x} tickets" style="${shade(x, hm)}"></span>`).join("");
    const dayCells = wd.map((x, d) => `<span title="${DAY_NAMES[d]}: ${x} tickets" style="${shade(x, dm)}">${DAYS[d][0]}</span>`).join("");
    const topTypes = Object.entries(types).sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([v, c]) => `<li><span>${esc(VLABEL[v] || "Code " + v)}</span><span>${num(c)}</span></li>`).join("");
    return `<p class="strip-label">At this address: ${num(n)} tickets matching your filters, about ${(n / WEEKS).toFixed(1)} a week</p>
      <p class="strip-label">By hour</p>
      <div class="strip h24">${hourCells}</div>
      <div class="axis"><span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>11pm</span></div>
      <p class="strip-label">By day</p>
      <div class="strip d7">${dayCells}</div>
      ${topTypes ? `<p class="strip-label">Most common</p><ul>${topTypes}</ul>` : ""}
`;
  }

  // ---------------------------------------------------------------- agents in an area
  const AGENT_CACHE = new Map();
  function getAgent(id) {
    if (!AGENT_CACHE.has(id)) {
      AGENT_CACHE.set(id, fetch(`data/agents/${encodeURIComponent(id)}.json`).then((r) => {
        if (!r.ok) throw new Error(id);
        return r.json();
      }).catch((e) => { AGENT_CACHE.delete(id); throw e; }));
    }
    return AGENT_CACHE.get(id);
  }

  // When an agent shows up within these spots: busiest 2-hour window and usual days
  function habits(data, spots) {
    const hours = new Array(24).fill(0), wd = new Array(7).fill(0), days = [];
    let n = 0;
    for (const [day, rows] of Object.entries(data.days)) {
      let hit = false;
      for (const [m, li] of rows) {
        if (!spots.has(li)) continue;
        hours[Math.floor(m / 60)]++; n++; hit = true;
        wd[(new Date(day + "T12:00:00").getDay() + 6) % 7]++;
      }
      if (hit) days.push(day);
    }
    if (!n) return null;
    let best = 0;
    for (let h = 0; h < 23; h++) if (hours[h] + hours[h + 1] > hours[best] + hours[best + 1]) best = h;
    const usual = wd.map((c, d) => [c, d]).filter(([c]) => c >= 0.15 * n).map(([, d]) => DAYS[d]);
    days.sort();
    return { n, from: best, to: best + 2, usual, days };
  }

  let areaToken = 0;
  async function showAreaAgents(c, label) {
    const box = $("area-agents"), token = ++areaToken;
    let spots = near(c, 250), radius = "about 2 blocks";
    const tally = (list) => {
      const t = new Map();
      for (const i of list) {
        const a = LOC.a[i] || [];
        for (let j = 0; j < a.length; j += 2) t.set(a[j], (t.get(a[j]) || 0) + a[j + 1]);
      }
      return t;
    };
    let t = tally(spots);
    if (!t.size) { spots = near(c, 500); radius = "about 5 blocks"; t = tally(spots); }
    if (!t.size) {
      box.innerHTML = `<p class="hint">No agents wrote tickets near ${esc(label)} in the last ${META.route_days} days.</p>`;
      return;
    }
    const top = [...t.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id]) => id);
    box.innerHTML = `<p class="hint">Finding who works near ${esc(label)}…</p>`;
    const set = new Set(spots);
    const found = await Promise.all(top.map((id) => getAgent(id).then((d) => ({ id, h: habits(d, set) })).catch(() => null)));
    if (token !== areaToken) return;             // a newer selection replaced this one
    const rows = found.filter((x) => x && x.h).sort((a, b) => b.h.n - a.h.n);
    if (!rows.length) { box.innerHTML = `<p class="hint">Couldn’t load the agents for this area. Try again in a moment.</p>`; return; }
    box.innerHTML = `<p class="hint">Agents who ticketed within ${radius} of ${esc(label)} in the last ${META.route_days} days. Tap one to replay their round.</p>
      <ul class="agent-cards">${rows.map(({ id, h }) => `
        <li><button type="button" class="agent-card" data-agent="${esc(id)}" aria-pressed="${agentData && agentData.id === id}">
          <span class="ac-id">${esc(id)}</span>
          <span class="ac-when">Usually ${fmtH(h.from)} to ${fmtH(h.to)}${h.usual.length ? ", " + h.usual.join(", ") : ""}</span>
          <span class="ac-meta">${num(h.n)} tickets nearby, seen on ${h.days.length} day${h.days.length === 1 ? "" : "s"} (${fmtDate(h.days[0]).replace(/^\w+, /, "")} to ${fmtDate(h.days[h.days.length - 1]).replace(/^\w+, /, "")})</span>
        </button></li>`).join("")}</ul>`;
    box.querySelectorAll("[data-agent]").forEach((b) => (b.onclick = () => { $("agent").value = b.dataset.agent; loadAgent(b.dataset.agent); }));
  }

  // ---------------------------------------------------------------- agent rounds
  async function loadAgent(id) {
    agentData = null;
    $("stops").innerHTML = ""; $("agent-info").innerHTML = "";
    if (!id) { $("day-field").hidden = true; map.getSource("route").setData(empty()); return; }
    try {
      agentData = await getAgent(id);
    } catch (e) {
      $("agent-info").innerHTML = "<p>This agent’s round couldn’t be loaded. Reload the page and try again.</p>";
      return;
    }
    document.querySelectorAll(".agent-card").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.agent === id)));
    const meta = AGENTS.find((a) => a.id === id);
    const dayList = Object.keys(agentData.days).sort().reverse();
    const sel = $("aday");
    sel.innerHTML = `<option value="all">All ${dayList.length} days together</option>` +
      dayList.map((d) => `<option value="${d}">${fmtDate(d)} (${agentData.days[d].length} tickets)</option>`).join("");
    sel.value = dayList[0];
    $("day-field").hidden = false;
    if (meta) {
      const usual = meta.wd.map((c, i) => [c, i]).filter(([c]) => c >= 0.08 * meta.n).map(([, i]) => DAYS[i]).join(", ");
      $("agent-info").innerHTML = `<p>Usually works ${fmtH(meta.h[0])} to ${fmtH(meta.h[1] + 1)}, mostly ${usual || "varies"}.</p>`;
    }
    drawRound();
  }

  function drawRound() {
    if (!agentData) return;
    const day = $("aday").value, src = map.getSource("route");
    const list = $("stops");
    if (day === "all") {
      const pts = [];
      Object.values(agentData.days).forEach((rows) => rows.forEach(([, li]) => pts.push(LOC.p[li])));
      src.setData({ type: "FeatureCollection", features: pts.map((c) => ({ type: "Feature", geometry: { type: "Point", coordinates: c }, properties: {} })) });
      list.innerHTML = "";
      fit(pts);
      return;
    }
    const rows = agentData.days[day] || [];
    const coords = rows.map(([, li]) => LOC.p[li]);
    const feats = rows.map(([, li], k) => ({ type: "Feature", geometry: { type: "Point", coordinates: LOC.p[li] }, properties: { label: String(k + 1) } }));
    if (coords.length > 1) feats.unshift({ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: {} });
    src.setData({ type: "FeatureCollection", features: feats });
    list.innerHTML = rows.map(([m, li, v]) =>
      `<li data-i="${li}"><span class="t">${fmtM(m)}</span><span>${esc(LOC.l[li])}<br><span class="w">${esc(VLABEL[v] || "Code " + v)}</span></span></li>`).join("");
    list.querySelectorAll("li").forEach((li) => (li.onclick = () => selectSpot(+li.dataset.i, true)));
    fit(coords);
  }

  function fit(coords) {
    if (!coords.length) return;
    const b = coords.reduce((acc, c) => acc.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
    const mobile = window.innerWidth <= 640;
    map.fitBounds(b, { padding: mobile ? { top: 40, bottom: window.innerHeight * 0.6, left: 30, right: 30 } : { top: 60, bottom: 60, left: 420, right: 60 }, maxZoom: 17 });
  }

  // ---------------------------------------------------------------- address search
  function setupSearch() {
    const q = $("q"), out = $("results");
    let timer, items = [], active = -1;
    const close = () => { out.hidden = true; active = -1; };
    const render = () => {
      out.innerHTML = items.map((it, k) => `<li role="option" aria-selected="${k === active}" data-k="${k}">${esc(it.label)}</li>`).join("");
      out.hidden = !items.length;
      out.querySelectorAll("li").forEach((li) => (li.onmousedown = (ev) => { ev.preventDefault(); choose(items[+li.dataset.k]); }));
    };
    const choose = (it) => { close(); q.value = it.label; selectPoint(it.c, it.label.replace(/,.*$/, ""), true); };
    q.oninput = () => {
      clearTimeout(timer);
      const text = q.value.trim();
      if (text.length < 3) { items = []; render(); return; }
      timer = setTimeout(async () => {
        try {
          const r = await fetch(`${GEOSEARCH}?text=${encodeURIComponent(text + ", " + META.borough)}`).then((x) => x.json());
          items = (r.features || [])
            .filter((f) => !f.properties.borough || f.properties.borough === META.borough)
            .slice(0, 6).map((f) => ({ label: f.properties.label || f.properties.name, c: f.geometry.coordinates }));
        } catch (e) { items = []; }
        active = -1; render();
      }, 250);
    };
    q.onkeydown = (ev) => {
      if (out.hidden) return;
      if (ev.key === "ArrowDown") { active = Math.min(items.length - 1, active + 1); render(); ev.preventDefault(); }
      else if (ev.key === "ArrowUp") { active = Math.max(0, active - 1); render(); ev.preventDefault(); }
      else if (ev.key === "Enter" && items.length) { choose(items[Math.max(0, active)]); ev.preventDefault(); }
      else if (ev.key === "Escape") close();
    };
    q.onblur = () => setTimeout(close, 150);
  }

  // ---------------------------------------------------------------- tabs
  let tab = "explore";
  function setTab(t) {
    tab = t;
    $("tab-explore").setAttribute("aria-pressed", String(t === "explore"));
    $("tab-game").setAttribute("aria-pressed", String(t === "game"));
    $("explore").hidden = t !== "explore";
    $("game").hidden = t !== "game";
    // Hide the heat map during the game so it doesn't give answers away
    ["heat", "dots", "route-line", "route-stops", "route-num"].forEach((id) => {
      if (map && map.getLayer(id)) map.setLayoutProperty(id, "visibility", t === "game" ? "none" : "visible");
    });
    if (t === "game") startGame();
    else ring(selection ? selection.c : null);
    $("panel").classList.remove("collapsed");
  }

  // ---------------------------------------------------------------- daily game
  function nyDate() {
    try { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date()); }
    catch (e) { return new Date().toISOString().slice(0, 10); }
  }
  const puzzleNo = () => Math.max(1, Math.floor((Date.parse(nyDate() + "T00:00:00Z") - GAME_EPOCH) / 864e5) + 1);

  function rng(seed) {   // mulberry32: same seed, same puzzle for everyone
    return () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function countNear(i, test) {
    const w = weekly(near(LOC.p[i]), false);
    let c = 0;
    for (let s = 0; s < 168; s++) if (test((s / 24) | 0, s % 24)) c += w[s];
    return Math.round(c);
  }

  function options(c, r) {
    const mult = [0.25, 0.4, 0.6, 1.6, 2.2, 3.2];
    for (let k = mult.length - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); [mult[k], mult[j]] = [mult[j], mult[k]]; }
    const set = [c];
    for (const m of mult) {
      const v = Math.max(1, Math.round(c * m));
      if (set.every((x) => Math.abs(x - v) >= Math.max(2, 0.18 * Math.max(x, v)))) set.push(v);
      if (set.length === 4) break;
    }
    return set.sort((a, b) => a - b);
  }

  function makeRounds(no) {
    const r = rng(no * 9973 + 17), pool = [];
    for (let i = 0; i < LOC.p.length; i++) {
      let t = 0;
      for (let j = 1; j < LOC.e[i].length; j += 2) t += LOC.e[i][j];
      if (t >= 15) pool.push(i);
    }
    const rounds = [];
    for (let guard = 0; rounds.length < 5 && guard < 600 && pool.length; guard++) {
      const i = pool[Math.floor(r() * pool.length)];
      if (rounds.some((x) => x.i === i)) continue;
      let q, c;
      if (r() < 0.5) {
        const d = Math.floor(r() * 7);
        c = countNear(i, (dw) => dw === d);
        q = `on ${DAY_NAMES[d]}s`;
      } else {
        const h0 = 6 + Math.floor(r() * 13);
        c = countNear(i, (dw, h) => h >= h0 && h < h0 + 2);
        q = `between ${fmtH(h0)} and ${fmtH(h0 + 2)}, any day`;
      }
      if (c < 8) continue;
      rounds.push({ i, q, c, opts: options(c, r) });
    }
    return rounds;
  }

  function loadStats() {
    try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (e) { return {}; }
  }
  function saveStats(s) { try { localStorage.setItem(STORE, JSON.stringify(s)); } catch (e) { /* private mode */ } }

  let G = null;
  function startGame() {
    const no = puzzleNo();
    if (!G || G.no !== no) {
      const st = loadStats();
      G = { no, rounds: makeRounds(no), answers: st.no === no && Array.isArray(st.answers) ? st.answers : [], picked: null };
    }
    renderGame();
  }

  function renderGame() {
    const el = $("game"), weeks = Math.round(WEEKS);
    if (G.rounds.length < 5) {
      el.innerHTML = `<h2>Ticket guess</h2><p class="hint">There isn’t enough data for today’s game yet. Check back after the next update.</p>`;
      return;
    }
    if (G.answers.length >= 5 && G.picked === null) return renderResults();
    const k = G.picked === null ? G.answers.length : G.answers.length - 1;
    const R = G.rounds[k];
    ring(LOC.p[R.i]);
    map.flyTo({ center: LOC.p[R.i], zoom: 16 });
    const buttons = R.opts.map((v) => {
      let cls = "";
      if (G.picked !== null) cls = v === R.c ? "right" : v === G.picked ? "wrong" : "";
      return `<button type="button" class="opt ${cls}" data-v="${v}" ${G.picked !== null ? "disabled" : ""}>${num(v)}</button>`;
    }).join("");
    const verdict = G.picked === null ? "" :
      `<p class="verdict">${G.picked === R.c ? "Correct" : "Not quite"}: agents wrote ${num(R.c)} tickets here.</p>
       <button type="button" id="next" class="primary">${k === 4 ? "See your score" : "Next spot"}</button>`;
    el.innerHTML = `<h2>Ticket guess #${G.no}</h2>
      <p class="progress">Spot ${k + 1} of 5 ${G.answers.map((a) => (a ? "🟩" : "🟥")).join("")}</p>
      <div class="plate">
        <h3>${esc(LOC.l[R.i])}</h3>
        <p class="q">How many tickets did agents write within a block of here ${esc(R.q)}, over the last ${weeks} weeks?</p>
        <div class="opts">${buttons}</div>
        ${verdict}
      </div>`;
    el.querySelectorAll(".opt").forEach((b) => (b.onclick = () => answer(+b.dataset.v)));
    if ($("next")) $("next").onclick = () => { G.picked = null; renderGame(); };
  }

  function answer(v) {
    const R = G.rounds[G.answers.length];
    G.picked = v;
    G.answers.push(v === R.c);
    const st = loadStats();
    st.no = G.no; st.answers = G.answers;
    if (G.answers.length === 5 && st.lastDone !== G.no) {
      st.streak = st.lastDone === G.no - 1 ? (st.streak || 0) + 1 : 1;
      st.best = Math.max(st.best || 0, st.streak);
      st.played = (st.played || 0) + 1;
      st.lastDone = G.no;
    }
    saveStats(st);
    renderGame();
  }

  function renderResults() {
    const st = loadStats(), score = G.answers.filter(Boolean).length;
    const grid = G.answers.map((a) => (a ? "🟩" : "🟥")).join("");
    const text = `Brooklyn Ticket Guess #${G.no}: ${score}/5\n${grid}\n${location.origin}${location.pathname}`;
    ring(null);
    $("game").innerHTML = `<h2>Ticket guess #${G.no}</h2>
      <div class="plate result">
        <div class="score">${score}/5</div>
        <p class="grid">${grid}</p>
        <p>Streak: ${st.streak || 1} day${(st.streak || 1) === 1 ? "" : "s"}. Best: ${st.best || 1}. Games played: ${st.played || 1}.</p>
        <button type="button" id="share" class="primary">Share result</button>
        <p class="hint">A new set of spots arrives tomorrow.</p>
      </div>`;
    $("share").onclick = async () => {
      try {
        if (navigator.share) await navigator.share({ text });
        else { await navigator.clipboard.writeText(text); $("share").textContent = "Copied to clipboard"; }
      } catch (e) { /* share sheet closed */ }
    };
  }

  load();
})();
