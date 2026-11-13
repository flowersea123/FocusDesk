// SPDX-FileCopyrightText: 2026 FocusDesk contributors
// SPDX-License-Identifier: GPL-3.0-only
#pragma once
#include <Arduino.h>

#include <cassert>
#include <algorithm>
#include <cstdlib>
#include <vector>
#include <gfxfont.h>
#include <glcdfont.c>

struct GfxCall {
  std::string kind;
  int x, y, w, h;
  uint16_t color;
  std::string text;
};

// Use the installed GFX font data for actual glyph metrics and a host raster.
// This validates drawing bounds and previews the framebuffer, not panel waveforms.
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
  void setFont(const GFXfont* value = nullptr) { font_ = value; }
  void setCursor(int16_t x, int16_t y) { x_ = x; y_ = y; }
  void fillScreen(uint16_t color) {
    calls.push_back({"clear", 0, 0, width_, height_, color, ""});
    for (int y = 0; y < height_; ++y)
      for (int x = 0; x < width_; ++x) drawPixel(x, y, color);
  }
  void drawRect(int16_t x, int16_t y, int16_t w, int16_t h, uint16_t c) {
    record("rect", x, y, w, h, c);
    for (int xx = x; xx < x + w; ++xx) { drawPixel(xx, y, c); drawPixel(xx, y + h - 1, c); }
    for (int yy = y; yy < y + h; ++yy) { drawPixel(x, yy, c); drawPixel(x + w - 1, yy, c); }
  }
  void fillRoundRect(int16_t x, int16_t y, int16_t w, int16_t h, int16_t r, uint16_t c) {
    record("round-fill", x, y, w, h, c);
    for (int yy = 0; yy < h; ++yy) for (int xx = 0; xx < w; ++xx) {
      const int dx = xx < r ? r - 1 - xx : xx >= w - r ? xx - (w - r) : 0;
      const int dy = yy < r ? r - 1 - yy : yy >= h - r ? yy - (h - r) : 0;
      if (dx * dx + dy * dy <= r * r) drawPixel(x + xx, y + yy, c);
    }
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
    int px = x, py = y;
    const int dx = std::abs(xx - x), sx = x < xx ? 1 : -1;
    const int dy = -std::abs(yy - y), sy = y < yy ? 1 : -1;
    int error = dx + dy;
    while (true) {
      drawPixel(px, py, c); if (px == xx && py == yy) break;
      const int twice = error * 2;
      if (twice >= dy) { error += dy; px += sx; }
      if (twice <= dx) { error += dx; py += sy; }
    }
  }
  void getTextBounds(const char* value, int16_t x, int16_t y,
                     int16_t* x1, int16_t* y1, uint16_t* w, uint16_t* h) {
    int left = 32767, top = 32767, right = -32768, bottom = -32768;
    for (const unsigned char* p = reinterpret_cast<const unsigned char*>(value); *p; ++p) {
      int xx = x, yy = y, width = 6 * textSize_, height = 8 * textSize_;
      if (font_) {
        assert(*p >= font_->first && *p <= font_->last);
        const auto& glyph = font_->glyph[*p - font_->first];
        xx += glyph.xOffset * textSize_; yy += glyph.yOffset * textSize_;
        width = glyph.width * textSize_; height = glyph.height * textSize_;
        x += glyph.xAdvance * textSize_;
      } else x += width;
      if (width && height) {
        left = std::min(left, xx); top = std::min(top, yy);
        right = std::max(right, xx + width); bottom = std::max(bottom, yy + height);
      }
    }
    *x1 = right < left ? x : left; *y1 = bottom < top ? y : top;
    *w = right < left ? 0 : right - left; *h = bottom < top ? 0 : bottom - top;
  }
  void print(const char* value) {
    const std::string text(value);
    if (text.empty()) return;
    int16_t left, top; uint16_t w, h;
    getTextBounds(value, x_, y_, &left, &top, &w, &h);
    if (w && h) bounds(left, top, w, h);
    calls.push_back({"text", x_, y_, w, h, textColor_, text});
    for (const auto raw : text) {
      const auto ch = static_cast<unsigned char>(raw);
      if (font_) {
        const auto& glyph = font_->glyph[ch - font_->first];
        size_t offset = glyph.bitmapOffset;
        uint8_t bits = 0; unsigned int bit = 0;
        for (int yy = 0; yy < glyph.height; ++yy) for (int xx = 0; xx < glyph.width; ++xx) {
          if ((bit++ & 7U) == 0) bits = font_->bitmap[offset++];
          if (bits & 0x80) paint(x_ + (glyph.xOffset + xx) * textSize_, y_ + (glyph.yOffset + yy) * textSize_);
          bits <<= 1;
        }
        x_ += glyph.xAdvance * textSize_;
      } else {
        for (int xx = 0; xx < 5; ++xx) for (int yy = 0; yy < 7; ++yy)
          if (font[ch * 5 + xx] & (1U << yy)) paint(x_ + xx * textSize_, y_ + yy * textSize_);
        x_ += 6 * textSize_;
      }
    }
  }

 private:
  int width_, height_, x_ = 0, y_ = 0;
  uint8_t textSize_ = 1;
  uint16_t textColor_ = 0;
  const GFXfont* font_ = nullptr;
  void paint(int x, int y) {
    for (int yy = 0; yy < textSize_; ++yy) for (int xx = 0; xx < textSize_; ++xx)
      drawPixel(x + xx, y + yy, textColor_);
  }
  void bounds(int x, int y, int w, int h) {
    assert(x >= 0 && y >= 0 && w > 0 && h > 0);
    assert(x + w <= width_ && y + h <= height_);
  }
  void record(const char* kind, int x, int y, int w, int h, uint16_t c) {
    bounds(x, y, w, h);
    calls.push_back({kind, x, y, w, h, c, ""});
  }
};
