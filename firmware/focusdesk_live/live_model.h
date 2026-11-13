// SPDX-FileCopyrightText: 2026 FocusDesk contributors
// SPDX-License-Identifier: GPL-3.0-only
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include "src/ArduinoJson.h"

namespace focusdesk {
constexpr size_t MAX_BODY_BYTES = 4096;
constexpr size_t MAX_TASKS = 3;

struct Task {
  std::string id, title, dueAt;
  bool done = false, hasDue = false;
};
struct Overview {
  std::string revision, date, timezone, updatedAt;
  std::array<Task, MAX_TASKS> tasks;
  size_t count = 0;
  bool hasFocus = false;
  std::string focusTaskId, focusStartedAt, focusEndsAt;
};

// Validate raw bytes before ArduinoJson can normalize malformed UTF-8.
inline bool validUtf8(const char* data, size_t length) {
  for (size_t i = 0; i < length;) {
    const auto lead = static_cast<unsigned char>(data[i++]);
    if (lead < 0x80) continue;
    uint32_t cp;
    size_t continuation;
    if (lead >= 0xc2 && lead <= 0xdf) { cp = lead & 0x1f; continuation = 1; }
    else if (lead >= 0xe0 && lead <= 0xef) { cp = lead & 0x0f; continuation = 2; }
    else if (lead >= 0xf0 && lead <= 0xf4) { cp = lead & 0x07; continuation = 3; }
    else return false;
    if (i + continuation > length) return false;
    for (size_t j = 0; j < continuation; ++j) {
      const auto c = static_cast<unsigned char>(data[i++]);
      if ((c & 0xc0) != 0x80) return false;
      cp = (cp << 6) | (c & 0x3f);
    }
    if ((continuation == 1 && cp < 0x80) ||
        (continuation == 2 && cp < 0x800) ||
        (continuation == 3 && cp < 0x10000) || cp > 0x10ffff ||
        (cp >= 0xd800 && cp <= 0xdfff)) return false;
  }
  return true;
}

// ArduinoJson accepts some non-JSON input forms. This small syntax gate enforces
// quoted keys, valid escapes/surrogate pairs, strict numbers, and no trailing data.
class JsonSyntax {
 public:
  JsonSyntax(const char* data, size_t length) : data_(data), length_(length) {}
  bool valid() { skip(); return value(0) && (skip(), pos_ == length_); }
 private:
  const char* data_;
  size_t length_, pos_ = 0;
  void skip() {
    while (pos_ < length_ && (data_[pos_] == ' ' || data_[pos_] == '\t' ||
           data_[pos_] == '\r' || data_[pos_] == '\n')) ++pos_;
  }
  bool take(char c) {
    if (pos_ >= length_ || data_[pos_] != c) return false;
    ++pos_; return true;
  }
  bool digits() {
    const auto start = pos_;
    while (pos_ < length_ && data_[pos_] >= '0' && data_[pos_] <= '9') ++pos_;
    return pos_ > start;
  }
  bool hex4(uint16_t& result) {
    result = 0;
    for (int i = 0; i < 4; ++i) {
      if (pos_ == length_) return false;
      const char c = data_[pos_++];
      int n = c >= '0' && c <= '9' ? c - '0' :
              c >= 'a' && c <= 'f' ? c - 'a' + 10 :
              c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
      if (n < 0) return false;
      result = static_cast<uint16_t>((result << 4) | n);
    }
    return true;
  }
  bool string() {
    if (!take('"')) return false;
    while (pos_ < length_) {
      const auto c = static_cast<unsigned char>(data_[pos_++]);
      if (c == '"') return true;
      if (c < 0x20) return false;
      if (c != '\\') continue;
      if (pos_ == length_) return false;
      const char escape = data_[pos_++];
      if (escape == 'u') {
        uint16_t cp;
        if (!hex4(cp)) return false;
        if (cp >= 0xd800 && cp <= 0xdbff) {
          uint16_t low;
          if (!take('\\') || !take('u') || !hex4(low) ||
              low < 0xdc00 || low > 0xdfff) return false;
        } else if (cp >= 0xdc00 && cp <= 0xdfff) return false;
      } else if (escape != '"' && escape != '\\' && escape != '/' &&
                 escape != 'b' && escape != 'f' && escape != 'n' &&
                 escape != 'r' && escape != 't') return false;
    }
    return false;
  }
  bool literal(const char* value) {
    const size_t size = std::strlen(value);
    if (pos_ + size > length_ || std::memcmp(data_ + pos_, value, size)) return false;
    pos_ += size; return true;
  }
  bool number() {
    take('-');
    if (!take('0')) {
      if (pos_ == length_ || data_[pos_] < '1' || data_[pos_] > '9' || !digits())
        return false;
    }
    if (take('.') && !digits()) return false;
    if (take('e') || take('E')) {
      if (!take('+')) take('-');
      if (!digits()) return false;
    }
    return true;
  }
  bool value(int depth) {
    if (depth > 12) return false;
    skip();
    if (pos_ == length_) return false;
    if (data_[pos_] == '"') return string();
    if (take('{')) {
      skip(); if (take('}')) return true;
      do {
        skip(); if (!string()) return false;
        skip(); if (!take(':') || !value(depth + 1)) return false;
        skip(); if (take('}')) return true;
      } while (take(','));
      return false;
    }
    if (take('[')) {
      skip(); if (take(']')) return true;
      do {
        if (!value(depth + 1)) return false;
        skip(); if (take(']')) return true;
      } while (take(','));
      return false;
    }
    if (data_[pos_] == 't') return literal("true");
    if (data_[pos_] == 'f') return literal("false");
    if (data_[pos_] == 'n') return literal("null");
    return number();
  }
};

// Bound ArduinoJson's actual allocation separately from the 4 KiB wire limit.
class JsonBudget : public ArduinoJson::Allocator {
 public:
  void* allocate(size_t size) override {
    if (size > LIMIT - used_) return nullptr;
    auto* header = static_cast<Header*>(std::malloc(sizeof(Header) + size));
    if (!header) return nullptr;
    header->size = size; used_ += size; return header + 1;
  }
  void deallocate(void* ptr) override {
    if (!ptr) return;
    auto* header = static_cast<Header*>(ptr) - 1;
    used_ -= header->size; std::free(header);
  }
  void* reallocate(void* ptr, size_t size) override {
    if (!ptr) return allocate(size);
    auto* header = static_cast<Header*>(ptr) - 1;
    const size_t old = header->size;
    if (size > LIMIT - used_ + old) return nullptr;
    auto* next = static_cast<Header*>(std::realloc(header, sizeof(Header) + size));
    if (!next) return nullptr;
    next->size = size; used_ = used_ - old + size; return next + 1;
  }
 private:
  struct alignas(std::max_align_t) Header { size_t size; };
  static constexpr size_t LIMIT = 32768;
  size_t used_ = 0;
};

inline bool ascii(const std::string& value, bool spaces, size_t maximum) {
  if (value.empty() || value.size() > maximum) return false;
  bool nonspace = false;
  for (const auto c : value) {
    if (static_cast<unsigned char>(c) < (spaces ? 0x20 : 0x21) ||
        static_cast<unsigned char>(c) > 0x7e) return false;
    nonspace = nonspace || c != ' ';
  }
  return nonspace;
}
inline bool readString(ArduinoJson::JsonVariantConst value, std::string& out,
                       size_t maximum = MAX_BODY_BYTES) {
  if (!value.is<const char*>()) return false;
  const auto text = value.as<ArduinoJson::JsonString>();
  if (text.size() > maximum) return false;
  out.assign(text.c_str(), text.size()); return true;
}
inline bool validDate(const std::string& text) {
  if (text.size() != 10 || text[4] != '-' || text[7] != '-') return false;
  for (size_t i = 0; i < text.size(); ++i)
    if (i != 4 && i != 7 && (text[i] < '0' || text[i] > '9')) return false;
  const int year = (text[0]-'0')*1000 + (text[1]-'0')*100 +
                   (text[2]-'0')*10 + text[3]-'0';
  const int month = (text[5]-'0')*10 + text[6]-'0';
  const int day = (text[8]-'0')*10 + text[9]-'0';
  const bool leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
  const int days[] = {31, leap ? 29 : 28,31,30,31,30,31,31,30,31,30,31};
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month-1];
}
inline bool validTimestamp(const std::string& text) {
  if (text.size() < 20 || !validDate(text.substr(0, 10)) || text[10] != 'T' ||
      text[13] != ':' || text[16] != ':' || text.back() != 'Z') return false;
  for (const int i : {11,12,14,15,17,18})
    if (text[i] < '0' || text[i] > '9') return false;
  if ((text[11]-'0')*10 + text[12]-'0' > 23 ||
      (text[14]-'0')*10 + text[15]-'0' > 59 ||
      (text[17]-'0')*10 + text[18]-'0' > 59) return false;
  if (text.size() == 20) return true;
  if (text.size() < 22 || text[19] != '.') return false;
  for (size_t i = 20; i + 1 < text.size(); ++i)
    if (text[i] < '0' || text[i] > '9') return false;
  return true;
}

