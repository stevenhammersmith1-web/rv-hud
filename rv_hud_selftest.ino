/*
 * RV HUD Self-Test — bench-only transceiver check. NOT the production bridge.
 *
 * !!! DISCONNECT THE 9-PIN FROM THE COACH BEFORE RUNNING THIS !!!
 * Unlike rv_hud_bridge.ino and rv_hud_sniffer.ino, this firmware TRANSMITS.
 * It must never run while plugged into the vehicle's live J1939 bus.
 *
 * Answers the question the listen-only scan cannot: is the SN65HVD230 itself
 * alive, powered, out of standby, and wired to BOTH ESP32 pins?
 *
 * TEST 1 — RX pin drive check (passive, no transmit)
 *   A powered, active CAN transceiver holds its RX output HIGH (recessive) when
 *   the bus is idle. We test whether GPIO22 is actively driven or just floating
 *   by pulling it both ways with the internal pull resistors:
 *     - Stays HIGH against an internal pulldown -> actively driven. Transceiver
 *       is powered and out of standby. GOOD.
 *     - Follows whichever pull is applied      -> floating. Nothing is driving
 *       it: transceiver unpowered, in standby (Rs pin 8 not tied low), or the
 *       CRX wire to GPIO22 is broken.
 *
 * TEST 2 — TWAI loopback (transmits!)
 *   Sends a frame in NO_ACK mode with self-reception requested. The frame goes
 *   out CTX -> transceiver -> CANH/CANL -> back in CRX. Receiving our own frame
 *   proves the whole ESP32 <-> transceiver path works in both directions.
 *   No second node and no ACK are needed. Failure with rising txErr means TX
 *   reached the wire but nothing echoed back.
 */

#include <Arduino.h>
#include "driver/twai.h"

#define CAN_TX_PIN GPIO_NUM_21
#define CAN_RX_PIN GPIO_NUM_22
#define RX_GPIO    22
#define TX_GPIO    21

static void printStatus(const char *tag) {
  twai_status_info_t s;
  if (twai_get_status_info(&s) != ESP_OK) { Serial.printf("  %s: status read failed\n", tag); return; }
  const char *st = "?";
  switch (s.state) {
    case TWAI_STATE_STOPPED:    st = "STOPPED";    break;
    case TWAI_STATE_RUNNING:    st = "RUNNING";    break;
    case TWAI_STATE_BUS_OFF:    st = "BUS_OFF";    break;
    case TWAI_STATE_RECOVERING: st = "RECOVERING"; break;
  }
  Serial.printf("  %s: state=%s rxErr=%u txErr=%u busErr=%u txFailed=%u\n",
                tag, st, (unsigned)s.rx_error_counter, (unsigned)s.tx_error_counter,
                (unsigned)s.bus_error_count, (unsigned)s.tx_failed_count);
}

// Sample a pin many times; returns fraction of samples that read HIGH.
static float sampleHigh(int pin, int mode) {
  pinMode(pin, mode);
  delay(20);
  int high = 0;
  for (int i = 0; i < 200; i++) { if (digitalRead(pin)) high++; delayMicroseconds(200); }
  return high / 200.0f;
}

static void testRxDrive() {
  Serial.println("TEST 1 — CAN RX pin (GPIO22) drive check");

  float up   = sampleHigh(RX_GPIO, INPUT_PULLUP);
  float down = sampleHigh(RX_GPIO, INPUT_PULLDOWN);
  float open = sampleHigh(RX_GPIO, INPUT);

  Serial.printf("  with pullup:   %.0f%% high\n", up   * 100);
  Serial.printf("  with pulldown: %.0f%% high\n", down * 100);
  Serial.printf("  floating:      %.0f%% high\n", open * 100);

  if (down > 0.9f && up > 0.9f) {
    Serial.println("  => ACTIVELY DRIVEN HIGH. Transceiver is powered, out of");
    Serial.println("     standby, and CRX->GPIO22 is intact. GOOD.");
  } else if (down < 0.1f && up > 0.9f) {
    Serial.println("  => FLOATING (follows the pull). Nothing is driving GPIO22:");
    Serial.println("     - SN65HVD230 has no 3.3V on VCC, or");
    Serial.println("     - Rs (pin 8) is not tied low -> chip is in standby, or");
    Serial.println("     - the CRX wire to GPIO22 is broken/not connected.");
  } else if (down < 0.1f && up < 0.1f) {
    Serial.println("  => HELD LOW. Stuck dominant: transceiver fault, or CANH/CANL");
    Serial.println("     shorted together, or CRX shorted to GND.");
  } else {
    Serial.println("  => UNSTABLE / noisy. Marginal wiring or a floating input");
    Serial.println("     picking up interference.");
  }
  Serial.println();
}

