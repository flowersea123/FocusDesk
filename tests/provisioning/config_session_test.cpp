// SPDX-License-Identifier: GPL-3.0-only
#include <cstdlib>
#include <iostream>
#include <string>
#include "../../firmware/experiments/focusdesk_provisioning_poc/config_session.h"
#include "../../firmware/experiments/focusdesk_provisioning_poc/hub_validation.h"

namespace fc = focusdesk_config;
namespace poc = focusdesk_poc;
unsigned checks = 0;
void check(bool condition) {
  ++checks;
  if (!condition) { std::cerr << "Failed check " << checks << '\n'; std::exit(1); }
}
fc::Config config(const char* ssid = "original", const char* password = "original-pass",
                  const char* hub = "http://192.168.1.10:8787") {
  fc::Config value;
  std::strcpy(value.ssid, ssid);
  std::strcpy(value.password, password);
  std::strcpy(value.hub_url, hub);
  return value;
}
bool same(const fc::Config& a, const fc::Config& b) { return std::memcmp(&a, &b, sizeof(a)) == 0; }
struct Store {
  bool ready = true, exists = true, loadError = false, saveError = false, publishedOnError = false;
  unsigned writes = 0;
  fc::Config durable = config();
  bool available() { return ready; }
  fc::LoadResult load(fc::Config& output) {
    if (loadError) return fc::LoadResult::Error;
    if (!exists) return fc::LoadResult::Missing;
    output = durable;
    return fc::LoadResult::Loaded;
  }
  bool save(const fc::Config& value) {
    ++writes;
    if (!saveError || publishedOnError) { durable = value; exists = true; }
    return !saveError;
  }
};
struct Link {
  bool online = false, beginOk = true, open = true, conflict = false, dropDuringHub = false, expireDuringHub = false;
  unsigned connects = 0, hubChecks = 0;
  uint32_t clock = 0;
  fc::HubResult hub = fc::HubResult::Ready;
  fc::Config target = {};
  bool connect(const fc::Config& value) { ++connects; target = value; online = false; return beginOk; }
  void disconnect() { online = false; }
  bool matches(const fc::Config& value) { return online && same(value, target); }
  bool subnetConflict() { return conflict; }
  fc::HubResult verifyHub(const fc::Config&) {
    ++hubChecks;
    if (dropDuringHub) online = false;
    if (expireDuringHub) open = false;
    return hub;
  }
  uint32_t now() { return clock; }
  bool windowOpen() { return open; }
};
using Session = fc::ConfigSession<Store, Link>;
void tick(Session& session, Link& link, uint32_t now, bool open = true) {
  link.clock = now; link.open = open; session.tick(now, open);
}
void reachSaving(Session& session, Link& link) {
  link.online = true;
  tick(session, link, 1);
  check(session.attempt.state == poc::State::Verifying);
  tick(session, link, 2);
  check(session.attempt.state == poc::State::Saving);
}
int main() {
  const auto original = config();
  const auto replacement = config("new network", "new-password", "http://192.168.1.20:8787");
  {
    Store store; store.exists = false;
    Link link; Session session(store, link); session.begin(0);
    check(session.storageReady() && !session.hasSaved() && link.connects == 0);
    check(session.startTrial(replacement, "first", 0));
    check(!session.startTrial(original, "second", 0));
    tick(session, link, 100);
    check(store.writes == 0 && session.attempt.state == poc::State::Connecting);
    reachSaving(session, link);
    check(store.writes == 0);
    tick(session, link, 3);
    check(store.writes == 1 && same(store.durable, replacement));
    check(session.hasSaved() && std::strcmp(session.result, "saved") == 0);
    check(session.attempt.state == poc::State::Connected);
    check(!session.startTrial(original, "first", 4));
    Link rebootLink; Session reboot(store, rebootLink); reboot.begin(0);
    check(rebootLink.connects == 1 && same(rebootLink.target, replacement));
    rebootLink.online = true; tick(reboot, rebootLink, 1, false);
    check(reboot.attempt.state == poc::State::Connected && store.writes == 1);
    rebootLink.online = false; tick(reboot, rebootLink, 100, false);
    check(reboot.attempt.state == poc::State::Disconnected);
    tick(reboot, rebootLink, 10099, false); check(rebootLink.connects == 1);
    tick(reboot, rebootLink, 10100, false); check(rebootLink.connects == 2);
  }
  {
    Store store; Link link; Session session(store, link); session.begin(0);
    link.online = true; tick(session, link, 1);
    check(session.attempt.state == poc::State::Connected);
    auto wrongPassword = original; std::strcpy(wrongPassword.password, "wrong-password");
    check(session.startTrial(wrongPassword, "wrong-password", 10));
    check(!link.online);
    tick(session, link, 30010);
    check(std::strcmp(session.error, "WIFI_FAILED") == 0 && store.writes == 0);
    check(same(store.durable, original) && same(link.target, original));
    link.online = true; tick(session, link, 30011);
    check(session.attempt.state == poc::State::Failed && std::strcmp(session.result, "failed") == 0);
  }
  for (const auto outcome : {fc::HubResult::Unreachable, fc::HubResult::Invalid}) {
    Store store; Link link; Session session(store, link); session.begin(0);
    check(session.startTrial(replacement, "hub-error", 0));
    link.online = true; tick(session, link, 1);
    link.hub = outcome; tick(session, link, 2);
    check(store.writes == 0 && same(store.durable, original) && same(link.target, original));
    check(std::strcmp(session.error, outcome == fc::HubResult::Invalid ? "HUB_INVALID" : "HUB_UNREACHABLE") == 0);
  }
  for (bool afterPublication : {false, true}) {
    Store store; Link link; Session session(store, link); session.begin(0);
    check(session.startTrial(replacement, "flash-error", 0));
    reachSaving(session, link);
    store.saveError = true; store.publishedOnError = afterPublication;
    tick(session, link, 3);
    check(std::strcmp(session.error, "NVS_SAVE_FAILED") == 0);
    check(same(link.target, afterPublication ? replacement : original));
    check(std::strcmp(session.result, "failed") == 0);
  }
  for (unsigned phase = 0; phase < 3; ++phase) {
    Store store; Link link; Session session(store, link); session.begin(0);
    check(session.startTrial(replacement, "expire", 0));
    if (phase > 0) { link.online = true; tick(session, link, 1); }
    if (phase > 1) tick(session, link, 2);
    tick(session, link, 600001, false);
    check(store.writes == 0 && same(store.durable, original) && same(link.target, original));
    check(std::strcmp(session.error, "SESSION_EXPIRED") == 0);
  }
  for (bool expires : {false, true}) {
    Store store; Link link; Session session(store, link); session.begin(0);
    check(session.startTrial(replacement, "verify-interrupted", 0));
    link.online = true; tick(session, link, 1);
    link.expireDuringHub = expires; link.dropDuringHub = !expires;
    tick(session, link, 2);
    check(store.writes == 0 && same(store.durable, original));
    check(std::strcmp(session.error, expires ? "SESSION_EXPIRED" : "WIFI_FAILED") == 0);
  }
  {
    Store store; Link link; Session session(store, link); session.begin(0);
    check(session.startTrial(replacement, "drop-before-save", 0));
    reachSaving(session, link); link.online = false; tick(session, link, 3);
    check(store.writes == 0 && std::strcmp(session.error, "WIFI_FAILED") == 0);
  }
  {
    Store store; Link link; Session session(store, link); session.begin(0);
    check(session.startTrial(replacement, "conflict", 0));
    link.online = true; link.conflict = true; tick(session, link, 1);
    check(store.writes == 0 && link.hubChecks == 0 && std::strcmp(session.error, "SUBNET_CONFLICT") == 0);
  }
  {
    Store store; store.loadError = true;
    Link link; Session session(store, link); session.begin(0);
    check(!session.storageReady() && link.connects == 0);
    check(!session.startTrial(replacement, "no-storage", 0) && store.writes == 0);
  }
  {
    Store store; Link link; Session session(store, link); session.begin(0);
    check(session.startTrial(replacement, "flash-read-error", 0));
    reachSaving(session, link); store.saveError = true; store.loadError = true;
    tick(session, link, 3);
    check(!session.storageReady() && same(link.target, original));
  }
  {
    Store store; Link link; Session session(store, link); session.begin(0);
    tick(session, link, 30000, false);
    check(store.writes == 0 && session.attempt.state == poc::State::Disconnected);
    tick(session, link, 40000, false); check(link.connects == 2);
  }
  {
    poc::Credentials output;
    const std::string form = "ssid=desk&password=password&hub_url=http%3A%2F%2F192.168.1.2%3A8787&attempt_id=one";
    check(poc::parseForm(form.c_str(), form.size(), output, true) == nullptr);
    check(std::strcmp(output.hub_url, "http://192.168.1.2:8787") == 0);
    for (const std::string suffix : {"&hub_url=other", "&unknown=other"})
      check(poc::parseForm((form + suffix).c_str(), form.size() + suffix.size(), output, true) != nullptr);
    const std::string noHub = "ssid=desk&password=password&attempt_id=one";
    check(poc::parseForm(noHub.c_str(), noHub.size(), output, true) != nullptr);
    poc::Attempt attempt; attempt.state = poc::State::Saving;
    check(attempt.accept("other") == poc::Acceptance::Busy);
    attempt.state = poc::State::Verifying;
    check(attempt.accept("other") == poc::Acceptance::Busy);
  }
  check(fc::boundedHubJson("{\"service\":\"FocusDesk\"}", 23));
  check(!fc::boundedHubJson(std::string(13, '[').c_str(), 13));
  check(!fc::boundedHubJson("[1", 2));
  check(!fc::boundedHubJson("\"unfinished", 11));
  check(!fc::boundedHubJson("[\0]", 3));
  std::cout << "P2 configuration session checks passed: " << checks << '\n';
}
