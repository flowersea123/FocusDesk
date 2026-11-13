# 固件与硬件准备状态

更新：2026-11-02，Asia/Shanghai。FW-P1 的只读检查已完成；用户随后确认沿用 Attention Router 同一块板、屏与接线，使用 Arduino IDE 手动操作。FW-S1 已准备独立静态 sketch 并完成主机行为测试；不把参考配置当成新的硬件实测结果。

## 当前已核实

| 项目 | 当前事实 | 限制 |
| --- | --- | --- |
| 板屏与接线 | 用户确认沿用原 ESP32-S3 + GDEM042F52/JD79668 及原接线；参考配置为 400×300、四色、rotation 0、完整刷新 | FocusDesk 画面尚未真机验收 |
| GPIO | BUSY=4、CS=5、RST=16、DC=17、SCK=18、MOSI=13 | 沿用原硬件，不由 Agent 调线或推断转接板 VCC |
| Arduino CLI | `%LOCALAPPDATA%\Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe`；Tech Lead 实测 1.5.1 | 不在 PATH 不代表未安装 |
| 本机依赖 | Tech Lead 核实 ESP32 core 3.3.12、Adafruit GFX 1.13.0、BusIO 1.17.4 | 沿用已安装版本；不降级到参考项目历史版本 |
| 主机编译器 | `C:\Program Files\mingw64\bin\g++.exe`；沙箱外可运行 8.1.0 | 先前沙箱内 DLL 重定位失败不能据此认定全机工具损坏 |
| 主机测试 | FW-S1 实际 sketch/renderer/原样驱动以 C++17、`-Wall -Wextra -Werror` 编译运行，成功/超时/闲置检查通过 | GFX/SPI 使用测试替身，不是像素字形/波形或真机验证 |
| 驱动与许可 | 只原样复用 `gdem042f52_display.h/.cpp`，保留作者与 GPL-3.0-only；GPL 正文同样原样复制，三者哈希一致 | 本静态测试固件保留 GPL-3.0-only，不替整个 FocusDesk 定发行许可 |
| Sketch | `firmware/focusdesk_static/focusdesk_static.ino`；静态合成英文任务、一次刷新、无网络 | 英文只作硬件诊断，不代表中文产品与共享任务完成 |

具体打开/验证/手动上传步骤、测试命令和预期标识见 `STATIC_DISPLAY.md`。来源和 SHA-256 见 `firmware/THIRD_PARTY_NOTICES.md`。

## FW-P1 历史检查及其解释

- `Get-Command` 当时未定位 Arduino CLI/CMake/ESP-IDF CLI/PlatformIO；参考项目 `.build/toolchain/` 的 CLI 与配置文件也不存在。后来用真实用户目录定位到 IDE 自带 CLI，不能再以 PATH/沙箱内候选路径缺失认定未安装。
- 当时 `g++ --version` 在沙箱内报“无效的系统 DLL 重定位”。后续沙箱外可执行，并完成主机测试，不需要修复或重装。
- `python`/`py` 当时只定位到 WindowsApps 启动器，版本未验证；此静态测试不依赖 Python。
- 只读 `[System.IO.Ports.SerialPort]::GetPortNames()` 曾返回 COM3、COM4，`Get-PnpDevice` 的 CIM 访问失败，未能映射实际设备。这些端口没有被打开，也不能据此认定板卡端口；由用户在 IDE 中沿用实际连接。

## 下一步与剩余输入

| 步骤 | 状态与产物 | 需要的后续动作 |
| --- | --- | --- |
| 1 独立静态页与主机验证 | FW-S1 已完成；无旧 config/private config/Hub/Scene/业务代码 | Tech Lead 目标板仅编译，记录实际 FQBN/选项及结果 |
| 2 Arduino IDE 手动实测 | 程序与操作说明已准备 | 用户沿用原 IDE 板卡/USB/Flash/PSRAM 设置，先验证再手动上传；记录实际端口、日志、画面与颜色，不需重复确认例行驱动复用 |
| 3 中文与共享任务显示 | 尚未实现；静态英文诊断不覆盖 | 落实可用字体、字符范围及许可；按共享 fixture 设计文字与容量验证 |
| 4 JSON 解析/网络页 | 尚未实现 | Tech Lead/B 冻结候选契约；另行分配固件实现和测试，B 提供唯一服务与局域网地址，不另建后端 |
| 5 Web→Backend→ESP32→屏幕 | 尚未开始真机联调 | 同一服务、真实设备与对照记录；分别报告主机测试、目标编译和屏幕实测 |

参考项目历史版本（CLI 1.5.1、core 3.3.1、ArduinoJson 7.4.2、GFX 1.12.6、BusIO 1.17.4）不等于本机当前依赖。当前静态页只需本机已核实 core/GFX/BusIO 与 SPI；以后添加 JSON 解析时再固定所选库版本，不提前引入 ArduinoJson/GxEPD2/Wi-Fi。

## 网络阶段保留的候选约束

- 唯一来源为 `docs/API_CONTRACT.md`，当前未与 B 冻结。候选 0–3 条任务、解码后 JSON body ≤4 KiB，标题最多 40 Unicode 码点且 ≤160 UTF-8 字节；body 上限不等于 JSON 对象、字体或 framebuffer 总内存上限。静态诊断程序尚不实现这些解析规则。
- 网络/HTTP/解析失败不发起刷新，不覆盖最后有效快照；合法空列表显示无任务。显示失败保留逻辑记录、不推进成功版本，实际屏幕状态未知；不能保证旧画面完整。
- 只有屏幕状态有效且 `revision` 等于已成功显示版本才跳过。显示失败后即使恢复到历史成功 revision 也须受控恢复。网络轮询/退避和最短刷新间隔需独立实测；本静态页每次启动只刷一次，失败不自动重试。
- 若字体/面板无法完整显示候选上限，先与 Tech Lead 调整规则和预览，不静默删任务或丢字符。真实今日日期由 Backend 按约定时区给出；本诊断页的固定日期不作替代。