/*
 * Static driver test. Bit-bangs CTX directly (no CAN timing involved) and
 * watches CRX. A working, non-standby transceiver echoes the level back:
 * TXD low = dominant -> both bus lines split -> its own receiver reads dominant
 * -> RXD goes low. Because this is static, it works even with no termination,
 * which is exactly what makes it able to tell a dead/standby DRIVER apart from
 * a mere termination/slew problem at 250 kbps.
 */
static void testStaticDriver() {
  Serial.println("TEST 3 — static driver check (bit-bang CTX, watch CRX)");

  pinMode(RX_GPIO, INPUT);
  pinMode(TX_GPIO, OUTPUT);

  digitalWrite(TX_GPIO, HIGH);       // recessive
  delay(5);
  int recessive = 0;
  for (int i = 0; i < 100; i++) { if (digitalRead(RX_GPIO)) recessive++; delayMicroseconds(100); }

  digitalWrite(TX_GPIO, LOW);        // dominant
  delay(5);
  int dominant = 0;
  for (int i = 0; i < 100; i++) { if (digitalRead(RX_GPIO)) dominant++; delayMicroseconds(100); }

  digitalWrite(TX_GPIO, HIGH);       // leave the bus recessive
  pinMode(TX_GPIO, INPUT);

  Serial.printf("  CTX high (recessive): CRX %d%% high\n", recessive);
  Serial.printf("  CTX low  (dominant):  CRX %d%% high\n", dominant);

  if (recessive > 90 && dominant < 10) {
    Serial.println("  => DRIVER WORKS, BUS CLEAN. Round trip intact, chip not in standby,");
    Serial.println("     and the recessive state is stable (termination present).");
  } else if (dominant < 10 && recessive > 40) {
    Serial.println("  => DRIVER WORKS, BUS UNTERMINATED. Dominant is driven and read back");
    Serial.println("     correctly, so CTX/CRX wiring and the transceiver are both GOOD and");
    Serial.printf("     the chip is NOT in standby. But recessive only held %d%% - with no\n", recessive);
    Serial.println("     120 ohm across CANH/CANL the lines float and ring when released,");
    Serial.println("     so the receiver output chatters. That fully explains the 250k");
    Serial.println("     loopback failure and the high busErr count.");
    Serial.println("     THIS IS A BENCH ARTIFACT, not a fault. The coach bus is terminated");
    Serial.println("     at both ends. To confirm here, put a 120 ohm resistor across");
    Serial.println("     CANH/CANL and re-run: recessive should go to ~100% and TEST 2 pass.");
  } else if (recessive > 90 && dominant > 90) {
    Serial.println("  => DRIVER NOT WORKING. CRX never followed CTX to dominant. Check,");
    Serial.println("     in this order:");
    Serial.println("     1. Rs (pin 8) must be tied to GND (directly or via <=10k).");
    Serial.println("        Floating or tied to VCC = standby: receiver on, DRIVER OFF.");
    Serial.println("        This also slows the receiver and can break 250k reception.");
    Serial.println("     2. GPIO21 -> CTX/D wire continuity.");
    Serial.println("     3. Transceiver VCC must be 3.3V (NOT 5V - the HVD230 is a");
    Serial.println("        3.3V part and 5V on VCC damages it).");
  } else {
    Serial.println("  => AMBIGUOUS / inverted. Check that CTX is on GPIO21 and CRX on");
    Serial.println("     GPIO22 and that they are not swapped.");
  }
  Serial.println();
}

