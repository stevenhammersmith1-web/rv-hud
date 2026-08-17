/*
 * RV HUD Sniffer — diagnostic firmware, NOT the production bridge.
 * Flash this temporarily when the dashboard shows no live data, then reflash
 * rv_hud_bridge.ino when you're done.
 *
 * Same wiring as rv_hud_bridge.ino (SN65HVD230 on GPIO 21 TX / 22 RX).
 * Listen-only at every bitrate — it physically cannot transmit, so it is safe
 * to run on the coach's live bus with the engine running.
 *
 * What it answers that the bridge firmware cannot:
 *   1. Is ANY frame arriving?  The bridge only counts the 10 PGNs it decodes,
 *      so a busy bus full of unrecognized PGNs looks identical to a dead wire.
 *   2. Is the bitrate right?  It auto-scans 250k / 500k / 125k.
 *   3. Is the wiring right?  Bus-error counts separate "noise / CANH-CANL
 *      swapped / wrong speed" from "nothing on the wire at all".
 *   4. What does this C7 actually broadcast?  It prints a live PGN histogram
 *      and raw frame dumps so the decode offsets can be verified by hand.
 */

#include <Arduino.h>
#include "driver/twai.h"

#define CAN_TX_PIN GPIO_NUM_21
#define CAN_RX_PIN GPIO_NUM_22
#define LED_PIN    2

#define SCAN_MS      5000   // listen this long per bitrate while scanning
#define RAW_DUMP_MAX 40     // raw frames to print after locking on

typedef struct {
  const char *name;
  twai_timing_config_t timing;
} BitrateOption;

static BitrateOption BITRATES[] = {
  {"250k", TWAI_TIMING_CONFIG_250KBITS()},
  {"500k", TWAI_TIMING_CONFIG_500KBITS()},
  {"125k", TWAI_TIMING_CONFIG_125KBITS()},
};
static const int NUM_BITRATES = sizeof(BITRATES) / sizeof(BITRATES[0]);

// ---------- PGN histogram ----------
typedef struct {
  uint32_t pgn;
  uint8_t  sa;        // source address
  uint32_t count;
  uint8_t  dlc;
  uint8_t  data[8];   // most recent payload
} PgnEntry;

#define MAX_PGNS 64
static PgnEntry pgns[MAX_PGNS];
static int      pgnCount = 0;

static uint32_t totalFrames = 0;
static uint32_t rawDumped   = 0;
static int      lockedIdx   = -1;

static uint32_t j1939Pgn(uint32_t id) {
  uint32_t pgn = (id >> 8) & 0x3FFFF;
  if (((pgn >> 8) & 0xFF) < 240) pgn &= 0x3FF00;  // PDU1: PS is a dest addr
  return pgn;
}

static bool canStart(const twai_timing_config_t &timing) {
  twai_general_config_t g =
      TWAI_GENERAL_CONFIG_DEFAULT(CAN_TX_PIN, CAN_RX_PIN, TWAI_MODE_LISTEN_ONLY);
  g.rx_queue_len = 64;
  twai_timing_config_t t = timing;
  twai_filter_config_t f = TWAI_FILTER_CONFIG_ACCEPT_ALL();

  if (twai_driver_install(&g, &t, &f) != ESP_OK) return false;
  if (twai_start() != ESP_OK) { twai_driver_uninstall(); return false; }
  return true;
}

static void canStop() {
  twai_stop();
  twai_driver_uninstall();
}

static void printStatus(const char *tag) {
  twai_status_info_t s;
  if (twai_get_status_info(&s) != ESP_OK) {
    Serial.printf("  %s: status read failed\n", tag);
    return;
  }
  const char *state = "?";
  switch (s.state) {
    case TWAI_STATE_STOPPED:    state = "STOPPED";    break;
    case TWAI_STATE_RUNNING:    state = "RUNNING";    break;
    case TWAI_STATE_BUS_OFF:    state = "BUS_OFF";    break;
    case TWAI_STATE_RECOVERING: state = "RECOVERING"; break;
  }
  Serial.printf("  %s: state=%s rxErr=%u txErr=%u busErr=%u rxMissed=%u arbLost=%u queued=%u\n",
                tag, state,
                (unsigned)s.rx_error_counter, (unsigned)s.tx_error_counter,
                (unsigned)s.bus_error_count, (unsigned)s.rx_missed_count,
                (unsigned)s.arb_lost_count,  (unsigned)s.msgs_to_rx);
}

