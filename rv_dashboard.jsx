import React, { useState, useEffect, useRef, useCallback, useContext, createContext } from "react";
import { Volume2, VolumeX, BellOff, Play, Pause, Sliders, Flame, RotateCcw,
  ChevronUp, ChevronDown, Gauge, Route, FastForward, Settings as SettingsIcon,
  X, Sun, Moon, Clock, LayoutGrid, Palette,
  Pencil, Plus, Trash2, Check, Lock, User, Thermometer } from "lucide-react";
import { useBridgeConnection, BridgeStatus } from "./bridgeConnection";

/* ============================================================================
   RV DASHBOARD — Phases 1-3+
   2005 Winnebago Journey 39K · Caterpillar C7 350hp · Allison · Freightliner
   cluster + demo sim + coolant alert + trips + theming/units + LAYOUT THEMES
   + danger-flash + persisted settings.
============================================================================ */

/* --------------------------------- config -------------------------------- */
const CONFIG = {
  gauges: {
    // Cat C7 ACERT 350hp: rated/governed speed 2400 rpm = factory redline.
    rpm:     { min: 0,   max: 2800, warn: 2300, crit: 2400, redline: 2400, label: "ENGINE",   unit: "RPM" },
    coolant: { min: 120, max: 250,  warn: 215,  crit: 225,  label: "COOLANT",  unit: "°F", temp: true },
    // Cat C7 oil pressure: ~45 psi mid-rpm, idle minimum ~6 psi. Warn early,
    // flash red only below the factory idle floor.
    oil:     { min: 0,   max: 80,   warnBelow: 12, critBelow: 6, label: "OIL PRESS", unit: "PSI", invert: true },
  },
  // additional J1939 channels the C7 ECM exposes — assignable to any slot
  channels: {
    boost:    { label: "BOOST",      unit: "psi", min: 0,   max: 35 },
    // Allison 3000MH: up to ~220°F normal on grades, 250°F max sump temp.
    trans:    { label: "TRANS TEMP", unit: "°F",  min: 120, max: 260, warn: 240, crit: 250, temp: true },
    // 12V chassis: healthy charge 13.5-14.8V. Low = discharge/no-charge;
    // high (warn/crit) = voltage-regulator overcharge cooking the batteries.
    volts:    { label: "BATTERY",    unit: "V",   min: 10,  max: 15,  warnBelow: 12.2, critBelow: 11.6, warn: 15.0, crit: 15.5 },
    // Intake manifold air temp: hot on grades even when healthy, so warn/crit
    // sit at derate-territory numbers to avoid nuisance beeps on hot-day climbs.
    intake:   { label: "INTAKE AIR", unit: "°F",  min: 40,  max: 220, warn: 170, crit: 190, temp: true },
    throttle: { label: "THROTTLE",   unit: "%",   min: 0,   max: 100 },
    fuelrate: { label: "FUEL RATE",  unit: "gph", min: 0,   max: 20 },
    hours:    { label: "ENGINE HRS", unit: "h" },
  },
  alert: { warnTemp: 220, critTemp: 225, resetTemp: 218, persistMs: 60000 },
  trip:  { rollWindowMi: 100, binSizeMi: 0.5 },
};
const TRIPS_KEY = "rvdash:trips:v1";
const SETTINGS_KEY = "rvdash:settings:v1";
const PROFILES_KEY = "rvdash:profiles:v1";
const CUSTOM_KEY = "rvdash:custom:v1";

/* -------------------------------- palettes ------------------------------- */
const PRESETS = {
  "Shimmer Blue": { accent:"#38BDF8", accentDeep:"#1D4ED8", accentBright:"#93E0FF", text:"#EAF2FF", dim:"#57688A", warn:"#FBBF24", crit:"#FB4A63", critDeep:"#7F1D2E", bg0:"#060A12", bg1:"#0B1322" },
  "Classic Amber":{ accent:"#F5A623", accentDeep:"#B45309", accentBright:"#FDE68A", text:"#FFF4E0", dim:"#7C6A48", warn:"#FB923C", crit:"#EF4444", critDeep:"#7F1D1D", bg0:"#0A0803", bg1:"#171106" },
  "Mono White":   { accent:"#DCE6F2", accentDeep:"#8394AC", accentBright:"#FFFFFF", text:"#FFFFFF", dim:"#647389", warn:"#FBBF24", crit:"#FB4A63", critDeep:"#7F1D2E", bg0:"#05070A", bg1:"#0E1219" },
  "Night Red":    { accent:"#FF5555", accentDeep:"#7F1D1D", accentBright:"#FF9A9A", text:"#FFDCDC", dim:"#8A5252", warn:"#FF9A3D", crit:"#FF3355", critDeep:"#5C0F16", bg0:"#000000", bg1:"#0A0202" },
};
const NIGHT_RED = PRESETS["Night Red"];

const LAYOUTS = {
  classic:    { label: "Classic",    desc: "Coolant + oil left, big speed center, RPM right" },
  speedFocus: { label: "Speed Focus", desc: "Huge speed, engine gauges shrunk to a top strip" },
  quad:       { label: "Four Corner", desc: "Speed center, four ring gauges in the corners" },
  tech:       { label: "Technician",  desc: "Dense — a readout for every ECM channel" },
  custom:     { label: "Custom",      desc: "Your own arrangement — drag & resize on screen" },
};

// grid resolution for the custom layout editor
const GRID_COLS = 12, GRID_ROWS = 8;
const DEFAULT_WIDGETS = [
  { id: "w-cool",  source: "coolant", style: "arc",     x: 0, y: 0, w: 3, h: 4 },
  { id: "w-oil",   source: "oil",     style: "arc",     x: 0, y: 4, w: 3, h: 4 },
  { id: "w-speed", source: "speed",   style: "digital", x: 3, y: 2, w: 6, h: 4 },
  { id: "w-rpm",   source: "rpm",     style: "arc",     x: 9, y: 2, w: 3, h: 4 },
];
// first open grid cell that fits a w×h widget (so "Add" never hides behind another)
function freeSpot(ws, w, h) {
  const hit = (x, y) => ws.some((g) => x < g.x + g.w && x + w > g.x && y < g.y + g.h && y + h > g.y);
  for (let y = 0; y <= GRID_ROWS - h; y++)
    for (let x = 0; x <= GRID_COLS - w; x++)
      if (!hit(x, y)) return { x, y };
  return { x: 0, y: 0 };
}

const DEFAULT_SETTINGS = {
  themeName: "Shimmer Blue", ...PRESETS["Shimmer Blue"],
  layout: "classic", widgets: DEFAULT_WIDGETS,
  bg: "deep", speedUnit: "mph", tempUnit: "F", dayNight: "day", nightRedShift: true,
};

const ThemeCtx = createContext({ T: PRESETS["Shimmer Blue"], S: DEFAULT_SETTINGS });
const useUI = () => useContext(ThemeCtx);

/* ------------------------------ color utils ------------------------------ */
function shade(hex, pct) {
  const n = parseInt(hex.slice(1), 16); let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const t = pct < 0 ? 0 : 255, p = Math.abs(pct);
  r = Math.round((t - r) * p) + r; g = Math.round((t - g) * p) + g; b = Math.round((t - b) * p) + b;
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}
const isNightNow = () => { const h = new Date().getHours(); return h < 6 || h >= 20; };
const effectiveNight = (s) => s.dayNight === "night" || (s.dayNight === "auto" && isNightNow());
function computeTheme(s, night) {
  let p = { accent:s.accent, accentDeep:s.accentDeep, accentBright:s.accentBright, text:s.text, dim:s.dim, warn:s.warn, crit:s.crit, critDeep:s.critDeep, bg0:s.bg0, bg1:s.bg1 };
  let bgMode = s.bg;
  if (night && s.nightRedShift) { p = { ...NIGHT_RED }; bgMode = "black"; }
  const bg = bgMode === "black" ? "#000000" : bgMode === "charcoal" ? "#0E1116"
    : `radial-gradient(120% 120% at 50% 0%, ${p.bg1} 0%, ${p.bg0} 70%)`;
  return { ...p, bg };
}

/* ------------------------------ zone helper ------------------------------ */
function zoneOf(cfg, v) {
  if (cfg.invert) { if (v <= cfg.critBelow) return "crit"; if (v <= cfg.warnBelow) return "warn"; return "normal"; }
  if (cfg.crit != null && v >= cfg.crit) return "crit";
  if (cfg.warn != null && v >= cfg.warn) return "warn";
  if (cfg.critBelow != null && v <= cfg.critBelow) return "crit";
  if (cfg.warnBelow != null && v <= cfg.warnBelow) return "warn";
  return "normal";
}

/* ------------------------------ unit helpers ----------------------------- */
const spd = (mph, u) => (u === "kph" ? mph * 1.60934 : mph);
const spdLabel = (u) => (u === "kph" ? "KPH" : "MPH");
const tmp = (f, u) => (u === "C" ? (f - 32) * 5 / 9 : f);
const tmpLabel = (u) => (u === "C" ? "°C" : "°F");
const dist = (mi, u) => (u === "kph" ? { v: mi * 1.60934, u: "km" } : { v: mi, u: "mi" });
function econ(mpg, u) {
  if (mpg == null) return { v: "—", u: u === "kph" ? "L/100km" : "mpg" };
  if (u === "kph") return { v: (235.215 / mpg).toFixed(1), u: "L/100km" };
  return { v: mpg.toFixed(1), u: "mpg" };
}

/* ---------------------- live-data + null helpers ------------------------- */
/* A channel is "available" only when it holds a real number. The ESP32 bridge
   sends null for any ECM channel it hasn't heard yet; those render as "--",
   matching the simulator's warm-up state. Display/conversion logic is
   untouched — these just guard the value before it reaches a gauge. */
const isNum = (v) => v != null && !Number.isNaN(v);
const na = (v, fn = (x) => x) => (isNum(v) ? fn(v) : "--");

// Bridge delivers metric raw; convert to the exact units `data` already holds
// (mph / °F / psi / gph / V), preserving null for not-yet-reported channels.
const KPA_PSI = 0.14503773773;
function mapBridgeData(b) {
  const c2f = (c) => (c * 9) / 5 + 32;
  return {
    speed:    b.speedKph == null ? null : b.speedKph / 1.60934,      // mph
    rpm:      b.rpm == null ? null : b.rpm,                          // rpm
    coolant:  b.coolantC == null ? null : c2f(b.coolantC),          // °F
    oil:      b.oilKpa == null ? null : b.oilKpa * KPA_PSI,          // psi
    fuel:     b.fuelLph == null ? null : b.fuelLph / 3.785411784,    // gph
    boost:    b.boostKpa == null ? null : b.boostKpa * KPA_PSI,      // psi
    trans:    b.transC == null ? null : c2f(b.transC),              // °F
    volts:    b.battV == null ? null : b.battV,                      // V
    intake:   b.intakeC == null ? null : c2f(b.intakeC),            // °F
    throttle: b.throttlePct == null ? null : Math.round(b.throttlePct), // %
  };
}
const DEFAULT_DATA = { speed: 0, rpm: 600, coolant: 168, oil: 44, fuel: 0.6, boost: 0, trans: 150, volts: 12.6, intake: 95, throttle: 0 };

