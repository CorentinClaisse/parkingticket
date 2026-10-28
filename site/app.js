/* Brooklyn parking ticket map. Everything runs in the browser on pre-built
   JSON files, so a search costs nothing. */
(() => {
  "use strict";

  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const STYLE = "https://tiles.openfreemap.org/styles/positron";
  const GEOSEARCH = "https://geosearch.planninglabs.nyc/v2/autocomplete";

  const S = { days: [true, true, true, true, true, true, true], h0: 0, h1: 23, v: "all" };
  let META, LOC, AGENTS, VLABEL = {}, COUNTS, map, selected = null, agentData = null;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtH = (h) => (h % 12 === 0 ? 12 : h % 12) + (h < 12 ? "am" : "pm");
  const fmtM = (m) => {
    const h = Math.floor(m / 60), mm = String(m % 60).padStart(2, "0");
    return (h % 12 === 0 ? 12 : h % 12) + ":" + mm + (h < 12 ? "am" : "pm");
  };
  const fmtDate = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const num = (n) => n.toLocaleString("en-US");

  // ---------------------------------------------------------------- data
  async function load() {
    const get = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(p); return r.json(); });
    try {
      [META, LOC, AGENTS] = await Promise.all([get("data/meta.json"), get("data/locations.json"), get("data/agents/index.json")]);
    } catch (e) {
      $("loading").textContent = "The map data hasn't been built yet. Run the “Update map” workflow on GitHub, then reload.";
      return;
    }
    META.violations.forEach((v) => (VLABEL[v.c] = v.l));
    buildControls();
    initMap();
  }

  // Each location has a flat list [key, count, key, count...]
  // where key = (weekday*24 + hour) * 100 + violation code.
  function matches(k) {
    const v = k % 100, how = (k - v) / 100, d = (how / 24) | 0, h = how % 24;
    return S.days[d] && h >= S.h0 && h <= S.h1 && (S.v === "all" || v === S.v);
  }

  function computeCounts() {
    const N = LOC.p.length, out = new Int32Array(N);
    let total = 0;
    for (let i = 0; i < N; i++) {
      const e = LOC.e[i];
      let s = 0;
      for (let j = 0; j < e.length; j += 2) if (matches(e[j])) s += e[j + 1];
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

  let pending = 0;
  function refresh() {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      const total = computeCounts();
      const src = map && map.getSource("tix");
      if (src) src.setData(geojson());
      const days = S.days.every(Boolean) ? "every day" : DAYS.filter((_, i) => S.days[i]).join(", ") || "no days";
      const hrs = S.h0 === 0 && S.h1 === 23 ? "all day" : `${fmtH(S.h0)} to ${fmtH((S.h1 + 1) % 24)}`;
      $("total").textContent = `${num(total)} tickets, ${days}, ${hrs}`;
      $("hours-out").textContent = hrs;
      if (selected !== null) showPlace(selected);
    });
  }

  // ---------------------------------------------------------------- controls
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

    $("about").innerHTML =
      `<p>${num(META.mapped)} of ${num(META.tickets)} tickets written by agents in ${esc(META.borough)} between ${fmtDate(META.from)} and ${fmtDate(META.to)}. ` +
      `Rounds cover the last ${META.route_days} days of that. Updated ${fmtDate(META.built)}.</p>` +
      `<p>Source: <a href="https://data.cityofnewyork.us/browse?q=parking%20violations%20issued" target="_blank" rel="noopener">NYC Open Data</a>. ` +
      `No plates or personal details are shown. Agent IDs are random, reset monthly, and the newest ${META.delay_days} days are held back. ` +
      `Past patterns don’t guarantee anything: always read the signs.</p>`;

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

      map.on("click", "dots", (e) => selectPlace(e.features[0].properties.i));
      map.on("mouseenter", "dots", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "dots", () => (map.getCanvas().style.cursor = ""));
      $("loading").hidden = true;
      refresh();
    });
  }

  const empty = () => ({ type: "FeatureCollection", features: [] });

  // ---------------------------------------------------------------- a selected spot
  function selectPlace(i, fly) {
    selected = i;
    map.getSource("pick").setData({ type: "Feature", geometry: { type: "Point", coordinates: LOC.p[i] } });
    if (fly) map.flyTo({ center: LOC.p[i], zoom: 17 });
    showPlace(i);
    $("panel").classList.remove("collapsed");
  }

  function showPlace(i) {
    const e = LOC.e[i], hours = new Array(24).fill(0), wd = new Array(7).fill(0), types = {};
    let n = 0;
    for (let j = 0; j < e.length; j += 2) {
      const k = e[j], c = e[j + 1], v = k % 100, how = (k - v) / 100, d = (how / 24) | 0, h = how % 24;
      const typeOk = S.v === "all" || v === S.v;
      if (typeOk && S.days[d]) hours[h] += c;
      if (typeOk && h >= S.h0 && h <= S.h1) wd[d] += c;
      if (S.days[d] && h >= S.h0 && h <= S.h1) types[v] = (types[v] || 0) + c;
      if (matches(k)) n += c;
    }
    const weeks = Math.max(1, Math.round(META.window_days / 7));
    const hm = Math.max(1, ...hours), dm = Math.max(1, ...wd);
    const shade = (x, m) => (x === 0 ? "" : `background: color-mix(in srgb, var(--red) ${Math.round(25 + 75 * x / m)}%, var(--plate))`);

    const hourCells = hours.map((x, h) => `<span title="${fmtH(h)}: ${x} tickets" style="${shade(x, hm)}"></span>`).join("");
    const dayCells = wd.map((x, d) => `<span title="${DAY_NAMES[d]}: ${x} tickets" style="${shade(x, dm)}">${DAYS[d][0]}</span>`).join("");
    const topTypes = Object.entries(types).sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([v, c]) => `<li><span>${esc(VLABEL[v] || "Code " + v)}</span><span>${num(c)}</span></li>`).join("");
    const a = LOC.a[i] || [];
    let agents = "";
    for (let j = 0; j < a.length; j += 2) agents += `<li><button class="agent-btn" data-agent="${esc(a[j])}">${esc(a[j])}</button><span>${a[j + 1]} tickets here</span></li>`;

    const el = $("place");
    el.hidden = false;
    el.innerHTML = `<div class="plate">
      <h3>${esc(LOC.l[i])}</h3>
      <p class="sub">Precinct ${esc(LOC.pr[i] || "unknown")}</p>
      <div class="big">${num(n)}</div>
      <p class="big-label">tickets matching your filters in ${weeks} weeks, about ${(n / weeks).toFixed(1)} a week</p>
      <p class="strip-label">By hour</p>
      <div class="strip h24">${hourCells}</div>
      <div class="axis"><span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>11pm</span></div>
      <p class="strip-label">By day</p>
      <div class="strip d7">${dayCells}</div>
      ${topTypes ? `<p class="strip-label">Most common</p><ul>${topTypes}</ul>` : ""}
      ${agents ? `<p class="strip-label">Agents who work this spot (last ${META.route_days} days)</p><ul>${agents}</ul>` : ""}
    </div>`;
    el.querySelectorAll("[data-agent]").forEach((b) => (b.onclick = () => { $("agent").value = b.dataset.agent; loadAgent(b.dataset.agent); }));
  }

  // ---------------------------------------------------------------- agent rounds
  async function loadAgent(id) {
    agentData = null;
    $("stops").innerHTML = ""; $("agent-info").innerHTML = "";
    if (!id) { $("day-field").hidden = true; map.getSource("route").setData(empty()); return; }
    try {
      agentData = await fetch(`data/agents/${encodeURIComponent(id)}.json`).then((r) => r.json());
    } catch (e) {
      $("agent-info").innerHTML = "<p>This agent’s round couldn’t be loaded. Reload the page and try again.</p>";
      return;
    }
    const meta = AGENTS.find((a) => a.id === id);
    const dayList = Object.keys(agentData.days).sort().reverse();
    const sel = $("aday");
    sel.innerHTML = `<option value="all">All ${dayList.length} days together</option>` +
      dayList.map((d) => `<option value="${d}">${fmtDate(d)} (${agentData.days[d].length} tickets)</option>`).join("");
    sel.value = dayList[0];
    $("day-field").hidden = false;
    if (meta) {
      const usual = meta.wd.map((c, i) => [c, i]).filter(([c]) => c >= 0.08 * meta.n).map(([, i]) => DAYS[i]).join(", ");
      $("agent-info").innerHTML = `<p>Usually works ${fmtH(meta.h[0])} to ${fmtH((meta.h[1] + 1) % 24)}, mostly ${usual || "varies"}.</p>`;
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
    list.querySelectorAll("li").forEach((li) => (li.onclick = () => selectPlace(+li.dataset.i, true)));
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
    const choose = (it) => {
      close(); q.value = it.label;
      const i = nearest(it.c);
      if (i !== null) selectPlace(i, true);
      else map.flyTo({ center: it.c, zoom: 17 });
    };
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

  // Closest ticketed spot within ~80 m of a searched address
  function nearest([lon, lat]) {
    let best = null, bd = Infinity;
    const kx = Math.cos(lat * Math.PI / 180);
    for (let i = 0; i < LOC.p.length; i++) {
      const dx = (LOC.p[i][0] - lon) * kx, dy = LOC.p[i][1] - lat, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    return Math.sqrt(bd) * 111000 < 80 ? best : null;
  }

  load();
})();
