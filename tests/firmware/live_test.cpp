// SPDX-FileCopyrightText: 2026 FocusDesk contributors
// SPDX-License-Identifier: GPL-3.0-only
#include <algorithm>
#include <cassert>
#include <fstream>
#include <iostream>
#include <iterator>
#include "../../firmware/focusdesk_live/live_page.h"
#include "../../firmware/focusdesk_live/live_state.h"

TestSerial Serial;
TestSPI SPI;
unsigned long millis() { return 0; }
void delay(unsigned long) {}
void pinMode(uint8_t, int) {}
void digitalWrite(uint8_t, int) {}
int digitalRead(uint8_t) { return HIGH; }
void TestSPI::begin(int, int, int, int) {}
void TestSPI::beginTransaction(SPISettings) {}
void TestSPI::endTransaction() {}
uint8_t TestSPI::transfer(uint8_t) { return 0; }

using namespace focusdesk;
size_t rejected = 0;
std::string load(const char* path) {
  std::ifstream stream(path, std::ios::binary);
  assert(stream.good());
  return {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}
Overview accept(const std::string& body) {
  Overview output;
  const char* error = nullptr;
  if (!parseOverview(body.data(), body.size(), output, error)) {
    std::cerr << "Unexpected rejection: " << error << '\n';
    assert(false);
  }
  assert(error == nullptr);
  return output;
}
void reject(const std::string& body) {
  Overview output;
  output.revision = "KEEP";
  const char* error = nullptr;
  assert(!parseOverview(body.data(), body.size(), output, error));
  assert(output.revision == "KEEP" && error != nullptr);
  ++rejected;
}
template<class Mutation> std::string changed(const std::string& body, Mutation mutate) {
  ArduinoJson::JsonDocument doc;
  assert(!ArduinoJson::deserializeJson(doc, body));
  mutate(doc);
  std::string result;
  ArduinoJson::serializeJson(doc, result);
  return result;
}

int main() {
  const auto body = load("contracts/fixtures/device-demo.json");
  const auto seed = accept(body);
  assert(seed.count == 3 && seed.tasks[1].done && !seed.tasks[0].done);
  assert(accept(load("contracts/fixtures/empty.json")).count == 0);
  assert(accept(body + std::string(4096 - body.size(), ' ')).revision == seed.revision);
  reject(body + std::string(4097 - body.size(), ' '));
  reject("[]"); reject("null"); reject(""); reject(body + "{}");
  reject("{unquoted:1}"); reject("{'single':1}"); reject("[1,]");
  reject("{\"x\":01}"); reject("{\"x\":NaN}"); reject("{\"x\":1.}");
  reject("/* comment */" + body); reject("{\"x\":\"\\ud800\"}");
  reject("{\"x\":\"\\udc00\"}");
  reject(std::string("{\"x\":\"") + '\xc0' + '\xaf' + "\"}");
  reject(std::string("{\"x\":\"") + '\xed' + '\xa0' + '\x80' + "\"}");
  reject(std::string("{\"x\":\"") + '\xf4' + '\x90' + '\x80' + '\x80' + "\"}");

  for (const char* field : {"schema_version","revision","date","timezone","updated_at","tasks"}) {
    reject(changed(body, [field](auto& d) { d.remove(field); }));
    reject(changed(body, [field](auto& d) { d[field] = 42; }));
  }
  reject(changed(body, [](auto& d) { d["schema_version"] = "2.0"; }));
  reject(changed(body, [](auto& d) { d["revision"] = "with space"; }));
  reject(changed(body, [](auto& d) { d["revision"] = std::string(65, 'a'); }));
  reject(changed(body, [](auto& d) { d["date"] = "2026-02-29"; }));
  reject(changed(body, [](auto& d) { d["date"] = "0000-01-01"; }));
  reject(changed(body, [](auto& d) { d["date"] = "2026-13-01"; }));
  reject(changed(body, [](auto& d) { d["timezone"] = "Europe/London"; }));
  reject(changed(body, [](auto& d) { d["updated_at"] = "2026-11-02T24:00:00Z"; }));
  reject(changed(body, [](auto& d) { d["updated_at"] = "2026-11-02T01:60:00Z"; }));
  reject(changed(body, [](auto& d) { d["updated_at"] = "2026-11-02T01:00:60Z"; }));
  reject(changed(body, [](auto& d) { d["updated_at"] = "2026-11-02T01:00:00+08:00"; }));
  reject(changed(body, [](auto& d) { d["updated_at"] = "2026-11-02T01:00:00.Z"; }));
  reject(changed(body, [](auto& d) { d["tasks"][3]["id"] = "four"; }));
  reject(changed(body, [](auto& d) { d["tasks"][1]["id"] = "demo-001"; }));
  for (const char* field : {"id","title","status","due_at"})
    reject(changed(body, [field](auto& d) { d["tasks"][0].remove(field); }));
  reject(changed(body, [](auto& d) { d["tasks"][0] = "not an object"; }));
  reject(changed(body, [](auto& d) { d["tasks"][0]["id"] = "bad id"; }));
  reject(changed(body, [](auto& d) { d["tasks"][0]["id"] = std::string(65, 'x'); }));
  reject(changed(body, [](auto& d) { d["tasks"][0]["title"] = std::string(41, 'x'); }));
  reject(changed(body, [](auto& d) { d["tasks"][0]["title"] = "   "; }));
  reject(changed(body, [](auto& d) { d["tasks"][0]["title"] = "line\nbreak"; }));
  reject(changed(body, [](auto& d) { d["tasks"][0]["title"] = "\x7f"; }));
  reject(changed(body, [](auto& d) { d["tasks"][0]["title"] = "\xe4\xb8\xad\xe6\x96\x87"; }));
  reject(changed(body, [](auto& d) { d["tasks"][0]["title"] = 12; }));
  reject(changed(body, [](auto& d) { d["tasks"][0]["status"] = "ack"; }));
  reject(changed(body, [](auto& d) { d["tasks"][0]["due_at"] = false; }));
  reject(changed(body, [](auto& d) { d["tasks"][0]["due_at"] = "2026-02-30T01:00:00Z"; }));
  const auto good = changed(body, [](auto& d) {
    d["date"] = "2024-02-29";
    d["timezone"] = "UTC";
    d["updated_at"] = "2024-02-29T23:59:59.123Z";
    d["tasks"][0]["due_at"] = "0001-01-01T00:00:00Z";
    d["extra"]["ignored"] = "\xf0\x9f\x98\x80";
  });
  assert(accept(good).tasks[0].hasDue);
  std::cout << "PASS: real ArduinoJson parser, shared fixtures, " << rejected
            << " invalid/unsupported snapshots, failed parse preserves output\n";

  PollState state;
  assert(state.pollDue(0));
  uint32_t now = 0;
  for (const auto interval : {30000U,60000U,120000U,240000U,300000U,300000U}) {
    state.pollFinished(now, false);
    assert(state.pollDelay() == interval);
    assert(!state.pollDue(now + interval - 1));
    assert(state.pollDue(now + interval)); now += interval;
  }
  state.pollFinished(now, true); assert(state.pollDelay() == 30000);
  assert(state.canDisplay(now, "A"));
  state.displayFinished(now, "A", true);
  assert(!state.canDisplay(now + 60000, "A"));
  assert(!state.canDisplay(now + 59999, "B"));
  assert(state.canDisplay(now + 60000, "B"));
  now += 60000;
  state.displayFinished(now, "B", false);
  assert(!state.screenValid() && state.displayedRevision() == "A");
  assert(!state.canDisplay(now + 59999, "A"));
  assert(state.canDisplay(now + 60000, "A"));
  state.pollFinished(now + 30000, false);  // Network failure never mutates screen state.
  assert(!state.screenValid() && state.displayedRevision() == "A");
  state.displayFinished(now + 60000, "A", true);
  state.pollFinished(now + 60000, true);
  assert(state.screenValid() && state.isDisplayed("A") && state.pollDelay() == 30000);
  PollState wrap;
  wrap.displayFinished(UINT32_MAX - 30000, "A", true);
  assert(!wrap.canDisplay(29998, "B") && wrap.canDisplay(29999, "B"));
  wrap.pollFinished(UINT32_MAX - 15000, true);
  assert(!wrap.pollDue(14998) && wrap.pollDue(14999));
  PollState repeatedFailure;
  repeatedFailure.pollFinished(0, false);
  repeatedFailure.pollDeferred(30000);
  repeatedFailure.pollFinished(60000, false);
  assert(repeatedFailure.pollDelay() == 60000);
  std::cout << "PASS: polling/backoff, same revision, failure retention, historic revision recovery, 60s guard, millis wrap\n";

  assert(pageWeekday("2026-11-02") == 1);
  assert(pageWeekday("2026-11-03") == 2);
  assert(pageWeekday("2024-02-29") == 4);
  assert(pageWeekday("2000-01-01") == 6);
  assert(footerCaption(std::string(40, 'W')).size() == 30);
  GDEM042F52Display display;
  auto page = seed;
  page.tasks[0].title = std::string(40, 'W');
  page.tasks[1].title = std::string(27, 'Y');
  drawOverview(display, page);
  std::vector<std::string> titles;
  std::vector<int> checkboxes;
  int ticks = 0, redBars = 0, yellowBadges = 0;
  bool progress = false, nextCaption = false, dayCaption = false;
  for (const auto& c : display.calls) {
    if (c.kind == "text") {
      assert(c.text != "BLACK" && c.text != "RED" && c.text != "YELLOW");
      if (c.x == 42) titles.push_back(c.text);
      if (c.text == "1 / 3 done") progress = true;
      if (c.text == footerCaption("NEXT: " + page.tasks[2].title)) nextCaption = true;
      if (c.text == "2026-11-02  MONDAY") dayCaption = true;
    }
    if ((c.kind == "rect" || c.kind == "fill") && c.x == 20 && c.w == 12)
      checkboxes.push_back(c.y);
    if (c.kind == "fill" && c.color == EPD_RED && c.x == 16) ++redBars;
    if (c.kind == "round-fill" && c.color == EPD_YELLOW) ++yellowBadges;
    if (c.kind == "line" && c.color == EPD_WHITE) {
      ++ticks; assert(c.y >= 214 && c.y <= 225);
    }
  }
  assert((titles == std::vector<std::string>{page.tasks[0].title,page.tasks[1].title,page.tasks[2].title}));
  assert((checkboxes == std::vector<int>{190,214,238}) && ticks == 2);
  assert(redBars == 1 && yellowBadges == 2 && progress && nextCaption && dayCaption);
  for (const char letter : {'W','i','j','_','~'}) {
    display.calls.clear(); page.tasks[0].title = std::string(40, letter);
    drawOverview(display, page);  // Actual font bounds must fit every field.
    assert(std::any_of(display.calls.begin(), display.calls.end(), [&](const auto& c) {
      return c.kind == "text" && c.x == 42 && c.text == page.tasks[0].title;
    }));
  }
  display.calls.clear(); page.count = 0; drawOverview(display, page);
  assert(std::any_of(display.calls.begin(), display.calls.end(),
                     [](const auto& c) { return c.kind == "text" && c.text == "No tasks"; }));
  assert(std::any_of(display.calls.begin(), display.calls.end(),
                     [](const auto& c) { return c.kind == "text" && c.text == "0 / 0 done"; }));
  page = seed;
  for (size_t i = 0; i < page.count; ++i) page.tasks[i].done = true;
  display.calls.clear(); drawOverview(display, page);
  assert(std::any_of(display.calls.begin(), display.calls.end(),
                     [](const auto& c) { return c.kind == "text" && c.text == "3 / 3 done"; }));
  assert(std::any_of(display.calls.begin(), display.calls.end(),
                     [](const auto& c) { return c.kind == "text" && c.text == "ALL TASKS DONE"; }));
  assert(std::none_of(display.calls.begin(), display.calls.end(),
                     [](const auto& c) { return c.kind == "text" && c.text.find("NEXT:") == 0; }));
  page = seed; page.count = 1; page.tasks[0].done = false;
  display.calls.clear(); drawOverview(display, page);
  assert(std::any_of(display.calls.begin(), display.calls.end(),
                     [](const auto& c) { return c.kind == "text" && c.text == "ONE THING AT A TIME"; }));
  std::cout << "PASS: reference-style renderer, real font bounds, complete 40-character titles, priority/next, status/progress, date/weekday, empty/all-done/single task\n";

  const auto focusBody = load("contracts/fixtures/focus.json");
  auto focused = accept(focusBody);
  assert(focused.hasFocus && focused.focusTaskId == "focus-task");
  assert(focusLocalEnd(focused) == "2026-11-04 00:15");
  focused.timezone = "UTC";
  assert(focusLocalEnd(focused) == "2026-11-03 16:15");
  focused.timezone = "Asia/Shanghai";
  for (const auto stamp : {"2024-02-28T16:05:00.000Z", "2024-02-29T16:05:00.000Z", "2026-12-31T16:05:00.000Z"}) {
    focused.focusEndsAt = stamp;
    const auto local = focusLocalEnd(focused);
    assert(local.substr(11) == "00:05");
    assert(local.substr(0, 10) == (std::string(stamp).substr(0, 10) == "2024-02-28" ? "2024-02-29" :
      std::string(stamp).substr(0, 10) == "2024-02-29" ? "2024-03-01" : "2027-01-01"));
  }
  focused = accept(focusBody);
  display.calls.clear(); drawOverview(display, focused);
  for (const auto text : {"Focus mode", "Build FocusDesk Demo", "00:15", "2026-11-04", "UTC+8 / SHANGHAI"})
    assert(std::any_of(display.calls.begin(), display.calls.end(), [&](const auto& c) { return c.kind == "text" && c.text == text; }));
  for (const char letter : {'W','i','j','_','~'}) {
    focused.tasks[0].title = std::string(40, letter);
    display.calls.clear(); drawOverview(display, focused);
    assert(std::any_of(display.calls.begin(), display.calls.end(), [&](const auto& c) { return c.kind == "text" && c.text == focused.tasks[0].title; }));
  }
  reject(changed(focusBody, [](auto& doc) { doc["focus"] = false; }));
  reject(changed(focusBody, [](auto& doc) { doc["focus"].remove("task_id"); }));
  reject(changed(focusBody, [](auto& doc) { doc["focus"]["task_id"] = "missing"; }));
  reject(changed(focusBody, [](auto& doc) { doc["focus"]["ends_at"] = "2026-11-03T16:14:00.000Z"; }));
  reject(changed(focusBody, [](auto& doc) { doc["focus"]["started_at"] = "2026-11-03T15:50:00Z"; }));
  reject(changed(focusBody, [](auto& doc) { doc["tasks"][0]["status"] = "done"; }));
  assert(!accept(changed(focusBody, [](auto& doc) { doc["focus"] = nullptr; })).hasFocus);
  std::cout << "PASS: focus contract/renderer, invalid focus rejected, full titles, UTC/Shanghai midnight/leap/year rollover\n";
}
