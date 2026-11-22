// SPDX-License-Identifier: GPL-3.0-only
// Independent P2 configuration experiment, using Core 3.3.12.
#include <Arduino.h>
#include <esp_event.h>
#include <esp_netif.h>
#include <esp_wifi_default.h>
#include <esp_arduino_version.h>
#include <esp_idf_version.h>
#include <esp_system.h>
#include <esp_http_server.h>
#include <fcntl.h>
#include <unistd.h>
#include <cerrno>
#include <cstdlib>
#include <algorithm>
#include <cJSON.h>
#include <esp_heap_caps.h>
#include <esp_log.h>
#include <esp_random.h>
#include <esp_wifi.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>
#include <lwip/sockets.h>
#include <lwip/inet.h>
#include "poc_logic.h"
#include "portal_page.h"
#include "nvs_config_store.h"
#include "config_session.h"
#include "hub_validation.h"
#if __has_include("private_config.h")
#include "private_config.h"
#else
#error "Run scripts/prepare-provisioning-poc.mjs to generate the local test AP password first."
#endif
#if ESP_ARDUINO_VERSION != ESP_ARDUINO_VERSION_VAL(3, 3, 12)
#error "This PoC is pinned to Arduino-ESP32 Core 3.3.12."
#endif
#if CORE_DEBUG_LEVEL != 0
#error "Set Core Debug Level to None to avoid framework credential logs."
#endif
static_assert(sizeof(FOCUSDESK_POC_AP_PASSWORD) >= 17 && sizeof(FOCUSDESK_POC_AP_PASSWORD) <= 64,
              "Use the independently generated 16-character or longer WPA2 test password.");

namespace poc = focusdesk_poc;
namespace fc = focusdesk_config;
esp_netif_t* apNetif = nullptr;
esp_netif_t* staNetif = nullptr;
QueueHandle_t requests = nullptr;
StaticQueue_t requestQueueControl;
uint8_t requestQueueStorage[sizeof(poc::Credentials)] = {};
httpd_handle_t httpServer = nullptr;
portMUX_TYPE statusMux = portMUX_INITIALIZER_UNLOCKED;
poc::Attempt attempt;
char sessionToken[33] = {};
uint32_t sessionStarted = 0;
uint32_t lastMetricsAt = 0;
bool setupOpen = false;
bool staHasIp = false;
uint32_t gotIpSequence = 0;
uint32_t disconnectedSequence = 0;
bool stationRequested = false;
bool wifiReady = false;
bool requestQueued = false;
struct ConfigStatus {
  bool saved = false;
  bool storageReady = false;
  char hubUrl[96] = {};
  const char* result = "none";
  const char* error = "";
} configStatus;
struct NetworkStatus {
  bool connected = false;
  bool subnetConflict = false;
  char ip[16] = "0.0.0.0";
  uint8_t channel = 1;
  uint16_t reason = 0;
  uint32_t joins = 0;
  uint32_t leaves = 0;
  uint32_t loopStack = 0;
} networkStatus;

