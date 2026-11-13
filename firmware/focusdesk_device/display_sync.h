// SPDX-FileCopyrightText: 2026 FocusDesk contributors
// SPDX-License-Identifier: GPL-3.0-only
#pragma once
#include <utility>
#include "../focusdesk_live/live_model.h"
#include "../focusdesk_live/live_state.h"

namespace focusdesk {
// Fetcher supplies ready(origin), read(origin, output), and now(). Panel supplies
// show(overview). The device loop owns both adapters and this synchronizer.
template <class Fetcher, class Panel, class Model = Overview>
class DisplaySync {
 public:
  DisplaySync(Fetcher& fetcher, Panel& panel) : fetcher_(fetcher), panel_(panel) {}

  const Model& lastValid() const { return lastValid_; }
  const PollState& state() const { return state_; }
  const std::string& source() const { return source_; }

  void tick(const char* hubOrigin) {
    if (!hubOrigin || !hubOrigin[0] || !fetcher_.ready(hubOrigin)) return;
    if (source_ != hubOrigin) {
      source_ = hubOrigin;
      state_.requestPoll();
    }
    if (!state_.pollDue(fetcher_.now())) return;

    Model candidate;
    bool success = fetcher_.read(hubOrigin, candidate);
    // Configuration requests can arrive on the HTTP task while a fetch waits.
    // Cancel that read without replacing the last accepted snapshot or screen.
    if (!fetcher_.ready(hubOrigin)) return;

    bool deferred = false;
    if (success) {
      lastValid_ = std::move(candidate);
      const std::string revision = source_ + '\n' + lastValid_.revision;
      if (!state_.isDisplayed(revision)) {
        if (state_.canDisplay(fetcher_.now(), revision)) {
          success = panel_.show(lastValid_);
          state_.displayFinished(fetcher_.now(), revision, success);
        } else {
          deferred = true;
        }
      }
    }
    if (deferred) state_.pollDeferred(fetcher_.now());
    else state_.pollFinished(fetcher_.now(), success);
  }

 private:
  Fetcher& fetcher_;
  Panel& panel_;
  PollState state_;
  Model lastValid_;
  std::string source_;
};
}  // namespace focusdesk
