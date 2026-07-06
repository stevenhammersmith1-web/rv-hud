/*
 * bridgeConnection.jsx — Web Bluetooth link to the RV-HUD-Bridge (ESP32)
 *
 * Pairs with rv_hud_bridge.ino firmware v1:
 *   Device name:    "RV-HUD-Bridge"
 *   Service UUID:   8e7c1a20-4f0d-4c9b-9a3e-5b1f2d6e8a01
 *   Characteristic: 8e7c1a21-4f0d-4c9b-9a3e-5b1f2d6e8a01
 *   Packet:         25-byte packed little-endian struct, notified at 4 Hz
 *
 * WHAT THIS EXPORTS
 *   useBridgeConnection()  — React hook: live data + connection state + controls
 *   BridgeStatus           — drop-in status pill / connect button component
 *   parseBridgePacket()    — exported separately for unit testing
 *
 * INTEGRATION (in the dashboard):
 *   const bridge = useBridgeConnection();
 *   const channels = bridge.connected ? bridge.data : simulatorData;
 *   // bridge.data uses null for any channel the ECM hasn't reported yet,
 *   // so gauges should render "--" for null, same as the sim's warm-up state.
 *
 * Data is delivered in the same base units the CONFIG conversion layer
 * already expects (metric raw): rpm, speedKph, coolantC, oilKpa, boostKpa,
 * intakeC, transC, battV, throttlePct, fuelLph, engineHours, canAlive.
 *
 * AUTO-CONNECT BEHAVIOR
 *   First ever connection requires one tap (browser security rule — the
 *   device picker can only open from a user gesture). After that, the
 *   permission is remembered by Chrome. On every subsequent page load this
 *   module calls navigator.bluetooth.getDevices(), finds the remembered
 *   bridge, and silently retries gatt.connect() until the ESP32 powers up —
 *   which is exactly the ignition-on scenario. No tap needed.
 *
 *   On the tablet, enable this Chrome flag once (required for getDevices):
 *     chrome://flags/#enable-web-bluetooth-new-permissions-backend  → Enabled
 *   If the flag/API is unavailable, the hook falls back gracefully and the
 *   BridgeStatus pill shows "Tap to connect" instead.
 */

import { useCallback, useEffect, useRef, useState } from "react";

// ---------- Constants (must match firmware) ----------
export const BRIDGE_NAME = "RV-HUD-Bridge";
export const SERVICE_UUID = "8e7c1a20-4f0d-4c9b-9a3e-5b1f2d6e8a01";
export const CHARACTERISTIC_UUID = "8e7c1a21-4f0d-4c9b-9a3e-5b1f2d6e8a01";

const PACKET_LENGTH = 25;
const PACKET_VERSION = 1;
const STALE_MS = 2000;        // no notify for 2 s → mark data stale
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 8000; // backoff cap while waiting for ignition

// ---------- Packet parser ----------
// Struct layout (packed, little-endian):
//  off  type     field
//   0   uint8    version
//   1   uint8    canAlive
//   2   uint16   rpm             (0xFFFF = n/a)
//   4   uint16   speedKphX100    (0xFFFF = n/a)
//   6   int16    coolantCX10     (0x7FFF = n/a)
//   8   uint16   oilKpa          (0xFFFF = n/a)
//  10   uint16   boostKpa        (0xFFFF = n/a)
//  12   int16    intakeCX10      (0x7FFF = n/a)
//  14   int16    transCX10       (0x7FFF = n/a)
//  16   uint16   battMv          (0xFFFF = n/a)
//  18   uint8    throttlePct     (0xFF   = n/a)
//  19   uint16   fuelLphX100     (0xFFFF = n/a)
//  21   uint32   engineHoursX20  (0xFFFFFFFF = n/a)
export function parseBridgePacket(dataView) {
  if (dataView.byteLength < PACKET_LENGTH) return null;
  const version = dataView.getUint8(0);
  if (version !== PACKET_VERSION) return null;

  const u16 = (off) => {
    const v = dataView.getUint16(off, true);
    return v === 0xffff ? null : v;
  };
  const i16 = (off) => {
    const v = dataView.getInt16(off, true);
    return v === 0x7fff ? null : v;
  };

  const rpm = u16(2);
  const speedRaw = u16(4);
  const coolRaw = i16(6);
  const oilKpa = u16(8);
  const boostKpa = u16(10);
  const intakeRaw = i16(12);
  const transRaw = i16(14);
  const battRaw = u16(16);
  const thrRaw = dataView.getUint8(18);
  const fuelRaw = u16(19);
  const hoursRaw = dataView.getUint32(21, true);

  return {
    version,
    canAlive: dataView.getUint8(1) === 1,
    rpm,
    speedKph: speedRaw === null ? null : speedRaw / 100,
    coolantC: coolRaw === null ? null : coolRaw / 10,
    oilKpa,
    boostKpa,
    intakeC: intakeRaw === null ? null : intakeRaw / 10,
    transC: transRaw === null ? null : transRaw / 10,
    battV: battRaw === null ? null : battRaw / 1000,
    throttlePct: thrRaw === 0xff ? null : thrRaw,
    fuelLph: fuelRaw === null ? null : fuelRaw / 100,
    engineHours: hoursRaw === 0xffffffff ? null : hoursRaw / 20,
  };
}

