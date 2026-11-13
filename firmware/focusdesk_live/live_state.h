// SPDX-FileCopyrightText: 2026 FocusDesk contributors
// SPDX-License-Identifier: GPL-3.0-only
#pragma once
#include <cstdint>
#include <string>

namespace focusdesk {
class PollState {
 public:
  void requestPoll() { hasPoll_ = false; }
  bool pollDue(uint32_t now) const {
    return !hasPoll_ || static_cast<uint32_t>(now - lastPoll_) >= pollDelay_;
  }
  void pollFinished(uint32_t now, bool success) {
    hasPoll_ = true; lastPoll_ = now;
    if (success) { failures_ = 0; pollDelay_ = 30000; }
    else {
      constexpr uint32_t delays[] = {30000,60000,120000,240000,300000};
      pollDelay_ = delays[failures_ < 5 ? failures_ : 4];
      if (failures_ < 5) ++failures_;
    }
  }
  void pollDeferred(uint32_t now) {
    // Waiting for the display guard is not a successful screen recovery.
    // Retain the error streak so repeated display failures still back off.
    hasPoll_ = true; lastPoll_ = now; pollDelay_ = 30000;
  }
  bool isDisplayed(const std::string& revision) const {
    return screenValid_ && displayedRevision_ == revision;
  }
  bool canDisplay(uint32_t now, const std::string& revision) const {
    return !isDisplayed(revision) &&
        (!hasDisplay_ || static_cast<uint32_t>(now - lastDisplay_) >= 60000);
  }
  void displayFinished(uint32_t now, const std::string& revision, bool success) {
    hasDisplay_ = true; lastDisplay_ = now; screenValid_ = success;
    if (success) displayedRevision_ = revision;
  }
  bool screenValid() const { return screenValid_; }
  const std::string& displayedRevision() const { return displayedRevision_; }
  uint32_t pollDelay() const { return pollDelay_; }
 private:
  bool hasPoll_ = false, hasDisplay_ = false, screenValid_ = false;
  uint8_t failures_ = 0;
  uint32_t lastPoll_ = 0, pollDelay_ = 30000, lastDisplay_ = 0;
  std::string displayedRevision_;
};
}  // namespace focusdesk
