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
| `rv_hud_sniffer.ino` | ESP32 (temporary) | Arduino C++ | Diagnostic: what is actually on the bus (serial) |
| `rv_hud_wifi_sniffer.ino` | ESP32 (temporary) | Arduino C++ | Same, served over its own WiFi AP — no laptop needed |
| `rv_hud_selftest.ino` | ESP32 (bench only) | Arduino C++ | Diagnostic: is the transceiver wired & alive |

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

## Diagnosing "no live data"

The bridge's serial console (115200 baud) prints a `[STATUS]` heartbeat every
2 s. Two counters separate the failure modes:

- `bus=` — every frame the CAN controller accepted, before any filtering
- `decoded=` — only frames matching a PGN in `decodeFrame()`

| Symptom | Meaning |
|---------|---------|
| `bus=0`, `busErr=0` | Nothing on the wire. Connector, key off, or bad wiring. |
| `bus=0`, `busErr` climbing | Wire is live but misread — wrong bitrate, or CANH/CANL swapped. |
| `bus>0`, `decoded=0` | **Wiring is fine.** The PGNs or byte offsets are wrong. Check `lastUnknownPgn=`. |
| `ble=advertising` forever | Tablet never linked. A CAN fix won't help; debug the BLE half. |

### `rv_hud_sniffer.ino` — what's actually on the bus

Listen-only, safe on a live coach bus. Auto-scans 250k/500k/125k, locks onto
whichever sees traffic, then prints raw frames (full 29-bit ID, priority, PGN,
source address, payload) and a running PGN histogram. Use this to learn what the
engine really broadcasts and to verify the decode offsets by hand.

### `rv_hud_wifi_sniffer.ino` — same, without a laptop

The bridge is powered from the buck converter off J1939 pin B, and USB must
never be plugged in at the same time (two supplies on the same 5 V rail). That
makes a serial console at the coach awkward, so this build serves the same
diagnostic over its own WiFi access point instead. No wiring changes.

1. Plug the 9-pin in, key ON.
2. Join WiFi **`RV-HUD-SNIFF`**, password **`rvhudcan`**.
3. Open **http://192.168.4.1** on a phone or the tablet.

Auto-refreshes twice a second: lock state and bitrate, TWAI health, every PGN
with source address / count / age / payload, the last 16 raw frames, and the
decoded gauge values using the same offsets as `rv_hud_bridge.ino`. Frames
flowing but a gauge reading wrong means the offsets are the bug, not the wiring.

### `rv_hud_selftest.ino` — is the bridge hardware good

> ⚠️ **Bench only. This firmware TRANSMITS.** Never run it while the 9-pin is
> plugged into the coach.

Three checks, no CAN bus required:

1. **RX drive** — is the transceiver powered and out of standby (does it hold
   GPIO22 high against an internal pulldown)?
2. **Static driver** — bit-bangs CTX and watches CRX. A clean dominant readback
   proves GPIO21→CTX, CRX→GPIO22, and that `Rs` (pin 8) is tied low.
3. **TWAI loopback** — transmits at 250k with self-reception.

On an unterminated bench the static test passes while the loopback fails, and
recessive reads well under 100% — that is expected, not a fault. Add a 120 Ω
resistor across CANH/CANL to make it pass.

### Web Bluetooth needs a secure context

`http://<lan-ip>:5173` will **not** work — `navigator.bluetooth` is undefined on
plain-HTTP origins. Use `localhost` on the dev machine, or the HTTPS Pages URL
on the tablet.

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
