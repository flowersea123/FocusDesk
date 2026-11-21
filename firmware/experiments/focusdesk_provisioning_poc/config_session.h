// SPDX-License-Identifier: GPL-3.0-only
#pragma once
#include "config_store.h"
#include "poc_logic.h"

namespace focusdesk_config {
enum class HubResult { Ready, Unreachable, Invalid };

// The loop task owns this controller. HTTP handlers exchange requests and
// snapshots with that task instead of touching credentials or NVS directly.
template <class Store, class Link>
class ConfigSession {
 public:
  ConfigSession(Store& store, Link& link) : store_(store), link_(link) {}

  focusdesk_poc::Attempt attempt;
  const char* result = "none";
  const char* error = "";

  bool storageReady() const { return storageReady_; }
  bool hasSaved() const { return hasSaved_; }
  const Config& saved() const { return saved_; }
  bool testing() const { return std::strcmp(result, "testing") == 0; }

  void begin(uint32_t now) {
    storageReady_ = store_.available();
    if (!storageReady_) { error = "STORAGE_UNAVAILABLE"; return; }
    const LoadResult loaded = store_.load(saved_);
    hasSaved_ = loaded == LoadResult::Loaded;
    if (loaded == LoadResult::Error) {
      storageReady_ = false;
      error = "STORAGE_UNAVAILABLE";
      return;
    }
    restore(now);
  }

  bool startTrial(const Config& candidate, const char* id, uint32_t now) {
    if (!storageReady_ || testing() || !validConfig(candidate)) return false;
    if (attempt.id[0] && std::strcmp(attempt.id, id) == 0) return false;
    const bool sameConnectedWifi = mode_ == Mode::Online && hasSaved_ &&
        std::strcmp(candidate.ssid, saved_.ssid) == 0 &&
        std::strcmp(candidate.password, saved_.password) == 0 && link_.matches(saved_);
    // A manual edit may interrupt a background reconnect of the saved network.
    attempt.state = focusdesk_poc::State::Idle;
    if (attempt.accept(id) != focusdesk_poc::Acceptance::New) return false;
    candidate_ = candidate;
    result = "testing";
    error = "";
    attempt.start(now);
    started_ = now;
    usingSavedWifi_ = sameConnectedWifi;
    if (usingSavedWifi_) {
      beginHubVerification(now);
    } else {
      mode_ = Mode::Trial;
      if (!link_.connect(candidate_)) fail("WIFI_FAILED", now);
    }
    return true;
  }

  void tick(uint32_t now, bool setupOpen) {
    if (testing() && !setupOpen) { fail("SESSION_EXPIRED", now); return; }
    if (mode_ == Mode::Trial) {
      if (static_cast<uint32_t>(now - started_) >= focusdesk_poc::CONNECT_TIMEOUT_MS) {
        fail("WIFI_FAILED", now);
      } else if (link_.matches(candidate_)) {
        beginHubVerification(now);
      }
      return;
    }
    if (mode_ == Mode::Verify) {
      if (!link_.matches(candidate_)) { fail("WIFI_FAILED", now); return; }
      const HubResult hub = link_.verifyHub(candidate_);
      const uint32_t afterCheck = link_.now();
      if (!link_.windowOpen()) { fail("SESSION_EXPIRED", afterCheck); return; }
      if (!link_.matches(candidate_)) { fail("WIFI_FAILED", afterCheck); return; }
      if (hub != HubResult::Ready) {
        fail(hub == HubResult::Invalid ? "HUB_INVALID" : "HUB_UNREACHABLE", afterCheck);
        return;
      }
      attempt.state = focusdesk_poc::State::Saving;
      mode_ = Mode::Save;
      return;
    }
    if (mode_ == Mode::Save) {
      if (!link_.windowOpen()) { fail("SESSION_EXPIRED", now); return; }
      if (!link_.matches(candidate_)) { fail("WIFI_FAILED", now); return; }
      if (!store_.save(candidate_)) {
        // A flash API can report an error after publishing a validated record.
        // Reload the authoritative selector before choosing what to reconnect.
        Config durable;
        const LoadResult loaded = store_.load(durable);
        if (loaded == LoadResult::Loaded) { saved_ = durable; hasSaved_ = true; }
        else if (loaded == LoadResult::Error) storageReady_ = false;
        focusdesk_poc::wipe(&durable, sizeof(durable));
        fail("NVS_SAVE_FAILED", link_.now());
        return;
      }
      saved_ = candidate_;
      hasSaved_ = true;
      usingSavedWifi_ = false;
      focusdesk_poc::wipe(&candidate_, sizeof(candidate_));
      result = "saved";
      error = "";
      attempt.state = focusdesk_poc::State::Connected;
      mode_ = Mode::Online;
      return;
    }
    if (mode_ == Mode::Restoring) {
      if (link_.matches(saved_)) {
        mode_ = Mode::Online;
        if (std::strcmp(result, "failed") != 0) attempt.state = focusdesk_poc::State::Connected;
      } else if (static_cast<uint32_t>(now - started_) >= focusdesk_poc::CONNECT_TIMEOUT_MS) {
        waitToRetry(now);
      }
      return;
    }
    if (mode_ == Mode::Online && !link_.matches(saved_)) {
      if (std::strcmp(result, "failed") != 0) attempt.state = focusdesk_poc::State::Disconnected;
      waitToRetry(now);
    } else if (mode_ == Mode::Waiting && static_cast<uint32_t>(now - started_) >= RETRY_MS) {
      restore(now);
    }
  }

 private:
  enum class Mode { Idle, Trial, Verify, Save, Restoring, Online, Waiting };
  static constexpr uint32_t RETRY_MS = 10000;
  Store& store_;
  Link& link_;
  Config saved_ = {};
  Config candidate_ = {};
  bool hasSaved_ = false;
  bool storageReady_ = false;
  bool usingSavedWifi_ = false;
  Mode mode_ = Mode::Idle;
  uint32_t started_ = 0;

  void beginHubVerification(uint32_t now) {
    if (link_.subnetConflict()) { fail("SUBNET_CONFLICT", now); return; }
    attempt.state = focusdesk_poc::State::Verifying;
    mode_ = Mode::Verify;
  }

  void waitToRetry(uint32_t now) {
    link_.disconnect();
    started_ = now;
    mode_ = Mode::Waiting;
    if (std::strcmp(result, "failed") != 0) attempt.state = focusdesk_poc::State::Disconnected;
  }
  void restore(uint32_t now) {
    if (!hasSaved_) { link_.disconnect(); mode_ = Mode::Idle; return; }
    started_ = now;
    mode_ = Mode::Restoring;
    if (std::strcmp(result, "failed") != 0) attempt.state = focusdesk_poc::State::Connecting;
    if (!link_.connect(saved_)) waitToRetry(now);
  }
  void fail(const char* reason, uint32_t now) {
    result = "failed";
    error = reason;
    attempt.state = focusdesk_poc::State::Failed;
    focusdesk_poc::wipe(&candidate_, sizeof(candidate_));
    const bool savedWifiStillConnected = usingSavedWifi_ && link_.matches(saved_);
    usingSavedWifi_ = false;
    if (savedWifiStillConnected) mode_ = Mode::Online;
    else restore(now);
  }
};
}  // namespace focusdesk_config
