/*
 * RV HUD WiFi Sniffer — diagnostic firmware, NOT the production bridge.
 *
 * Same wiring as rv_hud_bridge.ino. No hardware changes, no resoldering.
 * Powered from the buck converter off J1939 pin B exactly as normal — there is
 * no USB and no laptop involved, which is the whole point of this build.
 *
 * Mode: TWAI LISTEN-ONLY. It physically cannot transmit onto the coach bus.
 *
 * HOW TO USE AT THE COACH
 *   1. Plug the 9-pin in, key ON.
 *   2. On a phone or the tablet, join WiFi network  RV-HUD-SNIFF
 *      password: rvhudcan
 *   3. Browse to  http://192.168.4.1
 *
 * The page auto-refreshes twice a second and shows:
 *   - which bitrate locked (auto-scans 250k / 500k / 125k)
 *   - TWAI health: state, rx errors, bus errors, missed frames
 *   - every PGN seen, with source address, count, rate and last payload
 *   - the decoded gauge values, using the SAME offsets as rv_hud_bridge.ino
 *
 * That last part is the important one. If frames are flowing but a gauge value
 * is wrong, the wiring is fine and the decode offsets are the bug. If no frames
 * arrive at all, the histogram stays empty and the error counters tell us
 * whether anything is reaching the transceiver.
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include "driver/twai.h"

#define CAN_TX_PIN GPIO_NUM_21
#define CAN_RX_PIN GPIO_NUM_22
#define LED_PIN    2

#define AP_SSID "RV-HUD-SNIFF"
#define AP_PASS "rvhudcan"     // >= 8 chars, WPA2 requirement

#define SCAN_MS      5000
#define MAX_PGNS     48
#define RAW_RING     16

// ---------- J1939 PGNs (same set rv_hud_bridge.ino decodes) ----------
#define PGN_EEC1   61444
#define PGN_EEC2   61443
#define PGN_CCVS   65265
#define PGN_ET1    65262
#define PGN_EFLP1  65263
#define PGN_IC1    65270
#define PGN_TRF1   65272
#define PGN_VEP1   65271
#define PGN_LFE    65266
#define PGN_HOURS  65253

WebServer server(80);

typedef struct { const char *name; twai_timing_config_t timing; } BitrateOption;
static BitrateOption BITRATES[] = {
  {"250k", TWAI_TIMING_CONFIG_250KBITS()},
  {"500k", TWAI_TIMING_CONFIG_500KBITS()},
  {"125k", TWAI_TIMING_CONFIG_125KBITS()},
};
static const int NUM_BITRATES = sizeof(BITRATES) / sizeof(BITRATES[0]);

typedef struct {
  uint32_t pgn; uint8_t sa; uint32_t count;
  uint8_t dlc; uint8_t data[8]; uint32_t lastMs;
} PgnEntry;

static PgnEntry pgns[MAX_PGNS];
static int      pgnCount = 0;

typedef struct { uint32_t id; uint8_t dlc; uint8_t data[8]; uint32_t ms; } RawFrame;
static RawFrame rawRing[RAW_RING];
static int      rawHead = 0, rawFill = 0;

static uint32_t totalFrames = 0, framesPerSec = 0, lastRateFrames = 0, lastRateMs = 0;
static int      lockedIdx = -1, scanIdx = 0;
static uint32_t scanStartMs = 0;
static bool     driverUp = false;

// ---------- decoded values (same offsets as the bridge) ----------
typedef struct {
  float    rpm, speedKph, coolantC, oilKpa, boostKpa;
  float    intakeC, transC, battV, fuelLph, engineHours;
  uint8_t  throttlePct;
  bool     vRpm, vSpeed, vCool, vOil, vBoost, vIntake, vTrans, vBatt, vThr, vFuel, vHours;
} Decoded;
static Decoded dec;

static uint32_t j1939Pgn(uint32_t id) {
  uint32_t pgn = (id >> 8) & 0x3FFFF;
  if (((pgn >> 8) & 0xFF) < 240) pgn &= 0x3FF00;
  return pgn;
}
static inline uint16_t u16le(const uint8_t *d) { return (uint16_t)d[0] | ((uint16_t)d[1] << 8); }
static inline uint32_t u32le(const uint8_t *d) {
  return (uint32_t)d[0] | ((uint32_t)d[1] << 8) | ((uint32_t)d[2] << 16) | ((uint32_t)d[3] << 24);
}

static const char *pgnName(uint32_t p) {
  switch (p) {
    case PGN_EEC1:  return "EEC1 engine speed";
    case PGN_EEC2:  return "EEC2 throttle";
    case PGN_CCVS:  return "CCVS wheel speed";
    case PGN_ET1:   return "ET1 coolant temp";
    case PGN_EFLP1: return "EFL/P1 oil press";
    case PGN_IC1:   return "IC1 boost/intake";
    case PGN_TRF1:  return "TRF1 trans temp";
    case PGN_VEP1:  return "VEP1 battery";
    case PGN_LFE:   return "LFE fuel rate";
    case PGN_HOURS: return "HOURS engine hrs";
    default:        return "";
  }
}

static void decodeFrame(const twai_message_t &m) {
  if (!m.extd || m.data_length_code < 8) return;
  const uint8_t *d = m.data;
  switch (j1939Pgn(m.identifier)) {
    case PGN_EEC1:  { uint16_t r = u16le(&d[3]); if (r != 0xFFFF) { dec.rpm = r * 0.125f; dec.vRpm = true; } break; }
    case PGN_EEC2:  { if (d[1] != 0xFF) { dec.throttlePct = (uint8_t)(d[1] * 0.4f); dec.vThr = true; } break; }
    case PGN_CCVS:  { uint16_t r = u16le(&d[1]); if (r != 0xFFFF) { dec.speedKph = r / 256.0f; dec.vSpeed = true; } break; }
    case PGN_ET1:   { if (d[0] != 0xFF) { dec.coolantC = (int)d[0] - 40; dec.vCool = true; } break; }
    case PGN_EFLP1: { if (d[3] != 0xFF) { dec.oilKpa = d[3] * 4.0f; dec.vOil = true; } break; }
    case PGN_IC1:   { if (d[1] != 0xFF) { dec.boostKpa = d[1] * 2.0f; dec.vBoost = true; }
                      if (d[2] != 0xFF) { dec.intakeC = (int)d[2] - 40; dec.vIntake = true; } break; }
    case PGN_TRF1:  { uint16_t r = u16le(&d[4]); if (r != 0xFFFF) { dec.transC = r * 0.03125f - 273.0f; dec.vTrans = true; } break; }
    case PGN_VEP1:  { uint16_t r = u16le(&d[4]); if (r != 0xFFFF) { dec.battV = r * 0.05f; dec.vBatt = true; } break; }
    case PGN_LFE:   { uint16_t r = u16le(&d[0]); if (r != 0xFFFF) { dec.fuelLph = r * 0.05f; dec.vFuel = true; } break; }
    case PGN_HOURS: { uint32_t r = u32le(&d[0]); if (r != 0xFFFFFFFF) { dec.engineHours = r * 0.05f; dec.vHours = true; } break; }
    default: break;
  }
}

static void recordFrame(const twai_message_t &m) {
  totalFrames++;
  uint32_t now = millis();

  uint32_t pgn = m.extd ? j1939Pgn(m.identifier) : 0;
  uint8_t  sa  = m.extd ? (m.identifier & 0xFF) : 0;

  int slot = -1;
  for (int i = 0; i < pgnCount; i++) if (pgns[i].pgn == pgn && pgns[i].sa == sa) { slot = i; break; }
  if (slot < 0 && pgnCount < MAX_PGNS) { slot = pgnCount++; pgns[slot].pgn = pgn; pgns[slot].sa = sa; pgns[slot].count = 0; }
  if (slot >= 0) {
    pgns[slot].count++; pgns[slot].dlc = m.data_length_code;
    memcpy(pgns[slot].data, m.data, 8); pgns[slot].lastMs = now;
  }

  RawFrame &r = rawRing[rawHead];
  r.id = m.identifier; r.dlc = m.data_length_code; memcpy(r.data, m.data, 8); r.ms = now;
  rawHead = (rawHead + 1) % RAW_RING;
  if (rawFill < RAW_RING) rawFill++;

  decodeFrame(m);
}

static bool canStart(const twai_timing_config_t &timing) {
  twai_general_config_t g = TWAI_GENERAL_CONFIG_DEFAULT(CAN_TX_PIN, CAN_RX_PIN, TWAI_MODE_LISTEN_ONLY);
  g.rx_queue_len = 64;
  twai_timing_config_t t = timing;
  twai_filter_config_t f = TWAI_FILTER_CONFIG_ACCEPT_ALL();
  if (twai_driver_install(&g, &t, &f) != ESP_OK) return false;
  if (twai_start() != ESP_OK) { twai_driver_uninstall(); return false; }
  return true;
}
static void canStop() { twai_stop(); twai_driver_uninstall(); }

// ---------- JSON ----------
static String statusJson() {
  twai_status_info_t s; bool ok = (twai_get_status_info(&s) == ESP_OK);
  const char *st = "?";
  if (ok) switch (s.state) {
    case TWAI_STATE_STOPPED: st = "STOPPED"; break;
    case TWAI_STATE_RUNNING: st = "RUNNING"; break;
    case TWAI_STATE_BUS_OFF: st = "BUS_OFF"; break;
    case TWAI_STATE_RECOVERING: st = "RECOVERING"; break;
  }

  String j = "{";
  j += "\"locked\":"; j += (lockedIdx >= 0 ? "true" : "false");
  j += ",\"bitrate\":\""; j += (lockedIdx >= 0 ? BITRATES[lockedIdx].name : BITRATES[scanIdx].name); j += "\"";
  j += ",\"scanning\":"; j += (lockedIdx < 0 ? "true" : "false");
  j += ",\"total\":"; j += totalFrames;
  j += ",\"fps\":"; j += framesPerSec;
  j += ",\"uptime\":"; j += (millis() / 1000);
  j += ",\"state\":\""; j += st; j += "\"";
  if (ok) {
    j += ",\"rxErr\":"; j += s.rx_error_counter;
    j += ",\"busErr\":"; j += s.bus_error_count;
    j += ",\"rxMissed\":"; j += s.rx_missed_count;
  } else { j += ",\"rxErr\":0,\"busErr\":0,\"rxMissed\":0"; }

  j += ",\"dec\":{";
  j += "\"rpm\":";     if (dec.vRpm)    j += String(dec.rpm, 0);          else j += "null";
  j += ",\"mph\":";    if (dec.vSpeed)  j += String(dec.speedKph / 1.60934f, 1); else j += "null";
  j += ",\"coolF\":";  if (dec.vCool)   j += String(dec.coolantC * 9 / 5 + 32, 0); else j += "null";
  j += ",\"oilPsi\":"; if (dec.vOil)    j += String(dec.oilKpa * 0.145038f, 1); else j += "null";
  j += ",\"boostPsi\":";if (dec.vBoost) j += String(dec.boostKpa * 0.145038f, 1); else j += "null";
  j += ",\"intakeF\":";if (dec.vIntake) j += String(dec.intakeC * 9 / 5 + 32, 0); else j += "null";
  j += ",\"transF\":"; if (dec.vTrans)  j += String(dec.transC * 9 / 5 + 32, 0); else j += "null";
  j += ",\"volts\":";  if (dec.vBatt)   j += String(dec.battV, 1);        else j += "null";
  j += ",\"thr\":";    if (dec.vThr)    j += String(dec.throttlePct);     else j += "null";
  j += ",\"gph\":";    if (dec.vFuel)   j += String(dec.fuelLph / 3.785412f, 1); else j += "null";
  j += ",\"hours\":";  if (dec.vHours)  j += String(dec.engineHours, 1);  else j += "null";
  j += "}";

  uint32_t now = millis();
  j += ",\"pgns\":[";
  for (int i = 0; i < pgnCount; i++) {
    if (i) j += ",";
    j += "{\"pgn\":"; j += pgns[i].pgn;
    j += ",\"sa\":";  j += pgns[i].sa;
    j += ",\"n\":";   j += pgns[i].count;
    j += ",\"age\":"; j += (now - pgns[i].lastMs);
    j += ",\"name\":\""; j += pgnName(pgns[i].pgn); j += "\"";
    j += ",\"data\":\"";
    for (int b = 0; b < pgns[i].dlc; b++) { char t[4]; sprintf(t, "%02X", pgns[i].data[b]); j += t; if (b < pgns[i].dlc - 1) j += " "; }
    j += "\"}";
  }
  j += "]";

  j += ",\"raw\":[";
  for (int k = 0; k < rawFill; k++) {
    int idx = (rawHead - 1 - k + RAW_RING * 2) % RAW_RING;
    if (k) j += ",";
    char t[16]; sprintf(t, "%08X", (unsigned)rawRing[idx].id);
    j += "{\"id\":\""; j += t; j += "\",\"data\":\"";
    for (int b = 0; b < rawRing[idx].dlc; b++) { char h[4]; sprintf(h, "%02X", rawRing[idx].data[b]); j += h; if (b < rawRing[idx].dlc - 1) j += " "; }
    j += "\"}";
  }
  j += "]}";
  return j;
}

static const char PAGE[] PROGMEM = R"PAGE(<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RV HUD Sniffer</title><style>
*{box-sizing:border-box}body{margin:0;padding:12px;background:#12151a;color:#e6edf3;
font:13px/1.45 ui-monospace,Menlo,Consolas,monospace}
h1{font-size:15px;margin:0 0 10px;letter-spacing:.06em;color:#8fb6ff}
.card{background:#1a1f27;border:1px solid #2a313c;border-radius:8px;padding:10px;margin-bottom:10px}
.row{display:flex;flex-wrap:wrap;gap:6px 16px}
.kv{white-space:nowrap}.k{color:#8b98a8}.v{color:#e6edf3;font-weight:600}
.ok{color:#3fb950}.warn{color:#d29922}.bad{color:#f85149}
table{width:100%;border-collapse:collapse;font-size:12px;min-width:600px}
th,td{text-align:left;padding:3px 6px;border-bottom:1px solid #262c36;white-space:nowrap}
th{color:#8b98a8;font-weight:600}
td.n{text-align:right}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:6px}
.gauge{background:#141920;border:1px solid #262c36;border-radius:6px;padding:6px}
.gauge .lbl{color:#8b98a8;font-size:11px}.gauge .val{font-size:17px;font-weight:700}
.na{color:#4d5566}.scroll{overflow-x:auto}
</style></head><body>
<h1>RV HUD SNIFFER</h1>
<div class="card"><div class="row" id="hdr"></div></div>
<div class="card"><div class="k" style="margin-bottom:6px">DECODED (same offsets as rv_hud_bridge.ino)</div><div class="g" id="gauges"></div></div>
<div class="card"><div class="k" style="margin-bottom:6px">PGNs SEEN</div><div class="scroll"><table id="pgns"><thead><tr><th>PGN</th><th>hex</th><th>SA</th><th class="n">count</th><th class="n">age</th><th>name</th><th>last payload</th></tr></thead><tbody></tbody></table></div></div>
<div class="card"><div class="k" style="margin-bottom:6px">RECENT RAW FRAMES</div><div class="scroll"><table id="raw"><thead><tr><th>29-bit ID</th><th>data</th></tr></thead><tbody></tbody></table></div></div>
<script>
const G=[["rpm","RPM",""],["mph","SPEED","mph"],["coolF","COOLANT","F"],["oilPsi","OIL","psi"],
["boostPsi","BOOST","psi"],["intakeF","INTAKE","F"],["transF","TRANS","F"],["volts","VOLTS","V"],
["thr","THROTTLE","%"],["gph","FUEL","gph"],["hours","HOURS","h"]];
function esc(s){return String(s).replace(/[<>&]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;"}[c]))}
async function tick(){
 let d; try{d=await (await fetch("/data",{cache:"no-store"})).json()}catch(e){return}
 const lockCls=d.locked?"ok":"warn";
 const errCls=d.busErr>0?"bad":"ok";
 document.getElementById("hdr").innerHTML=
  `<span class="kv"><span class="k">bus </span><span class="v ${lockCls}">${d.locked?d.bitrate+" LOCKED":"scanning "+d.bitrate}</span></span>`+
  `<span class="kv"><span class="k">state </span><span class="v">${esc(d.state)}</span></span>`+
  `<span class="kv"><span class="k">frames </span><span class="v">${d.total}</span></span>`+
  `<span class="kv"><span class="k">rate </span><span class="v">${d.fps}/s</span></span>`+
  `<span class="kv"><span class="k">rxErr </span><span class="v">${d.rxErr}</span></span>`+
  `<span class="kv"><span class="k">busErr </span><span class="v ${errCls}">${d.busErr}</span></span>`+
  `<span class="kv"><span class="k">missed </span><span class="v">${d.rxMissed}</span></span>`+
  `<span class="kv"><span class="k">up </span><span class="v">${d.uptime}s</span></span>`;
 document.getElementById("gauges").innerHTML=G.map(([k,l,u])=>{
  const v=d.dec[k];
  return `<div class="gauge"><div class="lbl">${l}</div><div class="val ${v===null?"na":""}">${v===null?"--":v}<span class="lbl"> ${u}</span></div></div>`}).join("");
 document.querySelector("#pgns tbody").innerHTML=d.pgns.length?d.pgns.map(p=>
  `<tr><td>${p.pgn}</td><td>0x${p.pgn.toString(16).toUpperCase()}</td><td>${p.sa}</td><td class="n">${p.n}</td><td class="n">${p.age}ms</td><td>${esc(p.name)}</td><td>${esc(p.data)}</td></tr>`).join("")
  :`<tr><td colspan="7" class="na">no frames yet</td></tr>`;
 document.querySelector("#raw tbody").innerHTML=d.raw.length?d.raw.map(r=>
  `<tr><td>0x${esc(r.id)}</td><td>${esc(r.data)}</td></tr>`).join("")
  :`<tr><td colspan="2" class="na">no frames yet</td></tr>`;
}
tick();setInterval(tick,500);
</script></body></html>)PAGE";

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  delay(400);

  memset(&dec, 0, sizeof(dec));

  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASS);
  Serial.println();
  Serial.println("=== RV HUD WiFi Sniffer (listen-only) ===");
  Serial.printf("AP SSID: %s   pass: %s\n", AP_SSID, AP_PASS);
  Serial.print("Open: http://"); Serial.println(WiFi.softAPIP());

  server.on("/", []() { server.send_P(200, "text/html", PAGE); });
  server.on("/data", []() {
    server.sendHeader("Cache-Control", "no-store");
    server.send(200, "application/json", statusJson());
  });
  server.onNotFound([]() { server.sendHeader("Location", "/"); server.send(302, "text/plain", ""); });
  server.begin();

  scanStartMs = millis();
  driverUp = canStart(BITRATES[scanIdx].timing);
  lastRateMs = millis();
}

void loop() {
  server.handleClient();

  uint32_t now = millis();

  if (driverUp) {
    twai_message_t m;
    while (twai_receive(&m, 0) == ESP_OK) {
      recordFrame(m);
      if (lockedIdx < 0) { lockedIdx = scanIdx; Serial.printf("[LOCK] %s\n", BITRATES[scanIdx].name); }
    }
  }

  // Non-blocking bitrate scan so the web server stays responsive.
  if (lockedIdx < 0 && now - scanStartMs >= SCAN_MS) {
    if (driverUp) canStop();
    scanIdx = (scanIdx + 1) % NUM_BITRATES;
    driverUp = canStart(BITRATES[scanIdx].timing);
    scanStartMs = now;
    Serial.printf("[SCAN] trying %s\n", BITRATES[scanIdx].name);
  }

  if (now - lastRateMs >= 1000) {
    framesPerSec  = totalFrames - lastRateFrames;
    lastRateFrames = totalFrames;
    lastRateMs    = now;
    digitalWrite(LED_PIN, framesPerSec > 0);
  }
}
