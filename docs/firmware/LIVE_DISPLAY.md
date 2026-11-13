# ESP32 联网任务演示

任务 FW-L1。独立 sketch 为 **`E:\FocusDesk\firmware\focusdesk_live\focusdesk_live.ino`**。保留原静态 sketch，沿用用户已运行的 ESP32-S3、GDEM042F52/JD79668 400×300 屏及接线；不改驱动、波形或 GPIO。

FOCUS-1：新增可选 focus 解析和英文专注页，显示所选任务、固定 25 分钟、结束日期/时间（UTC 或固定 UTC+8），需要重新上传同一个 sketch。服务器到期/退出后发布总览，设备按原轮询及刷新保护更新；离线时不做本地到期切换。专注不变不重复全刷，完成/删除专注任务后退出。详细操作见 [FOCUS_MODE.md](../FOCUS_MODE.md)。用户已确认此前参考版总览排版真机通过，专注页仍待真机验收。

## 先启动唯一电脑服务

在 PowerShell 前台先构建 Dashboard，再启动服务：

```powershell
cd E:\FocusDesk
npm run build
npm run demo
```

服务默认端口 8787。电脑浏览器打开 `http://电脑实际局域网IPv4:8787/`，确认 Dashboard 可读到演示任务；设备读取同源服务的 `/api/v1/daily-overview`。使用电脑可达的局域网 IPv4，不用 `localhost`、`127.0.0.1` 或 `0.0.0.0` 作为设备目标地址。设备与电脑网络需互通，程序不修改防火墙；仅用于受控局域网只读演示。

任务源为 **`E:\FocusDesk\backend\data\tasks.json`**。当前支持在电脑本机网页编辑并保存任务（见 `docs/TASK_EDITING.md`），或手动修改该文件；服务验证后发布，设备沿用原读取 API。

## 本地配置与 Arduino IDE

1. 将 sketch 同目录的 `private_config.example.h` 复制为 **`private_config.h`**，只在本地填写 2.4 GHz Wi-Fi 名称、密码和 API URL，例如 `http://192.168.1.10:8787/api/v1/daily-overview`。该文件已被根 `.gitignore` 忽略，示例文件本身均为空字符串；不要把真实凭据写回示例或共享文档。
2. Arduino IDE 打开 `E:\FocusDesk\firmware\focusdesk_live\focusdesk_live.ino`，选择 **ESP32S3 Dev Module**，沿用原来正常工作的 Flash/PSRAM/USB CDC/端口设置。无需修改 IDE 全局配置。
3. 沿用已核实的 ESP32 Arduino core **3.3.12**、Adafruit GFX **1.13.0**、BusIO **1.17.4**。WiFi、HTTPClient、SPI 来自 core；ArduinoJson **7.4.2** 单头与 MIT 正文已经放在 sketch 的 `src/` 下，不需要另装全局 JSON 库。
4. 先点击“验证/编译”，成功后由用户手动上传。Agent 不打开串口、不烧录。串口监视器为 **115200**；USB CDC 沿用原设置，只有 native USB 看不到日志时才按实际连接方式核对。

没有私有配置或配置明显不完整时，默认程序仍可编译，启动输出 `CONFIG_REQUIRED`，不会尝试连接占位网络或刷新屏幕。配置只在启动读取，修改后需重新编译/上传。程序不打印 SSID、密码、URL、任务正文或服务器原始错误信息。

固定引脚为 BUSY=4、CS=5、RST=16、DC=17、SCK=18、MOSI=13，继续使用现有接线。

## 画面、更新与故障

FW-STYLE1（2026-11-03）：按用户参考图适配 400×300 英文页面，显示 FocusDesk、文件日期/星期、`Daily overview`、红色当前重点、黄色状态提示、0–3 条任务与完成勾选/删除线、底部完成计数和黄色下一步提示。当前重点取第一条未完成任务，下一步取其后的第一条未完成任务；只使用原有 todo/done，不添加进行中状态。空数组显示 `Nothing scheduled` / `No tasks`；全部完成显示 `All tasks completed`。不显示颜色测试标签。

使用已安装 Adafruit GFX 库中的 FreeSans9pt7b、FreeSansBold9pt7b、FreeSansBold12pt7b 字体，专注结束时间另用 FreeSansBold24pt7b。按实际字形宽度选择任务字号；长标题回退到内置字体，优先栏、专注任务和任务列表均完整显示最多 40 字符。底部重复的下一步摘要最多 30 字符，超出用省略号；完整标题仍在列表。本轮显示 profile 仅支持可打印 ASCII（普通空格允许、全空白不允许）和 `Asia/Shanghai` / `UTC` 时区；中文、控制符或其他时区明确拒绝，不用坏字替换。继续按用户要求使用英文，不加入中文字库。