// ---------- Connection states ----------
export const BridgeState = {
  UNSUPPORTED: "unsupported", // browser has no Web Bluetooth
  IDLE: "idle",               // never connected, needs a tap
  SEARCHING: "searching",     // auto-connect loop waiting for the ESP32
  CONNECTING: "connecting",   // GATT handshake in progress
  CONNECTED: "connected",     // notifications flowing
  STALE: "stale",             // connected but no packet in 2 s
  DISCONNECTED: "disconnected", // lost link, retrying
};

// ---------- The hook ----------
export function useBridgeConnection({ autoConnect = true } = {}) {
  const [state, setState] = useState(
    typeof navigator !== "undefined" && navigator.bluetooth
      ? BridgeState.IDLE
      : BridgeState.UNSUPPORTED
  );
  const [data, setData] = useState(null);
  const [lastPacketAt, setLastPacketAt] = useState(0);
  const [error, setError] = useState(null);

  const deviceRef = useRef(null);
  const charRef = useRef(null);
  const retryTimerRef = useRef(null);
  const staleTimerRef = useRef(null);
  const stoppedRef = useRef(false); // true after user-initiated disconnect
  const backoffRef = useRef(RECONNECT_BASE_MS);

  const clearTimers = () => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    if (staleTimerRef.current) clearTimeout(staleTimerRef.current);
    retryTimerRef.current = null;
    staleTimerRef.current = null;
  };

  const armStaleWatchdog = useCallback(() => {
    if (staleTimerRef.current) clearTimeout(staleTimerRef.current);
    staleTimerRef.current = setTimeout(() => {
      setState((s) => (s === BridgeState.CONNECTED ? BridgeState.STALE : s));
    }, STALE_MS);
  }, []);

  const handleNotification = useCallback(
    (event) => {
      const parsed = parseBridgePacket(event.target.value);
      if (!parsed) return;
      setData(parsed);
      setLastPacketAt(Date.now());
      setState(BridgeState.CONNECTED);
      backoffRef.current = RECONNECT_BASE_MS; // healthy link resets backoff
      armStaleWatchdog();
    },
    [armStaleWatchdog]
  );

  // Connect (or reconnect) to an already-permitted BluetoothDevice
  const connectToDevice = useCallback(
    async (device) => {
      deviceRef.current = device;
      setState(BridgeState.CONNECTING);
      setError(null);
      try {
        const server = await device.gatt.connect();
        const service = await server.getPrimaryService(SERVICE_UUID);
        const char = await service.getCharacteristic(CHARACTERISTIC_UUID);
        charRef.current = char;
        await char.startNotifications();
        char.addEventListener("characteristicvaluechanged", handleNotification);
        setState(BridgeState.CONNECTED);
        armStaleWatchdog();
      } catch (err) {
        // ESP32 probably not powered yet (ignition off) — schedule a retry
        scheduleRetry();
        throw err;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [handleNotification, armStaleWatchdog]
  );

  const scheduleRetry = useCallback(() => {
    if (stoppedRef.current || !deviceRef.current) return;
    setState(BridgeState.SEARCHING);
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = setTimeout(async () => {
      if (stoppedRef.current || !deviceRef.current) return;
      try {
        await connectToDevice(deviceRef.current);
      } catch {
        /* connectToDevice reschedules on failure */
      }
    }, backoffRef.current);
    backoffRef.current = Math.min(backoffRef.current * 2, RECONNECT_MAX_MS);
  }, [connectToDevice]);

  // GATT disconnect handler → auto-reconnect loop
  useEffect(() => {
    const device = deviceRef.current;
    if (!device) return;
    const onDisconnect = () => {
      setState(BridgeState.DISCONNECTED);
      setData(null);
      backoffRef.current = RECONNECT_BASE_MS;
      scheduleRetry();
    };
    device.addEventListener("gattserverdisconnected", onDisconnect);
    return () =>
      device.removeEventListener("gattserverdisconnected", onDisconnect);
    // Re-bind whenever state flips to a connected-ish value (deviceRef set)
  }, [state, scheduleRetry]);

  // First-time connect — MUST be called from a user gesture (button tap)
  const connect = useCallback(async () => {
    if (!navigator.bluetooth) return;
    stoppedRef.current = false;
    setError(null);
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ name: BRIDGE_NAME }],
        optionalServices: [SERVICE_UUID],
      });
      await connectToDevice(device);
    } catch (err) {
      if (err.name === "NotFoundError") {
        // User closed the picker — stay idle, no error banner
        setState(BridgeState.IDLE);
      } else {
        setError(err.message || String(err));
      }
    }
  }, [connectToDevice]);

  // User-initiated disconnect (kills the retry loop too)
  const disconnect = useCallback(() => {
    stoppedRef.current = true;
    clearTimers();
    const char = charRef.current;
    if (char) {
      try {
        char.removeEventListener(
          "characteristicvaluechanged",
          handleNotification
        );
      } catch {
        /* ignore */
      }
    }
    const device = deviceRef.current;
    if (device?.gatt?.connected) device.gatt.disconnect();
    charRef.current = null;
    setData(null);
    setState(BridgeState.IDLE);
  }, [handleNotification]);

  // Silent auto-connect on page load (the "turn the key and it's live" path).
  // Uses getDevices() to find the previously-permitted bridge, then retries
  // gatt.connect() with backoff until the ESP32 powers up on ignition.
  useEffect(() => {
    if (!autoConnect) return;
    if (!navigator.bluetooth) return;
    if (typeof navigator.bluetooth.getDevices !== "function") return; // flag off → fall back to tap
    let cancelled = false;
    (async () => {
      try {
        const devices = await navigator.bluetooth.getDevices();
        const bridge = devices.find((d) => d.name === BRIDGE_NAME);
        if (!bridge || cancelled) return;
        stoppedRef.current = false;
        deviceRef.current = bridge;
        try {
          await connectToDevice(bridge);
        } catch {
          /* retry loop is already scheduled */
        }
      } catch {
        /* getDevices failed — stay idle, tap-to-connect still works */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoConnect]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stoppedRef.current = true;
      clearTimers();
      const device = deviceRef.current;
      if (device?.gatt?.connected) device.gatt.disconnect();
    };
  }, []);

  const connected =
    state === BridgeState.CONNECTED || state === BridgeState.STALE;

  return {
    state,          // one of BridgeState.*
    connected,      // convenience boolean (true even while stale)
    live: state === BridgeState.CONNECTED, // fresh packets flowing
    data,           // parsed channels (nulls for n/a) or null
    lastPacketAt,   // epoch ms of most recent packet
    error,          // last connection error message, if any
    connect,        // call from a button tap for first-time pairing
    disconnect,     // user-initiated stop (disables auto-retry)
  };
}

