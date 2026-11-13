// SPDX-License-Identifier: GPL-3.0-only
// Integrated entry point. The standalone provisioning and LAN examples remain usable.
#define FOCUSDESK_PROVISIONING_EMBEDDED
#include "../experiments/focusdesk_provisioning_poc/focusdesk_provisioning_poc.ino"
#include "display_snapshot.h"
#include "display_sync.h"

GDEM042F52Display display;

struct SavedHubFetcher {
  uint32_t now() { return millis(); }
  bool ready(const char* hubOrigin) {
    bool queued;
    portENTER_CRITICAL(&statusMux); queued = requestQueued; portEXIT_CRITICAL(&statusMux);
    return wifiReady && !queued && configSession.hasSaved() && !configSession.testing() &&
        std::strcmp(hubOrigin, configSession.saved().hub_url) == 0 &&
        deviceLink.matches(configSession.saved());
  }
  bool read(const char* hubOrigin, focusdesk::DisplaySnapshot& snapshot) {
    if (!ready(hubOrigin)) return false;
    size_t offset = 0, length = 0;
    const fc::HubResult fetched = deviceLink.requestJson(
        hubOrigin, "/api/v1/display-snapshot", false, offset, length);
    const char* error = nullptr;
    const bool parsed = fetched == fc::HubResult::Ready &&
        focusdesk::parseDisplaySnapshot(hubReply + offset, length, snapshot, error);
    poc::wipe(hubReply, sizeof(hubReply));
    if (!parsed) {
      Serial.println("[FocusDesk] FETCH_FAILED: NETWORK_OR_INVALID_SNAPSHOT");
      return false;
    }
    Serial.println("[FocusDesk] FETCH_OK");
    return ready(hubOrigin);
  }
} savedHubFetcher;

struct DevicePanel {
  bool show(const focusdesk::DisplaySnapshot& snapshot) {
    focusdesk::drawDisplaySnapshot(display, snapshot);
    const bool refreshed = display.update();
    Serial.println(refreshed ? "[FocusDesk] DISPLAY_OK" : "[FocusDesk] DISPLAY_FAILED:SCREEN_STATE_UNKNOWN");
    return refreshed;
  }
} devicePanel;

focusdesk::DisplaySync<SavedHubFetcher, DevicePanel, focusdesk::DisplaySnapshot> displaySync(savedHubFetcher, devicePanel);

void setup() {
  provisioningSetup();
  display.begin();
  Serial.println("[FocusDesk] DEVICE_READY: shared goal-1 display snapshot");
}

void loop() {
  provisioningLoop();
  if (configSession.hasSaved()) displaySync.tick(configSession.saved().hub_url);
  delay(10);
}
