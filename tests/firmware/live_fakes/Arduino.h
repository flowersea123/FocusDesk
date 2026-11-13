// SPDX-FileCopyrightText: 2026 FocusDesk contributors
// SPDX-License-Identifier: GPL-3.0-only
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <sstream>
#include <string>
#ifndef PROGMEM
#define PROGMEM
#endif

constexpr int LOW = 0, HIGH = 1, INPUT = 0, OUTPUT = 1;
unsigned long millis();
void delay(unsigned long);
int digitalRead(uint8_t);
void digitalWrite(uint8_t, int);
void pinMode(uint8_t, int);

struct TestSerial {
  std::string output;
  unsigned long baud = 0;
  void begin(unsigned long value) { baud = value; }
  template <class T> void println(T value) {
    std::ostringstream stream;
    stream << value;
    output += stream.str() + '\n';
  }
  template <class... T> void printf(const char* format, T... values) {
    char buffer[512];
    std::snprintf(buffer, sizeof(buffer), format, values...);
    output += buffer;
  }
};
extern TestSerial Serial;
