// SPDX-License-Identifier: GPL-3.0-only
#pragma once
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>

namespace focusdesk_config {
struct Config {
  char ssid[33] = {};
  char password[64] = {};
  char hub_url[96] = {};
};
inline void wipe(void* memory, size_t size) {
  volatile unsigned char* bytes = static_cast<volatile unsigned char*>(memory);
  while (size--) *bytes++ = 0;
}
inline size_t boundedLength(const char* value, size_t capacity) {
  const void* end = std::memchr(value, '\0', capacity);
  return end ? static_cast<const char*>(end) - value : capacity;
}
inline bool validSsid(const char* value, size_t length) {
  if (!length || length > 32) return false;
  const auto* bytes = reinterpret_cast<const unsigned char*>(value);
  for (size_t i = 0; i < length;) {
    uint32_t point = bytes[i++];
    if (point < 0x80) { if (point < 0x20 || point == 0x7f) return false; continue; }
    size_t extra;
    uint32_t minimum;
    if (point >= 0xc2 && point <= 0xdf) { extra = 1; minimum = 0x80; point &= 0x1f; }
    else if (point >= 0xe0 && point <= 0xef) { extra = 2; minimum = 0x800; point &= 0x0f; }
    else if (point >= 0xf0 && point <= 0xf4) { extra = 3; minimum = 0x10000; point &= 7; }
    else return false;
    if (extra > length - i) return false;
    while (extra--) {
      if ((bytes[i] & 0xc0) != 0x80) return false;
      point = (point << 6) | (bytes[i++] & 0x3f);
    }
    if (point < minimum || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return false;
  }
  return true;
}
// The portal accepts either the Hub origin or its existing device API URL.
// Persist a canonical origin so a reboot never changes URL interpretation.
inline bool normalizeHub(const char* input, char* output, size_t capacity) {
  if (!input || !output || !capacity || std::strncmp(input, "http://", 7) != 0) return false;
  const char* cursor = input + 7;
  unsigned parts[4] = {};
  for (unsigned i = 0; i < 4; ++i) {
    const char* start = cursor;
    unsigned digits = 0;
    while (*cursor >= '0' && *cursor <= '9') {
      if (++digits > 3) return false;
      parts[i] = parts[i] * 10 + static_cast<unsigned>(*cursor++ - '0');
    }
    if (!digits || parts[i] > 255 || (digits > 1 && *start == '0')) return false;
    if (i < 3 && *cursor++ != '.') return false;
  }
  if (!parts[0] || parts[0] == 127 || parts[0] >= 224 || parts[3] == 255 ||
      (parts[0] == 169 && parts[1] == 254) ||
      (parts[0] == 192 && parts[1] == 168 && parts[2] == 4)) return false;
  unsigned port = 80;
  if (*cursor == ':') {
    ++cursor;
    port = 0;
    unsigned digits = 0;
    while (*cursor >= '0' && *cursor <= '9') {
      if (++digits > 5) return false;
      port = port * 10 + static_cast<unsigned>(*cursor++ - '0');
    }
    if (!digits || !port || port > 65535) return false;
  }
  if (*cursor && std::strcmp(cursor, "/") != 0 && std::strcmp(cursor, "/api/v1/daily-overview") != 0) return false;
  char normalized[96];
  const int length = std::snprintf(normalized, sizeof(normalized), "http://%u.%u.%u.%u:%u",
      parts[0], parts[1], parts[2], parts[3], port);
  if (length < 0 || static_cast<size_t>(length) >= capacity) return false;
  std::memcpy(output, normalized, static_cast<size_t>(length) + 1);
  return true;
}
inline bool validConfig(const Config& config) {
  const size_t ssidLength = boundedLength(config.ssid, sizeof(config.ssid));
  const size_t passwordLength = boundedLength(config.password, sizeof(config.password));
  if (!validSsid(config.ssid, ssidLength) || passwordLength < 8 || passwordLength > 63 ||
      boundedLength(config.hub_url, sizeof(config.hub_url)) == sizeof(config.hub_url)) return false;
  for (size_t i = 0; i < passwordLength; ++i) {
    const auto character = static_cast<unsigned char>(config.password[i]);
    if (character < 0x20 || character > 0x7e) return false;
  }
  char normalized[96];
  return normalizeHub(config.hub_url, normalized, sizeof(normalized)) && std::strcmp(normalized, config.hub_url) == 0;
}

enum class ReadResult { Missing, Read, Error };
enum class LoadResult { Missing, Loaded, Error };
namespace detail {
constexpr uint16_t SCHEMA = 1;
constexpr size_t PAYLOAD_SIZE = 193;
constexpr size_t RECORD_SIZE = 16 + PAYLOAD_SIZE + 4;
constexpr size_t SELECTOR_SIZE = 20;
inline uint32_t checksum(const uint8_t* bytes, size_t length) {
  uint32_t result = 0xffffffffU;
  for (size_t i = 0; i < length; ++i) {
    result ^= bytes[i];
    for (unsigned bit = 0; bit < 8; ++bit) result = (result >> 1) ^ (0xedb88320U & (0U - (result & 1U)));
  }
  return ~result;
}
inline void put(uint8_t* output, uint64_t value, size_t size) {
  for (size_t i = 0; i < size; ++i) { output[i] = static_cast<uint8_t>(value); value >>= 8; }
}
inline uint64_t get(const uint8_t* input, size_t size) {
  uint64_t value = 0;
  for (size_t i = 0; i < size; ++i) value |= static_cast<uint64_t>(input[i]) << (i * 8);
  return value;
}
struct Record {
  uint8_t bytes[RECORD_SIZE] = {};
  ~Record() { wipe(bytes, sizeof(bytes)); }
};
inline void encodeRecord(const Config& config, uint64_t generation, Record& record) {
  std::memcpy(record.bytes, "FDC2", 4);
  put(record.bytes + 4, SCHEMA, 2);
  put(record.bytes + 6, PAYLOAD_SIZE, 2);
  put(record.bytes + 8, generation, 8);
  std::memcpy(record.bytes + 16, config.ssid, sizeof(config.ssid));
  std::memcpy(record.bytes + 49, config.password, sizeof(config.password));
  std::memcpy(record.bytes + 113, config.hub_url, sizeof(config.hub_url));
  put(record.bytes + RECORD_SIZE - 4, checksum(record.bytes, RECORD_SIZE - 4), 4);
}
enum class Decoded { Valid, Invalid, Future };
inline Decoded decodeRecord(const Record& record, size_t size, Config& output, uint64_t& generation) {
  if (size >= 6 && std::memcmp(record.bytes, "FDC2", 4) == 0 && get(record.bytes + 4, 2) > SCHEMA) return Decoded::Future;
  if (size != RECORD_SIZE || std::memcmp(record.bytes, "FDC2", 4) != 0 || get(record.bytes + 4, 2) != SCHEMA ||
      get(record.bytes + 6, 2) != PAYLOAD_SIZE || get(record.bytes + RECORD_SIZE - 4, 4) != checksum(record.bytes, RECORD_SIZE - 4)) return Decoded::Invalid;
  Config candidate;
  std::memcpy(candidate.ssid, record.bytes + 16, sizeof(candidate.ssid));
  std::memcpy(candidate.password, record.bytes + 49, sizeof(candidate.password));
  std::memcpy(candidate.hub_url, record.bytes + 113, sizeof(candidate.hub_url));
  const bool valid = validConfig(candidate) && get(record.bytes + 8, 8) > 0;
  if (valid) { output = candidate; generation = get(record.bytes + 8, 8); }
  wipe(&candidate, sizeof(candidate));
  return valid ? Decoded::Valid : Decoded::Invalid;
}
inline void encodeSelector(unsigned slot, uint64_t generation, uint8_t* output) {
  std::memcpy(output, "FDA2", 4);
  put(output + 4, SCHEMA, 2);
  output[6] = static_cast<uint8_t>(slot);
  output[7] = 0;
  put(output + 8, generation, 8);
  put(output + 16, checksum(output, 16), 4);
}
inline bool decodeSelector(const uint8_t* bytes, size_t size, unsigned& slot, uint64_t& generation) {
  if (size != SELECTOR_SIZE || std::memcmp(bytes, "FDA2", 4) != 0 || get(bytes + 4, 2) != SCHEMA ||
      bytes[6] > 1 || bytes[7] || !get(bytes + 8, 8) || get(bytes + 16, 4) != checksum(bytes, 16)) return false;
  slot = bytes[6]; generation = get(bytes + 8, 8); return true;
}
}  // namespace detail

// Backend provides read(key, buffer, capacity, actual), write(key, data, size),
// commit(), and reset(). reset() reopens the handle after a write error.
// Some NVS errors occur after a durable write. Reload the authoritative state
// after save(false); either outcome refers only to a previously verified config.
template <class Backend> class ConfigStore {
 public:
  explicit ConfigStore(Backend& backend) : backend_(backend) {}
  LoadResult load(Config& output) {
    unsigned slot = 0; uint64_t generation = 0;
    return snapshot(output, slot, generation);
  }
  bool save(const Config& candidate) {
    if (!validConfig(candidate)) return false;
    Config previous;
    unsigned active = 1; uint64_t generation = 0;
    const LoadResult loaded = snapshot(previous, active, generation);
    wipe(&previous, sizeof(previous));
    if (loaded == LoadResult::Error || generation == std::numeric_limits<uint64_t>::max()) return false;
    const unsigned next = loaded == LoadResult::Missing ? 0 : 1 - active;
    detail::Record record, verified;
    detail::encodeRecord(candidate, generation + 1, record);
    const char* key = next ? "config1" : "config0";
    if (!backend_.write(key, record.bytes, sizeof(record.bytes)) || !backend_.commit()) { backend_.reset(); return false; }
    size_t size = 0;
    if (backend_.read(key, verified.bytes, sizeof(verified.bytes), size) != ReadResult::Read ||
        size != sizeof(record.bytes) || std::memcmp(record.bytes, verified.bytes, sizeof(record.bytes)) != 0) return false;
    uint8_t selector[detail::SELECTOR_SIZE] = {};
    detail::encodeSelector(next, generation + 1, selector);
    if (!backend_.write("active", selector, sizeof(selector)) || !backend_.commit()) { backend_.reset(); return false; }
    // Final selector commit is the linearization point. No fallible read follows.
    return true;
  }

 private:
  Backend& backend_;
  LoadResult snapshot(Config& output, unsigned& slot, uint64_t& generation) {
    uint8_t selector[detail::SELECTOR_SIZE] = {};
    size_t selectorSize = 0;
    const ReadResult selected = backend_.read("active", selector, sizeof(selector), selectorSize);
    if (selected == ReadResult::Error) return LoadResult::Error;
    Config configs[2];
    uint64_t generations[2] = {};
    detail::Decoded states[2] = {detail::Decoded::Invalid, detail::Decoded::Invalid};
    for (unsigned i = 0; i < 2; ++i) {
      detail::Record record;
      size_t size = 0;
      const ReadResult read = backend_.read(i ? "config1" : "config0", record.bytes, sizeof(record.bytes), size);
      if (read == ReadResult::Error) { wipe(configs, sizeof(configs)); return LoadResult::Error; }
      if (read == ReadResult::Read) states[i] = detail::decodeRecord(record, size, configs[i], generations[i]);
      if (states[i] == detail::Decoded::Future) { wipe(configs, sizeof(configs)); return LoadResult::Error; }
    }
    if (selected == ReadResult::Missing) { wipe(configs, sizeof(configs)); return LoadResult::Missing; }
    if (!detail::decodeSelector(selector, selectorSize, slot, generation)) { wipe(configs, sizeof(configs)); return LoadResult::Error; }
    unsigned chosen = slot;
    if (states[slot] != detail::Decoded::Valid || generations[slot] != generation) {
      chosen = 1 - slot;
      if (states[chosen] != detail::Decoded::Valid || generations[chosen] >= generation) {
        wipe(configs, sizeof(configs)); return LoadResult::Error;
      }
    }
    output = configs[chosen]; slot = chosen;
    wipe(configs, sizeof(configs));
    return LoadResult::Loaded;
  }
};
}  // namespace focusdesk_config