/* ------------------------- alarm monitors -------------------------------- */
/* Every channel that should beep + drop a banner when out of range. Each
   returns "none" | "warn" | "crit" (warn = orange, crit = red + flash), the
   same levels the coolant alarm already drives. Thresholds come from each
   gauge's cfg (the factory-tuned values above). */
const RANK = { none: 0, warn: 1, crit: 2 };

// Once a channel is alarming, hold it until the value clears the threshold by a
// small margin — stops the beep from chattering when a value hovers on the line.
function nearThreshold(cfg, v) {
  const range = ((cfg.max != null ? cfg.max : 100) - (cfg.min != null ? cfg.min : 0)) || 100;
  const m = range * 0.04;
  if (cfg.invert) return cfg.warnBelow != null && v <= cfg.warnBelow + m;
  let near = false;
  if (cfg.warn != null) near = near || v >= cfg.warn - m;
  if (cfg.warnBelow != null) near = near || v <= cfg.warnBelow + m;
  return near;
}
function genLevel(cfg) {
  return (v, prev) => {
    if (!isNum(v)) return "none"; // no data → no alarm
    const z = zoneOf(cfg, v);
    let lvl = z === "normal" ? "none" : z;
    if (prev !== "none" && lvl === "none" && nearThreshold(cfg, v)) lvl = prev; // hysteresis
    return lvl;
  };
}
// Coolant keeps its own hysteresis (CONFIG.alert) so its behavior is unchanged.
function coolantLevel(v, prev) {
  const A = CONFIG.alert;
  if (!isNum(v)) return "none";
  if (v >= A.critTemp) return "crit";
  if (v >= A.warnTemp) return "warn";
  if (v < A.resetTemp) return "none";
  return prev !== "none" ? "warn" : "none";
}
const MONITORS = [
  { key: "coolant", read: (d) => d.coolant, level: coolantLevel,
    fmt: (d, tu) => na(d.coolant, (v) => Math.round(tmp(v, tu))) + tmpLabel(tu),
    message: (lvl) => (lvl === "crit" ? "COOLANT CRITICAL — REDUCE LOAD NOW" : "COOLANT HIGH — WATCH TEMPERATURE") },
  { key: "oil", read: (d) => d.oil, level: genLevel(CONFIG.gauges.oil),
    fmt: (d) => na(d.oil, (v) => Math.round(v)) + " PSI",
    message: (lvl) => (lvl === "crit" ? "OIL PRESSURE CRITICAL — STOP ENGINE" : "OIL PRESSURE LOW") },
  { key: "rpm", read: (d) => d.rpm, level: genLevel(CONFIG.gauges.rpm),
    fmt: (d) => na(d.rpm, (v) => Math.round(v)) + " RPM",
    message: (lvl) => (lvl === "crit" ? "ENGINE OVERSPEED — EASE OFF" : "RPM HIGH — NEAR REDLINE") },
  { key: "trans", read: (d) => d.trans, level: genLevel(CONFIG.channels.trans),
    fmt: (d, tu) => na(d.trans, (v) => Math.round(tmp(v, tu))) + tmpLabel(tu),
    message: (lvl) => (lvl === "crit" ? "TRANS TEMP CRITICAL — REDUCE LOAD" : "TRANS TEMP HIGH") },
  { key: "volts", read: (d) => d.volts, level: genLevel(CONFIG.channels.volts),
    fmt: (d) => na(d.volts, (v) => v.toFixed(1)) + "V",
    message: (lvl, v) => (v >= 14
      ? (lvl === "crit" ? "CHARGING VOLTAGE CRITICAL" : "CHARGING VOLTAGE HIGH")
      : (lvl === "crit" ? "BATTERY VOLTAGE CRITICAL" : "BATTERY VOLTAGE LOW")) },
  { key: "intake", read: (d) => d.intake, level: genLevel(CONFIG.channels.intake),
    fmt: (d, tu) => na(d.intake, (v) => Math.round(tmp(v, tu))) + tmpLabel(tu),
    message: (lvl) => (lvl === "crit" ? "INTAKE AIR TEMP CRITICAL" : "INTAKE AIR TEMP HIGH") },
];

/* --------------------------- channel registry ---------------------------- */
/* Every assignable data source. `arcable` sources can render as a ring gauge;
   all can render as a digital readout. cfg drives arc scale + danger zones. */
const CHANNELS = {
  speed:    { label: "Speed",       arcable: true,  cfg: { min: 0, max: 85,   label: "SPEED",      unit: "MPH" }, get: (d) => d.speed,  disp: (d, t, su) => ({ value: String(Math.round(spd(d.speed, su))), unit: spdLabel(su) }) },
  rpm:      { label: "RPM",         arcable: true,  cfg: CONFIG.gauges.rpm,     get: (d) => d.rpm,     disp: (d) => ({ value: String(Math.round(d.rpm)), unit: "RPM" }) },
  coolant:  { label: "Coolant Temp",arcable: true,  cfg: CONFIG.gauges.coolant, get: (d) => d.coolant, disp: (d, t, su, tu) => ({ value: String(Math.round(tmp(d.coolant, tu))), unit: tmpLabel(tu) }) },
  oil:      { label: "Oil Pressure",arcable: true,  cfg: CONFIG.gauges.oil,     get: (d) => d.oil,     disp: (d) => ({ value: String(Math.round(d.oil)), unit: "PSI" }) },
  boost:    { label: "Boost",       arcable: true,  cfg: CONFIG.channels.boost, get: (d) => d.boost,   disp: (d) => ({ value: d.boost.toFixed(1), unit: "psi" }) },
  trans:    { label: "Trans Temp",  arcable: true,  cfg: { ...CONFIG.channels.trans, min: 120, max: 280 },  get: (d) => d.trans,  disp: (d, t, su, tu) => ({ value: String(Math.round(tmp(d.trans, tu))), unit: tmpLabel(tu) }) },
  volts:    { label: "Battery",     arcable: true,  cfg: { ...CONFIG.channels.volts, min: 10, max: 15 },    get: (d) => d.volts,  disp: (d) => ({ value: d.volts.toFixed(1), unit: "V" }) },
  intake:   { label: "Intake Air",  arcable: true,  cfg: { ...CONFIG.channels.intake, min: 60, max: 220 },  get: (d) => d.intake, disp: (d, t, su, tu) => ({ value: String(Math.round(tmp(d.intake, tu))), unit: tmpLabel(tu) }) },
  throttle: { label: "Throttle",    arcable: true,  cfg: { min: 0, max: 100, label: "THROTTLE", unit: "%" }, get: (d) => d.throttle, disp: (d) => ({ value: String(d.throttle), unit: "%" }) },
  fuelrate: { label: "Fuel Rate",   arcable: true,  cfg: { min: 0, max: 20, label: "FUEL RATE", unit: "gph" }, get: (d) => d.fuel, disp: (d, t, su) => ({ value: (su === "kph" ? d.fuel * 3.78541 : d.fuel).toFixed(1), unit: su === "kph" ? "L/h" : "gph" }) },
  hours:    { label: "Engine Hours",arcable: false, get: (d, t) => t.hours, disp: (d, t) => ({ value: t.hours.toFixed(1), unit: "h" }) },
  econInst: { label: "Instant MPG", arcable: false, get: () => 0, disp: (d, t, su) => { const m = d.speed < 3 ? null : mpgOf(d.speed, d.fuel); return econ(m, su); } },
  odo:      { label: "Odometer",    arcable: false, get: (d, t) => t.odo, disp: (d, t, su) => { const x = dist(t.odo, su); return { value: Math.floor(x.v).toLocaleString(), unit: x.u }; } },
};
const CHANNEL_KEYS = Object.keys(CHANNELS);

/* ----------------------------- geometry ---------------------------------- */
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const START_DEG = 135, SWEEP_DEG = 270;
function arcPath(cx, cy, r, fromFrac, toFrac) {
  const a = Math.round(160 * clamp01(fromFrac)), b = Math.round(160 * clamp01(toFrac));
  let d = "";
  for (let i = a; i <= b; i++) {
    const ang = ((START_DEG + SWEEP_DEG * (i / 160)) * Math.PI) / 180;
    d += (i === a ? "M" : "L") + (cx + r * Math.cos(ang)).toFixed(2) + " " + (cy + r * Math.sin(ang)).toFixed(2) + " ";
  }
  return d;
}

