// SPDX-License-Identifier: GPL-3.0-only
#pragma once
#include <nvs.h>
#include <nvs_flash.h>
#include "config_store.h"

namespace focusdesk_config {
class NvsBackend {
 public:
  ~NvsBackend() { close(); }
  bool begin() {
    if (opened_) return true;
    // Erasing a full or incompatible partition would destroy other data.
    if (nvs_flash_init() != ESP_OK) return false;
    opened_ = nvs_open("focusdesk_p2", NVS_READWRITE, &handle_) == ESP_OK;
    return opened_;
  }
  bool available() const { return opened_; }
  ReadResult read(const char* key, void* buffer, size_t capacity, size_t& actual) {
    if (!opened_) return ReadResult::Error;
    actual = 0;
    esp_err_t error = nvs_get_blob(handle_, key, nullptr, &actual);
    if (error == ESP_ERR_NVS_NOT_FOUND) return ReadResult::Missing;
    if (error != ESP_OK) return ReadResult::Error;
    if (actual > capacity) return ReadResult::Error;
    error = nvs_get_blob(handle_, key, buffer, &actual);
    return error == ESP_OK ? ReadResult::Read : ReadResult::Error;
  }
  bool write(const char* key, const void* bytes, size_t size) {
    return opened_ && nvs_set_blob(handle_, key, bytes, size) == ESP_OK;
  }
  bool commit() { return opened_ && nvs_commit(handle_) == ESP_OK; }
  void reset() { close(); begin(); }

 private:
  nvs_handle_t handle_ = 0;
  bool opened_ = false;
  void close() { if (opened_) nvs_close(handle_); opened_ = false; }
};
class NvsConfigStore {
 public:
  NvsConfigStore() : store_(backend_) {}
  bool begin() { return backend_.begin(); }
  bool available() const { return backend_.available(); }
  LoadResult load(Config& output) { return store_.load(output); }
  bool save(const Config& config) { return store_.save(config); }
 private:
  NvsBackend backend_;
  ConfigStore<NvsBackend> store_;
};
}  // namespace focusdesk_config
