// SPDX-FileCopyrightText: 2026 FocusDesk contributors
// SPDX-License-Identifier: GPL-3.0-only
#pragma once

#include <utility>
#include <vector>
#include "../focusdesk_live/live_model.h"
#include "../focusdesk_live/gdem042f52_display.h"
#include <Fonts/FreeSans9pt7b.h>
#include <Fonts/FreeSansBold9pt7b.h>
#include <Fonts/FreeSansBold18pt7b.h>
#include <Fonts/FreeSans12pt7b.h>
#include <Fonts/FreeSansBold12pt7b.h>
#include "fonts/SourceSans3Regular9pt7b.h"
#include "fonts/SourceSans3Bold9pt7b.h"
#include "fonts/SourceSans3Bold18pt7b.h"
#include "fonts/SourceSans3Regular12pt7b.h"
#include "fonts/SourceSans3Bold12pt7b.h"
#include "fonts/NunitoRegular10px.h"
#include "fonts/NunitoBold10px.h"
#include "fonts/NunitoRegular11px.h"
#include "fonts/NunitoBold11px.h"
#include "fonts/NunitoRegular13px.h"
#include "fonts/NunitoRegular16px.h"
#include "fonts/NunitoBold16px.h"
#include "fonts/NunitoBold17px.h"

