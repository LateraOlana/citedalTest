/* ============================================================
   CITADEL — daily capital city game
   ============================================================ */

(() => {
  "use strict";

  // ---------- Safe storage (some browsers disable localStorage under file://) ----------
  const safeStorage = (() => {
    try {
      const k = "__test__";
      window.localStorage.setItem(k, "1");
      window.localStorage.removeItem(k);
      return window.localStorage;
    } catch {
      // In-memory fallback so the rest of the app still works
      const mem = {};
      return {
        getItem: k => (k in mem ? mem[k] : null),
        setItem: (k, v) => { mem[k] = String(v); },
        removeItem: k => { delete mem[k]; },
      };
    }
  })();

  // ---------- Constants ----------
  const STORAGE_KEY = "citadel:v1";
  const STATS_KEY = "citadel:stats:v1";
  // Anchor for daily puzzle numbering (UTC). Puzzle 1 = this date.
  const PUZZLE_EPOCH = new Date(Date.UTC(2026, 3, 30)); // Apr 30, 2026
  const MAX_DISTANCE_KM = 20015; // half earth's circumference

  // Warmth thresholds (km). Tuned for global play.
  const WARMTH_TIERS = [
    { max: 100,    name: "Scorching", color: "var(--w-blazing)", glow: "rgba(255,42,77,.7)",  emoji: "🟥" },
    { max: 500,    name: "Hot",       color: "var(--w-hot)",     glow: "rgba(239,71,111,.6)", emoji: "🟧" },
    { max: 1500,   name: "Warm",      color: "var(--w-warm)",    glow: "rgba(255,209,102,.5)",emoji: "🟨" },
    { max: 4000,   name: "Cool",      color: "var(--w-cool)",    glow: "rgba(142,154,175,.4)",emoji: "🟦" },
    { max: Infinity,name:"Cold",      color: "var(--w-cold)",    glow: "rgba(74,144,226,.5)", emoji: "⬛" },
  ];

  const DIR_NAMES = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  const DIR_ARROWS = ["↑","↑","↗","↗","→","→","↘","↘","↓","↓","↙","↙","←","←","↖","↖"];

  // ---------- DOM ----------
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  // ---------- State ----------
  let capitals = [];
  let answer = null;       // {city, country, continent, lat, lon}
  let puzzleNum = null;
  let isFreePlay = false;
  let guesses = [];        // [{name, country, lat, lon, distanceKm, bearingDeg}]
  let gameOver = false;
  let map = null;
  let answerLatLng = null;
  let pinMarkers = [];
  let citadelMarker = null;
  let connectorPolyline = null;
  let suggestionIdx = -1;
  let isRestoring = false;  // true while replaying saved guesses on page load

  // ---------- Math helpers ----------
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;

  /** Great-circle distance, kilometers. */
  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371; // km
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat/2)**2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLon/2)**2;
    return 2 * R * Math.asin(Math.sqrt(Math.min(1, a)));
  }

  /** Initial bearing from (lat1,lon1) toward (lat2,lon2), 0–360 (0 = N, 90 = E).
   *  This is the great-circle bearing — geographically correct but can feel wrong
   *  on a flat (Mercator) map for long distances. Use screenBearing() for UI. */
  function bearing(lat1, lon1, lat2, lon2) {
    const φ1 = toRad(lat1), φ2 = toRad(lat2);
    const Δλ = toRad(lon2 - lon1);
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    const θ = Math.atan2(y, x);
    return (toDeg(θ) + 360) % 360;
  }

  /** Bearing as it appears on the map, computed in screen pixel space.
   *  This matches what the user sees: if Tokyo and New York look like
   *  east-and-west on the map, the arrow points east, not "great-circle NNE
   *  over the Pole." Falls back to geographic bearing if the map isn't ready
   *  or projection fails for some reason. */
  function screenBearing(lat1, lon1, lat2, lon2) {
    if (!map || typeof map.latLngToLayerPoint !== "function") {
      return bearing(lat1, lon1, lat2, lon2);
    }
    try {
      // Pick the shorter longitudinal route across the antimeridian, so a guess
      // in NZ aiming for a city in Argentina goes the *short* way visually.
      let lon2adj = lon2;
      if (lon2 - lon1 > 180) lon2adj -= 360;
      else if (lon2 - lon1 < -180) lon2adj += 360;

      const p1 = map.latLngToLayerPoint([lat1, lon1]);
      const p2 = map.latLngToLayerPoint([lat2, lon2adj]);
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y; // y grows downward on screen
      // atan2(dx, -dy): 0 = up (north on screen), 90 = right (east), etc.
      const θ = Math.atan2(dx, -dy);
      return (toDeg(θ) + 360) % 360;
    } catch {
      return bearing(lat1, lon1, lat2, lon2);
    }
  }

  function compassIdxFromBearing(deg) {
    return Math.round(deg / 22.5) % 16;
  }
  function compassNameFromBearing(deg) {
    return DIR_NAMES[compassIdxFromBearing(deg)];
  }
  function compassArrowFromBearing(deg) {
    return DIR_ARROWS[compassIdxFromBearing(deg)];
  }

  function warmthFor(km) {
    return WARMTH_TIERS.find(t => km < t.max) || WARMTH_TIERS[WARMTH_TIERS.length - 1];
  }

  /** Format kilometers with a thousands separator. */
  function fmtKm(km) {
    return Math.round(km).toLocaleString() + " km";
  }

  function escapeHTML(str = "") {
    return String(str).replace(/[&<>"']/g, ch => ({
      "&": "&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
    }[ch]));
  }

  // ---------- Daily seed ----------
  /** Days since epoch (UTC), so all players in any timezone share the same answer per UTC day. */
  function todaysPuzzleNumber() {
    const now = new Date();
    const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const days = Math.floor((utcMidnight - PUZZLE_EPOCH.getTime()) / 86400000);
    return Math.max(1, days + 1);
  }
  /** mulberry32 PRNG seeded by puzzle number → deterministic per-day pick. */
  function pickDaily(puzzleN, list) {
    let s = (puzzleN * 2654435761) >>> 0;
    let t = s + 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return list[Math.floor(r * list.length)];
  }

  function fmtDate(d) {
    return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  }

  // ---------- Persistence ----------
  function saveProgress() {
    if (isFreePlay) return;
    try {
      safeStorage.setItem(STORAGE_KEY, JSON.stringify({
        puzzleNum,
        guesses: guesses.map(g => ({ name: g.name, country: g.country })),
        won: gameOver && lastIsCorrect()
      }));
    } catch {}
  }
  function loadProgress() {
    try {
      const raw = safeStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch { return null; }
  }
  function lastIsCorrect() {
    if (guesses.length === 0) return false;
    return guesses[guesses.length - 1].distanceKm < 0.5;
  }

  function loadStats() {
    try {
      const raw = safeStorage.getItem(STATS_KEY);
      if (!raw) return defaultStats();
      const s = JSON.parse(raw);
      return Object.assign(defaultStats(), s);
    } catch { return defaultStats(); }
  }
  function defaultStats() {
    return {
      played: 0,
      wins: 0,
      currentStreak: 0,
      maxStreak: 0,
      lastWinPuzzle: null,
      bestGuesses: null, // smallest count for any win
      totalGuesses: 0,
    };
  }
  function saveStats(s) {
    try { safeStorage.setItem(STATS_KEY, JSON.stringify(s)); } catch {}
  }
  function recordWin(guessCount) {
    const s = loadStats();
    // Idempotency: if this puzzle was already recorded as won, do nothing.
    // Without this, every page reload would re-bump played/wins/streak.
    if (s.lastWinPuzzle === puzzleNum) return s;

    s.played += 1;
    s.wins += 1;
    s.totalGuesses += guessCount;
    s.bestGuesses = s.bestGuesses == null ? guessCount : Math.min(s.bestGuesses, guessCount);
    if (s.lastWinPuzzle === puzzleNum - 1) s.currentStreak += 1;
    else s.currentStreak = 1;
    s.maxStreak = Math.max(s.maxStreak, s.currentStreak);
    s.lastWinPuzzle = puzzleNum;
    saveStats(s);
    return s;
  }

  // ---------- Toast ----------
  function toast(msg, isError = false) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.toggle("error", isError);
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 2200);
  }

  /** Light no-labels tile layer: clean coastlines, country borders, no text.
   *  Light tiles read clearly on a phone screen in daylight, which dark tiles
   *  do not. Pin colors (warm-to-cold) still pop against the soft background. */
  function addBaseTiles() {
    return L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png",
      {
        maxZoom: 18,
        minZoom: 2,
        subdomains: "abcd",
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a> · © <a href="https://carto.com/attributions">CARTO</a>',
      }
    ).addTo(map);
  }

  // ---------- Map setup ----------
  function setupMap() {
    map = L.map("map", {
      center: [20, 0],
      zoom: 2,
      worldCopyJump: true,
      zoomControl: true,
      attributionControl: true,
    });
    addBaseTiles();

    // Whenever the user pans or zooms (or the app does so via flyTo), refresh
    // every guess's screen-bearing so the arrows still point the way they look.
    let moveTimer = null;
    map.on("moveend zoomend", () => {
      // Debounce — flyTo fires moveend at the end of its animation; that's
      // already a single event, but also covers user wheel-zoom rapid bursts.
      clearTimeout(moveTimer);
      moveTimer = setTimeout(refreshBearings, 50);
    });
  }

  function buildPinIcon(name, tier, isCorrect = false, isClosest = false) {
    const cls = [isCorrect ? "correct" : "", isClosest ? "is-closest" : ""].join(" ").trim();
    const html = `
      <div class="pin ${cls}" style="--pin-color: ${tier.color}; --pin-glow: ${tier.glow};">
        <div class="pin-pulse"></div>
        <div class="pin-dot"></div>
        ${isClosest && !isCorrect ? `<div class="pin-crown" aria-hidden="true">★</div>` : ""}
        <div class="pin-label">${escapeHTML(name)}</div>
      </div>`;
    return L.divIcon({
      className: "pin-icon",
      html,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });
  }

  /** After every new guess, update the visual "closest" highlight on the map.
   *  Re-builds the icon for the previous closest (un-marking it) and for the
   *  new closest (marking it). This keeps the star badge on the warmest pin. */
  function refreshClosestPinHighlight() {
    if (guesses.length === 0) return;
    const closest = closestGuess();
    if (!closest) return;
    const closestKey = `${closest.lat},${closest.lon}`;
    pinMarkers.forEach((marker, i) => {
      const g = guesses[i];
      if (!g) return;
      const isCorrect = g.distanceKm < 0.5;
      const isClosest = !isCorrect && `${g.lat},${g.lon}` === closestKey;
      const tier = warmthFor(g.distanceKm);
      marker.setIcon(buildPinIcon(g.name, tier, isCorrect, isClosest));
    });
  }

  function dropPin(g, isCorrect) {
    const tier = warmthFor(g.distanceKm);
    const marker = L.marker([g.lat, g.lon], {
      icon: buildPinIcon(g.name, tier, isCorrect, false /* will refresh below */),
      keyboard: false,
    }).addTo(map);
    pinMarkers.push(marker);

    // Update the "warmest pin" star badge on the map
    refreshClosestPinHighlight();

    // Connector line from latest guess toward the answer (only revealed on win)
    if (connectorPolyline) {
      map.removeLayer(connectorPolyline);
      connectorPolyline = null;
    }

    if (isCorrect) {
      // On win, reveal the answer with a citadel marker
      const trophyIcon = L.divIcon({
        className: "citadel-icon",
        html: `<div class="citadel-marker">🏰</div>`,
        iconSize: [50, 50],
        iconAnchor: [25, 25],
      });
      citadelMarker = L.marker([answer.lat, answer.lon], { icon: trophyIcon }).addTo(map);

      // Draw soft connecting lines from each guess to the answer
      const lines = pinMarkers.slice(0, -1).map(m => {
        const ll = m.getLatLng();
        return L.polyline(
          [[ll.lat, ll.lng], [answer.lat, answer.lon]],
          { color: "#ffd166", weight: 1, opacity: .35, dashArray: "4 6" }
        );
      });
      lines.forEach(l => l.addTo(map));

      const bounds = L.latLngBounds(pinMarkers.map(m => m.getLatLng()));
      bounds.extend([answer.lat, answer.lon]);
      map.flyToBounds(bounds.pad(0.4), { duration: 1.2 });
    } else {
      // Pan to the new guess (zoomed enough to see the pin clearly)
      map.flyTo([g.lat, g.lon], Math.max(map.getZoom(), 3), { duration: 0.9 });
    }
  }

  // ---------- Proximity HUD ----------
  /** Closest non-correct guess so far. Returns null if no guesses yet. */
  function closestGuess() {
    if (guesses.length === 0) return null;
    let best = guesses[0];
    for (const g of guesses) if (g.distanceKm < best.distanceKm) best = g;
    return best;
  }

  /** Re-compute screen bearings for every existing guess. The map projection
   *  changes on zoom/pan, so the on-screen direction toward the answer can
   *  shift — call this after map move events to keep arrows accurate. */
  function refreshBearings() {
    if (guesses.length === 0) return;
    for (const g of guesses) {
      g.bearingDeg = screenBearing(g.lat, g.lon, answer.lat, answer.lon);
    }
    renderGuessList();
    // Also update the compass to point along the latest guess's bearing
    const last = guesses[guesses.length - 1];
    if (last && last.distanceKm >= 0.5) {
      const ring = document.querySelector(".compass-ring");
      const isWin = ring?.classList.contains("win");
      if (!isWin) updateCompass(last.bearingDeg, compassNameFromBearing(last.bearingDeg) + " · " + fmtKm(last.distanceKm));
    }
  }

  /** Map raw distance (km) → 0..1 "closeness" score for the meter.
   *  Uses log scaling so the gauge moves visibly even at long distances,
   *  and rewards getting under ~500 km dramatically. */
  function closenessFromKm(km) {
    if (km < 0.5) return 1;
    // log curve: 20015 km → ~0, 100 km → ~0.86, 0 km → 1
    const score = 1 - Math.log10(km + 10) / Math.log10(20015 + 10);
    return Math.max(0, Math.min(1, score));
  }

  function updateProximityHud() {
    const hud = $("#hud-bar");
    const banner = $("#warmth-banner");
    const pill = $("#closest-pill");
    const prox = $("#proximity");

    if (guesses.length === 0) {
      hud.hidden = true;
      pill.hidden = true;
      prox.hidden = true;
      return;
    }

    const last = guesses[guesses.length - 1];
    const closest = closestGuess();
    const isWin = last.distanceKm < 0.5;

    // HUD bar (compass + warmth banner together, ABOVE the map)
    hud.hidden = false;

    // Banner — reflects the most recent guess's warmth
    const lastTier = warmthFor(last.distanceKm);
    banner.style.setProperty("--warmth", lastTier.color);
    banner.style.setProperty("--warmth-glow", lastTier.glow);
    banner.classList.toggle("win", isWin);
    $("#warmth-banner-emoji").textContent = isWin ? "🎯" : lastTier.emoji;
    $("#warmth-banner-label").textContent = isWin ? "Found it!" : lastTier.name;
    $("#warmth-banner-distance").textContent = isWin
      ? `in ${guesses.length} guess${guesses.length === 1 ? "" : "es"}`
      : fmtKm(last.distanceKm);

    // Closest pill — shows the warmest guess so far. After winning, that's
    // the correct guess itself (distance ≈ 0).
    if (isWin) {
      const correctTier = WARMTH_TIERS[0]; // scorching at 0 km
      pill.hidden = false;
      pill.classList.add("win");
      pill.style.setProperty("--warmth", "var(--w-correct)");
      pill.style.setProperty("--warmth-glow", "rgba(6, 214, 160, .7)");
      $("#closest-pill-lbl").textContent = "Found it";
      $("#closest-pill-name").textContent = `${last.name} · 0 km 🎯`;
    } else if (guesses.length >= 2) {
      const closestTier = warmthFor(closest.distanceKm);
      pill.hidden = false;
      pill.classList.remove("win");
      pill.style.setProperty("--warmth", closestTier.color);
      pill.style.setProperty("--warmth-glow", closestTier.glow);
      $("#closest-pill-lbl").textContent = "Closest so far";
      $("#closest-pill-name").textContent = `${closest.name} · ${fmtKm(closest.distanceKm)}`;
    } else {
      pill.hidden = true;
    }

    // Proximity meter
    prox.hidden = false;
    const closeness = closenessFromKm(closest.distanceKm);
    const pct = Math.round(closeness * 100);
    $("#proximity-fill").style.transform = `scaleX(${1 - closeness})`;
    $("#proximity-marker").style.left = `${pct}%`;
    const closestTier = warmthFor(closest.distanceKm);
    $("#proximity-marker").style.background = closestTier.color;
    $("#proximity-marker").style.boxShadow = `0 0 16px ${closestTier.glow}, 0 2px 4px rgba(0,0,0,.4)`;
    $("#prox-pct").textContent = isWin ? "100%" : `${pct}%`;
    $("#prox-pct").style.color = closestTier.color;
  }

  function resetProximityHud() {
    $("#hud-bar").hidden = true;
    $("#warmth-banner").classList.remove("win");
    $("#closest-pill").hidden = true;
    $("#proximity").hidden = true;
  }
  function updateCompass(deg, label, isWin = false) {
    const arrow = $("#compass-arrow");
    const ring = arrow.parentElement;
    arrow.style.transform = `rotate(${deg}deg)`;
    $("#compass-label").textContent = label;
    // Compass visibility is bound to the hud-bar wrapper now.
    if (isWin) {
      ring.classList.add("win");
      $("#compass-label").textContent = "Found!";
    }
  }

  // ---------- Guess list ----------
  function renderGuessList() {
    const ul = $("#guess-list");
    if (guesses.length === 0) {
      ul.innerHTML = `<li class="guess-empty">No guesses yet. The first one's free.</li>`;
      return;
    }

    // Track each guess's original 1-based number so the player can see "#3" etc.
    const numbered = guesses.map((g, i) => ({ ...g, _n: i + 1 }));
    // Sort by distance ascending so the closest is at the top
    numbered.sort((a, b) => a.distanceKm - b.distanceKm);

    // Identify the closest non-winning guess to badge as "warmest"
    const closestId = (() => {
      const nonWinners = numbered.filter(g => g.distanceKm >= 0.5);
      if (nonWinners.length === 0) return null;
      return nonWinners[0]._n; // already sorted ascending
    })();

    ul.innerHTML = numbered.map(g => {
      const isCorrect = g.distanceKm < 0.5;
      const isClosest = !isCorrect && g._n === closestId;
      const tier = warmthFor(g.distanceKm);
      const dir = isCorrect ? "🎯" : compassArrowFromBearing(g.bearingDeg);
      const dist = isCorrect ? "Correct!" : fmtKm(g.distanceKm);
      return `
        <li class="guess-item ${isCorrect ? "correct" : ""} ${isClosest ? "is-closest" : ""}"
            style="--warmth: ${tier.color}; --warmth-glow: ${tier.glow};">
          <span class="guess-num">${g._n}</span>
          <div class="guess-info">
            <div class="guess-name">${escapeHTML(g.name)}</div>
            <div class="guess-country">${escapeHTML(g.country)}</div>
          </div>
          <div class="guess-feedback">
            <span class="guess-arrow">${dir}</span>
            <span class="guess-distance">${escapeHTML(dist)}</span>
          </div>
        </li>`;
    }).join("");
  }

  function updateCounter() {
    const el = $("#guess-count");
    el.textContent = guesses.length;
    el.classList.add("bump");
    setTimeout(() => el.classList.remove("bump"), 250);
  }

  // ---------- Suggestions ----------
  function updateSuggestions(query) {
    const box = $("#guess-suggestions");
    if (!query || query.length < 1) { box.hidden = true; return; }
    const q = normName(query);
    if (!q) { box.hidden = true; return; }
    const used = new Set(guesses.map(g => `${normName(g.name)}|${normName(g.country)}`));

    // Score each city against (city, country, aliases). Lower = better.
    function score(c) {
      const cn = normName(c.city);
      const co = normName(c.country);
      const aliases = Array.isArray(c.aliases) ? c.aliases.map(normName) : [];

      if (cn === q) return 0;                                    // exact city
      if (aliases.includes(q)) return 1;                         // exact alias
      if (cn.startsWith(q)) return 2;                            // city prefix
      if (aliases.some(a => a.startsWith(q))) return 3;          // alias prefix
      if (co === q) return 4;                                    // exact country
      if (co.startsWith(q)) return 5;                            // country prefix
      if (cn.includes(q)) return 6;                              // city contains
      if (aliases.some(a => a.includes(q))) return 7;            // alias contains
      if (co.includes(q)) return 8;                              // country contains
      return 9;
    }

    const matches = capitals
      .map(c => ({ c, s: score(c) }))
      .filter(x => x.s < 9)
      .sort((a, b) => {
        if (a.s !== b.s) return a.s - b.s;
        if (a.c.isCapital !== b.c.isCapital) return a.c.isCapital ? -1 : 1;
        return a.c.city.localeCompare(b.c.city);
      })
      .map(x => x.c);
      // No slice — show every match. The dropdown is scrollable.

    if (matches.length === 0) {
      box.innerHTML = `<div class="suggestion-empty">No matching city. Try another spelling?</div>`;
      box.hidden = false;
      suggestionIdx = -1;
      return;
    }
    box.innerHTML = matches.map((c, i) => {
      const isUsed = used.has(`${normName(c.city)}|${normName(c.country)}`);
      const capStar = c.isCapital ? `<span class="suggestion-capital" title="capital city">★</span>` : "";
      return `<div class="suggestion ${isUsed ? "used" : ""}" data-name="${escapeHTML(c.city)}" data-country="${escapeHTML(c.country)}" data-i="${i}">
        <span class="suggestion-city">${escapeHTML(c.city)}${capStar}</span>
        <span class="suggestion-country">${escapeHTML(c.country)}</span>
      </div>`;
    }).join("");
    box.hidden = false;
    suggestionIdx = -1;
  }
  function highlightSuggestion(idx) {
    const items = $$(".suggestion:not(.used)");
    if (items.length === 0) return;
    suggestionIdx = (idx + items.length) % items.length;
    items.forEach((el, i) => el.classList.toggle("is-active", i === suggestionIdx));
    items[suggestionIdx]?.scrollIntoView({ block: "nearest" });
  }
  function pickHighlightedSuggestion() {
    const items = $$(".suggestion:not(.used)");
    if (suggestionIdx >= 0 && items[suggestionIdx]) {
      return { name: items[suggestionIdx].dataset.name, country: items[suggestionIdx].dataset.country };
    }
    if (items[0]) return { name: items[0].dataset.name, country: items[0].dataset.country };
    return null;
  }
  function hideSuggestions() {
    $("#guess-suggestions").hidden = true;
    suggestionIdx = -1;
  }

  // ---------- Submit guess ----------
  /** Strip diacritics (é → e, ñ → n, etc.) for forgiving matching from
   *  Latin-keyboard input. */
  function stripDiacritics(s) {
    return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  }

  /** Strong normalization for matching: lowercase, strip diacritics, strip
   *  apostrophes/dashes/punctuation, collapse whitespace. */
  function normName(s) {
    return stripDiacritics(String(s || ""))
      .toLowerCase()
      .replace(/[''`´]/g, "")
      .replace(/[-]/g, " ")
      .replace(/[^a-z0-9 ]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Check if a typed query matches a city's canonical name OR any alias. */
  function cityMatches(c, normalizedQuery) {
    if (normName(c.city) === normalizedQuery) return true;
    if (Array.isArray(c.aliases)) {
      for (const a of c.aliases) {
        if (normName(a) === normalizedQuery) return true;
      }
    }
    return false;
  }

  function findCapital(name) {
    const target = normName(name);
    if (!target) return null;

    // Exact "City, Country" match (e.g. "London, Canada", "sao paulo, brazil")
    const commaSplit = name.split(",").map(s => s.trim());
    if (commaSplit.length === 2) {
      const [cQ, coQ] = [normName(commaSplit[0]), normName(commaSplit[1])];
      const hit = capitals.find(x => cityMatches(x, cQ) && normName(x.country) === coQ);
      if (hit) return hit;
    }

    // City name (canonical or alias) matches
    const exact = capitals.filter(x => cityMatches(x, target));
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
      // Multiple matches → prefer capitals (more famous); return null otherwise
      // so the suggestion list can disambiguate.
      const cap = exact.find(x => x.isCapital);
      return cap || null;
    }
    return null;
  }

  function submitGuess(rawName, explicitCity = null) {
    if (gameOver) return;
    const cap = explicitCity || (() => {
      const name = (rawName ?? $("#guess-input").value).trim();
      if (!name) return null;
      const found = findCapital(name);
      if (found) return found;
      // Disambiguate
      const matches = capitals.filter(c => cityMatches(c, normName(name)));
      if (matches.length > 1) {
        toast(`Multiple cities matched "${name}" — pick one from the dropdown.`, true);
      } else {
        toast("Not a recognized city.", true);
      }
      return null;
    })();
    if (!cap) return;

    if (guesses.some(g => normName(g.name) === normName(cap.city) && normName(g.country) === normName(cap.country))) {
      toast("You already guessed that one.", true);
      return;
    }

    const km = haversine(cap.lat, cap.lon, answer.lat, answer.lon);
    const deg = screenBearing(cap.lat, cap.lon, answer.lat, answer.lon);
    const isCorrect = km < 0.5;
    const guess = {
      name: cap.city,
      country: cap.country,
      lat: cap.lat,
      lon: cap.lon,
      distanceKm: km,
      bearingDeg: deg,
    };
    guesses.push(guess);

    $("#guess-input").value = "";
    hideSuggestions();

    updateCounter();
    renderGuessList();
    updateProximityHud();
    dropPin(guess, isCorrect);

    if (isCorrect) {
      updateCompass(deg, "Found!", true);
      gameOver = true;
      saveProgress();
      onWin();
    } else {
      updateCompass(deg, compassNameFromBearing(deg) + " · " + fmtKm(km));
      saveProgress();
    }
  }

  // ---------- Win sequence ----------
  function onWin() {
    $("#guess-input").disabled = true;
    $("#guess-btn").disabled = true;

    // Stats: only update for daily mode, and only on the FRESH win (not when
    // we're replaying saved progress from localStorage on page load).
    let stats = loadStats();
    if (!isFreePlay && !isRestoring) {
      stats = recordWin(guesses.length);
    }

    // Populate modal
    $("#win-city").textContent = answer.city;
    $("#win-country").textContent = answer.country;
    $("#win-guess-count").textContent = guesses.length;
    $("#win-streak").textContent = isFreePlay ? "—" : stats.currentStreak;
    $("#win-played").textContent = isFreePlay ? "—" : stats.wins;

    renderShareGrid();

    // For free play, allow another round
    $("#play-again-btn").hidden = !isFreePlay;
    $("#win-next-hint").textContent = isFreePlay
      ? "Want another?"
      : "Come back tomorrow for a new citadel.";

    // On restore, show the modal but skip the confetti shower (already celebrated).
    setTimeout(() => {
      openModal("#win-modal");
      if (!isRestoring) runConfetti(2200);
    }, isRestoring ? 0 : 700);
  }

  function renderShareGrid() {
    // Build one row per guess: warmth tile + small dir arrow at end
    const rows = guesses.map(g => {
      if (g.distanceKm < 0.5) return "🟩 🎯";
      const tier = warmthFor(g.distanceKm);
      const dir = compassArrowFromBearing(g.bearingDeg);
      return `${tier.emoji} ${dir}`;
    });
    const grid = rows.map(r => `<div class="share-row">${r}</div>`).join("");
    $("#share-grid").innerHTML = grid;
  }

  function buildShareText() {
    const header = isFreePlay
      ? `Citadel · Free play · ${guesses.length} guess${guesses.length === 1 ? "" : "es"}`
      : `Citadel #${puzzleNum} · ${guesses.length} guess${guesses.length === 1 ? "" : "es"}`;
    const lines = guesses.map(g => {
      if (g.distanceKm < 0.5) return "🟩 🎯";
      return `${warmthFor(g.distanceKm).emoji} ${compassArrowFromBearing(g.bearingDeg)}`;
    });
    return [header, ...lines, "https://lateraolana.github.io/Citadel/"].join("\n");
  }

  async function shareResult() {
    const text = buildShareText();
    if (navigator.share) {
      try { await navigator.share({ text, title: "Citadel" }); return; } catch {}
    }
    // Fallback: copy to clipboard
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied result to clipboard!");
    } catch {
      toast("Couldn't share — long-press to copy.", true);
    }
  }

  // ---------- Confetti ----------
  function runConfetti(ms = 2000) {
    const canvas = $("#confetti");
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    canvas.style.width = innerWidth + "px";
    canvas.style.height = innerHeight + "px";
    ctx.scale(dpr, dpr);

    const colors = ["#ffd166", "#ef476f", "#06d6a0", "#fff8e7", "#ff5c8a", "#4a90e2"];
    const N = 140;
    const particles = [];
    for (let i = 0; i < N; i++) {
      particles.push({
        x: innerWidth / 2 + (Math.random() - .5) * 160,
        y: innerHeight / 2 - 40,
        vx: (Math.random() - .5) * 9,
        vy: -Math.random() * 11 - 6,
        ay: 0.32 + Math.random() * 0.08,
        size: 4 + Math.random() * 6,
        color: colors[Math.floor(Math.random() * colors.length)],
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - .5) * 0.3,
        shape: Math.random() < 0.5 ? "rect" : "circle",
      });
    }
    const start = performance.now();
    function frame(now) {
      const t = now - start;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      particles.forEach(p => {
        p.vy += p.ay;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = Math.max(0, 1 - t / ms);
        if (p.shape === "rect") {
          ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        } else {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      });
      if (t < ms) requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, innerWidth, innerHeight);
    }
    requestAnimationFrame(frame);
  }

  // ---------- Modals ----------
  function openModal(id) {
    $(id).hidden = false;
    document.body.classList.add("modal-open");
  }
  function closeModal(id) {
    $(id).hidden = true;
    if ($$(".modal:not([hidden])").length === 0) {
      document.body.classList.remove("modal-open");
    }
  }
  function bindModalClosers() {
    document.addEventListener("click", e => {
      const closer = e.target.closest("[data-close]");
      if (!closer) return;
      const m = closer.closest(".modal");
      if (m) {
        m.hidden = true;
        if ($$(".modal:not([hidden])").length === 0) {
          document.body.classList.remove("modal-open");
        }
      }
    });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        $$(".modal:not([hidden])").forEach(m => m.hidden = true);
        document.body.classList.remove("modal-open");
      }
    });
  }

  function refreshStatsModal() {
    const s = loadStats();
    $("#stats-played").textContent = s.played;
    $("#stats-wins").textContent = s.wins;
    $("#stats-streak").textContent = s.currentStreak;
    $("#stats-best").textContent = s.bestGuesses ?? "—";
    const avg = s.wins > 0 ? (s.totalGuesses / s.wins).toFixed(1) : "—";
    $("#stats-avg").textContent = avg;
  }

  /** Reset the map to a fresh state for a new game: remove all pins, polylines,
   *  and the citadel marker, but keep the base tile layer. */
  function resetMap() {
    pinMarkers.forEach(m => m.remove());
    pinMarkers = [];
    if (citadelMarker) { citadelMarker.remove(); citadelMarker = null; }
    if (connectorPolyline) { map.removeLayer(connectorPolyline); connectorPolyline = null; }
    // Remove any lingering polylines (great-circle arcs from past games)
    map.eachLayer(l => {
      if (l instanceof L.Polyline && !(l instanceof L.Rectangle)) map.removeLayer(l);
    });
    map.setView([20, 0], 2);
  }

  // ---------- Game lifecycle ----------
  function startDailyGame() {
    isFreePlay = false;
    puzzleNum = todaysPuzzleNumber();
    answer = pickDaily(puzzleNum, capitals);
    answerLatLng = [answer.lat, answer.lon];
    gameOver = false;
    guesses = [];
    resetMap();
    document.querySelector(".compass-ring")?.classList.remove("win");
    resetProximityHud();

    // Update header
    $("#puzzle-num").textContent = `Puzzle #${puzzleNum}`;
    $("#puzzle-date").textContent = fmtDate(new Date());
    $("#puzzle-mode-badge").hidden = true;

    // Restore progress if same puzzle was in progress
    const saved = loadProgress();
    if (saved && saved.puzzleNum === puzzleNum && Array.isArray(saved.guesses)) {
      isRestoring = true;
      try {
        saved.guesses.forEach(g => {
          if (typeof g === "string") {
            submitGuess(g);
          } else {
            const exact = capitals.find(c =>
              normName(c.city) === normName(g.name || "") &&
              normName(c.country) === normName(g.country || "")
            );
            if (exact) submitGuess(null, exact);
          }
        });
      } finally {
        isRestoring = false;
      }
    }

    renderGuessList();
    updateCounter();
    $("#guess-input").disabled = false;
    $("#guess-btn").disabled = false;
    $("#guess-input").focus();
  }

  function startFreePlay() {
    isFreePlay = true;
    answer = capitals[Math.floor(Math.random() * capitals.length)];
    answerLatLng = [answer.lat, answer.lon];
    gameOver = false;
    guesses = [];
    resetMap();
    document.querySelector(".compass-ring")?.classList.remove("win");
    resetProximityHud();

    $("#puzzle-num").textContent = `Free play`;
    $("#puzzle-date").textContent = "Random city";
    $("#puzzle-mode-badge").hidden = false;

    renderGuessList();
    updateCounter();
    $("#guess-input").disabled = false;
    $("#guess-btn").disabled = false;
    $("#guess-input").focus();
    toast("New random city — find it!");
  }

  // ---------- Boot ----------
  async function boot() {
    // City data is loaded via <script src="cities-data.js"> which assigns to window.CITY_DATA.
    // This works under both http:// and file:// (no fetch needed).
    if (Array.isArray(window.CITY_DATA) && window.CITY_DATA.length > 0) {
      capitals = window.CITY_DATA;
    } else {
      // Last-resort fallback: try fetch (only works under http://)
      try {
        const res = await fetch("cities.json", { cache: "no-store" });
        capitals = await res.json();
      } catch (e) {
        toast("Couldn't load city data. Make sure cities-data.js is in the same folder.", true);
        console.error("Cities not available:", e);
        return;
      }
    }

    setupMap();
    bindModalClosers();
    bindUI();

    // Show how-to on first visit
    if (!safeStorage.getItem("citadel:visited")) {
      openModal("#how-modal");
      safeStorage.setItem("citadel:visited", "1");
    }

    startDailyGame();
  }

  function bindUI() {
    const input = $("#guess-input");

    $("#guess-btn").addEventListener("click", () => submitGuess());
    input.addEventListener("input", () => updateSuggestions(input.value));
    input.addEventListener("focus", () => updateSuggestions(input.value));
    input.addEventListener("blur", () => setTimeout(hideSuggestions, 150));

    input.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault();
        const picked = pickHighlightedSuggestion();
        if (picked) {
          const exact = capitals.find(c =>
            normName(c.city) === normName(picked.name) &&
            normName(c.country) === normName(picked.country)
          );
          submitGuess(null, exact);
        } else {
          submitGuess(input.value);
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        highlightSuggestion(suggestionIdx + 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        highlightSuggestion(suggestionIdx - 1);
      } else if (e.key === "Escape") {
        hideSuggestions();
      }
    });

    $("#guess-suggestions").addEventListener("mousedown", e => {
      const item = e.target.closest(".suggestion");
      if (!item || item.classList.contains("used")) return;
      const exact = capitals.find(c =>
        normName(c.city) === normName(item.dataset.name) &&
        normName(c.country) === normName(item.dataset.country)
      );
      submitGuess(null, exact);
    });

    $("#how-btn").addEventListener("click", () => openModal("#how-modal"));
    $("#stats-btn").addEventListener("click", () => {
      refreshStatsModal();
      openModal("#stats-modal");
    });
    $("#share-btn").addEventListener("click", shareResult);
    $("#play-again-btn").addEventListener("click", () => {
      closeModal("#win-modal");
      startFreePlay();
    });

    $("#reset-stats-btn").addEventListener("click", () => {
      // Close stats modal first, then open the confirmation
      closeModal("#stats-modal");
      openModal("#reset-modal");
    });

    $("#reset-confirm-btn").addEventListener("click", () => {
      // Full reset: stats, today's progress, and visited-flag stay (so they
      // don't get the how-to popup again). Then restart today's puzzle so
      // they can play it from scratch.
      safeStorage.removeItem(STATS_KEY);
      safeStorage.removeItem(STORAGE_KEY);
      closeModal("#reset-modal");
      // Reset in-memory state and re-init the daily game (same answer city,
      // empty guess list, fresh stats).
      startDailyGame();
      toast("Everything reset. Same puzzle, fresh start.");
    });
  }

  function whenReady(cb) {
    // Wait for both DOM and Leaflet (and city data) to be available
    function check() {
      if (typeof L === "undefined") { setTimeout(check, 30); return; }
      cb();
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", check);
    } else {
      check();
    }
  }
  whenReady(boot);
})();