日期与星期来自任务数据日期，时区校验沿用原规则；新版排版不再单独显示时区或诊断信息。测试预览使用共享的合成 fixture，真实显示仍使用现有 Backend 内容，没有设备回执。此次只修改排版，不改变驱动、全刷波形、网络轮询、刷新间隔或私有配置。用户需在 Arduino IDE 重新验证并上传同一个联网 sketch；仅刷新网页不会安装新排版。

数据日期来自文件，不根据设备时钟推导“今日”。没有设备回执；Dashboard 的 API 成功不代表屏幕已同步。实际验收以用户观察与串口标识为准：

| 标识 | 含义 |
| --- | --- |
| `CONFIG_REQUIRED` | 需要填写本地配置；未联网/未刷新 |
| `FETCH_OK` | 本次 HTTP 和完整快照验证通过，尚不等于刷新成功 |
| `UNCHANGED` | 屏幕状态有效且 revision 已成功显示，跳过刷新 |
| `DISPLAY_DEFERRED: MIN_INTERVAL` | 内容有变化或需要恢复，但仍处于刷新间隔保护 |
| `DISPLAY_OK` | 驱动此次刷新完成，才推进成功显示版本 |
| `DISPLAY_FAILED:SCREEN_STATE_UNKNOWN` | 刷新失败，实际画面未知，不推进成功版本 |
| `FETCH_FAILED: …` | 网络、HTTP framing 或模型验证错误；保留最后有效快照，不发起刷新 |

Wi-Fi 单次连接/重连最多等待 30 秒。HTTP 连接超时配置为 3 秒、库读取超时 5 秒，响应体另设总计 5 秒期限；不是整条 Wi-Fi→显示链路总计 5 秒。仅接受 200、明确的 Content-Length 1–4096、JSON 类型，无压缩/分块/重定向。最多读取声明长度，不使用无限增长的响应字符串。

正常请求在上次处理完成后约 30 秒执行；错误按 30/60/120/240/300 秒退避，最高 5 分钟，恢复成功后回到 30 秒。串行处理，不重叠请求。每次刷新尝试完成后至少等待 **60 秒** 才允许下一次尝试；这是保守演示值，不声称是面板厂商最低间隔。间隔等待不清零显示失败计数。

网络/解析错误不触发新刷新，保留已有画面。全刷失败时物理画面可能改变，不能保证旧图完整；保留逻辑记录并受控恢复。即使服务后来返回历史成功 revision，屏幕状态未知时也不能直接跳过恢复。原驱动 BUSY 等待有上限，失败处理仍可能耗时；不能把 `FETCH_OK` 当作 `DISPLAY_OK`。

## 建议手动演示顺序

1. 启动服务，上传用户配置后的 sketch，观察 `FETCH_OK`、`DISPLAY_OK` 与屏幕任务。
2. 在电脑本机网页编辑并保存任务，观察 Dashboard 与屏幕显示同一内容。也可手动修改 `backend/data/tasks.json`。正常网络下刷新仍受 30 秒轮询、60 秒保护和电子纸耗时影响，不承诺瞬时更新。
3. 保持任务不变，观察 `UNCHANGED`，确认不会每次读取都刷屏。
4. 改成 `tasks: []` 验证 `No tasks`；恢复任务后再次更新。
5. 停止服务或断开网络，确认 `FETCH_FAILED` 且不新刷屏；恢复后观察有效快照和受控更新。不要把断网画面视为新的实时数据。

## 已实际运行的主机验证

真实 ArduinoJson parser、纯 C++ 状态和 renderer，以及真实 `.ino` 均已在主机编译执行；Wi-Fi/HTTP/GFX/SPI 使用本地替身，不发真实请求、不连接板卡。测试通过五组：共享 fixtures 和 59 个无效/不支持快照、退避/版本/60 秒保护/回绕、40 字符完整排版、缺配置不联网、实际 sketch 的 HTTP 边界/截断/超时/错误保留/显示失败回历史 revision/断网恢复。

在 `E:\FocusDesk` 的 PowerShell 中复现：

