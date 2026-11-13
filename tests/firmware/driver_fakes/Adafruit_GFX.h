// SPDX-FileCopyrightText: 2026 FocusDesk contributors
// SPDX-License-Identifier: GPL-3.0-only
#pragma once
#include <Arduino.h>

#include <cassert>
#include <vector>

struct GfxCall {
  std::string kind;
  int x, y, w, h;
  uint16_t color;
  std::string text;
};

// Capture renderer operations and check classic built-in font cell bounds.
// This does not emulate font glyphs or claim pixel-exact GFX text rendering.
class Adafruit_GFX {
 public:
  std::vector<GfxCall> calls;
  Adafruit_GFX(int16_t w, int16_t h) : width_(w), height_(h) {}
  virtual ~Adafruit_GFX() = default;
  virtual void drawPixel(int16_t, int16_t, uint16_t) = 0;
  void setRotation(uint8_t value) { assert(value == 0); }
  void setTextWrap(bool value) { assert(!value); }
  void setTextColor(uint16_t value) { textColor_ = value; }
  void setTextSize(uint8_t value) { textSize_ = value; }
  void setCursor(int16_t x, int16_t y) { x_ = x; y_ = y; }
  void fillScreen(uint16_t color) {
    calls.push_back({"clear", 0, 0, width_, height_, color, ""});
    for (int y = 0; y < height_; ++y)
      for (int x = 0; x < width_; ++x) drawPixel(x, y, color);
  }
  void drawRect(int16_t x, int16_t y, int16_t w, int16_t h, uint16_t c) {
    record("rect", x, y, w, h, c);
  }
  void fillRect(int16_t x, int16_t y, int16_t w, int16_t h, uint16_t c) {
    record("fill", x, y, w, h, c);
    for (int yy = y; yy < y + h; ++yy)
      for (int xx = x; xx < x + w; ++xx) drawPixel(xx, yy, c);
  }
  void drawLine(int16_t x, int16_t y, int16_t xx, int16_t yy, uint16_t c) {
    assert(x >= 0 && xx >= 0 && x < width_ && xx < width_);
    assert(y >= 0 && yy >= 0 && y < height_ && yy < height_);
    calls.push_back({"line", x, y, xx, yy, c, ""});
  }
  void print(const char* value) {
    const std::string text(value);
    const int w = static_cast<int>(text.size()) * 6 * textSize_;
    const int h = 8 * textSize_;
    bounds(x_, y_, w, h);
    calls.push_back({"text", x_, y_, w, h, textColor_, text});
    x_ += w;
  }

 private:
  int width_, height_, x_ = 0, y_ = 0;
  uint8_t textSize_ = 1;
  uint16_t textColor_ = 0;
  void bounds(int x, int y, int w, int h) {
    assert(x >= 0 && y >= 0 && w > 0 && h > 0);
    assert(x + w <= width_ && y + h <= height_);
  }
  void record(const char* kind, int x, int y, int w, int h, uint16_t c) {
    bounds(x, y, w, h);
    calls.push_back({kind, x, y, w, h, c, ""});
  }
};