/* ------------------------------- arc gauge ------------------------------- */
function ArcGauge({ cfg, value, size = 230, id, displayValue, displayUnit }) {
  const { T } = useUI();
  const { min, max } = cfg;
  const has = value != null && !Number.isNaN(value);
  const frac = has ? clamp01((value - min) / (max - min)) : 0;
  const zone = has ? zoneOf(cfg, value) : "normal";
  const cx = size / 2, cy = size / 2, r = size / 2 - 18, stroke = size < 170 ? 10 : 13;
  const zoneColor = zone === "crit" ? T.crit : zone === "warn" ? T.warn : null;
  const valueStroke = zoneColor || `url(#grad-${id})`;
  const glow = zone === "crit" ? T.crit : zone === "warn" ? T.warn : T.accent;
  const redlineFrac = cfg.redline != null ? clamp01((cfg.redline - min) / (max - min)) : null;
  const num = displayValue != null ? displayValue : has ? Math.round(value) : "--";
  const unit = displayUnit != null ? displayUnit : cfg.unit;

  return (
    <svg viewBox={`0 0 ${size} ${size}`} width="100%" height="100%" style={{ overflow: "visible" }}
         className={zone === "crit" ? "flash" : undefined}>
      <defs>
        <linearGradient id={`grad-${id}`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor={T.accentDeep} />
          <stop offset="55%" stopColor={T.accent} />
          <stop offset="100%" stopColor={T.accentBright} />
        </linearGradient>
        <filter id={`soft-${id}`} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="5" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <path d={arcPath(cx, cy, r, 0, 1)} fill="none" stroke="#1B273E" strokeWidth={stroke} strokeLinecap="round" />
      {redlineFrac != null && (
        <path d={arcPath(cx, cy, r, redlineFrac, 1)} fill="none" stroke={T.critDeep} strokeWidth={stroke} strokeLinecap="round" opacity="0.9" />
      )}
      <g className={zone === "crit" ? undefined : "shimmer"} filter={`url(#soft-${id})`} style={{ "--glow": glow }}>
        <path d={arcPath(cx, cy, r, 0, frac)} fill="none" stroke={valueStroke} strokeWidth={stroke} strokeLinecap="round" />
      </g>
      <text x={cx} y={cy - 4} textAnchor="middle" fontFamily="var(--font-digit)" fontWeight="700" fontSize={size * 0.30} fill={zoneColor || T.text} style={{ letterSpacing: "1px" }}>{num}</text>
      <text x={cx} y={cy + size * 0.135} textAnchor="middle" fontFamily="var(--font-label)" fontSize={size * 0.075} fill={T.dim} style={{ letterSpacing: "3px" }}>{unit}</text>
      <text x={cx} y={cy + size * 0.30} textAnchor="middle" fontFamily="var(--font-label)" fontSize={size * 0.072} fill={zone === "normal" ? T.dim : zoneColor} fontWeight="600" style={{ letterSpacing: "3.5px" }}>{cfg.label}</text>
    </svg>
  );
}

/* --------------------------------- tile ---------------------------------- */
function Tile({ label, value, unit, zone = "normal" }) {
  const { T } = useUI();
  const c = zone === "crit" ? T.crit : zone === "warn" ? T.warn : T.text;
  return (
    <div className={zone === "crit" ? "flash" : undefined}
      style={{ background: "#0b1626", border: `1px solid ${zone === "normal" ? "#16233c" : c}`, borderRadius: 12, padding: "12px 14px", minWidth: 0 }}>
      <div style={{ color: T.dim, letterSpacing: "2px", fontSize: 10.5, whiteSpace: "nowrap" }}>{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 5, marginTop: 3 }}>
        <span style={{ fontFamily: "var(--font-digit)", fontWeight: 700, fontSize: 30, color: c, textShadow: zone === "normal" ? `0 0 14px ${T.accent}22` : "none" }}>{value}</span>
        <span style={{ color: T.dim, fontSize: 12 }}>{unit}</span>
      </div>
    </div>
  );
}

/* ---------------------------------- MPH ---------------------------------- */
function Mph({ speed, su, fontSize = "clamp(140px,22vw,300px)", showLabel = true }) {
  const { T } = useUI();
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div style={{ fontFamily: "var(--font-digit)", fontWeight: 700, lineHeight: 0.9, fontSize, color: T.text, textShadow: `0 0 34px ${T.accent}55`, letterSpacing: "-2px" }}>{isNum(speed) ? Math.round(spd(speed, su)) : "--"}</div>
      {showLabel && <div style={{ letterSpacing: "14px", fontSize: "clamp(14px,2vw,22px)", color: T.accent, marginTop: -4, textIndent: "14px" }}>{spdLabel(su)}</div>}
    </div>
  );
}

/* ------------------------------ audio engine ----------------------------- */
function useAlertAudio(ready, level, muted) {
  const ctxRef = useRef(null);
  const ensureCtx = useCallback(() => {
    if (!ctxRef.current) { const AC = window.AudioContext || window.webkitAudioContext; ctxRef.current = new AC(); }
    if (ctxRef.current.state === "suspended") ctxRef.current.resume();
    return ctxRef.current;
  }, []);
  const beep = useCallback((freq, dur, gain = 0.22) => {
    const ctx = ctxRef.current; if (!ctx) return;
    const t = ctx.currentTime, osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = "triangle"; osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(ctx.destination); osc.start(t); osc.stop(t + dur + 0.02);
  }, []);
  useEffect(() => { if (ready) ensureCtx(); }, [ready, ensureCtx]);
  useEffect(() => {
    if (!ready || muted || level === "none") return;
    const fire = () => level === "crit" ? beep(980, 0.16, 0.28) : beep(660, 0.16, 0.2);
    fire();
    const iv = setInterval(fire, level === "crit" ? 420 : 1700);
    return () => clearInterval(iv);
  }, [ready, muted, level, beep]);
}

/* ------------------------------ wake lock -------------------------------- */
// Hold the screen on while the HUD is open. The OS auto-releases the lock when
// the page is hidden (screen off / app backgrounded), so re-acquire it whenever
// the page becomes visible again. Feature-detected — a no-op where unsupported.
function useWakeLock() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    let lock = null;
    let stopped = false;
    const request = async () => {
      if (stopped || lock || document.visibilityState !== "visible") return;
      try {
        lock = await navigator.wakeLock.request("screen");
        lock.addEventListener("release", () => { lock = null; });
      } catch (e) { /* denied (hidden, low battery, etc.) — retry on next visibility */ }
    };
    const onVisibility = () => { if (document.visibilityState === "visible") request(); };
    request();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (lock) { try { lock.release(); } catch (e) {} lock = null; }
    };
  }, []);
}

/* --------------------------------- clock --------------------------------- */
// Device wall-clock, ticked once a second. 12-hour time with AM/PM plus a short
// weekday + date line. Purely local — no network, works fully offline.
function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/* --------------------------- outside temperature ------------------------- */
// Real outdoor temperature from Open-Meteo (free, no API key), located by the
// tablet's GPS. Fetched on load and every 10 minutes, re-reading position each
// cycle so it tracks as the coach moves. Stored in °F to match every other
// temperature in the app (rendered through tmp()/tmpLabel() like the gauges).
// Degrades gracefully: no geolocation, denied permission, or no internet keeps
// the last good reading (seeded from storage on startup) — or null → "--".
const OUTTEMP_KEY = "rvdash:outtemp:v1";
const OUTTEMP_REFRESH_MS = 10 * 60 * 1000;
const OUTTEMP_STALE_MS = 60 * 60 * 1000; // dim the reading if it's over an hour old