// Canonical focus timestamps use milliseconds. Count from year 1; only
// differences are needed, so no device clock or platform time_t is involved.
inline int64_t focusTimestampMillis(const std::string& text) {
  if (text.size() != 24 || !validTimestamp(text) || text[19] != '.') return -1;
  const int year = std::atoi(text.c_str());
  const int month = std::atoi(text.c_str() + 5);
  const int day = std::atoi(text.c_str() + 8);
  const int64_t years = year - 1;
  int64_t days = years * 365 + years / 4 - years / 100 + years / 400 + day - 1;
  const bool leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
  const int months[] = {31,leap ? 29 : 28,31,30,31,30,31,31,30,31,30,31};
  for (int i = 1; i < month; ++i) days += months[i - 1];
  return (((days * 24 + std::atoi(text.c_str() + 11)) * 60 +
      std::atoi(text.c_str() + 14)) * 60 + std::atoi(text.c_str() + 17)) * 1000 + std::atoi(text.c_str() + 20);
}

inline bool parseOverview(const char* body, size_t length, Overview& output,
                          const char*& error) {
  error = "INVALID_SNAPSHOT";
  if (!body || !length || length > MAX_BODY_BYTES) { error = "BODY_LIMIT"; return false; }
  if (!validUtf8(body, length) || !JsonSyntax(body, length).valid()) {
    error = "INVALID_JSON_UTF8"; return false;
  }
  JsonBudget budget;
  ArduinoJson::JsonDocument doc(&budget);
  if (ArduinoJson::deserializeJson(doc, body, length,
      ArduinoJson::DeserializationOption::NestingLimit(12))) {
    error = "JSON_PARSE_OR_MEMORY"; return false;
  }
  if (!doc.is<ArduinoJson::JsonObjectConst>()) return false;
  const auto root = doc.as<ArduinoJson::JsonObjectConst>();
  std::string version;
  Overview candidate;
  if (!readString(root["schema_version"], version, 3) || version != "1.0") {
    error = "UNSUPPORTED_VERSION"; return false;
  }
  if (!readString(root["revision"], candidate.revision, 64) ||
      !ascii(candidate.revision, false, 64) ||
      !readString(root["date"], candidate.date, 10) || !validDate(candidate.date) ||
      !readString(root["timezone"], candidate.timezone, 64) ||
      !readString(root["updated_at"], candidate.updatedAt) ||
      !validTimestamp(candidate.updatedAt)) return false;
  if (candidate.timezone != "Asia/Shanghai" && candidate.timezone != "UTC") {
    error = "UNSUPPORTED_TIMEZONE"; return false;
  }
  if (!root["tasks"].is<ArduinoJson::JsonArrayConst>()) return false;
  const auto tasks = root["tasks"].as<ArduinoJson::JsonArrayConst>();
  if (tasks.size() > MAX_TASKS) { error = "TASK_LIMIT"; return false; }
  for (const auto value : tasks) {
    if (!value.is<ArduinoJson::JsonObjectConst>()) return false;
    const auto item = value.as<ArduinoJson::JsonObjectConst>();
    auto& task = candidate.tasks[candidate.count];
    if (!readString(item["id"], task.id, 64) || !ascii(task.id, false, 64)) return false;
    for (size_t i = 0; i < candidate.count; ++i)
      if (candidate.tasks[i].id == task.id) { error = "DUPLICATE_TASK_ID"; return false; }
    if (!readString(item["title"], task.title, 160) || !ascii(task.title, true, 40)) {
      error = "UNSUPPORTED_DEVICE_TEXT"; return false;
    }
    std::string status;
    if (!readString(item["status"], status, 4) || (status != "todo" && status != "done"))
      return false;
    task.done = status == "done";
    const auto due = item["due_at"];
    if (due.isUnbound()) return false;
    if (!due.isNull()) {
      if (!readString(due, task.dueAt) || !validTimestamp(task.dueAt)) return false;
      task.hasDue = true;
    }
    ++candidate.count;
  }
  const auto focus = root["focus"];
  if (!focus.isUnbound() && !focus.isNull()) {
    if (!focus.is<ArduinoJson::JsonObjectConst>() ||
        !readString(focus["task_id"], candidate.focusTaskId, 64) || !ascii(candidate.focusTaskId, false, 64) ||
        !readString(focus["started_at"], candidate.focusStartedAt, 24) ||
        !readString(focus["ends_at"], candidate.focusEndsAt, 24)) return false;
    const int64_t started = focusTimestampMillis(candidate.focusStartedAt);
    const int64_t ends = focusTimestampMillis(candidate.focusEndsAt);
    if (started < 0 || ends < 0 || ends - started != 1500000) return false;
    for (size_t i = 0; i < candidate.count; ++i)
      if (candidate.tasks[i].id == candidate.focusTaskId && !candidate.tasks[i].done) candidate.hasFocus = true;
    if (!candidate.hasFocus) return false;
  }
  output = candidate;
  error = nullptr; return true;
}
}  // namespace focusdesk
