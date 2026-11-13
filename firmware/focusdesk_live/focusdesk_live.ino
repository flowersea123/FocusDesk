// SPDX-FileCopyrightText: 2026 FocusDesk contributors
// SPDX-License-Identifier: GPL-3.0-only
// Independent LAN demo firmware; does not determine the whole project license.
#include <WiFi.h>
#include <HTTPClient.h>
#include "live_page.h"
#include "live_state.h"

#if !defined(FOCUSDESK_HOST_TEST) && __has_include("private_config.h")
#include "private_config.h"
#endif
#ifndef FOCUSDESK_WIFI_SSID
#define FOCUSDESK_WIFI_SSID ""
#endif
#ifndef FOCUSDESK_WIFI_PASSWORD
#define FOCUSDESK_WIFI_PASSWORD ""
#endif
#ifndef FOCUSDESK_API_URL
#define FOCUSDESK_API_URL ""
#endif

GDEM042F52Display display;
focusdesk::PollState pollState;
focusdesk::Overview lastValid;
bool configured = false;

bool validLocalConfig() {
  const char* ssid = FOCUSDESK_WIFI_SSID;
  const char* url = FOCUSDESK_API_URL;
  return std::strlen(ssid) > 0 && std::strlen(ssid) <= 32 &&
      std::strlen(FOCUSDESK_WIFI_PASSWORD) <= 63 &&
      !std::strstr(ssid, "YOUR_") && !std::strstr(ssid, "REPLACE_") &&
      std::strlen(url) < 200 && std::strncmp(url, "http://", 7) == 0 &&
      !std::strstr(url, "YOUR_") && !std::strstr(url, "REPLACE_") &&
      !std::strchr(url, '@') && !std::strstr(url, "localhost") &&
      !std::strstr(url, "127.0.0.1") &&
      std::strstr(url, "/api/v1/daily-overview") != nullptr;
}

bool connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return true;
  WiFi.disconnect();
  WiFi.begin(FOCUSDESK_WIFI_SSID, FOCUSDESK_WIFI_PASSWORD);
  const uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED &&
         static_cast<uint32_t>(millis() - started) < 30000) delay(100);
  if (WiFi.status() == WL_CONNECTED) return true;
  WiFi.disconnect();
  Serial.println("[FocusDesk] FETCH_FAILED: WIFI_TIMEOUT");
  return false;
}

bool fetchOverview(focusdesk::Overview& result) {
  WiFiClient client;
  HTTPClient http;
  http.setConnectTimeout(3000);
  http.setTimeout(5000);
  http.setReuse(false);
  http.useHTTP10(true);
  http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
  const char* headers[] = {"Content-Type", "Content-Encoding", "Transfer-Encoding"};
  if (!http.begin(client, FOCUSDESK_API_URL)) {
    Serial.println("[FocusDesk] FETCH_FAILED: HTTP_BEGIN"); return false;
  }
  http.collectHeaders(headers, 3);
  const int code = http.GET();
  const int length = http.getSize();
  if (code != HTTP_CODE_OK || length <= 0 || length > 4096 ||
      !http.header("Content-Type").startsWith("application/json") ||
      http.header("Content-Encoding").length() != 0 ||
      http.header("Transfer-Encoding").length() != 0) {
    Serial.println("[FocusDesk] FETCH_FAILED: HTTP_STATUS_OR_FRAMING");
    http.end(); return false;
  }
  static char body[focusdesk::MAX_BODY_BYTES + 1];
  size_t received = 0;
  const uint32_t started = millis();
  auto* stream = http.getStreamPtr();
  while (received < static_cast<size_t>(length) &&
         static_cast<uint32_t>(millis() - started) < 5000) {
    const int available = stream->available();
    if (available > 0) {
      const size_t remaining = static_cast<size_t>(length) - received;
      const size_t amount = remaining < static_cast<size_t>(available) ?
          remaining : static_cast<size_t>(available);
      const int read = stream->read(reinterpret_cast<uint8_t*>(body + received), amount);
      if (read > 0) received += static_cast<size_t>(read);
    } else if (!stream->connected()) break;
    delay(1);
  }
  http.end();
  if (received != static_cast<size_t>(length)) {
    Serial.println("[FocusDesk] FETCH_FAILED: BODY_TIMEOUT_OR_TRUNCATED"); return false;
  }
  body[received] = '\0';
  const char* error = nullptr;
  if (!focusdesk::parseOverview(body, received, result, error)) {
    Serial.printf("[FocusDesk] FETCH_FAILED: %s\n", error);
    return false;
  }
  Serial.println("[FocusDesk] FETCH_OK");
  return true;
}

void setup() {
  Serial.begin(115200);
  delay(250);
  configured = validLocalConfig();
  if (!configured) {
    Serial.println("[FocusDesk] CONFIG_REQUIRED: fill local private_config.h"); return;
  }
  display.begin();  // Initializes pins only; a valid snapshot is required to refresh.
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(false);
  Serial.println("[FocusDesk] DEMO_DATA: LAN READ-ONLY TASK DISPLAY");
}

void loop() {
  if (!configured || !pollState.pollDue(millis())) { delay(100); return; }
  focusdesk::Overview candidate;
  bool ok = connectWifi() && fetchOverview(candidate);
  bool deferred = false;
  if (ok) {
    lastValid = candidate;
    if (pollState.isDisplayed(lastValid.revision)) {
      Serial.println("[FocusDesk] UNCHANGED");
    } else if (pollState.canDisplay(millis(), lastValid.revision)) {
      focusdesk::drawOverview(display, lastValid);
      ok = display.update();
      pollState.displayFinished(millis(), lastValid.revision, ok);
      Serial.println(ok ? "[FocusDesk] DISPLAY_OK" :
                         "[FocusDesk] DISPLAY_FAILED:SCREEN_STATE_UNKNOWN");
    } else {
      deferred = true;
      Serial.println("[FocusDesk] DISPLAY_DEFERRED: MIN_INTERVAL");
    }
  }
  if (deferred) pollState.pollDeferred(millis());
  else pollState.pollFinished(millis(), ok);
  delay(100);
}
