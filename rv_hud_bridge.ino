/*
 * RV HUD Bridge — ESP32 J1939 listen-only CAN reader + BLE broadcaster
 * Target: 2005 Winnebago Journey 39K / Caterpillar C7 / Freightliner XC
 *
 * Hardware:
 *   ESP32 DevKitC + SN65HVD230 CAN transceiver
 *   SN65HVD230 VCC  -> ESP32 3V3
 *   SN65HVD230 GND  -> ESP32 GND
 *   SN65HVD230 CTX  -> GPIO 21   (CAN_TX_PIN)
 *   SN65HVD230 CRX  -> GPIO 22   (CAN_RX_PIN)
 *   SN65HVD230 CANH -> J1939 pin C
 *   SN65HVD230 CANL -> J1939 pin D
 *   Buck converter 5V out -> ESP32 VIN (5V) — NEVER while USB is also plugged in
 *   Buck converter in: J1939 pin B (+12V, ignition-switched) / pin A (GND)
 *
 * Bus: 250 kbps J1939 on pins C/D (black Type I connector — confirmed)
 * Mode: TWAI LISTEN-ONLY. This device physically cannot transmit on the bus.
 *
 * BLE: advertises as "RV-HUD-Bridge", one service, one notify characteristic.
 * Packet: 25-byte packed little-endian struct, sent 4x/second (see BridgePacket).
 * Raw 0xFF.. sentinel values from the ECM ("not available") are passed through
 * as 0xFFFF / 0xFF so the app can show "--" instead of a fake zero.
 *
 * Set DEMO_MODE to 1 to broadcast fabricated engine data for bench-testing
 * the tablet link without being plugged into the coach.
 */

#define DEMO_MODE 0

#include <Arduino.h>
#include "driver/twai.h"
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// ---------- Pins ----------
#define CAN_TX_PIN GPIO_NUM_21
#define CAN_RX_PIN GPIO_NUM_22
#define LED_PIN    2            // onboard LED: blinks with CAN traffic

// ---------- BLE UUIDs (custom, match these in the React app) ----------
#define SERVICE_UUID        "8e7c1a20-4f0d-4c9b-9a3e-5b1f2d6e8a01"
#define CHARACTERISTIC_UUID "8e7c1a21-4f0d-4c9b-9a3e-5b1f2d6e8a01"

// ---------- J1939 PGNs ----------
#define PGN_EEC1   61444  // 0xF004: RPM (SPN 190)
#define PGN_EEC2   61443  // 0xF003: throttle % (SPN 91)
#define PGN_CCVS   65265  // 0xFEF1: wheel speed (SPN 84)
#define PGN_ET1    65262  // 0xFEEE: coolant temp (SPN 110)
#define PGN_EFLP1  65263  // 0xFEEF: oil pressure (SPN 100)
#define PGN_IC1    65270  // 0xFEF6: boost (SPN 102), intake temp (SPN 105)
#define PGN_TRF1   65272  // 0xFEF8: transmission temp (SPN 177)
#define PGN_VEP1   65271  // 0xFEF7: battery voltage (SPN 168)
#define PGN_LFE    65266  // 0xFEF2: fuel rate (SPN 183)
#define PGN_HOURS  65253  // 0xFEE5: engine hours (SPN 247)

// ---------- Packet sent to the tablet ----------
// Little-endian, packed. 0xFFFF / 0xFF / 0xFFFFFFFF = not available yet.
typedef struct __attribute__((packed)) {
  uint8_t  version;        // = 1
  uint8_t  canAlive;       // 1 if a frame was seen in the last 2 s
  uint16_t rpm;            // engine RPM, whole revs
  uint16_t speedKphX100;   // road speed, km/h * 100
  int16_t  coolantCX10;    // coolant temp, degC * 10
  uint16_t oilKpa;         // oil pressure, kPa
  uint16_t boostKpa;       // boost / intake manifold pressure, kPa
  int16_t  intakeCX10;     // intake air temp, degC * 10
  int16_t  transCX10;      // transmission oil temp, degC * 10
  uint16_t battMv;         // battery voltage, millivolts
  uint8_t  throttlePct;    // throttle position, %
  uint16_t fuelLphX100;    // fuel rate, L/h * 100
  uint32_t engineHoursX20; // total engine hours * 20 (0.05 h resolution)
} BridgePacket;

static BridgePacket pkt;
static uint32_t lastFrameMs = 0;
static uint32_t frameCount  = 0;