```powershell
$compiler = 'C:\Program Files\mingw64\bin\g++.exe'
$gfx = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Arduino\libraries\Adafruit_GFX_Library'
$parserBinary = Join-Path $env:TEMP 'focusdesk-live-test.exe'
& $compiler -std=c++17 -Wall -Wextra -Werror -I tests/firmware/live_fakes -I $gfx tests/firmware/live_test.cpp firmware/focusdesk_live/gdem042f52_display.cpp -o $parserBinary
if ($LASTEXITCODE -ne 0) { throw 'Parser/state/renderer compilation failed' }
& $parserBinary
if ($LASTEXITCODE -ne 0) { throw 'Parser/state/renderer tests failed' }
foreach ($mode in @('unconfigured','configured')) {
  $sketchBinary = Join-Path $env:TEMP ('focusdesk-live-sketch-' + $mode + '.exe')
  $defines = @()
  if ($mode -eq 'configured') { $defines = @('-DFOCUSDESK_TEST_CONFIGURED') }
  & $compiler -std=c++17 -Wall -Wextra -Werror @defines -I tests/firmware/live_fakes -I $gfx tests/firmware/live_sketch_test.cpp firmware/focusdesk_live/gdem042f52_display.cpp -o $sketchBinary
  if ($LASTEXITCODE -ne 0) { throw 'Sketch host compilation failed' }
  & $sketchBinary
  if ($LASTEXITCODE -ne 0) { throw 'Sketch host tests failed' }
}
```

当前 Codex 沙箱内 g++ 有 DLL 重定位问题；上述命令在沙箱外已运行通过。主机测试宏会跳过真实 `private_config.h`，使用测试专属配置。

原样驱动的 SHA-256 与静态 sketch 一致。ArduinoJson 来源和 MIT 正文见 `firmware/THIRD_PARTY_NOTICES.md`。解析器验证严格 JSON/UTF-8、实际日期、UTC 时间戳、唯一 ID、必填字段及 due_at、枚举和大小；未知字段不渲染。另设最大嵌套 12 层及 ArduinoJson 分配预算 32 KiB，超出预算整体拒绝。

FW-STYLE1 主机替身使用已安装 GFX 字体的真实字形数据计算边界并绘制像素，五组主机测试已重新运行通过；另覆盖长标题、重点/下一步推导、完成计数、星期和空/全完成/单任务。它不模拟无线网络或屏幕波形。

`tests/firmware/live_page_preview.cpp` 可用相同编译参数替换测试源文件构建，再从项目根目录运行 `预览程序 输出.ppm [empty|done|long]`；默认读取共享 fixture，不读取真实任务文件。它捕获显示驱动发送的 30,000 字节帧缓冲，生成 400×300 PPM。本轮普通、空、全完成、长标题四种预览均已生成并检查；`.cache/epaper-style-normal.png` 为普通任务示意。颜色仅为示意，实际墨水观感以真机为准。

## 真实 ESP32-S3 目标源码核查

FOCUS-1：parser/state/renderer、缺配置/有配置实际 sketch 主机测试通过，涵盖专注数据校验、完整长标题、午夜/闰日/跨年换算、进入/不重刷/断网保留/回总览。专注及长标题预览已检查，预览程序支持 `focus` / `focus-long`；示意为 `.cache/epaper-focus.png`。真实工具链生成最新 `.cache/focus-api-check.o`（1042888 字节）和原样驱动 `.cache/focus-driver-check.o`（65128 字节）。仍仅源码目标文件检查，不等同最终链接或真机验证；未读取私有配置、上传或打开串口。

FW-STYLE1 已用下述方式重新编译最新 sketch 和原样驱动，生成 `.cache/style-api-check.o`（918592 字节）和 `.cache/style-driver-check.o`（65128 字节）；跳过私有配置，未最终链接、上传或打开串口。以下为初版核查记录。

Tech Lead 使用 IDE 自带 Arduino CLI 1.5.1、`esp32:esp32:esp32s3` / core 3.3.12 生成编译数据库，再执行真实交叉编译器参数，分别编译最新 `focusdesk_live.ino` 与原样显示驱动。两份目标文件均成功生成（767072 和 65128 字节），证明实际 WiFi/HTTPClient/GFX/ArduinoJson API 与源码可编译。

核查强制跳过私有配置，不读取 Wi-Fi 凭据；仅生成缓存目标文件，没有最终链接、上传、打开串口或连接无线网络。不能把它等同于完整固件构建通过。最终仍由用户在原 Arduino IDE 设置下验证/链接/上传并进行真机联网显示核对，本轮未声称完成设备同步。