function useOutsideTemp() {
  const [tempF, setTempF] = useState(null);      // canonical °F, or null when unknown
  const [updatedAt, setUpdatedAt] = useState(0); // epoch ms of last good fetch
  const busyRef = useRef(false);

  const getPosition = useCallback(
    () =>
      new Promise((resolve, reject) => {
        if (typeof navigator === "undefined" || !navigator.geolocation) {
          reject(new Error("no geolocation"));
          return;
        }
        navigator.geolocation.getCurrentPosition(
          (p) => resolve(p.coords),
          (e) => reject(e),
          { enableHighAccuracy: false, timeout: 15000, maximumAge: 5 * 60 * 1000 }
        );
      }),
    []
  );

  const refresh = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const { latitude, longitude } = await getPosition();
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${latitude.toFixed(4)}` +
        `&longitude=${longitude.toFixed(4)}&current=temperature_2m&temperature_unit=fahrenheit`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`weather ${res.status}`);
      const j = await res.json();
      const t = j && j.current && j.current.temperature_2m;
      if (typeof t === "number" && !Number.isNaN(t)) {
        setTempF(t);
        const at = Date.now();
        setUpdatedAt(at);
        pSave(OUTTEMP_KEY, { tempF: t, at });
      }
    } catch (e) {
      /* offline / denied / timeout — keep last value, retry next cycle */
    } finally {
      busyRef.current = false;
    }
  }, [getPosition]);

  useEffect(() => {
    // seed from last-known so an offline startup still shows a number
    pLoad(OUTTEMP_KEY).then((s) => {
      if (s && typeof s.tempF === "number") {
        setTempF(s.tempF);
        setUpdatedAt(s.at || 0);
      }
    });
    refresh();
    const id = setInterval(refresh, OUTTEMP_REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const stale = updatedAt > 0 && Date.now() - updatedAt > OUTTEMP_STALE_MS;
  return { tempF, updatedAt, stale };
}

/* --------------------- header clock + outside-temp cluster --------------- */
function HeaderStatus({ now, out, tu }) {
  const { T } = useUI();
  const time = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true });
  const date = now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const hasTemp = isNum(out.tempF);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <div style={{ display: "flex", flexDirection: "column", lineHeight: 1 }}>
        <span style={{ fontFamily: "var(--font-digit)", fontWeight: 700, fontSize: 22, color: T.text, letterSpacing: "1px" }}>{time}</span>
        <span style={{ color: T.dim, fontSize: 11, letterSpacing: "2px", marginTop: 3, textTransform: "uppercase" }}>{date}</span>
      </div>
      <div
        title={hasTemp ? (out.stale ? "Outside temp — no recent update" : "Outside temperature") : "Outside temp unavailable (needs internet + location)"}
        style={{ display: "flex", alignItems: "center", gap: 6, opacity: hasTemp && out.stale ? 0.55 : 1 }}
      >
        <Thermometer size={16} color={hasTemp ? T.accent : T.dim} />
        <span style={{ fontFamily: "var(--font-digit)", fontWeight: 700, fontSize: 20, color: hasTemp ? T.text : T.dim }}>
          {hasTemp ? Math.round(tmp(out.tempF, tu)) : "--"}
        </span>
        <span style={{ color: T.dim, fontSize: 12 }}>{tmpLabel(tu)}</span>
      </div>
    </div>
  );
}

/* -------------------------- fuel + trip helpers -------------------------- */
function fuelGph(speed, rpm, heat) {
  if (speed < 3) return 0.6;
  let mpg = 9.4;
  if (speed > 62) mpg -= (speed - 62) * 0.09;
  if (rpm > 2000) mpg -= (rpm - 2000) * 0.0012;
  if (heat) mpg -= 3;
  mpg = Math.max(3, Math.min(12, mpg));
  return speed / mpg;
}
const emptyTrip = () => ({ dist: 0, drive: 0, fuel: 0 });
const emptyTrips = () => ({ A: emptyTrip(), B: emptyTrip(), odo: 0, hours: 0, bins: [], cur: { mi: 0, gal: 0 }, rollMi: 0, rollGal: 0 });
function fmtDur(sec) { const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60); return `${h}h ${String(m).padStart(2, "0")}m`; }
const mpgOf = (d, f) => (f > 0.02 && d > 0.05 ? d / f : null);

async function pLoad(key) { try { if (window.storage) { const r = await window.storage.get(key); if (r && r.value) return JSON.parse(r.value); } } catch (e) {} return null; }
async function pSave(key, o) { try { if (window.storage) await window.storage.set(key, JSON.stringify(o)); } catch (e) {} }

/* --------------------------------- app ----------------------------------- */
export default function RVDashboard() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const night = effectiveNight(settings);
  const T = computeTheme(settings, night);

  const [audioReady, setAudioReady] = useState(false);
  const [showAudioPrompt, setShowAudioPrompt] = useState(true);
  const [view, setView] = useState("dash");
  const [showSettings, setShowSettings] = useState(false);
  const [editing, setEditing] = useState(false);      // custom-layout edit mode (locked by default)
  const [selectedId, setSelectedId] = useState(null);

  const [data, setData] = useState(DEFAULT_DATA);
  const [mode, setMode] = useState("auto");
  const [panelOpen, setPanelOpen] = useState(true);
  const [heat, setHeat] = useState(false);
  const [timeScale, setTimeScale] = useState(50);

  const [level, setLevel] = useState("none");   // highest active alarm level
  const [muted, setMuted] = useState(false);
  const [alarms, setAlarms] = useState([]);      // all currently-active alarms
  const ackLevelRef = useRef("none"); const ackTimeRef = useRef(0);
  const ackKeysRef = useRef(new Set()); const activeKeysRef = useRef([]);
  const chLevelsRef = useRef({}); const alarmSigRef = useRef("");
  const unitsRef = useRef({ tu: "F", su: "mph" });

  const [trips, setTrips] = useState(emptyTrips());
  const tripsRef = useRef(trips);
  const settingsLoaded = useRef(false);

  const [profiles, setProfiles] = useState([]);
  const [activeProfileId, setActiveProfileId] = useState(null);
  const profilesLoaded = useRef(false);

  // Live BLE bridge. Mounts unconditionally on first render (never gated behind
  // a settings screen), so the hook's silent getDevices() auto-connect loop can
  // start retrying the ESP32 the moment the page loads.
  const bridge = useBridgeConnection();
  const liveRef = useRef(false); liveRef.current = bridge.connected;

  const dataRef = useRef(data); dataRef.current = data;
  const modeRef = useRef(mode); modeRef.current = mode;
  const heatRef = useRef(heat); heatRef.current = heat;
  const scaleRef = useRef(timeScale); scaleRef.current = timeScale;
  const levelRef = useRef(level); levelRef.current = level;
  const mutedRef = useRef(muted); mutedRef.current = muted;

  useAlertAudio(audioReady, level, muted);
  useWakeLock(); // keep the tablet screen on while the dashboard is open
  const now = useClock();          // device clock for the header (ticks every second)
  const outside = useOutsideTemp(); // real outdoor temp via GPS + Open-Meteo

  useEffect(() => {
    const l = document.createElement("link"); l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=Chakra+Petch:wght@500;600&display=swap";
    document.head.appendChild(l);
    return () => { try { document.head.removeChild(l); } catch (e) {} };
  }, []);

  // load persisted trips + settings once
  useEffect(() => {
    pLoad(TRIPS_KEY).then((s) => { if (s) { const m = { ...emptyTrips(), ...s }; tripsRef.current = m; setTrips(m); } });
    pLoad(SETTINGS_KEY).then((s) => { if (s) setSettings((prev) => ({ ...prev, ...s })); settingsLoaded.current = true; });
    pLoad(PROFILES_KEY).then((s) => { if (s) { setProfiles(s.list || []); setActiveProfileId(s.activeId || null); } profilesLoaded.current = true; });
  }, []);
  // persist profiles when they change
  useEffect(() => { if (profilesLoaded.current) pSave(PROFILES_KEY, { list: profiles, activeId: activeProfileId }); }, [profiles, activeProfileId]);
  // persist settings whenever they change (after first load), debounced for drag
  useEffect(() => {
    if (!settingsLoaded.current) return;
    const t = setTimeout(() => pSave(SETTINGS_KEY, settings), 500);
    return () => clearTimeout(t);
  }, [settings]);

  useEffect(() => {
    let tick = 0;
    const iv = setInterval(() => {
      const live = liveRef.current;
      const simDt = 0.05 * (live ? 1 : scaleRef.current); // real time while live; sim can fast-forward
      const d = dataRef.current;
      const Tr = tripsRef.current;
      // Engine hours: ECM value is authoritative while live (set in the bridge
      // effect); only self-accrue when running on the simulator.
      if (!live) Tr.hours += simDt / 3600;
      if (d.speed > 0.2) {
        const dMi = (d.speed * simDt) / 3600, dGal = ((d.fuel || 0.6) * simDt) / 3600;
        Tr.A.dist += dMi; Tr.A.fuel += dGal; Tr.A.drive += simDt;
        Tr.B.dist += dMi; Tr.B.fuel += dGal; Tr.B.drive += simDt;
        Tr.odo += dMi;
        Tr.cur.mi += dMi; Tr.cur.gal += dGal; Tr.rollMi += dMi; Tr.rollGal += dGal;
        if (Tr.cur.mi >= CONFIG.trip.binSizeMi) { Tr.bins.push(Tr.cur); Tr.cur = { mi: 0, gal: 0 }; }
        while (Tr.rollMi > CONFIG.trip.rollWindowMi && Tr.bins.length) { const o = Tr.bins.shift(); Tr.rollMi -= o.mi; Tr.rollGal -= o.gal; }
      }
      setData((prev) => {
        if (liveRef.current) return prev; // bridge owns `data` while connected
        let { speed, rpm, coolant, oil } = prev;
        if (modeRef.current === "auto") {
          const target = 60 + 6 * Math.sin(Date.now() / 9000);
          speed += (target - speed) * 0.05 + (Math.random() - 0.5) * 0.3; speed = Math.max(0, speed);
          const rpmTarget = speed < 3 ? 620 : 1150 + speed * 11 + 90 * Math.sin(Date.now() / 4000);
          rpm += (rpmTarget - rpm) * 0.08;
          coolant += ((196 + 4 * Math.sin(Date.now() / 15000)) - coolant) * 0.02;
          oil += ((42 + speed * 0.12) - oil) * 0.05;
        }
        if (heatRef.current) coolant += 0.55;
        coolant = Math.max(120, Math.min(250, coolant));
        rpm = Math.max(0, Math.min(2900, rpm)); oil = Math.max(0, Math.min(80, oil));
        // derived ECM channels
        const load = clamp01((rpm - 800) / 1500);
        const boost = Math.max(0, prev.boost + ((2 + load * 27) - prev.boost) * 0.15);
        const trans = prev.trans + ((160 + load * 55 + (heatRef.current ? 22 : 0)) - prev.trans) * 0.012;
        const volts = prev.volts + (((speed < 3 ? 12.7 : 13.9) - load * 0.15) - prev.volts) * 0.1 + (Math.random() - 0.5) * 0.02;
        const intake = prev.intake + ((92 + boost * 1.7 + (heatRef.current ? 15 : 0)) - prev.intake) * 0.05;
        const throttle = Math.round(load * 100);
        return { speed, rpm, coolant, oil, fuel: fuelGph(speed, rpm, heatRef.current), boost, trans, volts, intake, throttle };
      });
      if (++tick % 4 === 0) setTrips({ ...tripsRef.current });
    }, 50);
    return () => clearInterval(iv);
  }, []);

  // Live BLE packets (4 Hz) drive the gauges, trip computer and audio alerts.
  // The simulator loop above steps aside (returns prev) while connected, and the
  // trip integrator + alarm watcher read dataRef, so they follow live data too.
  useEffect(() => {
    if (!bridge.connected || !bridge.data) return;
    setData(mapBridgeData(bridge.data));
    if (bridge.data.engineHours != null) tripsRef.current.hours = bridge.data.engineHours;
  }, [bridge.connected, bridge.data]);

  // When the link drops, hand `data` back to the simulator with clean numeric
  // values so its physics doesn't inherit stray nulls from the last live frame.
  useEffect(() => {
    if (bridge.connected) return;
    setData((d) => { const o = { ...DEFAULT_DATA }; for (const k in o) if (isNum(d[k])) o[k] = d[k]; return o; });
  }, [bridge.connected]);

  useEffect(() => { const iv = setInterval(() => pSave(TRIPS_KEY, tripsRef.current), 4000); return () => clearInterval(iv); }, []);

  // Evaluate every monitored channel; drive audio off the highest level and the
  // banner off the full active list. Any channel out of range alerts, not just
  // coolant.
  useEffect(() => {
    const A = CONFIG.alert;
    const iv = setInterval(() => {
      const d = dataRef.current, tu = unitsRef.current.tu;
      const active = [];
      let overall = "none";
      for (const m of MONITORS) {
        const v = m.read(d);
        const prev = chLevelsRef.current[m.key] || "none";
        const lvl = m.level(v, prev);
        chLevelsRef.current[m.key] = lvl;
        if (lvl !== "none") {
          active.push({ key: m.key, level: lvl, message: m.message(lvl, v), valueStr: m.fmt(d, tu) });
          if (RANK[lvl] > RANK[overall]) overall = lvl;
        }
      }
      active.sort((a, b) => RANK[b.level] - RANK[a.level]);
      const activeKeys = active.map((a) => a.key);
      activeKeysRef.current = activeKeys;

      if (overall === "none") {
        ackLevelRef.current = "none"; ackKeysRef.current = new Set();
        if (mutedRef.current) setMuted(false);
      } else if (mutedRef.current) {
        const escalated = RANK[overall] > RANK[ackLevelRef.current];
        const newAlarm = activeKeys.some((k) => !ackKeysRef.current.has(k));
        if (escalated || newAlarm) setMuted(false);
        else if (Date.now() - ackTimeRef.current >= A.persistMs) setMuted(false);
      }

      if (overall !== levelRef.current) setLevel(overall);
      const sig = active.map((a) => a.key + a.level + a.valueStr).join("|");
      if (sig !== alarmSigRef.current) { alarmSigRef.current = sig; setAlarms(active); }
    }, 300);
    return () => clearInterval(iv);
  }, []);

  const acknowledge = () => {
    if (levelRef.current === "none") return;
    ackLevelRef.current = levelRef.current;
    ackKeysRef.current = new Set(activeKeysRef.current);
    ackTimeRef.current = Date.now();
    setMuted(true);
  };
  const enableAudio = () => {
    const AC = window.AudioContext || window.webkitAudioContext; const ctx = new AC();
    ctx.resume().finally(() => { const o = ctx.createOscillator(), g = ctx.createGain(); g.gain.value = 0.0001; o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.03); setAudioReady(true); setShowAudioPrompt(false); });
  };
  const setManual = (k, v) => setData((d) => ({ ...d, [k]: v }));
  const resetTrip = (w) => { tripsRef.current = { ...tripsRef.current, [w]: emptyTrip() }; setTrips({ ...tripsRef.current }); pSave(TRIPS_KEY, tripsRef.current); };

  const su = settings.speedUnit, tu = settings.tempUnit;
  unitsRef.current = { tu, su };  // read by the alarm loop for banner formatting

  // Demo controls are hidden in normal (coach) use. The simulator itself stays
  // intact as the automatic fallback when the bridge is offline — this only
  // hides the control strip. Append ?dev to the URL to bring the controls back
  // for development on the simulator.
  const showDemo = typeof window !== "undefined" && /[?&]dev\b/.test(window.location.search);

  // custom layout: settings.widgets is the single source of truth
  const widgets = settings.widgets || DEFAULT_WIDGETS;
  const setWidgets = (updater) => setSettings((s) => {
    const cur = s.widgets || DEFAULT_WIDGETS;
    return { ...s, widgets: typeof updater === "function" ? updater(cur) : updater };
  });
  const addWidget = () => { const id = `w-${Date.now().toString(36)}`; setWidgets((ws) => { const p = freeSpot(ws, 3, 3); return [...ws, { id, source: "boost", style: "arc", x: p.x, y: p.y, w: 3, h: 3 }]; }); setSelectedId(id); };
  const resetWidgets = () => { setWidgets(DEFAULT_WIDGETS.map((w) => ({ ...w }))); setSelectedId(null); };
  const patchWidget = (patch) => setWidgets((ws) => ws.map((w) => (w.id === selectedId ? { ...w, ...patch } : w)));
  const deleteWidget = () => { setWidgets((ws) => ws.filter((w) => w.id !== selectedId)); setSelectedId(null); };

  // driver profiles — each is a full snapshot of settings
  const snap = () => JSON.parse(JSON.stringify(settings));
  const applyProfile = (id) => { const p = profiles.find((x) => x.id === id); if (p) { setSettings(JSON.parse(JSON.stringify(p.settings))); setActiveProfileId(id); } };
  const saveProfileAs = (name) => { const id = `p-${Date.now().toString(36)}`; setProfiles((ps) => [...ps, { id, name, settings: snap() }]); setActiveProfileId(id); };
  const updateProfile = (id) => setProfiles((ps) => ps.map((p) => (p.id === id ? { ...p, settings: snap() } : p)));
  const deleteProfile = (id) => { setProfiles((ps) => ps.filter((p) => p.id !== id)); setActiveProfileId((a) => (a === id ? null : a)); };
  const bannerColor = level === "crit" ? T.crit : T.warn;
  const instMpg = data.speed < 3 ? null : mpgOf(data.speed, data.fuel);
  const roll100 = mpgOf(trips.rollMi, trips.rollGal);
  const eInst = econ(instMpg, su), eRoll = econ(roll100, su);
  const aDist = dist(trips.A.dist, su), odoD = dist(trips.odo, su);

  const cool = <ArcGauge id="cool" cfg={CONFIG.gauges.coolant} value={data.coolant} displayValue={na(data.coolant, (v) => Math.round(tmp(v, tu)))} displayUnit={tmpLabel(tu)} />;
  const oilG = <ArcGauge id="oil" cfg={CONFIG.gauges.oil} value={data.oil} />;
  const rpmG = <ArcGauge id="rpm" cfg={CONFIG.gauges.rpm} value={data.rpm} size={300} />;

  return (
    <ThemeCtx.Provider value={{ T, S: settings }}>
    <div style={{ position: "relative", width: "100%", minHeight: "100vh", background: T.bg, color: T.text,
      fontFamily: "var(--font-label)", display: "flex", flexDirection: "column", overflow: "hidden",
      filter: night ? "brightness(0.72)" : "none", transition: "filter .4s ease" }}>
      <style>{`
        :root{ --font-digit:'Rajdhani','Chakra Petch',ui-sans-serif,system-ui,sans-serif;
               --font-label:'Chakra Petch','Rajdhani',ui-sans-serif,system-ui,sans-serif; }
        .shimmer{ animation: pulse 3.4s ease-in-out infinite; filter: drop-shadow(0 0 6px var(--glow)); }
        @keyframes pulse{ 0%,100%{opacity:.92} 50%{opacity:1} }
        .flash{ animation: flash 0.7s steps(2,jump-none) infinite; }
        @keyframes flash{ 0%,100%{opacity:1} 50%{opacity:.35} }
        @media (prefers-reduced-motion: reduce){ .shimmer,.flash{ animation:none !important; } }
      `}</style>

      {/* header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 24px", borderBottom: "1px solid #12203a" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 220 }}>
          <div style={{ letterSpacing: "3px", fontSize: 11, color: T.dim, fontWeight: 600 }}>
            JOURNEY&nbsp;39K <span style={{ opacity: .5 }}>·</span> CAT&nbsp;C7&nbsp;350
          </div>
          <HeaderStatus now={now} out={outside} tu={tu} />
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Tab active={view === "dash"} onClick={() => setView("dash")} icon={<Gauge size={15} />} label="DASH" />
          <Tab active={view === "trips"} onClick={() => setView("trips")} icon={<Route size={15} />} label="TRIPS" />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, minWidth: 240, justifyContent: "flex-end" }}>
          <BridgeStatus bridge={bridge} liveColor={T.accent} waitColor={T.warn} offColor={T.crit} textColor={T.text} background={`${T.accent}14`} />
          <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: audioReady ? T.accent : T.dim }}>
            {audioReady ? <Volume2 size={16} /> : <VolumeX size={16} />}
            {muted && level !== "none" && <BellOff size={15} style={{ color: bannerColor }} />}
          </span>
          <button onClick={() => setShowSettings(true)} style={{ background: "transparent", border: "none", color: T.dim, cursor: "pointer", display: "flex" }}><SettingsIcon size={19} /></button>
        </div>
      </div>

      {/* ============================ DASH VIEW ============================ */}
      {view === "dash" && settings.layout === "classic" && (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: "clamp(18px,4vw,72px)", padding: "10px 30px 4px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "clamp(10px,2vh,26px)", width: "clamp(180px,20vw,250px)" }}>
            <div style={{ aspectRatio: "1", width: "100%" }}>{cool}</div>
            <div style={{ aspectRatio: "1", width: "100%" }}>{oilG}</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", minWidth: "clamp(260px,34vw,520px)" }}>
            <Mph speed={data.speed} su={su} />
            <div className="shimmer" style={{ width: "42%", height: 2, marginTop: 18, "--glow": T.accent, background: `linear-gradient(90deg,transparent,${T.accent},transparent)` }} />
            <EconStrip eInst={eInst} aDist={aDist} />
          </div>
          <div style={{ width: "clamp(210px,26vw,330px)", aspectRatio: "1" }}>{rpmG}</div>
        </div>
      )}

      {view === "dash" && settings.layout === "speedFocus" && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: "10px 20px" }}>
          <div style={{ display: "flex", gap: "clamp(20px,4vw,60px)", justifyContent: "center", width: "100%" }}>
            <div style={{ width: 138, height: 138 }}>{cool}</div>
            <div style={{ width: 138, height: 138 }}><ArcGauge id="rpm2" cfg={CONFIG.gauges.rpm} value={data.rpm} size={160} /></div>
            <div style={{ width: 138, height: 138 }}>{oilG}</div>
          </div>
          <Mph speed={data.speed} su={su} fontSize="clamp(160px,26vw,340px)" />
          <EconStrip eInst={eInst} aDist={aDist} />
        </div>
      )}

      {view === "dash" && settings.layout === "quad" && (
        <div style={{ flex: 1, position: "relative", display: "grid", gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr 1fr", padding: "14px clamp(20px,5vw,80px)" }}>
          <div style={{ justifySelf: "start", alignSelf: "start", width: "clamp(150px,18vw,210px)", aspectRatio: 1 }}>{cool}</div>
          <div style={{ justifySelf: "end", alignSelf: "start", width: "clamp(150px,18vw,210px)", aspectRatio: 1 }}><ArcGauge id="rpm3" cfg={CONFIG.gauges.rpm} value={data.rpm} size={210} /></div>
          <div style={{ justifySelf: "start", alignSelf: "end", width: "clamp(150px,18vw,210px)", aspectRatio: 1 }}>{oilG}</div>
          <div style={{ justifySelf: "end", alignSelf: "end", width: "clamp(150px,18vw,210px)", aspectRatio: 1 }}><ArcGauge id="boost1" cfg={CONFIG.channels.boost} value={data.boost} displayValue={na(data.boost, (v) => v.toFixed(0))} size={210} /></div>
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
            <Mph speed={data.speed} su={su} fontSize="clamp(120px,18vw,240px)" />
            <EconStrip eInst={eInst} aDist={aDist} />
          </div>
        </div>
      )}

      {view === "dash" && settings.layout === "tech" && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12, padding: "12px clamp(16px,3vw,40px)", justifyContent: "center" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-around", gap: 12, flexWrap: "wrap" }}>
            <Mph speed={data.speed} su={su} fontSize="clamp(70px,10vw,120px)" />
            <div style={{ width: 150, height: 150 }}><ArcGauge id="rpm4" cfg={CONFIG.gauges.rpm} value={data.rpm} size={170} /></div>
            <div style={{ width: 140, height: 140 }}>{cool}</div>
            <div style={{ width: 140, height: 140 }}>{oilG}</div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
            <Tile label="BOOST" value={na(data.boost, (v) => v.toFixed(1))} unit="psi" />
            <Tile label="TRANS TEMP" value={na(data.trans, (v) => Math.round(tmp(v, tu)))} unit={tmpLabel(tu)} zone={isNum(data.trans) ? zoneOf(CONFIG.channels.trans, data.trans) : "normal"} />
            <Tile label="INTAKE AIR" value={na(data.intake, (v) => Math.round(tmp(v, tu)))} unit={tmpLabel(tu)} zone={isNum(data.intake) ? zoneOf(CONFIG.channels.intake, data.intake) : "normal"} />
            <Tile label="BATTERY" value={na(data.volts, (v) => v.toFixed(1))} unit="V" zone={isNum(data.volts) ? zoneOf(CONFIG.channels.volts, data.volts) : "normal"} />
            <Tile label="THROTTLE" value={na(data.throttle)} unit="%" />
            <Tile label="FUEL RATE" value={na(data.fuel, (v) => (su === "kph" ? v * 3.78541 : v).toFixed(1))} unit={su === "kph" ? "L/h" : "gph"} />
            <Tile label="ECONOMY" value={eInst.v} unit={eInst.u} />
            <Tile label="ENGINE HRS" value={trips.hours.toFixed(1)} unit="h" />
          </div>
        </div>
      )}

      {view === "dash" && settings.layout === "custom" && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 20px", borderBottom: "1px solid #12203a" }}>
            {editing ? (
              <>
                <span style={{ color: T.accent, letterSpacing: "2px", fontSize: 12, display: "flex", gap: 8, alignItems: "center" }}><Pencil size={14} /> EDIT MODE — drag to move, corner to resize, tap to configure</span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={addWidget} style={pill(false, T.accent, T)}><Plus size={14} /> Add gauge</button>
                  <button onClick={resetWidgets} style={pill(false, T.dim, T)}><RotateCcw size={13} /> Reset</button>
                  <button onClick={() => { setEditing(false); setSelectedId(null); }} style={pill(true, T.accent, T)}><Check size={14} /> Done</button>
                </div>
              </>
            ) : (
              <>
                <span style={{ color: T.dim, letterSpacing: "2px", fontSize: 12, display: "flex", gap: 8, alignItems: "center" }}><Lock size={13} /> Layout locked while driving</span>
                <button onClick={() => setEditing(true)} style={pill(false, T.accent, T)}><Pencil size={14} /> Edit layout</button>
              </>
            )}
          </div>
          <div style={{ flex: 1, minHeight: 0, padding: "6px 16px" }}>
            <EditableCanvas widgets={widgets} setWidgets={setWidgets} commit={() => {}} editing={editing}
              selectedId={selectedId} setSelectedId={setSelectedId} data={data} trips={trips} su={su} tu={tu} />
          </div>
          {editing && selectedId && widgets.find((w) => w.id === selectedId) && (
            <Inspector widget={widgets.find((w) => w.id === selectedId)} onChange={patchWidget} onDelete={deleteWidget} onClose={() => setSelectedId(null)} />
          )}
        </div>
      )}

      {/* TRIPS */}
      {view === "trips" && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "18px clamp(20px,4vw,60px)", gap: 18, justifyContent: "center" }}>
          <div style={{ display: "flex", gap: 18 }}>
            <HeroStat label="INSTANT ECONOMY" value={eInst.v} unit={eInst.u} note="estimated from ECM fuel rate" />
            <HeroStat label="LAST 100 MILES" value={eRoll.v} unit={eRoll.u} note={`rolling window · ${Math.min(100, trips.rollMi).toFixed(0)} mi collected`} />
            <HeroStat label="ODOMETER" value={Math.floor(odoD.v).toLocaleString()} unit={odoD.u} note="lifetime · never resets" small />
          </div>
          <div style={{ display: "flex", gap: 18 }}>
            <TripCard name="TRIP A" t={trips.A} onReset={() => resetTrip("A")} su={su} />
            <TripCard name="TRIP B" t={trips.B} onReset={() => resetTrip("B")} su={su} />
          </div>
        </div>
      )}

      {/* banner — one row per active alarm, sorted most-severe first */}
      {!muted && alarms.length > 0 && (
        <div>
          <div className="flash">
            {alarms.map((a) => {
              const c = a.level === "crit" ? T.crit : T.warn;
              return (
                <div key={a.key} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 16, padding: "10px 12px", background: `${c}1a`, borderTop: `2px solid ${c}`, color: c, letterSpacing: "2.5px", fontWeight: 700, fontSize: 15 }}>
                  <Flame size={19} />
                  <span>{a.message}</span>
                  <span style={{ fontFamily: "var(--font-digit)" }}>{a.valueStr}</span>
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", justifyContent: "center", padding: "8px", background: "#0810199c", borderTop: "1px solid #12203a" }}>
            <button onClick={acknowledge} style={ackBtn(bannerColor)}>ACKNOWLEDGE{alarms.length > 1 ? ` ALL (${alarms.length})` : ""}</button>
          </div>
        </div>
      )}

      {/* demo panel — hidden in coach use; append ?dev to the URL to show it */}
      {showDemo && (
      <div style={{ borderTop: "1px solid #12203a", background: "#0810199c" }}>
        <button onClick={() => setPanelOpen((o) => !o)} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, background: "transparent", border: "none", color: T.dim, padding: "6px", letterSpacing: "3px", fontSize: 11, cursor: "pointer", fontFamily: "var(--font-label)" }}>
          <Sliders size={13} /> DEMO CONTROLS {panelOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
        {panelOpen && (
          <div style={{ padding: "6px 24px 18px", display: "flex", flexWrap: "wrap", gap: 18, alignItems: "center" }}>
            <div style={{ display: "flex", gap: 8 }}>
              <Seg active={mode === "auto"} onClick={() => setMode("auto")} icon={<Play size={14} />} label="AUTO DRIVE" />
              <Seg active={mode === "manual"} onClick={() => setMode("manual")} icon={<Pause size={14} />} label="MANUAL" />
            </div>
            <button onClick={() => setHeat((h) => !h)} style={pill(heat, T.crit, T)}><Flame size={14} /> {heat ? "HEATING…" : "HEAT IT UP (TEST ALERT)"}</button>
            {heat && <button onClick={() => { setHeat(false); setData((d) => ({ ...d, coolant: 196 })); }} style={pill(false, T.dim, T)}><RotateCcw size={13} /> COOL DOWN</button>}
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: T.dim, fontSize: 12, letterSpacing: "1px" }}>
              <FastForward size={14} /> SIM SPEED
              {[1, 50, 250].map((s) => <button key={s} onClick={() => setTimeScale(s)} style={{ ...miniBtn(timeScale === s, T), fontFamily: "var(--font-digit)" }}>{s}×</button>)}
            </div>
            {mode === "manual" && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 18, flex: 1, minWidth: 300 }}>
                <ManualSlider label="Speed" val={data.speed} min={0} max={85} unit="mph" onChange={(v) => setManual("speed", v)} />
                <ManualSlider label="RPM" val={data.rpm} min={0} max={2900} unit="" onChange={(v) => setManual("rpm", v)} />
                <ManualSlider label="Coolant" val={data.coolant} min={120} max={250} unit="°F" onChange={(v) => setManual("coolant", v)} />
                <ManualSlider label="Oil" val={data.oil} min={0} max={80} unit="psi" onChange={(v) => setManual("oil", v)} />
              </div>
            )}
          </div>
        )}
      </div>
      )}

      {showSettings && <SettingsPanel settings={settings} setSettings={setSettings} onClose={() => setShowSettings(false)} night={night}
        profiles={profiles} activeProfileId={activeProfileId} onApplyProfile={applyProfile} onSaveProfileAs={saveProfileAs} onUpdateProfile={updateProfile} onDeleteProfile={deleteProfile} />}

      {showAudioPrompt && (
        <div style={{ position: "absolute", inset: 0, background: "#040810ee", backdropFilter: "blur(3px)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 22, zIndex: 30 }}>
          <div style={{ fontFamily: "var(--font-digit)", fontWeight: 700, fontSize: 30, letterSpacing: "2px" }}>RV Engine Dashboard</div>
          <div style={{ color: T.dim, maxWidth: 440, textAlign: "center", lineHeight: 1.5, fontSize: 15 }}>The temperature alarm needs sound enabled. Tap once to arm the audio — browsers won't play alerts until you do.</div>
          <button onClick={enableAudio} style={{ display: "flex", alignItems: "center", gap: 10, background: T.accent, color: "#04121f", border: "none", padding: "14px 30px", borderRadius: 12, fontWeight: 700, fontSize: 16, letterSpacing: "2px", cursor: "pointer", boxShadow: `0 0 40px ${T.accent}66`, fontFamily: "var(--font-label)" }}><Volume2 size={20} /> ENABLE & START</button>
          <button onClick={() => setShowAudioPrompt(false)} style={{ background: "transparent", border: "none", color: T.dim, cursor: "pointer", fontSize: 13, letterSpacing: "1px", textDecoration: "underline", fontFamily: "var(--font-label)" }}>Continue without sound</button>
        </div>
      )}
    </div>
    </ThemeCtx.Provider>
  );
}

function EconStrip({ eInst, aDist }) {
  const { T } = useUI();
  return (
    <div style={{ display: "flex", gap: 26, marginTop: 18, color: T.dim, fontSize: 13, letterSpacing: "1px" }}>
      <span>NOW <b style={{ color: T.text, fontFamily: "var(--font-digit)", fontSize: 17 }}>{eInst.v}</b> {eInst.u}</span>
      <span>TRIP&nbsp;A <b style={{ color: T.text, fontFamily: "var(--font-digit)", fontSize: 17 }}>{aDist.v.toFixed(1)}</b> {aDist.u}</span>
    </div>
  );
}

/* --------------------------- custom layout editor ------------------------ */
function WidgetView({ w, rectW, rectH, data, trips, su, tu }) {
  const { T } = useUI();
  const ch = CHANNELS[w.source];
  const raw = ch.get(data, trips);
  const cfg = ch.cfg;
  const has = raw != null && !Number.isNaN(raw);
  const zone = cfg && has ? zoneOf(cfg, raw) : "normal";
  const dsp = has ? ch.disp(data, trips, su, tu) : { value: "--", unit: (cfg && cfg.unit) || "" };
  if (w.style === "arc" && ch.arcable && cfg) {
    const size = Math.max(80, Math.min(rectW, rectH));
    return (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
        <div style={{ width: size, height: size }}>
          <ArcGauge id={`wg-${w.id}`} cfg={cfg} value={raw} size={size} displayValue={dsp.value} displayUnit={dsp.unit} />
        </div>
      </div>
    );
  }
  const c = zone === "crit" ? T.crit : zone === "warn" ? T.warn : T.text;
  const fs = Math.max(20, Math.min(rectH * 0.46, rectW * 0.42));
  return (
    <div className={zone === "crit" ? "flash" : undefined} style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1, pointerEvents: "none" }}>
      <div style={{ fontFamily: "var(--font-digit)", fontWeight: 700, lineHeight: 0.9, fontSize: fs, color: c, textShadow: zone === "normal" ? `0 0 20px ${T.accent}44` : "none" }}>{dsp.value}</div>
      <div style={{ color: T.accent, letterSpacing: "3px", fontSize: Math.max(10, fs * 0.2) }}>{dsp.unit}</div>
      <div style={{ color: T.dim, letterSpacing: "2px", fontSize: Math.max(9, fs * 0.15), marginTop: 2 }}>{(cfg && cfg.label) || ch.label.toUpperCase()}</div>
    </div>
  );
}

function EditableCanvas({ widgets, setWidgets, commit, editing, selectedId, setSelectedId, data, trips, su, tu }) {
  const { T } = useUI();
  const ref = useRef(null);
  const drag = useRef(null);
  const [size, setSize] = useState({ w: 900, h: 460 });

  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((es) => { const r = es[0].contentRect; setSize({ w: r.width, h: r.height }); });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!editing) return;
    const move = (e) => {
      if (!drag.current || !ref.current) return;
      const r = ref.current.getBoundingClientRect();
      const cw = r.width / GRID_COLS, chh = r.height / GRID_ROWS;
      const dCol = Math.round((e.clientX - drag.current.startX) / cw);
      const dRow = Math.round((e.clientY - drag.current.startY) / chh);
      const { id, mode, orig } = drag.current;
      setWidgets((ws) => ws.map((x) => {
        if (x.id !== id) return x;
        if (mode === "move") return { ...x, x: Math.max(0, Math.min(GRID_COLS - x.w, orig.x + dCol)), y: Math.max(0, Math.min(GRID_ROWS - x.h, orig.y + dRow)) };
        return { ...x, w: Math.max(1, Math.min(GRID_COLS - x.x, orig.w + dCol)), h: Math.max(1, Math.min(GRID_ROWS - x.y, orig.h + dRow)) };
      }));
    };
    const up = () => { if (drag.current) { drag.current = null; commit(); } };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [editing, setWidgets, commit]);

  const start = (id, mode, e) => {
    e.stopPropagation();
    const w = widgets.find((x) => x.id === id); if (!w) return;
    drag.current = { id, mode, startX: e.clientX, startY: e.clientY, orig: { x: w.x, y: w.y, w: w.w, h: w.h } };
    setSelectedId(id);
  };

  const cw = size.w / GRID_COLS, chh = size.h / GRID_ROWS;

  return (
    <div ref={ref} onPointerDown={() => { if (editing) setSelectedId(null); }}
      style={{ position: "relative", width: "100%", height: "100%", minHeight: 340, touchAction: "none",
        backgroundImage: editing ? `linear-gradient(${T.accent}12 1px, transparent 1px), linear-gradient(90deg, ${T.accent}12 1px, transparent 1px)` : "none",
        backgroundSize: `${cw}px ${chh}px` }}>
      {widgets.map((w) => {
        const sel = editing && selectedId === w.id;
        return (
          <div key={w.id} onPointerDown={(e) => { if (editing) start(w.id, "move", e); }}
            style={{ position: "absolute", left: cw * w.x, top: chh * w.y, width: cw * w.w, height: chh * w.h,
              padding: 5, boxSizing: "border-box", cursor: editing ? "grab" : "default", touchAction: "none",
              border: sel ? `1.5px solid ${T.accent}` : editing ? `1px dashed ${T.accent}44` : "1px solid transparent",
              borderRadius: 12, background: sel ? `${T.accent}0c` : "transparent" }}>
            <WidgetView w={w} rectW={cw * w.w - 12} rectH={chh * w.h - 12} data={data} trips={trips} su={su} tu={tu} />
            {editing && (
              <div onPointerDown={(e) => start(w.id, "resize", e)} title="Resize"
                style={{ position: "absolute", right: 2, bottom: 2, width: 26, height: 26, borderRadius: 6, background: T.accent, cursor: "nwse-resize", display: "flex", alignItems: "center", justifyContent: "center", touchAction: "none", boxShadow: "0 2px 8px #0007" }}>
                <svg width="12" height="12" viewBox="0 0 10 10"><path d="M9 1 L9 9 L1 9" fill="none" stroke="#04121f" strokeWidth="1.8" /></svg>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Inspector({ widget, onChange, onDelete, onClose }) {
  const { T } = useUI();
  const arcable = CHANNELS[widget.source].arcable;
  const styleBtn = (on) => ({ cursor: "pointer", background: on ? `${T.accent}22` : "#0E1826", border: `1px solid ${on ? T.accent : "#1B2A42"}`, color: on ? T.accent : T.dim, padding: "6px 12px", borderRadius: 7, fontSize: 12, fontFamily: "var(--font-label)" });
  return (
    <div style={{ borderTop: `1px solid ${T.accent}33`, background: "#0A121F", padding: "12px 20px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ color: T.dim, letterSpacing: "3px", fontSize: 11 }}>EDIT GAUGE</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onDelete} style={{ display: "flex", alignItems: "center", gap: 6, background: `${T.crit}18`, border: `1px solid ${T.crit}`, color: T.crit, padding: "6px 12px", borderRadius: 8, cursor: "pointer", fontSize: 12, fontFamily: "var(--font-label)" }}><Trash2 size={13} /> Delete</button>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: T.dim, cursor: "pointer" }}><X size={18} /></button>
        </div>
      </div>
      <div style={{ display: "flex", gap: 28, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div>
          <div style={{ color: T.dim, fontSize: 11, marginBottom: 6, letterSpacing: "1px" }}>DATA SOURCE</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxWidth: 620 }}>
            {CHANNEL_KEYS.map((k) => (
              <button key={k} onClick={() => onChange({ source: k, style: (!CHANNELS[k].arcable && widget.style === "arc") ? "digital" : widget.style })}
                style={{ cursor: "pointer", background: widget.source === k ? `${T.accent}22` : "#0E1826", border: `1px solid ${widget.source === k ? T.accent : "#1B2A42"}`, color: widget.source === k ? T.accent : T.dim, padding: "6px 10px", borderRadius: 7, fontSize: 12, fontFamily: "var(--font-label)" }}>
                {CHANNELS[k].label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div style={{ color: T.dim, fontSize: 11, marginBottom: 6, letterSpacing: "1px" }}>STYLE</div>
          <div style={{ display: "flex", gap: 6 }}>
            <button disabled={!arcable} onClick={() => arcable && onChange({ style: "arc" })} style={{ ...styleBtn(widget.style === "arc"), opacity: arcable ? 1 : .4, cursor: arcable ? "pointer" : "not-allowed" }}>Ring</button>
            <button onClick={() => onChange({ style: "digital" })} style={styleBtn(widget.style === "digital")}>Digital</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ settings UI ------------------------------ */
function SettingsPanel({ settings, setSettings, onClose, night, profiles, activeProfileId, onApplyProfile, onSaveProfileAs, onUpdateProfile, onDeleteProfile }) {
  const { T } = useUI();
  const [newName, setNewName] = useState("");
  const set = (patch) => setSettings((s) => ({ ...s, ...patch, themeName: patch.themeName ?? (patch.accent || patch.warn || patch.crit || patch.bg0 ? "Custom" : s.themeName) }));
  const applyPreset = (name) => setSettings((s) => ({ ...s, ...PRESETS[name], themeName: name }));
  const setAccent = (hex) => set({ accent: hex, accentDeep: shade(hex, -0.4), accentBright: shade(hex, 0.45) });
  const saveNew = () => { const n = newName.trim(); if (n) { onSaveProfileAs(n); setNewName(""); } };

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 40, display: "flex", justifyContent: "flex-end" }}>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "#020509cc", backdropFilter: "blur(2px)" }} />
      <div style={{ position: "relative", width: "min(440px, 92vw)", height: "100%", overflowY: "auto", background: "#0A121F", borderLeft: `1px solid ${T.accent}33`, padding: "22px 24px", boxShadow: "-20px 0 60px #0009" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div style={{ fontFamily: "var(--font-digit)", fontWeight: 700, fontSize: 22, letterSpacing: "2px" }}>Settings</div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: T.dim, cursor: "pointer" }}><X size={22} /></button>
        </div>

        <Group T={T} title="DRIVER PROFILES" icon={<User size={13} />}>
          {profiles.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
              {profiles.map((p) => {
                const active = activeProfileId === p.id;
                return (
                  <div key={p.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <button onClick={() => onApplyProfile(p.id)} style={{ flex: 1, textAlign: "left", cursor: "pointer",
                      background: active ? `${T.accent}18` : "#0E1826", border: `1px solid ${active ? T.accent : "#1B2A42"}`, borderRadius: 9, padding: "9px 12px", color: active ? T.accent : T.text, fontFamily: "var(--font-label)", fontSize: 13, letterSpacing: "1px", display: "flex", alignItems: "center", gap: 8 }}>
                      <User size={14} /> {p.name} {active && <Check size={13} style={{ marginLeft: "auto" }} />}
                    </button>
                    <button onClick={() => onUpdateProfile(p.id)} title="Save current setup into this profile" style={{ background: "#0E1826", border: "1px solid #1B2A42", color: T.dim, borderRadius: 8, padding: "8px 10px", cursor: "pointer", fontSize: 11, fontFamily: "var(--font-label)" }}>Update</button>
                    <button onClick={() => onDeleteProfile(p.id)} style={{ background: "transparent", border: "1px solid #24344d", color: T.dim, borderRadius: 8, padding: "8px", cursor: "pointer", display: "flex" }}><Trash2 size={14} /></button>
                  </div>
                );
              })}
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New profile name…"
              onKeyDown={(e) => { if (e.key === "Enter") saveNew(); }}
              style={{ flex: 1, background: "#0E1826", border: "1px solid #1B2A42", borderRadius: 8, padding: "9px 12px", color: T.text, fontFamily: "var(--font-label)", fontSize: 13, outline: "none" }} />
            <button onClick={saveNew} disabled={!newName.trim()} style={{ display: "flex", alignItems: "center", gap: 6, cursor: newName.trim() ? "pointer" : "not-allowed", opacity: newName.trim() ? 1 : .5, background: `${T.accent}22`, border: `1px solid ${T.accent}`, color: T.accent, borderRadius: 8, padding: "9px 14px", fontSize: 12, fontFamily: "var(--font-label)" }}><Plus size={14} /> Save</button>
          </div>
          <div style={{ color: "#3f4f6d", fontSize: 11, marginTop: 8, lineHeight: 1.4 }}>Saves the whole setup — theme, layout, gauges, and units. The last profile you select loads automatically next time.</div>
        </Group>

        <Group T={T} title="LAYOUT THEME" icon={<LayoutGrid size={13} />}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {Object.keys(LAYOUTS).map((k) => {
              const active = settings.layout === k;
              return (
                <button key={k} onClick={() => set({ layout: k })} style={{ textAlign: "left", cursor: "pointer",
                  background: active ? `${T.accent}18` : "#0E1826", border: `1px solid ${active ? T.accent : "#1B2A42"}`, borderRadius: 10, padding: "10px 14px", color: T.text, fontFamily: "var(--font-label)" }}>
                  <div style={{ fontSize: 14, letterSpacing: "1px", color: active ? T.accent : T.text }}>{LAYOUTS[k].label}</div>
                  <div style={{ fontSize: 11.5, color: T.dim, marginTop: 2 }}>{LAYOUTS[k].desc}</div>
                </button>
              );
            })}
          </div>
        </Group>

        <Group T={T} title="COLOR THEME" icon={<Palette size={13} />}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {Object.keys(PRESETS).map((name) => {
              const p = PRESETS[name], active = settings.themeName === name;
              return (
                <button key={name} onClick={() => applyPreset(name)} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer",
                  background: active ? `${p.accent}18` : "#0E1826", border: `1px solid ${active ? p.accent : "#1B2A42"}`, borderRadius: 10, padding: "10px 12px", color: T.text, fontFamily: "var(--font-label)", fontSize: 13, letterSpacing: "1px" }}>
                  <span style={{ width: 22, height: 22, borderRadius: 6, background: `linear-gradient(135deg, ${p.accentDeep}, ${p.accentBright})`, boxShadow: `0 0 10px ${p.accent}88`, flexShrink: 0 }} />
                  {name}
                </button>
              );
            })}
          </div>
        </Group>

        <Group T={T} title="CUSTOM COLORS">
          <Swatches label="Accent" onPick={setAccent} current={settings.accent} options={["#38BDF8", "#22D3EE", "#34D399", "#A78BFA", "#F5A623", "#F472B6", "#DCE6F2", "#FF5555"]} T={T} />
          <div style={{ display: "flex", gap: 14, marginTop: 12 }}>
            <ColorField label="Warning" value={settings.warn} onChange={(v) => set({ warn: v })} T={T} />
            <ColorField label="Critical" value={settings.crit} onChange={(v) => set({ crit: v, critDeep: shade(v, -0.45) })} T={T} />
          </div>
        </Group>

        <Group T={T} title="BACKGROUND">
          <Row>{[["deep", "Deep Space"], ["black", "Pure Black"], ["charcoal", "Charcoal"]].map(([k, lbl]) => (
            <Choice key={k} active={settings.bg === k} onClick={() => set({ bg: k })} T={T}>{lbl}</Choice>))}</Row>
        </Group>

        <Group T={T} title="UNITS">
          <div style={{ display: "flex", gap: 24 }}>
            <div><Sub T={T}>Speed</Sub><Row>
              <Choice active={settings.speedUnit === "mph"} onClick={() => set({ speedUnit: "mph" })} T={T}>MPH</Choice>
              <Choice active={settings.speedUnit === "kph"} onClick={() => set({ speedUnit: "kph" })} T={T}>KPH</Choice></Row></div>
            <div><Sub T={T}>Temperature</Sub><Row>
              <Choice active={settings.tempUnit === "F"} onClick={() => set({ tempUnit: "F" })} T={T}>°F</Choice>
              <Choice active={settings.tempUnit === "C"} onClick={() => set({ tempUnit: "C" })} T={T}>°C</Choice></Row></div>
          </div>
        </Group>

        <Group T={T} title="DAY / NIGHT">
          <Row>
            <Choice active={settings.dayNight === "day"} onClick={() => set({ dayNight: "day" })} T={T} icon={<Sun size={14} />}>Day</Choice>
            <Choice active={settings.dayNight === "night"} onClick={() => set({ dayNight: "night" })} T={T} icon={<Moon size={14} />}>Night</Choice>
            <Choice active={settings.dayNight === "auto"} onClick={() => set({ dayNight: "auto" })} T={T} icon={<Clock size={14} />}>Auto</Choice>
          </Row>
          <label style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14, color: T.dim, fontSize: 13, cursor: "pointer" }}>
            <input type="checkbox" checked={settings.nightRedShift} onChange={(e) => set({ nightRedShift: e.target.checked })} style={{ accentColor: T.accent, width: 16, height: 16 }} />
            Shift to Night Red palette when night is active
            {settings.dayNight === "auto" && <span style={{ opacity: .7 }}>({night ? "night now" : "day now"})</span>}
          </label>
        </Group>
      </div>
    </div>
  );
}
function Group({ title, children, T, icon }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ color: T.dim, letterSpacing: "3px", fontSize: 11, marginBottom: 10, display: "flex", alignItems: "center", gap: 7 }}>{icon}{title}</div>
      {children}
    </div>
  );
}
const Row = ({ children }) => <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{children}</div>;
const Sub = ({ children, T }) => <div style={{ color: T.dim, fontSize: 12, marginBottom: 6, opacity: .8 }}>{children}</div>;
function Choice({ active, onClick, children, icon, T }) {
  return (
    <button onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
      background: active ? `${T.accent}22` : "#0E1826", border: `1px solid ${active ? T.accent : "#1B2A42"}`,
      color: active ? T.accent : T.dim, padding: "8px 14px", borderRadius: 8, fontSize: 12, letterSpacing: "1px", fontFamily: "var(--font-label)" }}>
      {icon}{children}
    </button>
  );
}
function Swatches({ label, options, onPick, current, T }) {
  return (
    <div>
      <Sub T={T}>{label}</Sub>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        {options.map((c) => (
          <button key={c} onClick={() => onPick(c)} style={{ width: 30, height: 30, borderRadius: 8, cursor: "pointer", background: c, border: current === c ? `2px solid #fff` : `2px solid transparent`, boxShadow: `0 0 10px ${c}77` }} />
        ))}
        <label style={{ display: "flex", alignItems: "center", gap: 6, color: T.dim, fontSize: 12, cursor: "pointer" }}>
          <input type="color" value={current} onChange={(e) => onPick(e.target.value)} style={{ width: 30, height: 30, border: "none", background: "transparent", cursor: "pointer" }} /> custom
        </label>
      </div>
    </div>
  );
}
function ColorField({ label, value, onChange, T }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6, color: T.dim, fontSize: 12, cursor: "pointer" }}>
      <span>{label}</span>
      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} style={{ width: 34, height: 30, border: "none", background: "transparent", cursor: "pointer" }} />
        <span style={{ fontFamily: "var(--font-digit)", color: T.text }}>{value.toUpperCase()}</span>
      </span>
    </label>
  );
}

