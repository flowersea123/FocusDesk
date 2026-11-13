// SPDX-FileCopyrightText: 2026 FocusDesk contributors
// SPDX-License-Identifier: GPL-3.0-only
#pragma once
#include <Arduino.h>

constexpr int MSBFIRST = 1, SPI_MODE0 = 0;
struct SPISettings {
  SPISettings(uint32_t, int, int) {}
};
struct TestSPI {
  void begin(int, int, int, int);
  void beginTransaction(SPISettings);
  uint8_t transfer(uint8_t);
  void endTransaction();
};
extern TestSPI SPI;