static void recordFrame(const twai_message_t &m) {
  totalFrames++;

  uint32_t pgn = m.extd ? j1939Pgn(m.identifier) : 0;
  uint8_t  sa  = m.extd ? (m.identifier & 0xFF) : 0;

  int slot = -1;
  for (int i = 0; i < pgnCount; i++) {
    if (pgns[i].pgn == pgn && pgns[i].sa == sa) { slot = i; break; }
  }
  if (slot < 0 && pgnCount < MAX_PGNS) {
    slot = pgnCount++;
    pgns[slot].pgn   = pgn;
    pgns[slot].sa    = sa;
    pgns[slot].count = 0;
  }
  if (slot >= 0) {
    pgns[slot].count++;
    pgns[slot].dlc = m.data_length_code;
    memcpy(pgns[slot].data, m.data, 8);
  }

  if (rawDumped < RAW_DUMP_MAX) {
    rawDumped++;
    Serial.printf("[RAW] id=0x%08X %s dlc=%u pri=%u pgn=%lu(0x%04lX) sa=%u data=",
                  (unsigned)m.identifier, m.extd ? "ext" : "STD",
                  m.data_length_code, (unsigned)((m.identifier >> 26) & 0x7),
                  (unsigned long)pgn, (unsigned long)pgn, sa);
    for (int i = 0; i < m.data_length_code; i++) Serial.printf("%02X ", m.data[i]);
    Serial.println();
  }
}

static void printHistogram() {
  Serial.printf("[PGNS] %d distinct PGN/source pairs, %lu frames total\n",
                pgnCount, (unsigned long)totalFrames);
  for (int i = 0; i < pgnCount; i++) {
    Serial.printf("  PGN %6lu (0x%04lX) sa=%3u  n=%-7lu last=",
                  (unsigned long)pgns[i].pgn, (unsigned long)pgns[i].pgn,
                  pgns[i].sa, (unsigned long)pgns[i].count);
    for (int b = 0; b < pgns[i].dlc; b++) Serial.printf("%02X ", pgns[i].data[b]);
    Serial.println();
  }
}

// Listen at one bitrate for SCAN_MS and report what showed up.
static uint32_t scanBitrate(int idx) {
  Serial.printf("[SCAN] Trying %s ...\n", BITRATES[idx].name);
  if (!canStart(BITRATES[idx].timing)) {
    Serial.printf("  %s: driver failed to install/start\n", BITRATES[idx].name);
    return 0;
  }

  uint32_t seen  = 0;
  uint32_t start = millis();
  twai_message_t m;
  while (millis() - start < SCAN_MS) {
    while (twai_receive(&m, 0) == ESP_OK) seen++;
    delay(2);
  }
  printStatus(BITRATES[idx].name);
  Serial.printf("  %s: %lu frames in %d ms\n",
                BITRATES[idx].name, (unsigned long)seen, SCAN_MS);
  canStop();
  return seen;
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  delay(600);

  Serial.println();
  Serial.println("========================================");
  Serial.println(" RV HUD SNIFFER — listen-only diagnostic");
  Serial.println("========================================");
  Serial.printf("TX pin=%d RX pin=%d\n", CAN_TX_PIN, CAN_RX_PIN);
  Serial.println("Scanning bitrates. Engine should be RUNNING (or key in ON).");
  Serial.println();

  for (int i = 0; i < NUM_BITRATES; i++) {
    if (scanBitrate(i) > 0) { lockedIdx = i; break; }
  }

  Serial.println();
  if (lockedIdx < 0) {
    Serial.println("[RESULT] NO FRAMES AT ANY BITRATE.");
    Serial.println("  If busErr stayed 0, nothing is reaching the transceiver at all:");
    Serial.println("    - 9-pin not plugged in / key off / wrong pins (want C=CANH, D=CANL)");
    Serial.println("    - SN65HVD230 unpowered, or its Rs pin (8) not tied low -> standby mode");
    Serial.println("    - CANH/CANL open or swapped");
    Serial.println("  If busErr was CLIMBING, the wire is live but misread:");
    Serial.println("    - wrong bitrate, CANH/CANL swapped, or missing/extra termination");
    Serial.println("  Re-running scan in a loop; plug things in and watch.");
  } else {
    Serial.printf("[RESULT] LOCKED ON %s — now dumping raw frames + PGN histogram.\n",
                  BITRATES[lockedIdx].name);
    totalFrames = 0;
    rawDumped   = 0;
    pgnCount    = 0;
    canStart(BITRATES[lockedIdx].timing);
  }
  Serial.println();
}

void loop() {
  static uint32_t lastReport = 0;

  if (lockedIdx < 0) {
    // Nothing found yet — keep rescanning so the user can plug in live.
    for (int i = 0; i < NUM_BITRATES; i++) {
      if (scanBitrate(i) > 0) {
        lockedIdx = i;
        Serial.printf("[RESULT] LOCKED ON %s\n", BITRATES[i].name);
        totalFrames = 0; rawDumped = 0; pgnCount = 0;
        canStart(BITRATES[i].timing);
        break;
      }
    }
    return;
  }

  twai_message_t m;
  while (twai_receive(&m, 0) == ESP_OK) recordFrame(m);

  uint32_t now = millis();
  digitalWrite(LED_PIN, (now / 250) % 2);

  if (now - lastReport >= 3000) {
    lastReport = now;
    printStatus(BITRATES[lockedIdx].name);
    printHistogram();
    Serial.println();
  }
  delay(5);
}