uint32_t remainingSeconds() {
  const uint32_t elapsed = millis() - sessionStarted;
  return elapsed >= poc::SESSION_MS ? 0 : (poc::SESSION_MS - elapsed + 999) / 1000;
}
void printMemory(const char* phase) {
  constexpr uint32_t caps = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
  Serial.printf("[P2] memory phase=%s free=%u min_free=%u largest=%u psram=%u stack=%u\n",
      phase, static_cast<unsigned>(heap_caps_get_free_size(caps)),
      static_cast<unsigned>(heap_caps_get_minimum_free_size(caps)),
      static_cast<unsigned>(heap_caps_get_largest_free_block(caps)),
      static_cast<unsigned>(ESP.getFreePsram()), static_cast<unsigned>(uxTaskGetStackHighWaterMark(nullptr)));
}
esp_err_t reply(httpd_req_t* request, const char* status, const char* body) {
  httpd_resp_set_status(request, status);
  httpd_resp_set_type(request, "application/json; charset=utf-8");
  httpd_resp_set_hdr(request, "Cache-Control", "no-store");
  httpd_resp_set_hdr(request, "X-Content-Type-Options", "nosniff");
  httpd_resp_set_hdr(request, "Connection", "close");
  return httpd_resp_send(request, body, HTTPD_RESP_USE_STRLEN);
}
esp_err_t errorReply(httpd_req_t* request, const char* status, const char* code) {
  char body[128];
  snprintf(body, sizeof(body), "{\"error\":\"%s\"}", code);
  return reply(request, status, body);
}
bool readHeader(httpd_req_t* request, const char* name, char* output, size_t size) {
  return httpd_req_get_hdr_value_str(request, name, output, size) == ESP_OK;
}
bool authorize(httpd_req_t* request, bool requireToken) {
  char host[32] = {}, origin[48] = {}, token[40] = {};
  bool open;
  portENTER_CRITICAL(&statusMux); open = setupOpen; portEXIT_CRITICAL(&statusMux);
  if (!open || !remainingSeconds()) { errorReply(request, "403 Forbidden", "SESSION_EXPIRED"); return false; }
  if (!readHeader(request, "Host", host, sizeof(host)) ||
      (strcmp(host, "192.168.4.1") != 0 && strcmp(host, "192.168.4.1:80") != 0) || strchr(request->uri, '?')) {
    errorReply(request, "403 Forbidden", "HOST_FORBIDDEN"); return false;
  }
  if (httpd_req_get_hdr_value_len(request, "Origin") &&
      (!readHeader(request, "Origin", origin, sizeof(origin)) ||
       (strcmp(origin, "http://192.168.4.1") != 0 && strcmp(origin, "http://192.168.4.1:80") != 0))) {
    errorReply(request, "403 Forbidden", "ORIGIN_FORBIDDEN"); return false;
  }
  if (requireToken && (!readHeader(request, "X-FocusDesk-Token", token, sizeof(token)) || strcmp(token, sessionToken) != 0)) {
    errorReply(request, "403 Forbidden", "SESSION_INVALID"); return false;
  }
  return true;
}
bool socketIpv4(const sockaddr_storage& storage, uint32_t& address) {
  if (storage.ss_family == AF_INET) {
    address = ntohl(reinterpret_cast<const sockaddr_in*>(&storage)->sin_addr.s_addr);
    return true;
  }
  if (storage.ss_family == AF_INET6) {
    const auto* ipv6 = reinterpret_cast<const sockaddr_in6*>(&storage);
    return poc::mappedIpv4(reinterpret_cast<const uint8_t*>(&ipv6->sin6_addr), address);
  }
  return false;
}
esp_err_t acceptApSocket(httpd_handle_t, int socket) {
  // IDF HTTPD listens on wildcard. Reject STA-side sockets immediately after
  // accept and before parsing headers/body; never serve configuration on LAN.
  sockaddr_storage local = {}, peer = {};
  socklen_t size = sizeof(local);
  if (getsockname(socket, reinterpret_cast<sockaddr*>(&local), &size) != 0) return ESP_FAIL;
  size = sizeof(peer);
  if (getpeername(socket, reinterpret_cast<sockaddr*>(&peer), &size) != 0) return ESP_FAIL;
  uint32_t localAddress, peerAddress;
  return socketIpv4(local, localAddress) && socketIpv4(peer, peerAddress) && poc::apSocketAllowed(localAddress, peerAddress) ? ESP_OK : ESP_FAIL;
}
bool stationConnected() {
  bool hasIp;
  portENTER_CRITICAL(&statusMux); hasIp = staHasIp; portEXIT_CRITICAL(&statusMux);
  wifi_ap_record_t record = {};
  esp_netif_ip_info_t address = {};
  return hasIp && esp_wifi_sta_get_ap_info(&record) == ESP_OK &&
      esp_netif_get_ip_info(staNetif, &address) == ESP_OK && address.ip.addr != 0;
}
bool disconnectStation(uint32_t waitMs = 0) {
  uint32_t baseline;
  bool pending;
  portENTER_CRITICAL(&statusMux);
  baseline = disconnectedSequence; pending = stationRequested; staHasIp = false;
  portEXIT_CRITICAL(&statusMux);
  const esp_err_t stopped = esp_wifi_disconnect();
  const uint32_t started = millis();
  wifi_ap_record_t record = {};
  for (;;) {
    uint32_t sequence;
    portENTER_CRITICAL(&statusMux); sequence = disconnectedSequence; portEXIT_CRITICAL(&statusMux);
    const bool waitingEvent = pending && stopped == ESP_OK && sequence == baseline;
    if (!waitingEvent && esp_wifi_sta_get_ap_info(&record) != ESP_OK) break;
    if (millis() - started >= waitMs) return false;
    delay(5);
  }
  portENTER_CRITICAL(&statusMux); staHasIp = false; stationRequested = false; portEXIT_CRITICAL(&statusMux);
  return true;
}
void wifiEvent(void*, esp_event_base_t base, int32_t event, void* data) {
  portENTER_CRITICAL(&statusMux);
  if (base == WIFI_EVENT && event == WIFI_EVENT_AP_STACONNECTED) ++networkStatus.joins;
  else if (base == WIFI_EVENT && event == WIFI_EVENT_AP_STADISCONNECTED) ++networkStatus.leaves;
  else if (base == WIFI_EVENT && event == WIFI_EVENT_STA_DISCONNECTED) {
    ++disconnectedSequence; stationRequested = false;
    staHasIp = false; networkStatus.connected = false;
    std::strcpy(networkStatus.ip, "0.0.0.0");
    networkStatus.reason = static_cast<wifi_event_sta_disconnected_t*>(data)->reason;
  } else if (base == IP_EVENT && event == IP_EVENT_STA_GOT_IP && stationRequested) { ++gotIpSequence; staHasIp = true; }
  else if (base == IP_EVENT && event == IP_EVENT_STA_LOST_IP) staHasIp = false;
  portEXIT_CRITICAL(&statusMux);
}
bool startProtectedWifi(char* apName, size_t capacity) {
  if (esp_netif_init() != ESP_OK) return false;
  const esp_err_t eventLoop = esp_event_loop_create_default();
  if (eventLoop != ESP_OK && eventLoop != ESP_ERR_INVALID_STATE) return false;
  apNetif = esp_netif_create_default_wifi_ap();
  staNetif = esp_netif_create_default_wifi_sta();
  if (!apNetif || !staNetif) return false;
  wifi_init_config_t initialization = WIFI_INIT_CONFIG_DEFAULT();
  initialization.nvs_enable = false;
  if (esp_wifi_init(&initialization) != ESP_OK || esp_wifi_set_storage(WIFI_STORAGE_RAM) != ESP_OK ||
      esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifiEvent, nullptr) != ESP_OK ||
      esp_event_handler_register(IP_EVENT, ESP_EVENT_ANY_ID, wifiEvent, nullptr) != ESP_OK ||
      esp_wifi_set_mode(WIFI_MODE_APSTA) != ESP_OK) return false;
  uint8_t mac[6];
  if (esp_wifi_get_mac(WIFI_IF_AP, mac) != ESP_OK) return false;
  snprintf(apName, capacity, "FocusDesk-Setup-%02X%02X%02X", mac[3], mac[4], mac[5]);
  wifi_config_t accessPoint = {};
  std::memcpy(accessPoint.ap.ssid, apName, std::strlen(apName));
  accessPoint.ap.ssid_len = std::strlen(apName);
  std::memcpy(accessPoint.ap.password, FOCUSDESK_POC_AP_PASSWORD, sizeof(FOCUSDESK_POC_AP_PASSWORD));
  accessPoint.ap.channel = 1;
  accessPoint.ap.beacon_interval = 100;
  accessPoint.ap.max_connection = 1;
  accessPoint.ap.authmode = WIFI_AUTH_WPA2_PSK;
  accessPoint.ap.pairwise_cipher = WIFI_CIPHER_TYPE_CCMP;
  esp_netif_ip_info_t address = {};
  address.ip.addr = ESP_IP4TOADDR(192, 168, 4, 1);
  address.gw.addr = ESP_IP4TOADDR(192, 168, 4, 1);
  address.netmask.addr = ESP_IP4TOADDR(255, 255, 255, 0);
  const esp_err_t stopped = esp_netif_dhcps_stop(apNetif);
  if ((stopped != ESP_OK && stopped != ESP_ERR_ESP_NETIF_DHCP_ALREADY_STOPPED) ||
      esp_netif_set_ip_info(apNetif, &address) != ESP_OK ||
      esp_netif_dhcps_start(apNetif) != ESP_OK ||
      esp_wifi_set_config(WIFI_IF_AP, &accessPoint) != ESP_OK) return false;
  // Configure WPA2 while the radio is still stopped. Never enable an initial
  // default/open AP, as Arduino's convenience AP-start-then-configure path can.
  const esp_err_t started = esp_wifi_start();
  poc::wipe(&accessPoint, sizeof(accessPoint));
  return started == ESP_OK;
}
// Single loop-owned response buffer, keeping large replies off the task stack.
char hubReply[6145] = {};
struct HubSocket {
  int fd = -1;
  ~HubSocket() { if (fd >= 0) ::close(fd); }
};
struct DeviceLink {
  uint32_t ipBaseline = 0;
  bool requestAllowed(bool setupOnly) {
    if (setupOnly) return remainingSeconds() != 0;
    bool queued;
    portENTER_CRITICAL(&statusMux); queued = requestQueued; portEXIT_CRITICAL(&statusMux);
    return !queued;
  }
  bool waitSocket(int fd, bool writing, uint32_t started, bool setupOnly = true) {
    for (;;) {
      const uint32_t elapsed = millis() - started;
      if (elapsed >= 6000 || !requestAllowed(setupOnly)) return false;
      const uint32_t remaining = std::min<uint32_t>(6000 - elapsed, 250);
      timeval timeout = {};
      timeout.tv_sec = remaining / 1000;
      timeout.tv_usec = (remaining % 1000) * 1000;
      fd_set sockets;
      FD_ZERO(&sockets); FD_SET(fd, &sockets);
      const int ready = select(fd + 1, writing ? nullptr : &sockets, writing ? &sockets : nullptr, nullptr, &timeout);
      if (ready > 0) return millis() - started < 6000 && requestAllowed(setupOnly);
      if (ready < 0 && errno != EINTR) return false;
    }
  }
  int receive(int fd, char* output, size_t capacity, uint32_t started, bool setupOnly = true) {
    while (waitSocket(fd, false, started, setupOnly)) {
      const int received = recv(fd, output, capacity, 0);
      if (received >= 0) return received;
      if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) break;
    }
    return -1;
  }
  bool connect(const fc::Config& config) {
    if (!disconnectStation(1000)) return false;
    portENTER_CRITICAL(&statusMux);
    ipBaseline = gotIpSequence; networkStatus.reason = 0;
    portEXIT_CRITICAL(&statusMux);
    wifi_config_t station = {};
    std::memcpy(station.sta.ssid, config.ssid, std::strlen(config.ssid));
    std::memcpy(station.sta.password, config.password, std::strlen(config.password));
    station.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
    station.sta.pmf_cfg.capable = true;
    station.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;
    esp_err_t error = esp_wifi_set_config(WIFI_IF_STA, &station);
    poc::wipe(&station, sizeof(station));
    if (error != ESP_OK) return false;
    portENTER_CRITICAL(&statusMux); stationRequested = true; portEXIT_CRITICAL(&statusMux);
    error = esp_wifi_connect();
    if (error != ESP_OK) {
      portENTER_CRITICAL(&statusMux); stationRequested = false; portEXIT_CRITICAL(&statusMux);
    }
    return error == ESP_OK;
  }
  bool matches(const fc::Config& config) {
    uint32_t sequence;
    portENTER_CRITICAL(&statusMux); sequence = gotIpSequence; portEXIT_CRITICAL(&statusMux);
    wifi_ap_record_t record = {};
    return stationConnected() && sequence != ipBaseline &&
        esp_wifi_sta_get_ap_info(&record) == ESP_OK &&
        std::strncmp(reinterpret_cast<const char*>(record.ssid), config.ssid, sizeof(record.ssid)) == 0;
  }
  bool subnetConflict() {
    esp_netif_ip_info_t address = {};
    return esp_netif_get_ip_info(staNetif, &address) == ESP_OK &&
        (ntohl(address.ip.addr) & 0xffffff00UL) == 0xc0a80400UL;
  }
  void disconnect() { disconnectStation(1000); }
  uint32_t now() { return millis(); }
  bool windowOpen() { return setupOpen && remainingSeconds(); }
  fc::HubResult requestJson(const char* hubOrigin, const char* path, bool setupOnly,
                            size_t& bodyOffset, size_t& bodyLength) {
    bodyOffset = 0;
    bodyLength = 0;
    char normalized[96] = {};
    if (!hubOrigin || !path || !fc::normalizeHub(hubOrigin, normalized, sizeof(normalized)) ||
        std::strcmp(hubOrigin, normalized) != 0 ||
        (std::strcmp(path, "/api/v1/server-info") != 0 &&
         std::strcmp(path, "/api/v1/daily-overview") != 0 &&
         std::strcmp(path, "/api/v1/display-snapshot") != 0))
      return fc::HubResult::Invalid;
    if (!requestAllowed(setupOnly)) return fc::HubResult::Unreachable;
    const uint32_t started = millis();
    const char* colon = std::strrchr(hubOrigin, ':');
    if (!colon || colon <= hubOrigin + 7) return fc::HubResult::Invalid;
    char host[16] = {};
    const size_t hostLength = static_cast<size_t>(colon - hubOrigin - 7);
    if (hostLength >= sizeof(host)) return fc::HubResult::Invalid;
    std::memcpy(host, hubOrigin + 7, hostLength);
    const int expectedPort = std::atoi(colon + 1);
    sockaddr_in address = {};
    address.sin_family = AF_INET;
    address.sin_port = htons(expectedPort);
    if (inet_pton(AF_INET, host, &address.sin_addr) != 1) return fc::HubResult::Invalid;
    HubSocket connection;
    connection.fd = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (connection.fd < 0 || fcntl(connection.fd, F_SETFL, O_NONBLOCK) < 0) return fc::HubResult::Unreachable;
    const int opening = ::connect(connection.fd, reinterpret_cast<sockaddr*>(&address), sizeof(address));
    if (opening < 0 && errno != EINPROGRESS) return fc::HubResult::Unreachable;
    if (!waitSocket(connection.fd, true, started, setupOnly)) return fc::HubResult::Unreachable;
    int socketError = 0;
    socklen_t errorSize = sizeof(socketError);
    if (getsockopt(connection.fd, SOL_SOCKET, SO_ERROR, &socketError, &errorSize) != 0 || socketError)
      return fc::HubResult::Unreachable;
    char request[256];
    const int requestSize = snprintf(request, sizeof(request),
        "GET %s HTTP/1.1\r\nHost: %s\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
        path, hubOrigin + 7);
    if (requestSize <= 0 || static_cast<size_t>(requestSize) >= sizeof(request)) return fc::HubResult::Invalid;
    size_t sent = 0;
    while (sent < static_cast<size_t>(requestSize)) {
      if (!waitSocket(connection.fd, true, started, setupOnly)) return fc::HubResult::Unreachable;
      const int amount = send(connection.fd, request + sent, requestSize - sent, 0);
      if (amount > 0) sent += static_cast<size_t>(amount);
      else if (amount == 0 || (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR))
        return fc::HubResult::Unreachable;
    }
    size_t total = 0, headerLength = 0;
    while (!headerLength) {
      if (total >= 2048) return fc::HubResult::Invalid;
      const int amount = receive(connection.fd, hubReply + total, 2048 - total, started, setupOnly);
      if (amount <= 0) return fc::HubResult::Unreachable;
      total += static_cast<size_t>(amount);
      hubReply[total] = '\0';
      if (std::memchr(hubReply, '\0', total)) return fc::HubResult::Invalid;
      const char* end = std::strstr(hubReply, "\r\n\r\n");
      if (end) headerLength = static_cast<size_t>(end - hubReply) + 4;
    }
    fc::HubHeaders headers;
    if (!fc::parseHubHeaders(hubReply, headerLength, headers)) return fc::HubResult::Invalid;
    const size_t expected = headerLength + headers.contentLength;
    if (total > expected) return fc::HubResult::Invalid;
    while (total < expected) {
      const int amount = receive(connection.fd, hubReply + total, expected - total, started, setupOnly);
      if (amount <= 0) return fc::HubResult::Unreachable;
      total += static_cast<size_t>(amount);
    }
    hubReply[total] = '\0';
    const char* body = hubReply + headerLength;
    const unsigned tokenLimit = std::strcmp(path, "/api/v1/display-snapshot") == 0 ? 768 : 128;
    if (!fc::boundedHubJson(body, headers.contentLength, tokenLimit)) return fc::HubResult::Invalid;
    if (!requestAllowed(setupOnly)) return fc::HubResult::Unreachable;
    bodyOffset = headerLength;
    bodyLength = headers.contentLength;
    return fc::HubResult::Ready;
  }
  fc::HubResult verifyHub(const fc::Config& config) {
    size_t bodyOffset = 0, bodyLength = 0;
    const fc::HubResult response = requestJson(config.hub_url, "/api/v1/server-info", true, bodyOffset, bodyLength);
    if (response != fc::HubResult::Ready) {
      poc::wipe(hubReply, sizeof(hubReply));
      return response;
    }
    cJSON* json = cJSON_ParseWithLengthOpts(hubReply + bodyOffset, bodyLength + 1, nullptr, true);
    const cJSON* service = cJSON_GetObjectItemCaseSensitive(json, "service");
    const cJSON* port = cJSON_GetObjectItemCaseSensitive(json, "port");
    const char* colon = std::strrchr(config.hub_url, ':');
    const int expectedPort = colon ? std::atoi(colon + 1) : 80;
    const bool valid = cJSON_IsObject(json) && cJSON_IsString(service) &&
        std::strcmp(service->valuestring, "FocusDesk") == 0 && cJSON_IsNumber(port) && port->valuedouble == expectedPort;
    cJSON_Delete(json);
    poc::wipe(hubReply, sizeof(hubReply));
    return valid ? fc::HubResult::Ready : fc::HubResult::Invalid;
  }
} deviceLink;
fc::NvsConfigStore configStore;
fc::ConfigSession<fc::NvsConfigStore, DeviceLink> configSession(configStore, deviceLink);

