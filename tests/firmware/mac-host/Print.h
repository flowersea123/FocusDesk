// SPDX-License-Identifier: GPL-3.0-only
#pragma once
#include <cstddef>
#include <cstdint>
#include <cstring>

// Only Arduino's byte-dispatch surface is adapted. GFX's upstream write() and
// drawChar() still perform all cursor movement, glyph decoding and rendering.
class Print {
 public:
  virtual ~Print() = default;
  virtual size_t write(uint8_t value) = 0;
  size_t write(const uint8_t* bytes, size_t length) {
    size_t written = 0;
    for (size_t index = 0; index < length; ++index) written += write(bytes[index]);
    return written;
  }
  size_t print(const char* text) {
    return write(reinterpret_cast<const uint8_t*>(text), std::strlen(text));
  }
};
