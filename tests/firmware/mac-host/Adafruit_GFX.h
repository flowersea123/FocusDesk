// SPDX-License-Identifier: GPL-3.0-only
#pragma once
#include <vector>

#ifndef FOCUSDESK_UPSTREAM_GFX_HEADER
#error "Build through scripts/test-display-host.mjs with the pinned upstream GFX source."
#endif

// Rename the official base class, also renamed when compiling its unmodified
// .cpp, so the old test harness can keep its calls.clear() compatibility hook.
// No drawing methods are overridden: all geometry and glyph rendering are the
// upstream Adafruit GFX implementation, not the live_fakes implementation.
#ifndef ARDUINO
#define ARDUINO 100
#define FOCUSDESK_UNDEFINE_ARDUINO
#endif
#define Adafruit_GFX FocusDeskUpstreamGFX
#include FOCUSDESK_UPSTREAM_GFX_HEADER
#undef Adafruit_GFX
#ifdef FOCUSDESK_UNDEFINE_ARDUINO
#undef ARDUINO
#undef FOCUSDESK_UNDEFINE_ARDUINO
#endif

class Adafruit_GFX : public FocusDeskUpstreamGFX {
 public:
  using FocusDeskUpstreamGFX::FocusDeskUpstreamGFX;
  std::vector<int> calls;  // The snapshot test only clears this; never rendered.
};
