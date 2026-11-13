// SPDX-FileCopyrightText: 2026 FocusDesk contributors
// SPDX-License-Identifier: GPL-3.0-only
#pragma once
#include <WiFi.h>
#include <algorithm>
#include <cassert>
#include <cstring>
#include <map>
#include <string>

constexpr int HTTP_CODE_OK = 200, HTTPC_DISABLE_FOLLOW_REDIRECTS = 0;
struct FakeString {
  std::string value;
  bool startsWith(const char* prefix) const { return value.rfind(prefix, 0) == 0; }
  size_t length() const { return value.size(); }
};
struct FakeHttp {
  int status = 200, contentLength = -2, requests = 0;
  bool beginOk = true, freezeBody = false;
  size_t position = 0;
  std::string body;
  std::map<std::string,std::string> headers = {{"Content-Type","application/json; charset=utf-8"}};
};
extern FakeHttp fakeHttp;
struct FakeStream {
  int available() const {
    return fakeHttp.freezeBody ? 0 : static_cast<int>(fakeHttp.body.size() - fakeHttp.position);
  }
  bool connected() const { return fakeHttp.freezeBody || fakeHttp.position < fakeHttp.body.size(); }
  int read(uint8_t* output, size_t length) {
    const size_t amount = std::min(length, fakeHttp.body.size() - fakeHttp.position);
    std::memcpy(output, fakeHttp.body.data() + fakeHttp.position, amount);
    fakeHttp.position += amount;
    return static_cast<int>(amount);
  }
};
class HTTPClient {
 public:
  void setConnectTimeout(int value) { assert(value == 3000); }
  void setTimeout(int value) { assert(value == 5000); }
  void setReuse(bool value) { assert(!value); }
  void useHTTP10(bool value) { assert(value); }
  void setFollowRedirects(int value) { assert(value == HTTPC_DISABLE_FOLLOW_REDIRECTS); }
  void collectHeaders(const char**, size_t count) { assert(count == 3); }
  bool begin(WiFiClient&, const char*) { return fakeHttp.beginOk; }
  int GET() { ++fakeHttp.requests; fakeHttp.position = 0; return fakeHttp.status; }
  int getSize() const { return fakeHttp.contentLength == -2 ?
      static_cast<int>(fakeHttp.body.size()) : fakeHttp.contentLength; }
  FakeString header(const char* key) const {
    const auto found = fakeHttp.headers.find(key);
    return {found == fakeHttp.headers.end() ? "" : found->second};
  }
  FakeStream* getStreamPtr() { return &stream_; }
  void end() {}
 private:
  FakeStream stream_;
};