// ---------- Status pill / connect button ----------
// Deliberately theme-neutral: colors come in via props so it inherits the
// active dashboard theme. Drop it in the header bar next to the day/night
// toggle. All states are one tap or zero taps.
const PILL_LABELS = {
  [BridgeState.UNSUPPORTED]: "Bluetooth unavailable",
  [BridgeState.IDLE]: "Tap to connect",
  [BridgeState.SEARCHING]: "Waiting for bridge…",
  [BridgeState.CONNECTING]: "Connecting…",
  [BridgeState.CONNECTED]: "Live",
  [BridgeState.STALE]: "No data",
  [BridgeState.DISCONNECTED]: "Reconnecting…",
};

export function BridgeStatus({
  bridge,               // return value of useBridgeConnection()
  liveColor = "#2ecc71",
  waitColor = "#f1c40f",
  offColor = "#e74c3c",
  textColor = "#ffffff",
  background = "rgba(255,255,255,0.08)",
}) {
  const { state, connect, disconnect } = bridge;

  const dotColor =
    state === BridgeState.CONNECTED
      ? liveColor
      : state === BridgeState.SEARCHING ||
        state === BridgeState.CONNECTING ||
        state === BridgeState.DISCONNECTED
      ? waitColor
      : offColor;

  const pulsing =
    state === BridgeState.SEARCHING ||
    state === BridgeState.CONNECTING ||
    state === BridgeState.DISCONNECTED;

  const onTap = () => {
    if (state === BridgeState.IDLE) connect();
    else if (
      state === BridgeState.CONNECTED ||
      state === BridgeState.STALE ||
      state === BridgeState.SEARCHING ||
      state === BridgeState.DISCONNECTED
    ) {
      // Long-press semantics are overkill on a dash — a tap toggles off.
      disconnect();
    }
  };

  return (
    <button
      onClick={onTap}
      disabled={state === BridgeState.UNSUPPORTED}
      aria-label={`Bridge connection: ${PILL_LABELS[state]}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 14px",
        borderRadius: 999,
        border: "1px solid rgba(255,255,255,0.15)",
        background,
        color: textColor,
        font: "600 13px/1 system-ui, sans-serif",
        letterSpacing: "0.04em",
        cursor: state === BridgeState.UNSUPPORTED ? "default" : "pointer",
        opacity: state === BridgeState.UNSUPPORTED ? 0.5 : 1,
        WebkitTapHighlightColor: "transparent",
      }}
    >
      <span
        style={{
          width: 9,
          height: 9,
          borderRadius: "50%",
          background: dotColor,
          animation: pulsing ? "bridgePulse 1.2s ease-in-out infinite" : "none",
        }}
      />
      {PILL_LABELS[state]}
      <style>{`
        @keyframes bridgePulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        @media (prefers-reduced-motion: reduce) {
          @keyframes bridgePulse { 0%, 100% { opacity: 1; } }
        }
      `}</style>
    </button>
  );
}
