// SPDX-FileCopyrightText: 2026 FocusDesk contributors
// SPDX-License-Identifier: GPL-3.0-only
#pragma once
#include "gdem042f52_display.h"
#include "live_model.h"
#include <Fonts/FreeSans9pt7b.h>
#include <Fonts/FreeSansBold9pt7b.h>
#include <Fonts/FreeSansBold12pt7b.h>
#include <Fonts/FreeSansBold24pt7b.h>

namespace focusdesk {
inline void pageFont(GDEM042F52Display& display, const GFXfont* font) {
  display.setFont(font);
  display.setTextSize(1);
}

inline uint16_t pageTextWidth(GDEM042F52Display& display,
                              const std::string& text, const GFXfont* font) {
  pageFont(display, font);
  int16_t x, y;
  uint16_t width, height;
  display.getTextBounds(text.c_str(), 0, 0, &x, &y, &width, &height);
  return static_cast<uint16_t>(width + (x > 0 ? x : 0));
}

inline void pageText(GDEM042F52Display& display, int16_t x, int16_t baseline,
                     const std::string& text, const GFXfont* font,
                     uint16_t color = EPD_BLACK) {
  pageFont(display, font);
  display.setTextColor(color);
  display.setCursor(x, font ? baseline : baseline - 8);
  display.print(text.c_str());
}

inline const GFXfont* taskPageFont(GDEM042F52Display& display,
                                 const std::string& title, uint16_t width,
                                 bool priority = false) {
  if (priority && pageTextWidth(display, title, &FreeSansBold12pt7b) <= width)
    return &FreeSansBold12pt7b;
  const GFXfont* normal = priority ? &FreeSansBold9pt7b : &FreeSans9pt7b;
  return pageTextWidth(display, title, normal) <= width ? normal : nullptr;
}

// Footer repeats a task that is shown in full in the list; only this caption
// may use an ellipsis. All supported 40-character task titles remain visible.
inline std::string footerCaption(const std::string& text) {
  return text.size() <= 30 ? text : text.substr(0, 27) + "...";
}

inline int pageMonth(const std::string& date) {
  return date.size() == 10 ? std::atoi(date.c_str() + 5) : 0;
}

inline int pageWeekday(const std::string& date) {
  const int month = pageMonth(date);
  if (month < 1 || month > 12) return 0;
  int year = std::atoi(date.c_str());
  const int day = std::atoi(date.c_str() + 8);
  constexpr int offsets[] = {0,3,2,5,0,3,5,1,4,6,2,4};
  if (month < 3) --year;
  return (year + year / 4 - year / 100 + year / 400 + offsets[month - 1] + day) % 7;
}

inline std::string pageNumber(int value, size_t width) {
  const auto result = std::to_string(value);
  return std::string(result.size() < width ? width - result.size() : 0, '0') + result;
}

inline std::string focusLocalEnd(const Overview& overview) {
  const auto& stamp = overview.focusEndsAt;
  int year = std::atoi(stamp.c_str()), month = std::atoi(stamp.c_str() + 5), day = std::atoi(stamp.c_str() + 8);
  int hour = std::atoi(stamp.c_str() + 11) + (overview.timezone == "Asia/Shanghai" ? 8 : 0);
  if (hour >= 24) {
    hour -= 24; ++day;
    const auto date = pageNumber(year, 4) + "-" + pageNumber(month, 2) + "-" + pageNumber(day, 2);
    if (!validDate(date)) { day = 1; if (++month > 12) { month = 1; ++year; } }
  }
  return pageNumber(year, 4) + "-" + pageNumber(month, 2) + "-" + pageNumber(day, 2) + " " + pageNumber(hour, 2) + ":" + stamp.substr(14, 2);
}

inline void drawFocus(GDEM042F52Display& display, const Overview& overview) {
  display.fillScreen(EPD_WHITE);
  display.setTextWrap(false);
  pageText(display, 16, 26, "FocusDesk", &FreeSansBold9pt7b);
  pageText(display, 294, 26, "FOCUS / 25 MIN", nullptr);
  display.drawLine(16, 39, 384, 39, EPD_BLACK);
  pageText(display, 16, 55, "ONE THING AT A TIME", nullptr);
  pageText(display, 16, 84, "Focus mode", &FreeSansBold12pt7b);
  display.fillRect(16, 105, 4, 61, EPD_RED);
  pageText(display, 28, 117, "FOCUSING ON", nullptr, EPD_RED);
  for (size_t i = 0; i < overview.count; ++i) {
    if (overview.tasks[i].id == overview.focusTaskId)
      pageText(display, 28, 151, overview.tasks[i].title, taskPageFont(display, overview.tasks[i].title, 350, true));
  }
  display.drawLine(16, 182, 384, 182, EPD_BLACK);
  const std::string local = focusLocalEnd(overview);
  pageText(display, 20, 202, "ENDS AT", nullptr);
  pageText(display, 20, 244, local.substr(local.size() - 5), &FreeSansBold24pt7b);
  pageText(display, 194, 226, local.substr(0, local.size() - 6), nullptr);
  pageText(display, 194, 242, overview.timezone == "UTC" ? "UTC" : "UTC+8 / SHANGHAI", nullptr);
  display.drawLine(16, 267, 384, 267, EPD_BLACK);
  display.fillRoundRect(16, 274, 368, 20, 6, EPD_YELLOW);
  pageText(display, 28, 288, "RETURN TO OVERVIEW AFTER FOCUS", nullptr);
}

inline void drawOverview(GDEM042F52Display& display, const Overview& overview) {
  if (overview.hasFocus) { drawFocus(display, overview); return; }
  const char* const months[] = {"JAN","FEB","MAR","APR","MAY","JUN",
                              "JUL","AUG","SEP","OCT","NOV","DEC"};
  const char* const days[] = {"SUN","MON","TUE","WED","THU","FRI","SAT"};
  const char* const fullDays[] = {"SUNDAY","MONDAY","TUESDAY","WEDNESDAY",
                                "THURSDAY","FRIDAY","SATURDAY"};
  const int month = pageMonth(overview.date);
  const std::string monthName = month >= 1 && month <= 12 ? months[month - 1] : "---";
  const int day = pageWeekday(overview.date);
  size_t completed = 0;
  size_t current = overview.count, next = overview.count;
  for (size_t i = 0; i < overview.count; ++i) {
    if (overview.tasks[i].done) ++completed;
    else if (current == overview.count) current = i;
    else if (next == overview.count) next = i;
  }

  display.fillScreen(EPD_WHITE);
  display.setTextWrap(false);
  pageText(display, 16, 26, "FocusDesk", &FreeSansBold9pt7b);
  const std::string header = "DAILY / " + monthName + "  " + days[day];
  pageText(display, static_cast<int16_t>(384 - pageTextWidth(display, header, nullptr)),
           26, header, nullptr);
  display.drawLine(16, 39, 384, 39, EPD_BLACK);
  pageText(display, 16, 55, overview.date + "  " + fullDays[day], nullptr);
  pageText(display, 16, 84, "Daily overview", &FreeSansBold12pt7b);

  const bool pending = current < overview.count;
  display.fillRect(16, 99, 4, 48, pending ? EPD_RED : EPD_BLACK);
  pageText(display, 28, 109, pending ? "CURRENT PRIORITY" :
           overview.count ? "ALL COMPLETE" : "A LITTLE SPACE", nullptr,
           pending ? EPD_RED : EPD_BLACK);
  const std::string priority = pending ? overview.tasks[current].title :
      overview.count ? "All tasks completed" : "Nothing scheduled";
  pageText(display, 28, 140, priority, taskPageFont(display, priority, 286, true));
  display.fillRoundRect(326, 123, 58, 22, 6, EPD_YELLOW);
  const std::string badge = pending ? "TO DO" : overview.count ? "DONE" : "EMPTY";
  pageText(display, static_cast<int16_t>(355 - badge.size() * 3), 138, badge, nullptr);
  display.drawLine(16, 158, 384, 158, EPD_BLACK);
  pageText(display, 16, 179, "Today's tasks", &FreeSansBold9pt7b);

  if (overview.count == 0) {
    pageText(display, 20, 211, "No tasks", &FreeSans9pt7b);
  }
  for (size_t i = 0; i < overview.count; ++i) {
    const auto& task = overview.tasks[i];
    const int16_t y = static_cast<int16_t>(190 + i * 24);
    if (task.done) display.fillRect(20, y, 12, 12, EPD_BLACK);
    else display.drawRect(20, y, 12, 12, EPD_BLACK);
    if (task.done) {
      display.drawLine(23, y + 6, 26, y + 9, EPD_WHITE);
      display.drawLine(26, y + 9, 30, y + 3, EPD_WHITE);
    }
    const auto* font = taskPageFont(display, task.title, 342);
    pageText(display, 42, y + 11, task.title, font);
    if (task.done) display.drawLine(42, y + 5,
        static_cast<int16_t>(42 + pageTextWidth(display, task.title, font)), y + 5, EPD_BLACK);
  }

  display.drawLine(16, 267, 384, 267, EPD_BLACK);
  pageText(display, 16, 288, std::to_string(completed) + " / " +
           std::to_string(overview.count) + " done", &FreeSansBold9pt7b);
  display.drawLine(169, 275, 169, 292, EPD_BLACK);
  display.fillRoundRect(184, 274, 200, 20, 6, EPD_YELLOW);
  const std::string caption = next < overview.count ? "NEXT: " + overview.tasks[next].title :
      pending ? "ONE THING AT A TIME" : overview.count ? "ALL TASKS DONE" : "ADD YOUR FIRST TASK";
  pageText(display, 192, 288, footerCaption(caption), nullptr);
}
}  // namespace focusdesk
