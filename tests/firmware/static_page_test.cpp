// SPDX-FileCopyrightText: 2026 FocusDesk contributors
// SPDX-License-Identifier: GPL-3.0-only
#include <algorithm>
#include <cassert>
#include <iostream>
#include <vector>

// Compile the actual sketch setup()/loop(), renderer and unmodified driver.
#include "../../firmware/focusdesk_static/focusdesk_static.ino"

TestSerial Serial;
TestSPI SPI;
enum class Failure { None, PowerOn, Refresh };
Failure failure = Failure::None;
uint32_t clockMs = 0;
int levels[256]{}, modes[256]{};
bool transaction = false;
uint8_t command = 0;
std::vector<uint8_t> commands, image;

unsigned long millis() { return clockMs; }
void delay(unsigned long ms) { clockMs += ms; }
void pinMode(uint8_t pin, int mode) { modes[pin] = mode; }
void digitalWrite(uint8_t pin, int level) { levels[pin] = level; }
int digitalRead(uint8_t pin) {
  if (pin != PIN_BUSY) return levels[pin];
  if (failure == Failure::PowerOn) return LOW;
  if (failure == Failure::Refresh && command == 0x12) return LOW;
  return HIGH;
}
void TestSPI::begin(int sck, int miso, int mosi, int cs) {
  assert(sck == 18 && miso == -1 && mosi == 13 && cs == 5);
}
void TestSPI::beginTransaction(SPISettings) {
  assert(!transaction);
  transaction = true;
}
void TestSPI::endTransaction() {
  assert(transaction);
  transaction = false;
}
uint8_t TestSPI::transfer(uint8_t data) {
  assert(transaction && levels[PIN_CS] == LOW);
  if (levels[PIN_DC] == LOW) {
    command = data;
    commands.push_back(data);
  } else if (command == 0x10) {
    image.push_back(data);
  }
  return 0;
}

void reset(Failure mode) {
  failure = mode;
  clockMs = 0;
  command = 0;
  transaction = false;
  commands.clear();
  image.clear();
  display.calls.clear();
  Serial.output.clear();
  Serial.baud = 0;
}

void assertIdleDoesNotRefresh() {
  const auto commandCount = commands.size();
  const auto callCount = display.calls.size();
  const auto imageSize = image.size();
  const auto log = Serial.output;
  const auto before = clockMs;
  for (int i = 0; i < 20; ++i) loop();
  assert(clockMs == before + 20000);
  assert(commands.size() == commandCount && image.size() == imageSize);
  assert(display.calls.size() == callCount && Serial.output == log);
}

void assertPage() {
  std::vector<std::string> texts;
  std::vector<int> checkboxY;
  int checkStrokes = 0;
  assert(!display.calls.empty() && display.calls.front().kind == "clear");
  for (const auto& c : display.calls) {
    if (c.kind == "text") texts.push_back(c.text);
    if (c.kind == "rect" && c.x == 20 && c.w == 14 && c.h == 14)
      checkboxY.push_back(c.y);
    if (c.kind == "line" && c.x >= 23 && c.x <= 26) {
      ++checkStrokes;
      assert(c.y >= 124 && c.y <= 137 && c.h >= 124 && c.h <= 137);
    }
  }
  const std::vector<std::string> expected = {
      "FocusDesk", "STATIC TEST", "DIAGNOSTIC DATE: 2026-11-02",
      "FIXED SAMPLE / NO NETWORK", "DIAGNOSTIC TASKS", "Check display layout",
      "Inspect text and boxes", "Inspect color patches",
      "SYNTHETIC / NOT LIVE TASKS"};
  // The complete text list also verifies BLACK/RED/YELLOW are absent.
  assert(texts == expected);
  assert((checkboxY == std::vector<int>{124, 160, 196}));
  assert(checkStrokes == 2);
  // All recorded text/rect coordinates are checked by the graphics test double.
}

int main() {
  static_assert(PIN_BUSY == 4 && PIN_CS == 5 && PIN_RST == 16 && PIN_DC == 17);
  static_assert(PIN_SCK == 18 && PIN_MOSI == 13);
  reset(Failure::None);
  setup();
  assert(Serial.baud == 115200);
  assertPage();
  assert(Serial.output.find("[FocusDesk] DISPLAY_OK\n") != std::string::npos);
  assert(Serial.output.find("DISPLAY_FAILED") == std::string::npos);
  const std::vector<uint8_t> expectedCommands = {
      0x4d,0x00,0x06,0x30,0x50,0x61,0xae,0xb0,0xbd,0xbe,0xe9,
      0x04,0x10,0x12,0x02,0x07};
  assert(commands == expectedCommands && image.size() == 30000);
  // The entire former patch/label area is now white in the real framebuffer.
  for (int y = 260; y < 286; ++y) {
    for (int x = 20; x < 172; ++x) {
      const auto pixel = y * 400 + x;
      const auto shift = 6 - (pixel % 4) * 2;
      assert(((image[pixel / 4] >> shift) & 0x03) == 0x01);
    }
  }
  assert(image[0] == 0x55 && !transaction);
  assert(clockMs == 360);  // Bounded 250 ms startup + original reset delays.
  assertIdleDoesNotRefresh();
  std::cout << "PASS: actual renderer, task order/checkboxes, bounds, white footer/no color labels, setup success, idle\n";

  for (const auto mode : {Failure::PowerOn, Failure::Refresh}) {
    reset(mode);
    setup();
    assertPage();
    assert(Serial.output.find("DISPLAY_FAILED: SCREEN_STATE_UNKNOWN\n") != std::string::npos);
    assert(Serial.output.find("DISPLAY_OK") == std::string::npos);
    assert(!transaction);
    assert(std::count(commands.begin(), commands.end(), 0x12) ==
           (mode == Failure::Refresh ? 1 : 0));
    assert(clockMs == (mode == Failure::PowerOn ? 75360U : 60360U));
    assertIdleDoesNotRefresh();
  }
  std::cout << "PASS: power-on/refresh BUSY timeout, screen unknown, no automatic retry\n";
}