esp_err_t pageHandler(httpd_req_t* request) {
  if (!authorize(request, false)) return ESP_OK;
  httpd_resp_set_type(request, "text/html; charset=utf-8");
  httpd_resp_set_hdr(request, "Cache-Control", "no-store");
  httpd_resp_set_hdr(request, "X-Content-Type-Options", "nosniff");
  httpd_resp_set_hdr(request, "Referrer-Policy", "no-referrer");
  httpd_resp_set_hdr(request, "Content-Security-Policy",
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  return httpd_resp_send(request, POC_PORTAL_PAGE, sizeof(POC_PORTAL_PAGE) - 1);
}
esp_err_t sessionHandler(httpd_req_t* request) {
  if (!authorize(request, false)) return ESP_OK;
  char body[128];
  snprintf(body, sizeof(body), "{\"token\":\"%s\",\"remaining_s\":%u}", sessionToken, static_cast<unsigned>(remainingSeconds()));
  return reply(request, "200 OK", body);
}
esp_err_t statusHandler(httpd_req_t* request) {
  if (!authorize(request, true)) return ESP_OK;
  poc::Attempt current;
  NetworkStatus network;
  ConfigStatus config;
  portENTER_CRITICAL(&statusMux);
  current = attempt; network = networkStatus; config = configStatus;
  portEXIT_CRITICAL(&statusMux);
  constexpr uint32_t caps = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
  char body[1536];
  const int length = snprintf(body, sizeof(body),
      "{\"state\":\"%s\",\"attempt_id\":\"%s\",\"wifi_connected\":%s,\"ip\":\"%s\",\"channel\":%u,"
      "\"disconnect_reason\":%u,\"ap_joins\":%u,\"ap_leaves\":%u,\"remaining_s\":%u,\"subnet_conflict\":%s,"
      "\"config\":{\"saved\":%s,\"storage_ready\":%s,\"hub_url\":\"%s\"},\"result\":\"%s\",\"error\":\"%s\","
      "\"heap\":{\"free\":%u,\"min_free\":%u,\"largest\":%u,\"psram\":%u,\"loop_stack\":%u,\"http_stack\":%u},"
      "\"hardware\":{\"chip\":\"%s\",\"revision\":%u,\"cores\":%u,\"flash_bytes\":%u,\"psram_bytes\":%u,\"core\":\"%s\",\"idf\":\"%s\"}}",
      poc::name(current.state), current.id, network.connected ? "true" : "false", network.ip, network.channel,
      network.reason, static_cast<unsigned>(network.joins), static_cast<unsigned>(network.leaves),
      static_cast<unsigned>(remainingSeconds()), network.subnetConflict ? "true" : "false",
      config.saved ? "true" : "false", config.storageReady ? "true" : "false", config.hubUrl, config.result, config.error,
      static_cast<unsigned>(heap_caps_get_free_size(caps)), static_cast<unsigned>(heap_caps_get_minimum_free_size(caps)),
      static_cast<unsigned>(heap_caps_get_largest_free_block(caps)), static_cast<unsigned>(ESP.getFreePsram()),
      static_cast<unsigned>(network.loopStack), static_cast<unsigned>(uxTaskGetStackHighWaterMark(nullptr)),
      ESP.getChipModel(), ESP.getChipRevision(), ESP.getChipCores(), static_cast<unsigned>(ESP.getFlashChipSize()),
      static_cast<unsigned>(ESP.getPsramSize()), ESP_ARDUINO_VERSION_STR, esp_get_idf_version());
  if (length < 0 || static_cast<size_t>(length) >= sizeof(body)) return errorReply(request, "500 Internal Server Error", "STATUS_LIMIT");
  return reply(request, "200 OK", body);
}
esp_err_t connectHandler(httpd_req_t* request) {
  if (!authorize(request, true)) return ESP_OK;
  char contentType[96] = {};
  if (!readHeader(request, "Content-Type", contentType, sizeof(contentType)) ||
      (strcasecmp(contentType, "application/x-www-form-urlencoded") != 0 &&
       strcasecmp(contentType, "application/x-www-form-urlencoded;charset=UTF-8") != 0 &&
       strcasecmp(contentType, "application/x-www-form-urlencoded; charset=UTF-8") != 0)) {
    return errorReply(request, "415 Unsupported Media Type", "FORM_REQUIRED");
  }
  if (!request->content_len || request->content_len > poc::MAX_FORM_BYTES ||
      httpd_req_get_hdr_value_len(request, "Transfer-Encoding")) {
    return errorReply(request, "413 Payload Too Large", "BODY_LIMIT");
  }
  // Fixed buffer before any body read. No Arduino String or unbounded POST parser.
  char body[poc::MAX_FORM_BYTES + 1] = {};
  size_t received = 0;
  const uint32_t started = millis();
  while (received < request->content_len && millis() - started < 2000 && remainingSeconds()) {
    const int amount = httpd_req_recv(request, body + received, request->content_len - received);
    if (amount <= 0) break;
    received += static_cast<size_t>(amount);
  }
  poc::Credentials candidate;
  const char* invalid = received == request->content_len ? poc::parseForm(body, received, candidate, true) : "BODY_TIMEOUT";
  poc::wipe(body, sizeof(body));
  char normalized[96] = {};
  if (!invalid && !fc::normalizeHub(candidate.hub_url, normalized, sizeof(normalized))) invalid = "HUB_INVALID";
  if (invalid) { poc::wipe(&candidate, sizeof(candidate)); return errorReply(request, "400 Bad Request", invalid); }
  std::memcpy(candidate.hub_url, normalized, sizeof(normalized));
  if (!remainingSeconds()) { poc::wipe(&candidate, sizeof(candidate)); return errorReply(request, "403 Forbidden", "SESSION_EXPIRED"); }
  poc::Acceptance accepted;
  portENTER_CRITICAL(&statusMux);
  const bool storageReady = configStatus.storageReady;
  const bool wifiAvailable = candidate.ssid[0] || configStatus.saved;
  if (std::strcmp(configStatus.result, "testing") != 0 && !requestQueued) attempt.state = poc::State::Idle;
  accepted = storageReady && wifiAvailable ? attempt.accept(candidate.attempt_id) : poc::Acceptance::Busy;
  if (accepted == poc::Acceptance::New) {
    requestQueued = true;
    configStatus.result = "testing";
    configStatus.error = "";
  }
  portEXIT_CRITICAL(&statusMux);
  if (!storageReady) {
    poc::wipe(&candidate, sizeof(candidate));
    return errorReply(request, "503 Service Unavailable", "STORAGE_UNAVAILABLE");
  }
  if (!wifiAvailable) {
    poc::wipe(&candidate, sizeof(candidate));
    return errorReply(request, "422 Unprocessable Content", "NO_SAVED_WIFI");
  }
  if (accepted == poc::Acceptance::Busy || accepted == poc::Acceptance::Expired) {
    poc::wipe(&candidate, sizeof(candidate));
    return errorReply(request, accepted == poc::Acceptance::Busy ? "409 Conflict" : "403 Forbidden",
                      accepted == poc::Acceptance::Busy ? "BUSY" : "SESSION_EXPIRED");
  }
  char result[96];
  snprintf(result, sizeof(result), "{\"attempt_id\":\"%s\"}", candidate.attempt_id);
  if (accepted == poc::Acceptance::New && xQueueSend(requests, &candidate, 0) != pdTRUE) {
    portENTER_CRITICAL(&statusMux);
    attempt.state = poc::State::Failed; requestQueued = false; configStatus.result = "failed"; configStatus.error = "QUEUE_BUSY";
    portEXIT_CRITICAL(&statusMux);
    poc::wipe(&candidate, sizeof(candidate));
    return errorReply(request, "503 Service Unavailable", "QUEUE_BUSY");
  }
  poc::wipe(&candidate, sizeof(candidate));
  return reply(request, accepted == poc::Acceptance::Duplicate ? "200 OK" : "202 Accepted", result);
}
bool startHttp() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.stack_size = 6144;
  config.max_open_sockets = 3;
  config.max_uri_handlers = 4;
  config.max_req_hdr_len = 1536;
  config.max_uri_len = 64;
  config.recv_wait_timeout = 1;
  config.send_wait_timeout = 2;
  config.lru_purge_enable = true;
  config.open_fn = acceptApSocket;
  if (httpd_start(&httpServer, &config) != ESP_OK) return false;
  const httpd_uri_t routes[] = {
    { .uri = "/", .method = HTTP_GET, .handler = pageHandler, .user_ctx = nullptr },
    { .uri = "/api/session", .method = HTTP_GET, .handler = sessionHandler, .user_ctx = nullptr },
    { .uri = "/api/status", .method = HTTP_GET, .handler = statusHandler, .user_ctx = nullptr },
    { .uri = "/api/connect", .method = HTTP_POST, .handler = connectHandler, .user_ctx = nullptr }
  };
  for (const auto& route : routes) if (httpd_register_uri_handler(httpServer, &route) != ESP_OK) {
    httpd_stop(httpServer); httpServer = nullptr; return false;
  }
  return true;
}
void publishStatus() {
  const bool connected = stationConnected();
  esp_netif_ip_info_t address = {};
  if (connected) esp_netif_get_ip_info(staNetif, &address);
  const uint32_t ip = ntohl(address.ip.addr);
  char addressText[16];
  snprintf(addressText, sizeof(addressText), "%u.%u.%u.%u",
      static_cast<unsigned>((ip >> 24) & 255), static_cast<unsigned>((ip >> 16) & 255),
      static_cast<unsigned>((ip >> 8) & 255), static_cast<unsigned>(ip & 255));
  uint8_t channel = 0;
  wifi_second_chan_t secondary;
  esp_wifi_get_channel(&channel, &secondary);
  ConfigStatus config;
  config.saved = configSession.hasSaved();
  config.storageReady = configSession.storageReady();
  if (config.saved) std::memcpy(config.hubUrl, configSession.saved().hub_url, sizeof(config.hubUrl));
  config.result = configSession.result;
  config.error = configSession.error;
  const uint32_t stack = uxTaskGetStackHighWaterMark(nullptr);
  portENTER_CRITICAL(&statusMux);
  networkStatus.connected = connected;
  networkStatus.subnetConflict = connected && (ip & 0xffffff00UL) == 0xc0a80400UL;
  std::strcpy(networkStatus.ip, connected ? addressText : "0.0.0.0");
  networkStatus.channel = channel;
  networkStatus.loopStack = stack;
  // An HTTP request may have been queued while this loop was checking Hub/NVS.
  // Preserve its queued snapshot until the loop has consumed its credentials.
  if (!requestQueued) { attempt = configSession.attempt; configStatus = config; }
  portEXIT_CRITICAL(&statusMux);
}
void provisioningSetup() {
  Serial.begin(115200);
  delay(300);
  esp_log_level_set("*", ESP_LOG_NONE);
  Serial.printf("[P2] chip=%s revision=%u cores=%u flash_bytes=%u psram_bytes=%u core=%s idf=%s\n",
      ESP.getChipModel(), ESP.getChipRevision(), ESP.getChipCores(), static_cast<unsigned>(ESP.getFlashChipSize()),
      static_cast<unsigned>(ESP.getPsramSize()), ESP_ARDUINO_VERSION_STR, esp_get_idf_version());
  printMemory("boot");
  configStore.begin();
  requests = xQueueCreateStatic(1, sizeof(poc::Credentials), requestQueueStorage, &requestQueueControl);
  if (!requests) { Serial.println("[P2] START_FAILED: QUEUE"); return; }
  char apName[32];
  if (!startProtectedWifi(apName, sizeof(apName))) {
    esp_wifi_stop(); Serial.println("[P2] START_FAILED: PROTECTED_WIFI"); return;
  }
  wifiReady = true;
  uint8_t random[16]; esp_fill_random(random, sizeof(random));
  for (size_t i = 0; i < sizeof(random); ++i) snprintf(sessionToken + i * 2, 3, "%02x", random[i]);
  poc::wipe(random, sizeof(random));
  sessionStarted = millis();
  portENTER_CRITICAL(&statusMux); setupOpen = true; portEXIT_CRITICAL(&statusMux);
  configSession.begin(millis());
  publishStatus();
  if (!startHttp()) {
    portENTER_CRITICAL(&statusMux); setupOpen = false; portEXIT_CRITICAL(&statusMux);
    esp_wifi_set_mode(WIFI_MODE_STA);
    Serial.println("[P2] START_FAILED: HTTP; saved Wi-Fi recovery continues");
    return;
  }
  Serial.printf("[P2] READY ssid=%s url=http://192.168.4.1 window_seconds=600 saved=%s storage_ready=%s\n",
      apName, configSession.hasSaved() ? "yes" : "no", configSession.storageReady() ? "yes" : "no");
  Serial.println("[P2] Validated Wi-Fi and Hub settings persist in NVS. Press RST to edit.");
  printMemory("ap_http_ready");
}
void provisioningLoop() {
  if (!wifiReady) { delay(20); return; }
  if (setupOpen && !remainingSeconds()) {
    portENTER_CRITICAL(&statusMux); setupOpen = false; portEXIT_CRITICAL(&statusMux);
    configSession.tick(millis(), false);
    esp_wifi_set_mode(WIFI_MODE_STA);
    if (httpServer) { httpd_stop(httpServer); httpServer = nullptr; }
    poc::wipe(sessionToken, sizeof(sessionToken));
    Serial.println("[P2] SETUP_CLOSED: saved Wi-Fi recovery continues; press RST to edit");
    printMemory("session_closed");
  }
  poc::Credentials pending;
  if (xQueueReceive(requests, &pending, 0) == pdTRUE) {
    poc::wipe(requestQueueStorage, sizeof(requestQueueStorage));
    if (setupOpen && remainingSeconds()) {
      if (!pending.ssid[0]) {
        configSession.startHubTrial(pending.hub_url, pending.attempt_id, millis());
      } else {
        fc::Config candidate;
        std::memcpy(candidate.ssid, pending.ssid, sizeof(candidate.ssid));
        std::memcpy(candidate.password, pending.password, sizeof(candidate.password));
        std::memcpy(candidate.hub_url, pending.hub_url, sizeof(candidate.hub_url));
        configSession.startTrial(candidate, pending.attempt_id, millis());
        poc::wipe(&candidate, sizeof(candidate));
      }
      printMemory("connect_start");
    }
    poc::wipe(&pending, sizeof(pending));
    portENTER_CRITICAL(&statusMux); requestQueued = false; portEXIT_CRITICAL(&statusMux);
  }
  const poc::State previous = configSession.attempt.state;
  configSession.tick(millis(), setupOpen && remainingSeconds());
  publishStatus();
  if (configSession.attempt.state != previous) {
    Serial.printf("[P2] state=%s result=%s error=%s\n",
        poc::name(configSession.attempt.state), configSession.result, configSession.error);
    printMemory(poc::name(configSession.attempt.state));
  }
  if (millis() - lastMetricsAt >= 15000) { lastMetricsAt = millis(); printMemory("periodic"); }
  delay(10);
}

#ifndef FOCUSDESK_PROVISIONING_EMBEDDED
void setup() { provisioningSetup(); }
void loop() { provisioningLoop(); }
#endif