/* ------------------------------ small parts ------------------------------ */
function Tab({ active, onClick, icon, label }) {
  const { T } = useUI();
  return <button onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer", background: active ? `${T.accent}22` : "transparent", border: `1px solid ${active ? T.accent : "#22344f"}`, color: active ? T.accent : T.dim, padding: "7px 16px", borderRadius: 8, letterSpacing: "2px", fontSize: 12, fontFamily: "var(--font-label)" }}>{icon}{label}</button>;
}
function Seg({ active, onClick, icon, label }) {
  const { T } = useUI();
  return <button onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer", background: active ? `${T.accent}22` : "transparent", border: `1px solid ${active ? T.accent : "#22344f"}`, color: active ? T.accent : T.dim, padding: "8px 14px", borderRadius: 8, letterSpacing: "2px", fontSize: 12, fontFamily: "var(--font-label)" }}>{icon}{label}</button>;
}
function HeroStat({ label, value, unit, note, small }) {
  const { T } = useUI();
  return (
    <div style={{ flex: 1, background: "#0b1626", border: "1px solid #16233c", borderRadius: 14, padding: "16px 20px" }}>
      <div style={{ color: T.dim, letterSpacing: "3px", fontSize: 12 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 4 }}>
        <span style={{ fontFamily: "var(--font-digit)", fontWeight: 700, fontSize: small ? 40 : 52, color: T.text, textShadow: `0 0 20px ${T.accent}33` }}>{value}</span>
        <span style={{ color: T.accent, letterSpacing: "2px", fontSize: 15 }}>{unit}</span>
      </div>
      <div style={{ color: "#3f4f6d", fontSize: 11, letterSpacing: "0.5px", marginTop: 2 }}>{note}</div>
    </div>
  );
}
function TripCard({ name, t, onReset, su }) {
  const { T } = useUI();
  const mpg = mpgOf(t.dist, t.fuel); const e = econ(mpg, su); const d = dist(t.dist, su);
  return (
    <div style={{ flex: 1, background: "#0b1626", border: "1px solid #16233c", borderRadius: 14, padding: "18px 22px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <span style={{ color: T.accent, letterSpacing: "3px", fontWeight: 700, fontSize: 15 }}>{name}</span>
        <button onClick={onReset} style={{ display: "flex", alignItems: "center", gap: 6, background: "transparent", border: "1px solid #22344f", color: T.dim, padding: "6px 12px", borderRadius: 8, cursor: "pointer", fontSize: 11, letterSpacing: "1px", fontFamily: "var(--font-label)" }}><RotateCcw size={12} /> RESET</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px 10px" }}>
        <Field label="DISTANCE" value={d.v.toFixed(1)} unit={d.u} />
        <Field label="AVG ECON" value={e.v} unit={e.u} />
        <Field label="DRIVE TIME" value={fmtDur(t.drive)} unit="" />
        <Field label="FUEL USED" value={(su === "kph" ? t.fuel * 3.78541 : t.fuel).toFixed(1)} unit={su === "kph" ? "L" : "gal"} />
      </div>
    </div>
  );
}
function Field({ label, value, unit }) {
  const { T } = useUI();
  return (
    <div>
      <div style={{ color: T.dim, letterSpacing: "2px", fontSize: 11 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
        <span style={{ fontFamily: "var(--font-digit)", fontWeight: 700, fontSize: 30, color: T.text }}>{value}</span>
        {unit && <span style={{ color: T.dim, fontSize: 13 }}>{unit}</span>}
      </div>
    </div>
  );
}
function ManualSlider({ label, val, min, max, unit, onChange }) {
  const { T } = useUI();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 130, flex: 1 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: T.dim, letterSpacing: "1px" }}>
        <span>{label}</span><span style={{ color: T.text, fontFamily: "var(--font-digit)" }}>{Math.round(val)}{unit}</span>
      </div>
      <input type="range" min={min} max={max} value={val} onChange={(e) => onChange(Number(e.target.value))} style={{ width: "100%", accentColor: T.accent }} />
    </div>
  );
}
const ackBtn = (color) => ({ marginLeft: 14, background: color, color: "#0a0a0a", border: "none", padding: "8px 18px", borderRadius: 8, fontWeight: 700, letterSpacing: "2px", fontSize: 13, cursor: "pointer", fontFamily: "var(--font-label)" });
const pill = (active, color, T) => ({ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", background: active ? `${color}22` : "transparent", border: `1px solid ${active ? color : "#22344f"}`, color: active ? color : T.dim, padding: "8px 14px", borderRadius: 8, letterSpacing: "2px", fontSize: 12, fontFamily: "var(--font-label)" });
const miniBtn = (active, T) => ({ background: active ? `${T.accent}22` : "transparent", border: `1px solid ${active ? T.accent : "#22344f"}`, color: active ? T.accent : T.dim, padding: "4px 9px", borderRadius: 6, cursor: "pointer", fontSize: 12 });
