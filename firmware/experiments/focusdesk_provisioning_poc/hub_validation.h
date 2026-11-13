// SPDX-License-Identifier: GPL-3.0-only
#pragma once
#include <cstddef>
#include <cstring>

namespace focusdesk_config {
struct HubHeaders {
  size_t contentLength = 0;
};

namespace hub_detail {
inline bool equalAscii(const char* value, size_t length, const char* expected) {
  if (length != std::strlen(expected)) return false;
  for (size_t i = 0; i < length; ++i) {
    char character = value[i];
    if (character >= 'A' && character <= 'Z') character += 'a' - 'A';
    if (character != expected[i]) return false;
  }
  return true;
}
inline bool tokenCharacter(char value) {
  return (value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z') ||
      (value >= '0' && value <= '9') || std::strchr("!#$%&'*+-.^_`|~", value) != nullptr;
}
inline size_t lineEnd(const char* header, size_t length, size_t start) {
  for (size_t i = start; i < length; ++i) {
    if (header[i] == '\r') return i + 1 < length && header[i + 1] == '\n' ? i : length;
    if (header[i] == '\n') return length;
  }
  return length;
}
inline void trimSpace(const char* text, size_t& start, size_t& end) {
  while (start < end && (text[start] == ' ' || text[start] == '\t')) ++start;
  while (start < end && (text[end - 1] == ' ' || text[end - 1] == '\t')) --end;
}
inline bool jsonContentType(const char* value, size_t length) {
  size_t end = 0;
  while (end < length && value[end] != ';') ++end;
  size_t start = 0, mediaEnd = end;
  trimSpace(value, start, mediaEnd);
  if (!equalAscii(value + start, mediaEnd - start, "application/json")) return false;
  if (end == length) return true;
  start = end + 1;
  end = start;
  while (end < length && value[end] != '=') ++end;
  if (end == length) return false;
  size_t nameEnd = end;
  trimSpace(value, start, nameEnd);
  if (!equalAscii(value + start, nameEnd - start, "charset")) return false;
  start = end + 1;
  end = length;
  trimSpace(value, start, end);
  if (end - start >= 2 && value[start] == '"' && value[end - 1] == '"') { ++start; --end; }
  return equalAscii(value + start, end - start, "utf-8");
}
}  // namespace hub_detail

// Parse exactly one complete header block. Body bytes are read separately by
// the caller, which also enforces the socket's overall deadline and byte cap.
inline bool parseHubHeaders(const char* header, size_t length, HubHeaders& output) {
  if (!header || length < 4 || length > 2048 || std::memcmp(header + length - 4, "\r\n\r\n", 4) != 0) return false;
  for (size_t i = 0; i < length; ++i) {
    const auto value = static_cast<unsigned char>(header[i]);
    if (value != '\r' && value != '\n' && value != '\t' && (value < 0x20 || value > 0x7e)) return false;
  }
  size_t end = hub_detail::lineEnd(header, length, 0);
  if (end < 12 || end == length ||
      (std::memcmp(header, "HTTP/1.0 200", 12) != 0 && std::memcmp(header, "HTTP/1.1 200", 12) != 0) ||
      (end > 12 && header[12] != ' ')) return false;
  bool foundLength = false, foundType = false;
  HubHeaders parsed;
  for (size_t start = end + 2; start < length; start = end + 2) {
    end = hub_detail::lineEnd(header, length, start);
    if (end == length) return false;
    if (end == start) {
      if (end + 2 != length || !foundLength || !foundType) return false;
      output = parsed;
      return true;
    }
    size_t colon = start;
    while (colon < end && header[colon] != ':') {
      if (!hub_detail::tokenCharacter(header[colon])) return false;
      ++colon;
    }
    if (colon == start || colon == end) return false;
    size_t valueStart = colon + 1, valueEnd = end;
    hub_detail::trimSpace(header, valueStart, valueEnd);
    const size_t nameLength = colon - start;
    if (hub_detail::equalAscii(header + start, nameLength, "transfer-encoding") ||
        hub_detail::equalAscii(header + start, nameLength, "content-encoding")) return false;
    if (hub_detail::equalAscii(header + start, nameLength, "content-length")) {
      if (foundLength || valueStart == valueEnd) return false;
      for (size_t i = valueStart; i < valueEnd; ++i) {
        if (header[i] < '0' || header[i] > '9') return false;
        parsed.contentLength = parsed.contentLength * 10 + static_cast<size_t>(header[i] - '0');
        if (parsed.contentLength > 4096) return false;
      }
      if (!parsed.contentLength) return false;
      foundLength = true;
    } else if (hub_detail::equalAscii(header + start, nameLength, "content-type")) {
      if (foundType || !hub_detail::jsonContentType(header + valueStart, valueEnd - valueStart)) return false;
      foundType = true;
    }
  }
  return false;
}

// Bound cJSON recursion and allocation before parsing an untrusted LAN reply.
inline bool boundedHubJson(const char* text, size_t length, unsigned tokenLimit = 128) {
  if (!text || !length || length > 4096) return false;
  unsigned depth = 0, tokens = 0;
  bool quoted = false, escaped = false;
  for (size_t i = 0; i < length; ++i) {
    const char value = text[i];
    if (!value) return false;
    if (quoted) {
      if (escaped) escaped = false;
      else if (value == '\\') escaped = true;
      else if (value == '"') quoted = false;
    } else if (value == '"') {
      quoted = true;
      if (++tokens > tokenLimit) return false;
    } else if (value == '{' || value == '[') {
      if (++depth > 12 || ++tokens > tokenLimit) return false;
    } else if (value == '}' || value == ']') {
      if (!depth) return false;
      --depth;
    } else if (value == ',' && ++tokens > tokenLimit) return false;
  }
  return !quoted && !depth;
}
}  // namespace focusdesk_config
