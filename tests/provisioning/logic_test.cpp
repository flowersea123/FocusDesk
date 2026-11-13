// SPDX-License-Identifier: GPL-3.0-only
#include "../../firmware/experiments/focusdesk_provisioning_poc/poc_logic.h"
#include <cassert>
#include <iostream>
#include <string>
#include <vector>

namespace p = focusdesk_poc;
static unsigned checks = 0;
static void check(bool condition) { assert(condition); ++checks; }
static std::string encode(const std::string& value) {
  static constexpr char hex[] = "0123456789ABCDEF";
  std::string result;
  for (const unsigned char c : value) { result += '%'; result += hex[c >> 4]; result += hex[c & 15]; }
  return result;
}
static const char* parse(const std::string& body, p::Credentials& output) { return p::parseForm(body.data(), body.size(), output); }
int main() {
  const uint8_t mapped[16] = {0,0,0,0,0,0,0,0,0,0,0xff,0xff,192,168,4,2};
  uint32_t ipv4 = 0;
  check(p::mappedIpv4(mapped, ipv4) && ipv4 == 0xc0a80402UL);
  check(p::apSocketAllowed(0xc0a80401UL, ipv4));
  check(!p::apSocketAllowed(0xc0a80101UL, ipv4));
  check(!p::apSocketAllowed(0xc0a80401UL, 0xc0a80102UL));
  const uint8_t nativeV6[16] = {0x20,0x01,0x0d,0xb8,0,0,0,0,0,0,0,0,0,0,0,1};
  check(!p::mappedIpv4(nativeV6, ipv4));
  const uint8_t compatibleV6[16] = {0,0,0,0,0,0,0,0,0,0,0,0,192,168,4,2};
  check(!p::mappedIpv4(compatibleV6, ipv4));
  p::Credentials result;
  const std::string secret = " Ab+&\"\\= cd ";  // Synthetic fixture; never real credentials.
  const std::string ssid = u8" 工作室 +&\"\\ ";
  check(parse("ssid=" + encode(ssid) + "&password=" + encode(secret) + "&attempt_id=try-1", result) == nullptr);
  check(ssid == result.ssid);
  check(secret == result.password);
  check(std::string(result.attempt_id) == "try-1");
  check(parse("ssid=two+words&password=ab%2Bcd%26ef&attempt_id=try-2", result) == nullptr);
  check(std::string(result.ssid) == "two words" && std::string(result.password) == "ab+cd&ef");
  check(parse("ssid=" + std::string(32, 'a') + "&password=" + std::string(63, 'b') + "&attempt_id=" + std::string(48, 'c'), result) == nullptr);
  check(parse("ssid=" + std::string(33, 'a') + "&password=password&attempt_id=x", result) != nullptr);
  check(parse("ssid=" + encode(u8"中文中文中文中文中文中文") + "&password=password&attempt_id=x", result) != nullptr);
  const std::vector<std::string> bad = {
    "ssid=&password=password&attempt_id=x", "ssid=ok&password=&attempt_id=x",
    "ssid=ok&password=short&attempt_id=x", "ssid=ok&password=" + std::string(64, 'a') + "&attempt_id=x",
    "ssid=ok&password=password&attempt_id=", "ssid=ok&password=password&attempt_id=x%0D%0A",
    "ssid=ok&ssid=other&password=password&attempt_id=x", "ssid=ok&password=password&attempt_id=x&extra=y",
    "ssid=ok&password=password", "ssid=bad%00name&password=password&attempt_id=x",
    "ssid=bad%0Aname&password=password&attempt_id=x", "ssid=%&password=password&attempt_id=x",
    "ssid=%ZZ&password=password&attempt_id=x", "ssid=%C0%AF&password=password&attempt_id=x",
    "ssid=%ED%A0%80&password=password&attempt_id=x", "ssid=%F4%90%80%80&password=password&attempt_id=x",
    "ssid=%E4%B8&password=password&attempt_id=x", "ssid=ok&password=abc%00defgh&attempt_id=x",
    "ssid=ok&password=%E4%B8%ADabcdefgh&attempt_id=x", "ssid=ok&password=password&attempt_id=x&",
    "ssid=ok&password=password&attempt_id=x&&", "ssid=ok&password=password&attempt_id=x&garbage",
  };
  for (const auto& body : bad) {
    p::Credentials unchanged;
    std::strcpy(unchanged.ssid, "keep");
    check(parse(body, unchanged) != nullptr);
    check(std::string(unchanged.ssid) == "keep");
  }
  check(parse(std::string(p::MAX_FORM_BYTES + 1, 'a'), result) != nullptr);
  check(p::parseForm(nullptr, 1, result) != nullptr);
  check(parse("", result) != nullptr);
  check(p::validUtf8(u8"网络😀"));
  p::Attempt attempt;
  check(attempt.accept("a") == p::Acceptance::New);
  check(attempt.accept("a") == p::Acceptance::Duplicate);
  check(attempt.accept("b") == p::Acceptance::Busy);
  attempt.start(100);
  check(!attempt.observe(30099, false) && attempt.state == p::State::Connecting);
  check(attempt.observe(30100, false) && attempt.state == p::State::Failed);
  check(attempt.accept("a") == p::Acceptance::Duplicate && attempt.state == p::State::Failed);
  check(attempt.accept("b") == p::Acceptance::New);
  attempt.start(50000);
  check(!attempt.observe(50001, true) && attempt.state == p::State::Connected);
  check(attempt.accept("b") == p::Acceptance::Duplicate);
  check(!attempt.observe(50002, false) && attempt.state == p::State::Disconnected);
  check(!attempt.observe(50003, true) && attempt.state == p::State::Connected);
  check(!attempt.observe(50004, false) && attempt.state == p::State::Disconnected);
  check(attempt.accept("c") == p::Acceptance::New);
  attempt.start(0xfffffff0U);
  check(!attempt.observe(static_cast<uint32_t>(0xfffffff0U + 29999U), false));
  check(attempt.observe(static_cast<uint32_t>(0xfffffff0U + 30000U), false));
  attempt.start(1);
  check(attempt.observe(30001, true) && attempt.state == p::State::Failed);
  check(!attempt.observe(30002, true) && attempt.state == p::State::Failed);
  attempt.state = p::State::Expired;
  check(attempt.accept("c") == p::Acceptance::Expired);
  check(attempt.accept("d") == p::Acceptance::Expired);
  p::wipe(&result, sizeof(result));
  const auto* bytes = reinterpret_cast<const unsigned char*>(&result);
  bool allZero = true;
  for (size_t i = 0; i < sizeof(result); ++i) allZero &= bytes[i] == 0;
  check(allZero);
  std::cout << "Provisioning parser/state checks passed: " << checks << '\n';
}