// ---------- BLE state ----------
static BLECharacteristic *bleChar = nullptr;
static volatile bool deviceConnected = false;

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *s) override {
    deviceConnected = true;
    Serial.println("[BLE] Tablet connected");
  }
  void onDisconnect(BLEServer *s) override {
    deviceConnected = false;
    Serial.println("[BLE] Tablet disconnected — advertising again");
    s->getAdvertising()->start();
  }
};

static void initPacket() {
  pkt.version        = 1;
  pkt.canAlive       = 0;
  pkt.rpm            = 0xFFFF;
  pkt.speedKphX100   = 0xFFFF;
  pkt.coolantCX10    = 0x7FFF;
  pkt.oilKpa         = 0xFFFF;
  pkt.boostKpa       = 0xFFFF;
  pkt.intakeCX10     = 0x7FFF;
  pkt.transCX10      = 0x7FFF;
  pkt.battMv         = 0xFFFF;
  pkt.throttlePct    = 0xFF;
  pkt.fuelLphX100    = 0xFFFF;
  pkt.engineHoursX20 = 0xFFFFFFFF;
}

static void setupBLE() {
  BLEDevice::init("RV-HUD-Bridge");
  BLEDevice::setMTU(185); // packet is 25 B; leave headroom over the 23 B default

  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  BLEService *service = server->createService(SERVICE_UUID);
  bleChar = service->createCharacteristic(
      CHARACTERISTIC_UUID,
      BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  bleChar->addDescriptor(new BLE2902());
  service->start();

  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(SERVICE_UUID);
  adv->setScanResponse(true);
  adv->start();
  Serial.println("[BLE] Advertising as RV-HUD-Bridge");
}

static void setupCAN() {
  twai_general_config_t g =
      TWAI_GENERAL_CONFIG_DEFAULT(CAN_TX_PIN, CAN_RX_PIN, TWAI_MODE_LISTEN_ONLY);
  g.rx_queue_len = 32;
  twai_timing_config_t t = TWAI_TIMING_CONFIG_250KBITS();
  twai_filter_config_t f = TWAI_FILTER_CONFIG_ACCEPT_ALL(); // filter by PGN in software

  if (twai_driver_install(&g, &t, &f) != ESP_OK) {
    Serial.println("[CAN] Driver install FAILED");
    return;
  }
  if (twai_start() != ESP_OK) {
    Serial.println("[CAN] Start FAILED");
    return;
  }
  Serial.println("[CAN] Listening at 250k, LISTEN-ONLY");
}

// Extract the PGN from a 29-bit J1939 identifier.
static uint32_t j1939Pgn(uint32_t id) {
  uint32_t pgn = (id >> 8) & 0x3FFFF;          // EDP+DP+PF+PS
  if (((pgn >> 8) & 0xFF) < 240) pgn &= 0x3FF00; // PDU1: PS is a dest addr, not part of PGN
  return pgn;
}

static inline uint16_t u16le(const uint8_t *d) {
  return (uint16_t)d[0] | ((uint16_t)d[1] << 8);
}
static inline uint32_t u32le(const uint8_t *d) {
  return (uint32_t)d[0] | ((uint32_t)d[1] << 8) |
         ((uint32_t)d[2] << 16) | ((uint32_t)d[3] << 24);
}

static void decodeFrame(const twai_message_t &m) {
  if (!m.extd || m.data_length_code < 8) return; // J1939 is 29-bit, 8-byte frames
  const uint8_t *d = m.data;

  switch (j1939Pgn(m.identifier)) {
    case PGN_EEC1: { // SPN 190: bytes 4-5, 0.125 rpm/bit
      uint16_t raw = u16le(&d[3]);
      if (raw != 0xFFFF) pkt.rpm = (uint16_t)(raw * 0.125f);
      break;
    }
    case PGN_EEC2: { // SPN 91: byte 2, 0.4 %/bit
      if (d[1] != 0xFF) pkt.throttlePct = (uint8_t)(d[1] * 0.4f);
      break;
    }
    case PGN_CCVS: { // SPN 84: bytes 2-3, 1/256 km/h per bit
      uint16_t raw = u16le(&d[1]);
      if (raw != 0xFFFF) pkt.speedKphX100 = (uint16_t)((raw * 100UL) / 256UL);
      break;
    }
    case PGN_ET1: { // SPN 110: byte 1, 1 degC/bit, -40 offset
      if (d[0] != 0xFF) pkt.coolantCX10 = ((int16_t)d[0] - 40) * 10;
      break;
    }
    case PGN_EFLP1: { // SPN 100: byte 4, 4 kPa/bit
      if (d[3] != 0xFF) pkt.oilKpa = (uint16_t)d[3] * 4;
      break;
    }
    case PGN_IC1: { // SPN 102: byte 2, 2 kPa/bit; SPN 105: byte 3, 1 degC -40
      if (d[1] != 0xFF) pkt.boostKpa = (uint16_t)d[1] * 2;
      if (d[2] != 0xFF) pkt.intakeCX10 = ((int16_t)d[2] - 40) * 10;
      break;
    }
    case PGN_TRF1: { // SPN 177: bytes 5-6, 0.03125 degC/bit, -273 offset
      uint16_t raw = u16le(&d[4]);
      if (raw != 0xFFFF)
        pkt.transCX10 = (int16_t)((raw * 0.03125f - 273.0f) * 10.0f);
      break;
    }
    case PGN_VEP1: { // SPN 168: bytes 5-6, 0.05 V/bit
      uint16_t raw = u16le(&d[4]);
      if (raw != 0xFFFF) pkt.battMv = (uint16_t)(raw * 50UL); // 0.05 V = 50 mV
      break;
    }
    case PGN_LFE: { // SPN 183: bytes 1-2, 0.05 L/h per bit
      uint16_t raw = u16le(&d[0]);
      if (raw != 0xFFFF) pkt.fuelLphX100 = (uint16_t)(raw * 5UL); // 0.05*100
      break;
    }
    case PGN_HOURS: { // SPN 247: bytes 1-4, 0.05 h/bit
      uint32_t raw = u32le(&d[0]);
      if (raw != 0xFFFFFFFF) pkt.engineHoursX20 = raw; // already in 0.05 h units
      break;
    }
    default:
      return; // not a PGN we care about
  }
  lastFrameMs = millis();
  frameCount++;
}

#if DEMO_MODE
static void fabricateDemoData() {
  float t = millis() / 1000.0f;
  pkt.rpm            = (uint16_t)(1200 + 600 * (0.5f + 0.5f * sinf(t * 0.3f)));
  pkt.speedKphX100   = (uint16_t)(9500 + 1500 * sinf(t * 0.1f)); // ~55-68 mph
  pkt.coolantCX10    = (int16_t)(880 + 30 * sinf(t * 0.05f));    // ~88-91 C
  pkt.oilKpa         = (uint16_t)(280 + 40 * sinf(t * 0.2f));
  pkt.boostKpa       = (uint16_t)(60 + 50 * (0.5f + 0.5f * sinf(t * 0.4f)));
  pkt.intakeCX10     = 350;
  pkt.transCX10      = 820;
  pkt.battMv         = 13800;
  pkt.throttlePct    = (uint8_t)(30 + 20 * sinf(t * 0.3f));
  pkt.fuelLphX100    = 1450;
  pkt.engineHoursX20 = 123456UL * 20UL / 20UL + (uint32_t)(t / 180.0f);
  lastFrameMs = millis();
}
#endif

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  initPacket();
  setupBLE();
#if !DEMO_MODE
  setupCAN();
#else
  Serial.println("[DEMO] Demo mode ON — broadcasting fabricated engine data");
#endif
}

