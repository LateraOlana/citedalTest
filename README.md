# 🏰 Citadel · A daily city game

A geography game inspired by Wordle and Globle. Each day, one of 592 well-known world cities (197 capitals + 395 major cities) is hidden. Guess any city, see how far away it is, get a compass arrow and a "warmth" pin on the world map, with the warmest guess crowned with a gold ★. Keep guessing until you find it.

## Files

- `index.html` — markup
- `styles.css` — atmospheric night-sky theme
- `app.js` — game logic, map, animations, stats
- `cities-data.js` — embedded city data (loaded as a `<script>`, works under `file://`)
- `cities.json` — same data as JSON, kept as the editable source of truth

## Just open `index.html`

The app loads its data via a `<script>` tag, not `fetch()`, so **double-clicking `index.html` works** — no local server required.

For the smoothest experience and cross-tab persistence, host on GitHub Pages or run a local server:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## How it works

- A deterministic seed picks the **same city for every player on the same UTC day**, like Wordle.
- The map uses **Leaflet** + free CartoDB dark tiles, **with no labels** — no city or country names visible on the map, so the answer can't be read off the geography.
- Distance is **haversine** (great-circle, the truthful "as the crow flies" distance).
- Direction is computed in **map-frame** pixel space, not great-circle bearing — so the arrow always points where the answer would *appear* on the flat map. (Great-circle bearings can feel wrong on Mercator: e.g. Anchorage→Tokyo is "due west" geographically, but visually appears southwest.)
- Pins are color-coded by warmth:
  - **Scorching** (under 100 km) → red
  - **Hot** (under 500 km) → coral
  - **Warm** (under 1500 km) → gold
  - **Cool** (under 4000 km) → slate blue
  - **Cold** (further) → ice blue
- The **closest guess** so far gets a gold ★ crown above its pin and a gold-edged glow, making it easy to remember which guess to think outward from.
- Capital cities show a ★ in the autocomplete to flag them as more famous answers.
- All progress and stats are stored in your browser's `localStorage` (with an in-memory fallback for `file://` in browsers that disable it).

## Latin-keyboard friendly

Every city accepts Latin/ASCII variants. You can type:

- `Sao Paulo` for São Paulo
- `Reykjavik` for Reykjavík
- `Yaounde` for Yaoundé
- `Ndjamena` for N'Djamena
- `Munchen` for München (Munich)
- `Cote d'Ivoire` or `Cote divoire`

Plus historical / colloquial alternates:

- `Bombay` → Mumbai · `Calcutta` → Kolkata · `Madras` → Chennai · `Bangalore` → Bengaluru
- `Saigon` → Ho Chi Minh City · `Rangoon` → Yangon · `Peking` → Beijing
- `Leningrad` / `St Petersburg` → Saint Petersburg · `Kiev` → Kyiv · `Bucuresti` → Bucharest
- `Wien` → Vienna · `Roma` → Rome · `Lisboa` → Lisbon · `Praha` → Prague
- `Swaziland` → Eswatini · `Macedonia` → North Macedonia · `Cote d'Ivoire` → Ivory Coast

The autocomplete surfaces aliases too — typing `bomb` brings up Mumbai, `leningrad` brings up Saint Petersburg.

## Disambiguating cities with the same name

Some cities share names: London (UK / Canada), Valencia (Spain / Venezuela), Córdoba (Argentina / Spain), Victoria (Seychelles / Canada). Two ways to disambiguate:

1. **Use the autocomplete dropdown** — both cities appear; pick the one you want.
2. **Type "City, Country"** — e.g. `London, Canada` resolves uniquely.

Plain `London` defaults to London, UK (since it's a capital, marked ★).

## Hosting on GitHub Pages

1. Push these five files to a repo (e.g. `citadel`).
2. Repo → **Settings** → **Pages** → set source to `main` branch, root folder.
3. Visit `https://<your-username>.github.io/citadel/`.

## Modes

- **Daily** — one puzzle per UTC day, shared by all players. Updates streaks and stats.
- **Free play** — random city. Tap the ↻ icon in the header. Doesn't affect stats.

## Sharing

After a win, click **Share result**. On mobile, the system share sheet opens; on desktop, the result is copied to your clipboard. The share format mirrors Wordle:

```
Citadel #14 · 5 guesses
🟦 ↗
🟨 ↖
🟧 ↑
🟥 ←
🟩 🎯
```

## Customization

- **Colors**: edit the CSS variables at the top of `styles.css` — `--gold`, `--coral`, the warmth tier colors, etc.
- **Warmth tiers**: edit `WARMTH_TIERS` in `app.js`.
- **Add/remove cities**: edit `cities.json`. To regenerate `cities-data.js`:
  ```bash
  node -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync("cities.json"));fs.writeFileSync("cities-data.js","window.CITY_DATA = "+JSON.stringify(c)+";\n")'
  ```
- **Add aliases for a city**: edit the city's `aliases` array in `cities.json` (an array of lowercase Latin strings), then regenerate as above.
- **Change puzzle epoch** (when puzzle #1 = which date): edit `PUZZLE_EPOCH` in `app.js`.

## Keyboard

- `Enter` — submit guess (auto-completes from the suggestion list)
- `↑`/`↓` — navigate suggestions
- `Esc` — close modal / dismiss suggestions

## Credits

- Map tiles © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors · © [CARTO](https://carto.com/attributions)
- Built with [Leaflet](https://leafletjs.com/)
- Type: **Fraunces** (display) + **Inter** (body) + **JetBrains Mono** (numbers)
