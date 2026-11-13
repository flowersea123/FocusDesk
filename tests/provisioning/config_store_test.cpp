// SPDX-License-Identifier: GPL-3.0-only
#include "../../firmware/experiments/focusdesk_provisioning_poc/config_store.h"
#include <cstdlib>
#include <iostream>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

namespace config = focusdesk_config;
static unsigned checks = 0;
static void check(bool condition) {
  ++checks;
  if (!condition) { std::cerr << "Config store check failed at assertion " << checks << '\n'; std::exit(1); }
}
struct PowerLoss {};
struct FakeBackend {
  std::map<std::string, std::vector<uint8_t>> durable, pending;
  unsigned operation = 0, failAt = 0, failAfter = 0, powerBefore = 0, powerAfter = 0;
  unsigned writes = 0;
  bool immediate = false;
  bool corruptReadback = false;
  bool fail() {
    ++operation;
    if (operation == powerBefore) throw PowerLoss{};
    return operation == failAt;
  }
  void finish() { if (operation == powerAfter) throw PowerLoss{}; }
  config::ReadResult read(const char* key, void* buffer, size_t capacity, size_t& actual) {
    if (fail()) return config::ReadResult::Error;
    const auto found = durable.find(key);
    if (found == durable.end()) { finish(); return config::ReadResult::Missing; }
    actual = found->second.size();
    if (actual > capacity) return config::ReadResult::Error;
    std::memcpy(buffer, found->second.data(), actual);
    if (corruptReadback && operation == 6 && actual) static_cast<uint8_t*>(buffer)[0] ^= 1;
    finish();
    return config::ReadResult::Read;
  }
  bool write(const char* key, const void* data, size_t size) {
    if (fail()) return false;
    ++writes;
    const auto* bytes = static_cast<const uint8_t*>(data);
    (immediate ? durable : pending)[key] = std::vector<uint8_t>(bytes, bytes + size);
    finish(); return operation != failAfter;
  }
  bool commit() {
    if (fail()) return false;
    for (const auto& entry : pending) durable[entry.first] = entry.second;
    pending.clear(); finish(); return operation != failAfter;
  }
  void reset() { pending.clear(); }
  void reboot() {
    pending.clear(); operation = 0; failAt = 0; failAfter = 0; powerBefore = 0; powerAfter = 0; corruptReadback = false;
  }
};
static config::Config example(const char* name = "old network") {
  config::Config result;
  std::strcpy(result.ssid, name);
  std::strcpy(result.password, " pass+&\"\\word ");
  std::strcpy(result.hub_url, "http://192.168.1.10:8787");
  return result;
}
static bool same(const config::Config& left, const config::Config& right) {
  return std::strcmp(left.ssid, right.ssid) == 0 && std::strcmp(left.password, right.password) == 0 &&
      std::strcmp(left.hub_url, right.hub_url) == 0;
}
static config::Config load(FakeBackend& backend) {
  config::Config result;
  config::ConfigStore<FakeBackend> store(backend);
  check(store.load(result) == config::LoadResult::Loaded);
  return result;
}
static void hubTests() {
  struct Valid { const char* input; const char* output; };
  const Valid accepted[] = {
    {"http://192.168.1.10:8787", "http://192.168.1.10:8787"},
    {"http://192.168.1.10:8787/", "http://192.168.1.10:8787"},
    {"http://192.168.1.10:8787/api/v1/daily-overview", "http://192.168.1.10:8787"},
    {"http://10.0.0.1", "http://10.0.0.1:80"},
    {"http://172.20.0.2:65535", "http://172.20.0.2:65535"},
  };
  for (const auto& item : accepted) {
    char result[96] = {};
    check(config::normalizeHub(item.input, result, sizeof(result)));
    check(std::strcmp(result, item.output) == 0);
    char small[4] = "old";
    check(!config::normalizeHub(item.input, small, sizeof(small)));
    check(std::strcmp(small, "old") == 0);
  }
  const char* rejected[] = {
    "", "https://192.168.1.2", "HTTP://192.168.1.2", "http://localhost", "http://focusdesk.local",
    "http://0.1.2.3", "http://127.1.2.3", "http://224.0.0.1", "http://255.255.255.255",
    "http://169.254.1.2", "http://192.168.4.1", "http://192.168.4.50", "http://192.168.1.255",
    "http://1.2.3", "http://1.2.3.256", "http://1.2.3.4444", "http://1.2.3.4.5",
    "http://192.168.001.010:08787", "http://010.0.0.1", "http://192.168.00.1",
    "http://1.2.3.4:", "http://1.2.3.4:0", "http://1.2.3.4:65536", "http://1.2.3.4:999999999999",
    "http://1.2.3.4:8787x", "http://1.2.3.4:1:2", "http://user:password@1.2.3.4",
    "http://1.2.3.4?x=1", "http://1.2.3.4/#fragment", "http://1.2.3.4/other",
    "http://1.2.3.4/api/v1/daily-overview/", "http://1.2.3.4\\@other", " http://1.2.3.4",
    "http://1.2.3.4 ", "http://1.2.3.4\r\nInjected: bad", "http://[::1]", "http://1.2.3.4/%2e%2e",
  };
  for (const auto* input : rejected) {
    char output[96] = "unchanged";
    check(!config::normalizeHub(input, output, sizeof(output)));
    check(std::strcmp(output, "unchanged") == 0);
  }
  char output[96];
  check(!config::normalizeHub(nullptr, output, sizeof(output)));
  check(!config::normalizeHub("http://10.0.0.1", nullptr, 96));
}
static void credentialTests() {
  auto value = example(u8" 工作桌 + & \" ");
  check(config::validConfig(value));
  const char* invalidSsid[] = {"", "bad\nname", "bad\x7f", "\xc0\xaf", "\xed\xa0\x80", "\xf4\x90\x80\x80", "\xe4\xb8"};
  for (const char* input : invalidSsid) { auto invalid = example(input); check(!config::validConfig(invalid)); }
  std::memset(value.ssid, 'x', sizeof(value.ssid)); check(!config::validConfig(value));
  value = example(); std::memset(value.ssid, 'x', 32); value.ssid[32] = 0; check(config::validConfig(value));
  value = example(); std::strcpy(value.password, "short"); check(!config::validConfig(value));
  value = example(); std::memset(value.password, 'x', sizeof(value.password)); check(!config::validConfig(value));
  value = example(); std::memset(value.password, 'x', 63); value.password[63] = 0; check(config::validConfig(value));
  value = example(); value.password[2] = '\n'; check(!config::validConfig(value));
  value = example(); std::strcpy(value.hub_url, "http://192.168.1.10"); check(!config::validConfig(value));
  value = example(); std::memset(value.hub_url, 'x', sizeof(value.hub_url)); check(!config::validConfig(value));
}
static FakeBackend initialized() {
  FakeBackend backend;
  config::ConfigStore<FakeBackend> store(backend);
  config::Config untouched = example("untouched");
  check(store.load(untouched) == config::LoadResult::Missing);
  check(std::strcmp(untouched.ssid, "untouched") == 0);
  check(store.save(example()));
  backend.reboot();
  check(same(load(backend), example()));
  backend.reboot();
  return backend;
}
static void failureTests() {
  const auto old = example(), next = example(u8"新网络 + &");
  const FakeBackend original = initialized();
  // Reads 1..3 snapshot the active state, then record write/commit/readback and
  // selector write/commit occupy operations 4..8.
  for (unsigned failAt = 1; failAt <= 8; ++failAt) {
    auto backend = original;
    backend.failAt = failAt;
    config::ConfigStore<FakeBackend> store(backend);
    check(!store.save(next));
    backend.reboot(); check(same(load(backend), old));
    backend.reboot(); check(store.save(next));
    backend.reboot(); check(same(load(backend), next));
  }
  for (unsigned operation = 1; operation <= 8; ++operation) {
    for (bool after : {false, true}) {
      auto backend = original;
      if (after) backend.powerAfter = operation; else backend.powerBefore = operation;
      config::ConfigStore<FakeBackend> store(backend);
      bool interrupted = false;
      try { store.save(next); } catch (const PowerLoss&) { interrupted = true; }
      check(interrupted);
      backend.reboot();
      check(same(load(backend), after && operation == 8 ? next : old));
    }
  }
  auto backend = original;
  backend.corruptReadback = true;
  config::ConfigStore<FakeBackend> store(backend);
  check(!store.save(next)); backend.reboot(); check(same(load(backend), old));
  auto invalid = next; invalid.password[0] = 0;
  backend.reboot(); backend.writes = 0;
  check(!store.save(invalid)); check(backend.writes == 0); check(same(load(backend), old));
  backend.reboot(); backend.immediate = true; backend.failAt = 8;
  check(!store.save(next));
  // Real SDK writes may already be durable before a later commit error.
  // Either selector outcome remains safe because both records were verified.
  backend.reboot(); check(same(load(backend), next));
  check(backend.durable.at("config0") == original.durable.at("config0"));
  for (unsigned operation : {4U, 5U, 7U, 8U}) {
    backend = original; backend.immediate = true; backend.failAfter = operation;
    config::ConfigStore<FakeBackend> ambiguousStore(backend);
    check(!ambiguousStore.save(next));
    backend.reboot(); check(same(load(backend), operation >= 7 ? next : old));
    check(backend.durable.at("config0") == original.durable.at("config0"));
  }
  for (unsigned operation = 1; operation <= 8; ++operation) {
    backend = original; backend.immediate = true; backend.powerAfter = operation;
    config::ConfigStore<FakeBackend> immediateStore(backend);
    try { immediateStore.save(next); } catch (const PowerLoss&) {}
    backend.reboot(); check(same(load(backend), operation >= 7 ? next : old));
  }
}
static void corruptionTests() {
  auto backend = initialized();
  config::ConfigStore<FakeBackend> store(backend);
  const auto next = example("new network");
  check(store.save(next)); backend.reboot(); check(same(load(backend), next));
  backend.durable.at("config1")[50] ^= 0x20;
  backend.reboot(); check(same(load(backend), example()));
  backend.reboot(); check(store.save(example("after recovery")));
  backend.reboot(); check(std::strcmp(load(backend).ssid, "after recovery") == 0);
  // A newer staged slot must never be promoted without its matching selector.
  backend = initialized();
  config::detail::Record pending;
  config::detail::encodeRecord(next, 2, pending);
  backend.durable["config1"] = std::vector<uint8_t>(pending.bytes, pending.bytes + sizeof(pending.bytes));
  backend.reboot(); check(same(load(backend), example()));
  backend.durable.at("config0")[50] ^= 1;
  backend.reboot(); config::Config output = example("untouched");
  check(store.load(output) == config::LoadResult::Error);
  check(std::strcmp(output.ssid, "untouched") == 0);
  backend = initialized();
  backend.durable.at("active")[0] ^= 1;
  backend.reboot(); backend.writes = 0;
  check(store.load(output) == config::LoadResult::Error); check(!store.save(next)); check(backend.writes == 0);
  backend = initialized();
  backend.durable.at("config0")[4] = 2;
  backend.reboot(); backend.writes = 0;
  check(store.load(output) == config::LoadResult::Error); check(!store.save(next)); check(backend.writes == 0);
  backend = initialized();
  backend.durable.at("active")[4] = 2;
  backend.reboot(); backend.writes = 0;
  check(store.load(output) == config::LoadResult::Error); check(!store.save(next)); check(backend.writes == 0);
  backend = initialized();
  config::detail::encodeRecord(next, 2, pending); pending.bytes[4] = 2;
  backend.durable["config1"] = std::vector<uint8_t>(pending.bytes, pending.bytes + sizeof(pending.bytes));
  backend.reboot(); backend.writes = 0;
  check(store.load(output) == config::LoadResult::Error); check(!store.save(next)); check(backend.writes == 0);
  backend = initialized(); backend.durable.erase("active"); backend.reboot();
  check(store.load(output) == config::LoadResult::Missing);
  backend = initialized();
  backend.durable.at("config0").resize(300); backend.reboot();
  check(store.load(output) == config::LoadResult::Error);
  backend = initialized();
  config::detail::Record latest;
  config::detail::encodeRecord(example(), UINT64_MAX, latest);
  backend.durable["config0"] = std::vector<uint8_t>(latest.bytes, latest.bytes + sizeof(latest.bytes));
  config::detail::encodeSelector(0, UINT64_MAX, backend.durable.at("active").data());
  backend.reboot(); backend.writes = 0;
  check(!store.save(next)); check(backend.writes == 0); check(same(load(backend), example()));
}
int main() {
  hubTests(); credentialTests(); failureTests(); corruptionTests();
  std::cout << "Config validation/transaction checks passed: " << checks << '\n';
}