namespace focusdesk {
constexpr size_t MAX_DISPLAY_COMMANDS = 64;
constexpr size_t MAX_DISPLAY_TEXT = 1024;

// The Hub supplies the layout. This renderer deliberately contains no task,
// goal, signal selection or line-fitting rules of its own.
struct DisplayCommand {
  int kind = 0, x = 0, y = 0, a = 0, b = 0, color = 0;
  std::string text;
};
struct DisplaySnapshot {
  std::string revision;
  std::vector<DisplayCommand> commands;
};

inline const GFXfont* displaySnapshotFont(int index) {
  const GFXfont* fonts[] = {
      &FreeSans9pt7b, &FreeSansBold9pt7b, &FreeSansBold18pt7b,
      &FreeSans12pt7b, &FreeSansBold12pt7b,
      &SourceSans3Regular9pt7b, &SourceSans3Bold9pt7b, &SourceSans3Bold18pt7b,
      &SourceSans3Regular12pt7b, &SourceSans3Bold12pt7b,
      &NunitoRegular10px, &NunitoBold10px, &NunitoRegular11px, &NunitoBold11px,
      &NunitoRegular13px, &NunitoRegular16px, &NunitoBold16px, &NunitoBold17px};
  return fonts[index];
}
inline bool snapshotInteger(ArduinoJson::JsonVariantConst value, int& output,
                            int minimum, int maximum) {
  if (!value.is<int>()) return false;
  output = value.as<int>();
  return output >= minimum && output <= maximum;
}
inline bool snapshotTextBounds(const DisplayCommand& command) {
  const GFXfont* font = displaySnapshotFont(command.a);
  int cursor = command.x;
  for (const unsigned char c : command.text) {
    if (c < 0x20 || c > 0x7e) return false;
    const GFXglyph& glyph = font->glyph[c - font->first];
    if (glyph.width && glyph.height) {
      const int left = cursor + glyph.xOffset, top = command.y + glyph.yOffset;
      if (left < 0 || top < 0 || left + glyph.width > 400 || top + glyph.height > 300) return false;
    }
    cursor += glyph.xAdvance;
    if (cursor > 400) return false;
  }
  return true;
}

inline bool parseDisplaySnapshot(const char* body, size_t length,
                                  DisplaySnapshot& output, const char*& error) {
  error = "INVALID_DISPLAY_SNAPSHOT";
  if (!body || !length || length > MAX_BODY_BYTES) { error = "BODY_LIMIT"; return false; }
  if (!validUtf8(body, length) || !JsonSyntax(body, length).valid()) {
    error = "INVALID_JSON_UTF8"; return false;
  }
  JsonBudget budget;
  ArduinoJson::JsonDocument doc(&budget);
  if (ArduinoJson::deserializeJson(doc, body, length,
      ArduinoJson::DeserializationOption::NestingLimit(12))) {
    error = "JSON_PARSE_OR_MEMORY"; return false;
  }
  if (!doc.is<ArduinoJson::JsonObjectConst>()) return false;
  const auto root = doc.as<ArduinoJson::JsonObjectConst>();
  if (root.size() != 6 || root["schema_version"] != "display-1" ||
      root["layout_version"] != "goal-1") {
    error = "UNSUPPORTED_DISPLAY_VERSION"; return false;
  }
  int width = 0, height = 0;
  DisplaySnapshot candidate;
  if (!snapshotInteger(root["width"], width, 400, 400) ||
      !snapshotInteger(root["height"], height, 300, 300) ||
      !readString(root["revision"], candidate.revision, 80) ||
      !ascii(candidate.revision, false, 80) ||
      !root["commands"].is<ArduinoJson::JsonArrayConst>()) return false;
  const auto commands = root["commands"].as<ArduinoJson::JsonArrayConst>();
  if (commands.size() > MAX_DISPLAY_COMMANDS) { error = "COMMAND_LIMIT"; return false; }
  candidate.commands.reserve(commands.size());
  size_t textBytes = 0;
  for (const auto raw : commands) {
    if (!raw.is<ArduinoJson::JsonArrayConst>()) return false;
    const auto values = raw.as<ArduinoJson::JsonArrayConst>();
    DisplayCommand command;
    if (values.size() != 6 || !snapshotInteger(values[0], command.kind, 0, 2) ||
        !snapshotInteger(values[1], command.x, 0, 399) ||
        !snapshotInteger(values[2], command.y, 0, 299)) return false;
    if (command.kind == 0) {
      if (!snapshotInteger(values[3], command.a, 1, 400 - command.x) ||
          !snapshotInteger(values[4], command.b, 1, 300 - command.y) ||
          !snapshotInteger(values[5], command.color, 0, 3)) return false;
    } else if (command.kind == 1) {
      if (!snapshotInteger(values[3], command.a, 0, 17) ||
          !snapshotInteger(values[4], command.color, 0, 3) ||
          !readString(values[5], command.text, 96) || !snapshotTextBounds(command)) return false;
      textBytes += command.text.size();
      if (textBytes > MAX_DISPLAY_TEXT) { error = "TEXT_LIMIT"; return false; }
    } else {
      if (!snapshotInteger(values[3], command.a, 1, 64) ||
          !snapshotInteger(values[4], command.color, 0, 3) ||
          !snapshotInteger(values[5], command.b, 0, 1) ||
          command.x - command.a < 0 || command.x + command.a >= 400 ||
          command.y - command.a < 0 || command.y + command.a >= 300) return false;
    }
    candidate.commands.push_back(std::move(command));
  }
  // Only a fully validated scene may replace the last accepted snapshot.
  output = std::move(candidate);
  error = nullptr;
  return true;
}

inline void drawDisplaySnapshot(GDEM042F52Display& display, const DisplaySnapshot& snapshot) {
  const uint16_t colors[] = {EPD_BLACK, EPD_WHITE, EPD_YELLOW, EPD_RED};
  display.setRotation(0);
  display.setTextWrap(false);
  display.setTextSize(1);
  display.fillScreen(EPD_WHITE);
  for (const auto& command : snapshot.commands) {
    const uint16_t color = colors[command.color];
    if (command.kind == 0) {
      display.fillRect(command.x, command.y, command.a, command.b, color);
    } else if (command.kind == 1) {
      display.setFont(displaySnapshotFont(command.a));
      display.setTextColor(color);
      display.setCursor(command.x, command.y);
      display.print(command.text.c_str());
    } else {
      for (int dy = -command.a; dy <= command.a; ++dy) {
        for (int dx = -command.a; dx <= command.a; ++dx) {
          const int distance = std::abs(dx) + std::abs(dy);
          if (distance == command.a || (command.b && distance < command.a)) {
            display.drawPixel(command.x + dx, command.y + dy, color);
          }
        }
      }
    }
  }
}
}  // namespace focusdesk
