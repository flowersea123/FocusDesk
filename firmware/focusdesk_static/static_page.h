// SPDX-FileCopyrightText: 2026 FocusDesk contributors
// SPDX-License-Identifier: GPL-3.0-only
#pragma once

#include "gdem042f52_display.h"

// Fixed English hardware diagnostics, unrelated to live tasks or API fixtures.
inline void drawStaticPage(GDEM042F52Display& display) {
  display.fillScreen(EPD_WHITE);
  display.setTextWrap(false);
  display.setTextColor(EPD_BLACK);
  display.drawRect(8, 8, 384, 284, EPD_BLACK);

  display.setTextSize(3);
  display.setCursor(20, 18);
  display.print("FocusDesk");
  display.setTextSize(1);
  display.setCursor(260, 26);
  display.print("STATIC TEST");
  display.setCursor(20, 54);
  display.print("DIAGNOSTIC DATE: 2026-11-02");
  display.setCursor(20, 70);
  display.print("FIXED SAMPLE / NO NETWORK");
  display.drawLine(20, 88, 380, 88, EPD_BLACK);
  display.setCursor(20, 100);
  display.print("DIAGNOSTIC TASKS");

  const char* const titles[] = {
      "Check display layout", "Inspect text and boxes", "Inspect color patches"};
  for (uint8_t i = 0; i < 3; ++i) {
    const int16_t y = static_cast<int16_t>(124 + i * 36);
    display.drawRect(20, y, 14, 14, EPD_BLACK);
    if (i == 0) {
      // Only the first synthetic task is checked; this is sample status.
      display.drawLine(23, y + 6, 26, y + 9, EPD_BLACK);
      display.drawLine(26, y + 9, 31, y + 2, EPD_BLACK);
    }
    display.setTextSize(2);
    display.setCursor(46, y + 1);
    display.print(titles[i]);
  }

  display.setTextSize(1);
  display.setCursor(20, 236);
  display.print("SYNTHETIC / NOT LIVE TASKS");
}
