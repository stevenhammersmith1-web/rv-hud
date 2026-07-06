# RV HUD

A heads-up engine display for a 2005 Winnebago Journey 39K (Caterpillar C7 350 /
Allison / Freightliner XC). It runs as an offline-capable PWA on a tablet in the
coach and shows live engine data read from the J1939 bus — or a built-in
simulator when no bridge is connected.

**Live:** https://stevenhammersmith1-web.github.io/rv-hud/

---

## How the pieces fit together

This repo contains **two halves of one Bluetooth link**, written for two
different devices. They are not interchangeable — one broadcasts, one receives.

```
  Coach J1939 CAN bus
          │  (250 kbps, listen-only)
          ▼
  ┌─────────────────┐   BLE notify, 4 Hz    ┌──────────────────────┐
  │   ESP32 bridge  │  ── 25-byte packet ─► │  Tablet (Chrome PWA) │
  │ rv_hud_bridge.ino│                       │  rv_dashboard.jsx    │
  └─────────────────┘                       │  bridgeConnection.jsx│
                                             └──────────────────────┘
```

| File | Runs on | Language | Role |
|------|---------|----------|------|
| `rv_hud_bridge.ino` | ESP32 DevKitC + SN65HVD230 | Arduino C++ | Reads CAN, **broadcasts** the packet over BLE |
| `bridgeConnection.jsx` | Tablet browser | JavaScript (React hook) | **Receives** & parses the packet |
| `rv_dashboard.jsx` | Tablet browser | JavaScript (React) | Renders gauges, trips, alerts |

`bridgeConnection.jsx` is **browser code — it does not get flashed to the ESP32.**
The only thing both sides must agree on is the BLE contract below.

---

## BLE contract (must match on both sides)

- **Device name:** `RV-HUD-Bridge`
- **Service UUID:** `8e7c1a20-4f0d-4c9b-9a3e-5b1f2d6e8a01`
- **Characteristic UUID:** `8e7c1a21-4f0d-4c9b-9a3e-5b1f2d6e8a01`
- **Packet:** 25-byte packed little-endian struct, version `1`, notified at 4 Hz.
  `0xFFFF` / `0x7FFF` / `0xFF` / `0xFFFFFFFF` mean "not available yet" and render
  as `--` on the gauges.

| Offset | Type   | Field            | Units sent            |
|-------:|--------|------------------|-----------------------|
| 0      | u8     | version          | = 1                   |
| 1      | u8     | canAlive         | 1 = frame seen < 2 s  |
| 2      | u16    | rpm              | rpm                   |
| 4      | u16    | speedKphX100     | km/h × 100            |
| 6      | i16    | coolantCX10      | °C × 10               |
| 8      | u16    | oilKpa           | kPa                   |
| 10     | u16    | boostKpa         | kPa                   |
| 12     | i16    | intakeCX10       | °C × 10               |
| 14     | i16    | transCX10        | °C × 10               |
| 16     | u16    | battMv           | millivolts            |
| 18     | u8     | throttlePct      | %                     |
| 19     | u16    | fuelLphX100      | L/h × 100             |
| 21     | u32    | engineHoursX20   | hours × 20            |

The dashboard converts these to the display units it already uses (mph, °F, psi,
gph, V) in `mapBridgeData()` — no display/conversion logic was changed to add the
bridge. When connected, live data drives the gauges, the trip computer, and the
coolant audio alarm; the simulator is the automatic fallback the moment the link
drops.

---

## Develop

```bash
npm install
npm run dev        # http://localhost:5173  — starts on the simulator
```

The simulator is always available (the "DEMO CONTROLS" strip at the bottom:
auto-drive, manual sliders, "heat it up" to test the alarm, sim-speed multiplier).
It stays fully intact even when a bridge is connected — live data simply takes
over while the pill shows "Live".

## Build & deploy

Deployment is automatic. **Any push to `main`** triggers the GitHub Actions
workflow (`.github/workflows/deploy.yml`), which builds and publishes to GitHub
Pages over HTTPS (required for Web Bluetooth):

```bash
git add -A
git commit -m "your change"
git push
```

Watch it: the repo's **Actions** tab, or `gh run watch`. Live ~1 minute later.

Local production build:

```bash
npm run build      # runs gen:icons, then vite build -> dist/
npm run preview
```

The base path (`/rv-hud/` on Pages) is set automatically by CI from the repo
name via `VITE_BASE`. For a root host (Netlify, user/org Pages) it defaults to
`/`.

### Icons

`scripts/gen-icons.mjs` generates the full PWA icon set (a gauge-ring motif) with
no external dependencies — it runs as part of `npm run build`.

---

## Flash the ESP32

Open `rv_hud_bridge.ino` in the Arduino IDE with the ESP32 board package.
Wiring and pin assignments are documented in the file header.

- `#define DEMO_MODE 0` — reads the real CAN bus (normal operation).
- `#define DEMO_MODE 1` — broadcasts fabricated engine data for bench-testing the
  tablet link away from the coach. Reflash to switch.

The bus is read **listen-only** — the device physically cannot transmit onto the
coach's CAN bus.

---

## Tablet setup (Android + Chrome)

Web Bluetooth is a **Chrome / Edge / Chromium** feature. It is **not supported on
iPhone or iPad** in any browser — the simulator still runs there, but the ESP32
link will not connect. Use an Android tablet.

1. Open the live URL in Chrome.
2. Enable once, for silent auto-reconnect on ignition:
   `chrome://flags/#enable-web-bluetooth-new-permissions-backend` → **Enabled** →
   relaunch Chrome.
3. Chrome menu → **Add to Home screen** to install the fullscreen PWA (launches
   offline after the first load — the service worker caches the app shell).
4. First pairing needs one tap on the status pill (a browser security rule).
   After that it silently reconnects whenever the ESP32 powers up.
