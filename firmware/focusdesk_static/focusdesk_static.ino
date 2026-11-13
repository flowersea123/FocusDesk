// SPDX-FileCopyrightText: 2026 FocusDesk contributors
// SPDX-License-Identifier: GPL-3.0-only
// License applies to this diagnostic firmware, not the entire FocusDesk project.

#include "static_page.h"

GDEM042F52Display display;

void setup() {
  Serial.begin(115200);
  delay(250);  // A short startup pause; never wait indefinitely for a USB host.
  Serial.println("[FocusDesk] STATIC_TEST: SYNTHETIC DATA / NO NETWORK");

  if (!display.begin()) {
    Serial.println("[FocusDesk] DISPLAY_FAILED: SCREEN_STATE_UNKNOWN");
    return;
  }
  drawStaticPage(display);
  if (display.update()) {
    Serial.println("[FocusDesk] DISPLAY_OK");
  } else {
    Serial.println("[FocusDesk] DISPLAY_FAILED: SCREEN_STATE_UNKNOWN");
  }
}

void loop() {
  delay(1000);  // One refresh per boot, including after failure. No auto-retry.
}
