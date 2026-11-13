// SPDX-FileCopyrightText: 2026 FocusDesk contributors
// SPDX-License-Identifier: GPL-3.0-only
#include <cassert>
#include <fstream>
#include <iostream>
#include <iterator>
#include <vector>
#include "../../firmware/focusdesk_live/live_page.h"

TestSerial Serial;
TestSPI SPI;
uint32_t clockMs = 0;
int levels[256]{};
uint8_t command = 0;
std::vector<uint8_t> image;
unsigned long millis() { return clockMs; }
void delay(unsigned long value) { clockMs += value; }
void pinMode(uint8_t, int) {}
void digitalWrite(uint8_t pin, int value) { levels[pin] = value; }
int digitalRead(uint8_t) { return HIGH; }
void TestSPI::begin(int, int, int, int) {}
void TestSPI::beginTransaction(SPISettings) {}
void TestSPI::endTransaction() {}
uint8_t TestSPI::transfer(uint8_t value) {
  if (levels[PIN_DC] == LOW) command = value;
  else if (command == 0x10) image.push_back(value);
  return 0;
}

int main(int argc, char** argv) {
  assert(argc >= 2);
  const bool focus = argc > 2 && (std::string(argv[2]) == "focus" || std::string(argv[2]) == "focus-long");
  std::ifstream source(focus ? "contracts/fixtures/focus.json" : "contracts/fixtures/device-demo.json", std::ios::binary);
  assert(source.good());
  const std::string body{std::istreambuf_iterator<char>(source), std::istreambuf_iterator<char>()};
  focusdesk::Overview overview;
  const char* error = nullptr;
  assert(focusdesk::parseOverview(body.data(), body.size(), overview, error));
  if (argc > 2 && std::string(argv[2]) == "empty") overview.count = 0;
  if (argc > 2 && std::string(argv[2]) == "done")
    for (size_t i = 0; i < overview.count; ++i) overview.tasks[i].done = true;
  if (argc > 2 && (std::string(argv[2]) == "long" || std::string(argv[2]) == "focus-long"))
    overview.tasks[0].title = std::string(40, 'W');
  GDEM042F52Display display;
  assert(display.begin());
  focusdesk::drawOverview(display, overview);
  assert(display.update() && image.size() == 30000);
  std::ofstream output(argv[1], std::ios::binary);
  assert(output.good());
  output << "P6\n400 300\n255\n";
  // Four-color illustration palette; physical pigment colors may differ.
  const unsigned char palette[4][3] = {{20,20,18},{252,251,244},{255,219,65},{200,44,36}};
  for (size_t i = 0; i < 400 * 300; ++i) {
    const uint8_t color = (image[i / 4] >> (6 - (i % 4) * 2)) & 3;
    output.write(reinterpret_cast<const char*>(palette[color]), 3);
  }
  output.close(); assert(output.good());
  std::cout << "PASS: 400x300 renderer preview from packed driver framebuffer\n";
}
