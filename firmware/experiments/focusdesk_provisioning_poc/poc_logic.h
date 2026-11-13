// SPDX-License-Identifier: GPL-3.0-only
#pragma once
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace focusdesk_poc {
constexpr size_t MAX_FORM_BYTES = 1024;
constexpr uint32_t CONNECT_TIMEOUT_MS = 30000;
constexpr uint32_t SESSION_MS = 600000;
struct Credentials {
  char ssid[33] = {};
  char password[64] = {};
  char attempt_id[49] = {};
  char hub_url[96] = {};
};
inline void wipe(void* memory, size_t size) {
  volatile unsigned char* p = static_cast<volatile unsigned char*>(memory);
  while (size--) *p++ = 0;
}
inline bool mappedIpv4(const uint8_t* bytes, uint32_t& address) {
  for (size_t i = 0; i < 10; ++i) if (bytes[i] != 0) return false;
  if (bytes[10] != 0xff || bytes[11] != 0xff) return false;
  address = (static_cast<uint32_t>(bytes[12]) << 24) | (static_cast<uint32_t>(bytes[13]) << 16) |
            (static_cast<uint32_t>(bytes[14]) << 8) | bytes[15];
  return true;
}
inline bool apSocketAllowed(uint32_t local, uint32_t peer) {
  return local == 0xc0a80401UL && (peer & 0xffffff00UL) == 0xc0a80400UL;
}
inline int hex(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}
inline bool decode(const char* source, size_t length, char* target, size_t capacity) {
  size_t out = 0;
  for (size_t i = 0; i < length; ++i) {
    unsigned char c = static_cast<unsigned char>(source[i]);
    if (c == '%') {
      if (i + 2 >= length || hex(source[i + 1]) < 0 || hex(source[i + 2]) < 0) return false;
      c = static_cast<unsigned char>((hex(source[i + 1]) << 4) | hex(source[i + 2]));
      i += 2;
    } else if (c == '+') c = ' ';
    if (!c || out + 1 >= capacity) return false;
    target[out++] = static_cast<char>(c);
  }
  target[out] = '\0';
  return true;
}
inline bool validUtf8(const char* value) {
  const auto* bytes = reinterpret_cast<const unsigned char*>(value);
  const size_t length = std::strlen(value);
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
inline const char* parseForm(const char* body, size_t length, Credentials& output, bool requireHub = false) {
  if (!body || !length || length > MAX_FORM_BYTES) return "BODY_LIMIT";
  Credentials candidate;
  unsigned found = 0;
  const char* error = nullptr;
  for (size_t offset = 0; offset < length && !error;) {
    size_t end = offset;
    while (end < length && body[end] != '&') ++end;
    size_t equal = offset;
    while (equal < end && body[equal] != '=') ++equal;
    char key[16] = {};
    if (equal == end || !decode(body + offset, equal - offset, key, sizeof(key))) { error = "FORM_INVALID"; break; }
    unsigned bit = 0;
    char* value = nullptr;
    size_t capacity = 0;
    if (std::strcmp(key, "ssid") == 0) { bit = 1; value = candidate.ssid; capacity = sizeof(candidate.ssid); }
    else if (std::strcmp(key, "password") == 0) { bit = 2; value = candidate.password; capacity = sizeof(candidate.password); }
    else if (std::strcmp(key, "attempt_id") == 0) { bit = 4; value = candidate.attempt_id; capacity = sizeof(candidate.attempt_id); }
    else if (requireHub && std::strcmp(key, "hub_url") == 0) { bit = 8; value = candidate.hub_url; capacity = sizeof(candidate.hub_url); }
    else { error = "FIELD_UNKNOWN"; break; }
    if ((found & bit) || !decode(body + equal + 1, end - equal - 1, value, capacity)) { error = "FIELD_INVALID"; break; }
    found |= bit;
    if (end + 1 == length) { error = "FORM_INVALID"; break; }
    offset = end + 1;
  }
  if (!error && (found != (requireHub ? 15U : 7U) || !candidate.ssid[0] || !validUtf8(candidate.ssid))) error = "SSID_INVALID";
  if (!error && requireHub && !candidate.hub_url[0]) error = "HUB_INVALID";
  const size_t passwordLength = std::strlen(candidate.password);
  if (!error && (passwordLength < 8 || passwordLength > 63)) error = "PASSWORD_8_TO_63_ASCII_REQUIRED";
  for (size_t i = 0; !error && i < passwordLength; ++i) {
    const auto c = static_cast<unsigned char>(candidate.password[i]);
    if (c < 0x20 || c > 0x7e) error = "PASSWORD_8_TO_63_ASCII_REQUIRED";
  }
  if (!error && !candidate.attempt_id[0]) error = "ATTEMPT_INVALID";
  for (size_t i = 0; !error && candidate.attempt_id[i]; ++i) {
    const char c = candidate.attempt_id[i];
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-')) error = "ATTEMPT_INVALID";
  }
  if (!error) output = candidate;
  wipe(&candidate, sizeof(candidate));
  return error;
}
enum class State { Idle, Queued, Connecting, Verifying, Saving, Connected, Failed, Disconnected, Expired };
inline const char* name(State state) {
  switch (state) {
    case State::Idle: return "idle";
    case State::Queued: return "queued";
    case State::Connecting: return "connecting";
    case State::Verifying: return "verifying";
    case State::Saving: return "saving";
    case State::Connected: return "connected";
    case State::Failed: return "failed";
    case State::Disconnected: return "disconnected";
    default: return "expired";
  }
}
enum class Acceptance { New, Duplicate, Busy, Expired };
struct Attempt {
  State state = State::Idle;
  char id[49] = {};
  uint32_t started = 0;
  Acceptance accept(const char* next) {
    if (state == State::Expired) return Acceptance::Expired;
    if (id[0] && std::strcmp(next, id) == 0) return Acceptance::Duplicate;
    if (state == State::Queued || state == State::Connecting || state == State::Verifying || state == State::Saving) return Acceptance::Busy;
    std::strncpy(id, next, sizeof(id) - 1);
    id[sizeof(id) - 1] = '\0';
    state = State::Queued;
    return Acceptance::New;
  }
  void start(uint32_t now) { started = now; state = State::Connecting; }
  bool observe(uint32_t now, bool connected) {
    if (state == State::Connecting) {
      if (static_cast<uint32_t>(now - started) >= CONNECT_TIMEOUT_MS) { state = State::Failed; return true; }
      if (connected) state = State::Connected;
    } else if (state == State::Connected && !connected) state = State::Disconnected;
    else if (state == State::Disconnected && connected) state = State::Connected;
    return false;
  }
};
}  // namespace focusdesk_poc