static void testLoopback() {
  Serial.println("TEST 2 — TWAI loopback (TRANSMITS — 9-pin must be unplugged)");

  twai_general_config_t g =
      TWAI_GENERAL_CONFIG_DEFAULT(CAN_TX_PIN, CAN_RX_PIN, TWAI_MODE_NO_ACK);
  g.rx_queue_len = 16;
  twai_timing_config_t t = TWAI_TIMING_CONFIG_250KBITS();
  twai_filter_config_t f = TWAI_FILTER_CONFIG_ACCEPT_ALL();

  if (twai_driver_install(&g, &t, &f) != ESP_OK) { Serial.println("  driver install FAILED"); return; }
  if (twai_start() != ESP_OK) { Serial.println("  start FAILED"); twai_driver_uninstall(); return; }

  int sent = 0, echoed = 0;
  for (int i = 0; i < 5; i++) {
    twai_message_t tx = {};
    tx.identifier        = 0x18FF5000UL + i;  // proprietary PGN range, harmless
    tx.extd              = 1;
    tx.self              = 1;                 // request self-reception
    tx.data_length_code  = 8;
    for (int b = 0; b < 8; b++) tx.data[b] = (uint8_t)(0xA0 + b + i);

    if (twai_transmit(&tx, pdMS_TO_TICKS(200)) == ESP_OK) {
      sent++;
      twai_message_t rx;
      uint32_t start = millis();
      bool got = false;
      while (millis() - start < 200) {
        if (twai_receive(&rx, pdMS_TO_TICKS(50)) == ESP_OK) {
          if (rx.identifier == tx.identifier) {
            got = true;
            Serial.printf("  echo %d: id=0x%08X data=", i, (unsigned)rx.identifier);
            for (int b = 0; b < rx.data_length_code; b++) Serial.printf("%02X ", rx.data[b]);
            Serial.println();
            break;
          }
        }
      }
      if (got) echoed++;
      else Serial.printf("  echo %d: NOT RECEIVED\n", i);
    } else {
      Serial.printf("  frame %d: transmit queue/send failed\n", i);
    }
    delay(100);
  }

  printStatus("after loopback");
  Serial.printf("  sent=%d echoed=%d\n", sent, echoed);

  if (echoed == sent && sent > 0) {
    Serial.println("  => PASS. Full path works: GPIO21 -> transceiver -> CANH/CANL");
    Serial.println("     -> transceiver -> GPIO22. The bridge hardware is GOOD.");
    Serial.println("     A no-data fault is then on the vehicle side: connector");
    Serial.println("     pins, the coach bus itself, or the ECM not broadcasting.");
  } else if (echoed == 0) {
    Serial.println("  => FAIL. Nothing echoed back. TX may reach the wire but the");
    Serial.println("     return path is dead: transceiver unpowered/standby, CANH-CANL");
    Serial.println("     open (no termination at all), or CRX not landing on GPIO22.");
  } else {
    Serial.println("  => INTERMITTENT. Some frames echoed. Marginal wiring,");
    Serial.println("     bad solder joint, or missing termination.");
  }

  twai_stop();
  twai_driver_uninstall();
  Serial.println();
}

void setup() {
  Serial.begin(115200);
  delay(800);
  Serial.println();
  Serial.println("==========================================");
  Serial.println(" RV HUD SELF-TEST — BENCH ONLY, TRANSMITS");
  Serial.println(" Unplug the 9-pin from the coach first!");
  Serial.println("==========================================");
  Serial.println();
  testRxDrive();
  testStaticDriver();
  testLoopback();
  Serial.println("=== self-test complete, repeating in 10 s ===");
  Serial.println();
}

void loop() {
  delay(10000);
  testRxDrive();
  testStaticDriver();
  testLoopback();
}
