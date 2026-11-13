// SPDX-FileCopyrightText: 2026 FocusDesk contributors
// SPDX-License-Identifier: GPL-3.0-only
#define FOCUSDESK_HOST_TEST 1
#ifdef FOCUSDESK_TEST_CONFIGURED
#define FOCUSDESK_WIFI_SSID "HostTestNetwork"
#define FOCUSDESK_WIFI_PASSWORD ""
#define FOCUSDESK_API_URL "http://192.0.2.1:8787/api/v1/daily-overview"
#endif
#include <cassert>
#include <fstream>
#include <iostream>
#include <iterator>
#include "../../firmware/focusdesk_live/focusdesk_live.ino"

TestSerial Serial;
TestSPI SPI;
FakeWiFi WiFi;
FakeHttp fakeHttp;
uint32_t clockMs = 0;
bool stuckBusy = false;
size_t refreshes = 0;
uint8_t command = 0;
int levels[256]{};
unsigned long millis() { return clockMs; }
void delay(unsigned long value) { clockMs += value; }
void pinMode(uint8_t, int) {}
void digitalWrite(uint8_t pin, int value) { levels[pin] = value; }
int digitalRead(uint8_t pin) { return pin == PIN_BUSY && stuckBusy ? LOW : HIGH; }
void TestSPI::begin(int, int, int, int) {}
void TestSPI::beginTransaction(SPISettings) {}
void TestSPI::endTransaction() {}
uint8_t TestSPI::transfer(uint8_t value) {
  if (levels[PIN_DC] == LOW) {
    command = value;
    if (value == 0x12) ++refreshes;
  }
  return 0;
}
std::string seedBody() {
  std::ifstream stream("contracts/fixtures/device-demo.json", std::ios::binary);
  assert(stream.good());
  return {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}
void resetResponse(const std::string& body) {
  fakeHttp = FakeHttp(); fakeHttp.body = body;
}
void assertFetchRejected() {
  const auto count = refreshes;
  const auto revision = lastValid.revision;
  focusdesk::Overview output;
  output.revision = "UNCHANGED_OUTPUT";
  assert(!fetchOverview(output));
  assert(output.revision == "UNCHANGED_OUTPUT");
  assert(refreshes == count && lastValid.revision == revision);
}

int main() {
  setup();
  assert(Serial.baud == 115200);
#ifndef FOCUSDESK_TEST_CONFIGURED
  assert(!configured && Serial.output.find("CONFIG_REQUIRED") != std::string::npos);
  for (int i = 0; i < 10; ++i) loop();
  assert(WiFi.begins == 0 && fakeHttp.requests == 0 && refreshes == 0);
  std::cout << "PASS: actual unconfigured sketch compiles, CONFIG_REQUIRED, no Wi-Fi/HTTP/refresh\n";
#else
  assert(configured);
  const auto body = seedBody();
  resetResponse(body);
  loop();
  assert(lastValid.revision == "device-demo-seed" && pollState.isDisplayed(lastValid.revision));
  assert(refreshes == 1 && Serial.output.find("FETCH_OK") != std::string::npos);
  assert(Serial.output.find("DISPLAY_OK") != std::string::npos);
  clockMs += 30000; loop();
  assert(refreshes == 1 && Serial.output.find("UNCHANGED") != std::string::npos);

  resetResponse(body); fakeHttp.status = 503; assertFetchRejected();
  resetResponse(body); fakeHttp.contentLength = 4097; assertFetchRejected();
  resetResponse(body); fakeHttp.contentLength = -1; assertFetchRejected();
  resetResponse(body); fakeHttp.contentLength = 0; assertFetchRejected();
  resetResponse(body); fakeHttp.headers["Transfer-Encoding"] = "chunked"; assertFetchRejected();
  resetResponse(body); fakeHttp.headers["Content-Encoding"] = "gzip"; assertFetchRejected();
  resetResponse(body); fakeHttp.headers["Content-Type"] = "text/html"; assertFetchRejected();
  resetResponse(body); fakeHttp.beginOk = false; assertFetchRejected();
  resetResponse(body); fakeHttp.body = "{"; fakeHttp.contentLength = 20; assertFetchRejected();
  resetResponse(body); fakeHttp.body = "not JSON"; assertFetchRejected();
  resetResponse(body); fakeHttp.freezeBody = true;
  auto before = clockMs; assertFetchRejected(); assert(clockMs - before == 5000);
  WiFi.connected = false; WiFi.connectOnBegin = false;
  before = clockMs;
  assert(!connectWifi() && clockMs - before == 30000);
  WiFi.connectOnBegin = true; assert(connectWifi());

  auto changed = body;
  const auto offset = changed.find("device-demo-seed");
  changed.replace(offset, std::string("device-demo-seed").size(), "changed-version");
  resetResponse(changed);
  clockMs += 60000;
  stuckBusy = true;
  loop();
  assert(!pollState.screenValid() && pollState.displayedRevision() == "device-demo-seed");
  assert(lastValid.revision == "changed-version");
  assert(Serial.output.find("DISPLAY_FAILED:SCREEN_STATE_UNKNOWN") != std::string::npos);
  stuckBusy = false;
  resetResponse(body);
  clockMs += 30000; loop();
  assert(!pollState.screenValid() && refreshes == 1);
  assert(Serial.output.find("DISPLAY_DEFERRED") != std::string::npos);
  clockMs += 30000; loop();
  assert(pollState.isDisplayed("device-demo-seed") && refreshes == 2);

  const auto stableRevision = lastValid.revision;
  resetResponse(body); fakeHttp.status = 503;
  clockMs += 30000; loop();
  assert(lastValid.revision == stableRevision && pollState.isDisplayed(stableRevision));
  resetResponse(changed);
  clockMs += 60000; loop();
  assert(pollState.isDisplayed("changed-version") && refreshes == 3);
  std::cout << "PASS: actual configured sketch, bounded Wi-Fi/HTTP framing/body, parser failure retention, polling/unchanged, display failure/historic revision recovery, disconnect recovery\n";
  std::ifstream focusStream("contracts/fixtures/focus.json", std::ios::binary);
  assert(focusStream.good());
  const std::string focusBody{std::istreambuf_iterator<char>(focusStream), std::istreambuf_iterator<char>()};
  resetResponse(focusBody);
  clockMs += 30000; loop();
  assert(lastValid.hasFocus && refreshes == 3);  // Existing 60-second guard still applies.
  clockMs += 30000; loop();
  assert(pollState.isDisplayed("focus-demo-seed") && refreshes == 4);
  clockMs += 30000; loop(); assert(refreshes == 4);
  resetResponse(focusBody); fakeHttp.status = 503;
  clockMs += 30000; loop(); assert(lastValid.hasFocus && refreshes == 4);
  resetResponse(body); clockMs += 60000; loop();
  assert(!lastValid.hasFocus && pollState.isDisplayed("device-demo-seed") && refreshes == 5);
  std::cout << "PASS: actual sketch focus entry/unchanged/offline retention/return, without periodic focus refreshes\n";
#endif
}
