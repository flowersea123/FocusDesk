// SPDX-FileCopyrightText: 2026 FocusDesk contributors
// SPDX-License-Identifier: GPL-3.0-only
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <iterator>
#include <vector>
#include "../../firmware/focusdesk_device/display_sync.h"

namespace fd = focusdesk;
constexpr const char* HUB_A = "http://192.168.1.10:8787";
constexpr const char* HUB_B = "http://192.168.1.20:8787";
unsigned checks = 0;
void check(bool condition) {
  ++checks;
  if (!condition) { std::cerr << "Failed display sync check " << checks << '\n'; std::exit(1); }
}
std::string load(const char* path) {
  std::ifstream file(path, std::ios::binary);
  check(file.good());
  return {std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
}
std::string edited(const std::string& body, const char* revision, bool done = false) {
  ArduinoJson::JsonDocument document;
  check(!ArduinoJson::deserializeJson(document, body));
  document["revision"] = revision;
  document["tasks"][0]["title"] = "Edited in Dashboard";
  document["tasks"][0]["status"] = done ? "done" : "todo";
  std::string output;
  ArduinoJson::serializeJson(document, output);
  return output;
}
struct Fetcher {
  uint32_t clock = 0, duration = 0;
  std::string origin = HUB_A, body;
  bool online = true, busy = false, fail = false, busyAfterRead = false;
  unsigned reads = 0;
  bool ready(const char* requested) { return online && !busy && origin == requested; }
  bool read(const char* requested, fd::Overview& output) {
    check(origin == requested);
    ++reads;
    clock += duration;
    if (busyAfterRead) busy = true;
    const char* error = nullptr;
    return !fail && fd::parseOverview(body.data(), body.size(), output, error);
  }
  uint32_t now() { return clock; }
};
struct Panel {
  uint32_t& clock;
  uint32_t duration = 0;
  bool success = true;
  std::vector<fd::Overview> frames;
  explicit Panel(uint32_t& time) : clock(time) {}
  bool show(const fd::Overview& overview) {
    frames.push_back(overview);
    clock += duration;
    return success;
  }
};
struct Device {
  Fetcher fetcher;
  Panel panel{fetcher.clock};
  fd::DisplaySync<Fetcher, Panel> sync{fetcher, panel};
  explicit Device(const std::string& body) { fetcher.body = body; }
  void tick(uint32_t at, const char* origin = HUB_A) { fetcher.clock = at; sync.tick(origin); }
};
std::string key(const char* hub, const char* revision) { return std::string(hub) + '\n' + revision; }

void taskEditsAndUnchanged(const std::string& seed) {
  Device device(seed);
  device.sync.tick(nullptr); device.sync.tick("");
  device.fetcher.busy = true; device.tick(0);
  device.fetcher.busy = false; device.fetcher.online = false; device.tick(0);
  check(device.fetcher.reads == 0 && device.panel.frames.empty());
  check(device.sync.lastValid().revision.empty() && device.sync.source().empty());
  device.fetcher.online = true; device.tick(0);
  check(device.fetcher.reads == 1 && device.panel.frames.size() == 1);
  check(device.sync.state().isDisplayed(key(HUB_A, "device-demo-seed")));
  device.tick(29999); check(device.fetcher.reads == 1);
  device.tick(30000); check(device.fetcher.reads == 2 && device.panel.frames.size() == 1);
  device.fetcher.body = edited(seed, "edited-todo"); device.tick(60000);
  check(device.panel.frames.size() == 2);
  check(device.panel.frames.back().tasks[0].title == "Edited in Dashboard");
  check(!device.panel.frames.back().tasks[0].done);
  device.tick(90000); check(device.panel.frames.size() == 2);
  device.fetcher.body = edited(seed, "edited-done", true); device.tick(120000);
  check(device.panel.frames.size() == 3 && device.panel.frames.back().tasks[0].done);
}

void focusAndOffline(const std::string& seed, const std::string& focus) {
  Device device(seed); device.tick(0);
  device.fetcher.body = focus; device.tick(30000);
  check(device.sync.lastValid().hasFocus && device.panel.frames.size() == 1);
  check(device.sync.state().isDisplayed(key(HUB_A, "device-demo-seed")));
  device.tick(60000);
  check(device.panel.frames.size() == 2 && device.panel.frames.back().hasFocus);
  device.tick(90000); check(device.panel.frames.size() == 2);
  device.fetcher.online = false; device.tick(120000);
  check(device.panel.frames.size() == 2 && device.sync.lastValid().hasFocus);
  device.fetcher.online = true; device.fetcher.fail = true; device.tick(120000);
  check(device.panel.frames.size() == 2 && device.sync.lastValid().hasFocus);
  device.fetcher.fail = false; device.fetcher.body = seed; device.tick(150000);
  check(device.panel.frames.size() == 3 && !device.panel.frames.back().hasFocus);
}

void rejectedReadsRetainState(const std::string& seed) {
  Device device(seed); device.tick(0);
  const auto displayed = device.sync.state().displayedRevision();
  device.fetcher.body = "{broken"; device.tick(30000);
  check(device.sync.lastValid().revision == "device-demo-seed");
  check(device.sync.state().displayedRevision() == displayed && device.panel.frames.size() == 1);
  check(device.sync.state().pollDelay() == 30000);
  device.tick(60000); check(device.sync.state().pollDelay() == 60000);
  device.tick(119999); check(device.fetcher.reads == 3);
  device.tick(120000); check(device.sync.state().pollDelay() == 120000);
  device.tick(240000); check(device.sync.state().pollDelay() == 240000);
  device.tick(480000); check(device.sync.state().pollDelay() == 300000);
  device.tick(780000); check(device.sync.state().pollDelay() == 300000);
  device.fetcher.body = seed; device.tick(1080000);
  check(device.sync.state().pollDelay() == 30000 && device.panel.frames.size() == 1);
}

void pendingConfigurationCancelsRead(const std::string& seed) {
  Device device(seed); device.tick(0);
  const auto stableRevision = device.sync.state().displayedRevision();
  device.fetcher.body = edited(seed, "queued-config");
  device.fetcher.busyAfterRead = true; device.tick(60000);
  check(device.panel.frames.size() == 1 && device.sync.lastValid().revision == "device-demo-seed");
  check(device.sync.state().displayedRevision() == stableRevision);
  check(device.sync.state().pollDue(60000));
  device.tick(90000); check(device.fetcher.reads == 2);
  // A failed candidate returns to the same saved Hub and resumes immediately.
  device.fetcher.busy = false; device.fetcher.busyAfterRead = false; device.tick(90000);
  check(device.panel.frames.size() == 2 && device.sync.lastValid().revision == "queued-config");
}

void hubChangeReusesRevision(const std::string& seed) {
  Device device(seed); device.tick(0);
  device.fetcher.origin = HUB_B;
  device.tick(1000, HUB_B);
  check(device.fetcher.reads == 2 && device.panel.frames.size() == 1);
  check(device.sync.source() == HUB_B);
  check(device.sync.state().displayedRevision() == key(HUB_A, "device-demo-seed"));
  device.tick(31000, HUB_B); check(device.panel.frames.size() == 1);
  device.tick(61000, HUB_B); check(device.panel.frames.size() == 2);
  check(device.sync.state().displayedRevision() == key(HUB_B, "device-demo-seed"));
  device.fetcher.origin = HUB_A; device.tick(62000, HUB_A);
  check(device.fetcher.reads == 5 && device.panel.frames.size() == 2);
  device.tick(92000, HUB_A); check(device.panel.frames.size() == 2);
  device.tick(122000, HUB_A); check(device.panel.frames.size() == 3);
  check(device.sync.state().displayedRevision() == key(HUB_A, "device-demo-seed"));
}

void failedDisplayAndGuard(const std::string& seed) {
  Device device(seed); device.tick(0);
  device.fetcher.body = edited(seed, "changed");
  device.panel.success = false; device.tick(60000);
  check(!device.sync.state().screenValid() && device.panel.frames.size() == 2);
  check(device.sync.state().displayedRevision() == key(HUB_A, "device-demo-seed"));
  device.panel.success = true; device.tick(90000);
  check(!device.sync.state().screenValid() && device.panel.frames.size() == 2);
  device.tick(120000);
  check(device.sync.state().screenValid() && device.panel.frames.size() == 3);
  check(device.sync.state().displayedRevision() == key(HUB_A, "changed"));
  device.fetcher.origin = HUB_B;
  device.fetcher.fail = true; device.tick(121000, HUB_B);
  device.tick(151000, HUB_B); check(device.sync.state().pollDelay() == 60000);
  // A source change wakes polling but preserves its failure streak and guard.
  device.fetcher.origin = HUB_A; device.tick(152000, HUB_A);
  check(device.sync.state().pollDelay() == 120000 && device.panel.frames.size() == 3);
}

void timestampsAndWraparound(const std::string& seed) {
  Device device(seed);
  device.fetcher.duration = 1000; device.panel.duration = 2000;
  device.tick(0);
  check(device.fetcher.clock == 3000 && device.panel.frames.size() == 1);
  check(!device.sync.state().pollDue(32999) && device.sync.state().pollDue(33000));
  device.fetcher.body = edited(seed, "after-io");
  device.fetcher.duration = 0; device.panel.duration = 0;
  device.tick(33000); check(device.panel.frames.size() == 1);
  device.tick(63000); check(device.panel.frames.size() == 2);

  Device wrapped(seed);
  const uint32_t base = 0xfffffff0U;
  wrapped.tick(base);
  wrapped.fetcher.body = edited(seed, "wrapped");
  wrapped.tick(base + 30000U); check(wrapped.panel.frames.size() == 1);
  wrapped.tick(base + 60000U); check(wrapped.panel.frames.size() == 2);
  check(wrapped.sync.state().isDisplayed(key(HUB_A, "wrapped")));
}

int main() {
  const auto seed = load("contracts/fixtures/device-demo.json");
  const auto focus = load("contracts/fixtures/focus.json");
  taskEditsAndUnchanged(seed);
  focusAndOffline(seed, focus);
  rejectedReadsRetainState(seed);
  pendingConfigurationCancelsRead(seed);
  hubChangeReusesRevision(seed);
  failedDisplayAndGuard(seed);
  timestampsAndWraparound(seed);
  std::cout << "P3 display sync checks passed: " << checks << '\n';
}