void loop() {
  static uint32_t lastNotifyMs = 0;
  static uint32_t lastStatsMs  = 0;

#if !DEMO_MODE
  // Drain everything waiting in the RX queue (bus is busy at 250k)
  twai_message_t msg;
  while (twai_receive(&msg, 0) == ESP_OK) {
    decodeFrame(msg);
  }
#else
  fabricateDemoData();
#endif

  uint32_t now = millis();
  pkt.canAlive = (now - lastFrameMs < 2000) ? 1 : 0;
  digitalWrite(LED_PIN, pkt.canAlive && ((now / 250) % 2)); // blink when data flows

  // Notify the tablet 4x/second
  if (now - lastNotifyMs >= 250) {
    lastNotifyMs = now;
    if (deviceConnected && bleChar) {
      bleChar->setValue((uint8_t *)&pkt, sizeof(pkt));
      bleChar->notify();
    }
  }

  // Serial heartbeat every 2 s for bench debugging
  if (now - lastStatsMs >= 2000) {
    lastStatsMs = now;
    Serial.printf("[STATUS] frames=%lu alive=%u rpm=%u kphX100=%u coolC10=%d oilKpa=%u ble=%s\n",
                  (unsigned long)frameCount, pkt.canAlive, pkt.rpm,
                  pkt.speedKphX100, pkt.coolantCX10, pkt.oilKpa,
                  deviceConnected ? "connected" : "advertising");
  }

  delay(5);
}
