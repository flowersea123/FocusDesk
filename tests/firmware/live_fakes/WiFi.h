// SPDX-FileCopyrightText: 2026 FocusDesk contributors
// SPDX-License-Identifier: GPL-3.0-only
#pragma once
#include <Arduino.h>
constexpr int WL_CONNECTED = 3, WIFI_STA = 1;
class WiFiClient {};
struct FakeWiFi {
  bool connected = true, connectOnBegin = true;
  int begins = 0;
  int status() const { return connected ? WL_CONNECTED : 0; }
  void disconnect() { connected = false; }
  void begin(const char*, const char*) { ++begins; connected = connectOnBegin; }
  void persistent(bool) {}
  void mode(int) {}
  void setAutoReconnect(bool) {}
};
extern FakeWiFi WiFi;
