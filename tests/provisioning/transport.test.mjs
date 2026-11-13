// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sketch = await readFile(path.join(root, 'firmware/experiments/focusdesk_provisioning_poc/focusdesk_provisioning_poc.ino'), 'utf8');
function section(start, end) {
  const first = sketch.indexOf(start);
  const last = sketch.indexOf(end, first);
  assert(first >= 0 && last > first, 'Transport method markers must remain identifiable');
  return sketch.slice(first, last);
}
const readiness = section('  bool requestAllowed(bool setupOnly)', '  bool connect(const fc::Config& config)');
const request = section('  fc::HubResult requestJson(', '  fc::HubResult verifyHub(');

test('actual native request methods preserve deadlines, bounds, cancellation and polling after setup closes', async () => {
  const cache = path.join(root, '.cache/p3-transport-tests');
  await mkdir(cache, { recursive: true });
  const run = await mkdtemp(path.join(cache, 'run-'));
  const source = path.join(run, 'transport.cpp');
  const executable = path.join(run, process.platform === 'win32' ? 'transport.exe' : 'transport');
  const header = name => JSON.stringify(path.join(root, 'firmware/experiments/focusdesk_provisioning_poc', name).replaceAll('\\', '/'));
  const harness = String.raw`
#include <algorithm>
#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <string>
#include ${header('config_session.h')}
#include ${header('hub_validation.h')}
namespace fc = focusdesk_config;
namespace poc = focusdesk_poc;
unsigned checks = 0;
void check(bool value) { ++checks; if (!value) { std::cerr << "check " << checks << " failed\n"; std::exit(1); } }
struct FakeFdSet {};
struct FakeTimeval { long tv_sec = 0, tv_usec = 0; };
using socklen_t = unsigned;
struct sockaddr {};
struct sockaddr_in { int sin_family = 0; unsigned sin_port = 0; unsigned sin_addr = 0; };
constexpr int AF_INET = 2, SOCK_STREAM = 1, IPPROTO_TCP = 6, F_SETFL = 4, O_NONBLOCK = 1, SOL_SOCKET = 1, SO_ERROR = 4;
unsigned millisClock = 0, windowSeconds = 600, closed = 0, opened = 0;
bool requestQueued = false;
int statusMux = 0;
struct FakeNetwork {
  std::string response, sent;
  size_t offset = 0;
  unsigned readDelay = 0, writeDelay = 0;
  bool queuedAfterRead = false, neverWritable = false;
  int connectionError = 0;
} network;
unsigned millis() { return millisClock; }
unsigned remainingSeconds() { return windowSeconds; }
int fakeSocket(int, int, int) { ++opened; return 3; }
int fakeFcntl(int, int, int) { return 0; }
int fakeConnect(int, sockaddr*, size_t) { return 0; }
unsigned htons(unsigned value) { return value; }
int fakeInetPton(int, const char*, void*) { return 1; }
int fakeGetSockOpt(int, int, int, int* output, socklen_t*) { *output = network.connectionError; return 0; }
int fakeSelect(int, FakeFdSet* reading, FakeFdSet* writing, void*, FakeTimeval* timeout) {
  if (writing && !network.neverWritable) { millisClock += network.writeDelay; return 1; }
  if (reading && network.offset < network.response.size()) { millisClock += network.readDelay; return 1; }
  millisClock += static_cast<unsigned>(timeout->tv_sec * 1000 + timeout->tv_usec / 1000);
  return 0;
}
int fakeSend(int, const char* bytes, size_t size, int) { network.sent.append(bytes, size); return static_cast<int>(size); }
int fakeRecv(int, char* output, size_t size, int) {
  const size_t amount = std::min(size, network.response.size() - network.offset);
  std::memcpy(output, network.response.data() + network.offset, amount);
  network.offset += amount;
  if (network.queuedAfterRead) requestQueued = true;
  return static_cast<int>(amount);
}
struct HubSocket { int fd = -1; ~HubSocket() { if (fd >= 0) ++closed; } };
char hubReply[6145] = {};
#define portENTER_CRITICAL(mux) static_cast<void>(mux)
#define portEXIT_CRITICAL(mux) static_cast<void>(mux)
#define fd_set FakeFdSet
#define timeval FakeTimeval
#define FD_ZERO(set) static_cast<void>(set)
#define FD_SET(fd, set) do { static_cast<void>(fd); static_cast<void>(set); } while (false)
#define socket fakeSocket
#define fcntl fakeFcntl
#define connect fakeConnect
#define inet_pton fakeInetPton
#define getsockopt fakeGetSockOpt
#define select fakeSelect
#define send fakeSend
#define recv fakeRecv
struct DeviceLink {
${readiness}
${request}
};
#undef connect
std::string response(const std::string& body, const std::string& type = "application/json") {
  return "HTTP/1.1 200 OK\r\nContent-Type: " + type + "\r\nContent-Length: " + std::to_string(body.size()) + "\r\n\r\n" + body;
}
void reset(const std::string& body = "{}") {
  network = FakeNetwork{}; network.response = response(body);
  millisClock = 0; windowSeconds = 600; requestQueued = false; opened = 0; closed = 0;
}
int main() {
  DeviceLink link;
  size_t offset = 99, length = 99;
  reset();
  check(link.requestJson("http://192.168.1.10:8787", "/api/v1/server-info", true, offset, length) == fc::HubResult::Ready);
  check(length == 2 && std::string(hubReply + offset, length) == "{}");
  check(network.sent.find("GET /api/v1/server-info HTTP/1.1\r\nHost: 192.168.1.10:8787\r\n") == 0);
  check(opened == 1 && closed == 1);
  reset(); windowSeconds = 0;
  check(link.requestJson("http://192.168.1.10:8787", "/api/v1/server-info", true, offset, length) == fc::HubResult::Unreachable);
  check(offset == 0 && length == 0 && opened == 0);
  reset(); windowSeconds = 0;
  check(link.requestJson("http://192.168.1.10:8787", "/api/v1/daily-overview", false, offset, length) == fc::HubResult::Ready);
  check(length == 2 && closed == 1 && network.sent.find("GET /api/v1/daily-overview ") == 0);
  reset(); requestQueued = true;
  check(link.requestJson("http://192.168.1.10:8787", "/api/v1/daily-overview", false, offset, length) == fc::HubResult::Unreachable);
  check(opened == 0 && length == 0);
  reset(); network.queuedAfterRead = true;
  check(link.requestJson("http://192.168.1.10:8787", "/api/v1/daily-overview", false, offset, length) == fc::HubResult::Unreachable);
  check(closed == 1 && length == 0);
  reset(); network.neverWritable = true;
  check(link.requestJson("http://192.168.1.10:8787", "/api/v1/daily-overview", false, offset, length) == fc::HubResult::Unreachable);
  check(millisClock == 6000 && closed == 1);
  reset(); network.readDelay = 6001;
  check(link.requestJson("http://192.168.1.10:8787", "/api/v1/daily-overview", false, offset, length) == fc::HubResult::Unreachable);
  check(closed == 1 && length == 0);
  reset(); network.connectionError = 100;
  check(link.requestJson("http://192.168.1.10:8787", "/api/v1/daily-overview", false, offset, length) == fc::HubResult::Unreachable);
  check(closed == 1 && network.sent.empty());
  reset(); network.response = response("{}", "text/html");
  check(link.requestJson("http://192.168.1.10:8787", "/api/v1/daily-overview", false, offset, length) == fc::HubResult::Invalid);
  check(length == 0 && closed == 1);
  reset(); network.response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 4097\r\n\r\n";
  check(link.requestJson("http://192.168.1.10:8787", "/api/v1/daily-overview", false, offset, length) == fc::HubResult::Invalid);
  check(closed == 1 && length == 0);
  reset(); network.response = "HTTP/1.1 200 OK\r\nX-Padding: " + std::string(2048, 'x');
  check(link.requestJson("http://192.168.1.10:8787", "/api/v1/daily-overview", false, offset, length) == fc::HubResult::Invalid);
  check(network.offset == 2048 && closed == 1);
  reset(); network.response = response("{\"value\":\"" + std::string(4084, 'x') + "\"}");
  check(link.requestJson("http://192.168.1.10:8787", "/api/v1/daily-overview", false, offset, length) == fc::HubResult::Ready);
  check(length == 4096 && offset + length < sizeof(hubReply));
  for (const char* path : {"/", "/api/v1/daily-overview?extra=1", "/api/v1/server-info\r\nInjected: x"}) {
    reset();
    check(link.requestJson("http://192.168.1.10:8787", path, false, offset, length) == fc::HubResult::Invalid);
    check(opened == 0 && length == 0);
  }
  reset();
  check(link.requestJson("http://127.0.0.1:8787", "/api/v1/daily-overview", false, offset, length) == fc::HubResult::Invalid);
  check(opened == 0);
  reset(); windowSeconds = 0;
  check(link.requestJson("http://192.168.1.10:8787", "/api/v1/display-snapshot", false, offset, length) == fc::HubResult::Ready);
  check(length == 2 && closed == 1 && network.sent.find("GET /api/v1/display-snapshot ") == 0);
  std::string scene = "{\"schema_version\":\"display-1\",\"layout_version\":\"goal-1\",\"revision\":\"goal-1:transport\",\"width\":400,\"height\":300,\"commands\":[";
  for (int i = 0; i < 64; ++i) { if (i) scene += ','; scene += "[0,0,0,1,1,0]"; }
  scene += "]}";
  reset(scene);
  check(link.requestJson("http://192.168.1.10:8787", "/api/v1/display-snapshot", false, offset, length) == fc::HubResult::Ready);
  check(length == scene.size() && std::string(hubReply + offset, length) == scene && closed == 1);
  reset(scene);
  check(link.requestJson("http://192.168.1.10:8787", "/api/v1/daily-overview", false, offset, length) == fc::HubResult::Invalid);
  check(length == 0 && closed == 1);
  std::string excessiveTokens = "[";
  for (int i = 0; i < 800; ++i) { if (i) excessiveTokens += ','; excessiveTokens += '0'; }
  excessiveTokens += ']';
  reset(excessiveTokens);
  check(link.requestJson("http://192.168.1.10:8787", "/api/v1/display-snapshot", false, offset, length) == fc::HubResult::Invalid);
  check(length == 0 && closed == 1);
  reset(scene); network.queuedAfterRead = true;
  check(link.requestJson("http://192.168.1.10:8787", "/api/v1/display-snapshot", false, offset, length) == fc::HubResult::Unreachable);
  check(length == 0 && closed == 1);
  reset();
  check(link.requestJson("http://192.168.1.10:8787", "/api/v1/display-snapshot?extra=1", false, offset, length) == fc::HubResult::Invalid);
  check(length == 0 && opened == 0);
  std::cout << "P3 actual native transport checks passed: " << checks << '\n';
}
`;
  await writeFile(source, harness);
  const compiler = process.env.CXX || (existsSync('C:/Program Files/mingw64/bin/g++.exe') ? 'C:/Program Files/mingw64/bin/g++.exe' : 'g++');
  const compiled = spawnSync(compiler, ['-std=c++17', '-Wall', '-Wextra', '-Werror', source, '-o', executable], { encoding: 'utf8', timeout: 120000 });
  assert.equal(compiled.status, 0, compiled.error?.message || compiled.stderr || compiled.stdout);
  const executed = spawnSync(executable, [], { encoding: 'utf8', timeout: 30000 });
  assert.equal(executed.status, 0, executed.error?.message || executed.stderr || executed.stdout);
  assert.match(executed.stdout, /P3 actual native transport checks passed: \d+/);
});
