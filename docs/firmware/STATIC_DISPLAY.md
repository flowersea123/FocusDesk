# Arduino IDE 静态屏测试

任务 FW-S2：在 FW-S1 静态页基础上移除底部颜色测试区及标签。用用户确认的 Attention Router 同一块 ESP32-S3、同一块 GDEM042F52/JD79668 屏和现有接线验证独立 FocusDesk 静态页。无网络，不连接 Dashboard 或 Backend，不改现有接线。

## 在 Arduino IDE 中操作

1. 打开 **`E:\FocusDesk\firmware\focusdesk_static\focusdesk_static.ino`**。目录名与 sketch 同名，相关 `.h/.cpp` 同目录可直接编译。
2. 选择 **ESP32S3 Dev Module**，沿用这套硬件之前正常工作的 Flash、PSRAM、USB 等板卡设置；端口由用户选择实际板卡对应项。无需修改全局 IDE 配置。
3. 本机已核实 Arduino CLI 1.5.1、ESP32 Arduino core **3.3.12**、Adafruit GFX **1.13.0**、Adafruit BusIO **1.17.4**。沿用这些已安装版本，不安装或降级。SPI 由 ESP32 core 提供，不需要 ArduinoJson、GxEPD2、Wi-Fi 凭据或私有配置。
4. 先点击 **验证/编译**。构建成功后，再由用户手动点击 **上传**。Agent 只进行编译和主机测试，不操作上传、串口或设备。
5. 串口监视器选择 **115200**。USB CDC 沿用原来成功的设置；若使用 native USB 且看不到日志，再按实际连接方式核对 CDC 与端口，不统一要求修改 USB Mode。程序仅等待启动 250 ms，不会无限等待 USB 主机；若监视器错过启动日志，可打开监视器后手动复位一次，这会再触发一次完整刷新。

固定 GPIO：BUSY=4、CS=5、RST=16、DC=17、SCK=18、MOSI=13；沿用现有已确认接线。此 sketch 不为其他板卡或其他 JD79668 面板提供通用兼容保证。

## 预期画面与结果

400×300 白底画面显示 FocusDesk、`STATIC TEST`、固定诊断日期 `2026-11-02`、`FIXED SAMPLE / NO NETWORK` 和三条英文诊断任务。底部原颜色测试区已留白，不再绘制色块或 `BLACK`/`RED`/`YELLOW` 标签。三条任务依次为：

1. `Check display layout`，样例状态为勾选。
2. `Inspect text and boxes`，样例状态为未勾选。
3. `Inspect color patches`，样例状态为未勾选。

画面另有 `SYNTHETIC / NOT LIVE TASKS`。日期不是设备时钟，“完成”勾选也是合成样例，不代表自动完成硬件检查。英文只验证基础硬件与布局，不是中文产品页、共享任务 fixture 或实时今日任务。

串口先输出 `[FocusDesk] STATIC_TEST: SYNTHETIC DATA / NO NETWORK`。显示驱动返回成功时输出 **`[FocusDesk] DISPLAY_OK`**；失败时输出 **`[FocusDesk] DISPLAY_FAILED: SCREEN_STATE_UNKNOWN`**。`DISPLAY_OK` 表示驱动完成此次操作，实际字形及屏幕效果仍须人眼验收。

每次启动只调用一次刷新，`loop()` 只闲置，不自动重试或循环刷屏。原样驱动对上电/显示 BUSY 等待各设 60 秒上限，关电等待设 15 秒上限；失败可能需要等待超时退出。失败后物理画面可能已经改变，不能保证旧内容完整。保留日志并核对实物后，再由用户决定是否手动复位重试。

## 已执行的主机测试

在 `E:\FocusDesk` 的 PowerShell 中执行：

```powershell
$testBinary = Join-Path $env:TEMP 'focusdesk-static-page-test.exe'
& 'C:\Program Files\mingw64\bin\g++.exe' -std=c++17 -Wall -Wextra -Werror -I tests/firmware/driver_fakes tests/firmware/static_page_test.cpp firmware/focusdesk_static/gdem042f52_display.cpp -o $testBinary
if ($LASTEXITCODE -ne 0) { throw 'Host test compilation failed' }
& $testBinary
if ($LASTEXITCODE -ne 0) { throw 'Host tests failed' }
```

本轮在沙箱外实际编译并执行，通过两组行为检查：

- 直接执行真实 sketch 的 `setup()`、`loop()` 和 renderer，核查标题/固定日期/合成标识、任务顺序、一个已勾选与两个未勾选 checkbox、绘制和经典内置字体单元边界；文本列表无底部三个颜色标签，实际驱动输出的 30,000 字节画面中原色块/标签区域为白底；成功路径串口与闲置行为。
- 模拟上电及显示阶段 BUSY 卡住，核查有界退出、失败标识、未知屏幕状态，后续 `loop()` 不再刷新。

测试用替身记录 GFX 调用和字体单元尺寸，不模拟真实字形或屏幕波形。它不代替目标板编译、上传或真机显示。两份驱动与 GPL 正文的 SHA-256 已与参考项目核对一致，见 `firmware/THIRD_PARTY_NOTICES.md`。

历史记录：FW-S1 时 Tech Lead 的自动目标构建使用 `esp32:esp32:esp32s3`，源码生成目标文件后在链接阶段出现 `cannot find -lxtensa/-lesp*` 与中文用户路径乱码；工作区局部 ASCII 别名尝试也未完成成功构建。随后用户已反馈手动运行成功，Agent 未实测该画面。

上述历史路径排查未修改 IDE 全局配置或开发板包版本；一次 CLI 别名初始化自动安装了 builtin serial-monitor 0.15.0，未打开串口。所有自动编译现已退出。本次 FW-S2 只执行主机测试，未重新排查 CLI 路径、进行目标编译或上传新版。请继续沿用原 Arduino IDE 设置，先验证再手动上传新版；构建失败时提供首段报错，不上传。新版画面仍待用户运行核对；中文字库、真实任务接口及全链路同步尚未完成。上传会替换板上当前程序。
