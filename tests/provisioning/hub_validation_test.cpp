// SPDX-License-Identifier: GPL-3.0-only
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>
#include "../../firmware/experiments/focusdesk_provisioning_poc/hub_validation.h"

namespace fc = focusdesk_config;
unsigned checks = 0;
void check(bool condition) {
  ++checks;
  if (!condition) { std::cerr << "Failed Hub validation check " << checks << '\n'; std::exit(1); }
}
std::string headers(const std::string& fields = "", const std::string& length = "43",
                    const std::string& type = "application/json", const std::string& status = "HTTP/1.1 200 OK") {
  return status + "\r\nContent-Length: " + length + "\r\nContent-Type: " + type + "\r\n" + fields + "\r\n";
}
void rejected(const std::string& value) {
  fc::HubHeaders output;
  output.contentLength = 99;
  check(!fc::parseHubHeaders(value.data(), value.size(), output));
  check(output.contentLength == 99);
}

int main() {
  fc::HubHeaders output;
  const auto plain = headers();
  check(fc::parseHubHeaders(plain.data(), plain.size(), output));
  check(output.contentLength == 43);
  for (const std::string& type : {"application/json", "APPLICATION/JSON", "application/json; charset=utf-8",
       "Application/Json ; CHARSET = UTF-8", "application/json;charset=\"UTF-8\"", "\tapplication/json\t"}) {
    const auto value = headers("Cache-Control: no-store\r\nConnection: close\r\n", "4096", type, "HTTP/1.0 200 OK");
    check(fc::parseHubHeaders(value.data(), value.size(), output));
    check(output.contentLength == 4096);
  }
  const std::string mixed = "HTTP/1.1 200\r\ncOnTeNt-LeNgTh:\t0001 \r\ncontent-TYPE: application/json\r\n\r\n";
  check(fc::parseHubHeaders(mixed.data(), mixed.size(), output));
  check(output.contentLength == 1);

  for (const std::string& length : {"", "0", "0000", "4097", "999999999999999999999999999999999",
       "+12", "-12", "1.0", "1e2", "0x10", "12,12", "1 2", "12x"}) rejected(headers("", length));
  for (const std::string& type : {"", "text/html", "application/jsonp", "application/json garbage", "application/json;",
       "application/json; charset", "application/json; charset=", "application/json; charset=latin1",
       "application/json; charset=\"utf-8", "application/json; charset=utf-8; charset=utf-8"}) rejected(headers("", "12", type));
  for (const std::string& status : {"HTTP/1.1 201 OK", "HTTP/1.1 301 Redirect", "HTTP/1.1 404 Missing", "HTTP/1.1 500 Error",
       "HTTP/1.2 200 OK", "HTTP/2 200", "http/1.1 200 OK", "HTTP/1.1 2000 OK", "HTTP/1.1 200x", "HTTP/1.1\t200 OK"}) {
    rejected(headers("", "12", "application/json", status));
  }
  for (const std::string& field : {"Content-Length: 43\r\n", "content-length: 44\r\n", "Content-Type: application/json\r\n",
       "CONTENT-TYPE: text/html\r\n", "Transfer-Encoding: chunked\r\n", "transfer-encoding:\r\n",
       "Content-Encoding: gzip\r\n", "Content-Encoding: identity\r\n", "Content-Encoding:\r\n",
       " X-Fold: unsafe\r\n", "\tcontinuation\r\n", "Content Length: 43\r\n", "Content-Length : 43\r\n",
       ": missing-name\r\n", "MissingColon\r\n", "X-Bad\nName: value\r\n", "X-Bad: value\rbroken\r\n"}) rejected(headers(field));
  rejected("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n");
  rejected("HTTP/1.1 200 OK\r\nContent-Length: 43\r\n\r\n");
  rejected("HTTP/1.1 200 OK\nContent-Length: 43\nContent-Type: application/json\n\n");
  rejected(plain.substr(0, plain.size() - 1));
  rejected(plain + "body");
  rejected(plain + "\r\n");
  rejected("HTTP/1.1 100 Continue\r\n\r\n" + plain);
  std::string embeddedNull = plain;
  embeddedNull[embeddedNull.find("OK")] = '\0';
  rejected(embeddedNull);
  rejected(headers(std::string("X-Control: ") + '\x01' + "\r\n"));
  rejected(headers(std::string("X-High: ") + '\x80' + "\r\n"));
  const auto prefix = headers("X-Padding: \r\n");
  std::string exactLimit = headers("X-Padding: " + std::string(2048 - prefix.size(), 'a') + "\r\n");
  check(exactLimit.size() == 2048);
  check(fc::parseHubHeaders(exactLimit.data(), exactLimit.size(), output));
  rejected(headers("X-Padding: " + std::string(2049 - prefix.size(), 'a') + "\r\n"));
  check(!fc::parseHubHeaders(nullptr, 20, output));
  for (size_t length = 0; length < plain.size(); ++length) {
    output.contentLength = 77;
    check(!fc::parseHubHeaders(plain.data(), length, output));
    check(output.contentLength == 77);
  }

  const std::string info = "{\"service\":\"FocusDesk\",\"port\":8787,\"addresses\":[{\"interface\":\"Wi-Fi\",\"address\":\"192.168.1.10\"}]}";
  check(fc::boundedHubJson(info.data(), info.size()));
  const std::string escaped = R"JSON({"text":"quoted \" } [ and slash \\"})JSON";
  check(fc::boundedHubJson(escaped.data(), escaped.size()));
  const std::string deepest = std::string(12, '[') + "1" + std::string(12, ']');
  check(fc::boundedHubJson(deepest.data(), deepest.size()));
  const std::string tooDeep = '[' + deepest + ']';
  check(!fc::boundedHubJson(tooDeep.data(), tooDeep.size()));
  std::string manyValues = "[0";
  for (unsigned i = 0; i < 128; ++i) manyValues += ",0";
  manyValues += ']';
  check(!fc::boundedHubJson(manyValues.data(), manyValues.size()));
  check(!fc::boundedHubJson("[1", 2));
  check(!fc::boundedHubJson("\"unfinished", 11));
  check(!fc::boundedHubJson("[\0]", 3));
  check(!fc::boundedHubJson(nullptr, 1));
  check(!fc::boundedHubJson("", 0));
  const std::string oversized(4097, ' ');
  check(!fc::boundedHubJson(oversized.data(), oversized.size()));
  // The lightweight guard bounds resources. cJSON still verifies JSON grammar.
  check(fc::boundedHubJson("{]", 2));
  std::cout << "P2 Hub header/JSON guard checks passed: " << checks << '\n';
}
