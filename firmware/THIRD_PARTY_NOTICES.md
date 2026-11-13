# FocusDesk 演示固件的来源与许可

本说明适用于 `firmware/focusdesk_static/` 静态硬件测试固件和 `firmware/focusdesk_live/` 联网演示固件。复用驱动及新写的演示程序保留 `GPL-3.0-only`，完整 GNU GPL version 3 正文见同目录下的 `LICENSE`。下述 ArduinoJson 保留原 MIT 许可。这不决定整个 FocusDesk、Web Dashboard 或 Backend 的发行许可。

## 原样复制的文件

来源：用户本机参考项目 `E:/attention-router-s3-jd79668`。以下文件未修改字节，保留原 SPDX 与作者标记。

| FocusDesk 路径 | 来源项目路径 | 作者/来源与许可 | SHA-256 |
| --- | --- | --- | --- |
| `firmware/focusdesk_static/gdem042f52_display.h` | `firmware/esp32_dashboard/gdem042f52_display.h` | 2026 flowersea123；GPL-3.0-only | `31095AA37EF735FB3A23879C8A73E36D5DE405D141FA16036D0950461B4A6663` |
| `firmware/focusdesk_static/gdem042f52_display.cpp` | `firmware/esp32_dashboard/gdem042f52_display.cpp` | 2026 flowersea123；GPL-3.0-only | `3F94E4432F6D6BCBAC0DF5F256C729445E96E7A94CC32D290FE532B8655DB201` |
| `firmware/LICENSE` | `firmware/LICENSE` | GNU GPL version 3 正文，Free Software Foundation | `8CEB4B9EE5ADEDDE47B31E975C1D90C73AD27B6B165A1DCD80C7C545EB65B903` |

联网 sketch 的 `firmware/focusdesk_live/gdem042f52_display.h` 与 `.cpp` 从已保留的静态 sketch 原样复制，其 SHA-256 分别与上表两份驱动一致；作者与 SPDX 未修改。

参考项目 `firmware/LICENSING.md` 说明驱动初始化值核对过 Good Display 的 `A32-GDEM042F52-20240618.rar` Arduino 示例，资料入口为 [Good Display 产品页](https://www.good-display.com/product/564.html)。本项目未复制或分发厂商压缩包、位图或字体，也不对其重新授权。

## 本次新写内容与外部依赖

`focusdesk_static.ino`、`config.h`、`static_page.h` 及本次 `tests/firmware/` 中测试代码为独立新写的诊断实现，标注 GPL-3.0-only。新配置只定义面板选择与六个 GPIO；没有复制原项目 config、私有配置、Hub、Scene、API 或业务代码。

静态 sketch 的运行依赖由本机 Arduino 环境提供：ESP32 Arduino core（含 SPI）、Adafruit GFX、Adafruit BusIO。未将这些外部库复制进 FocusDesk；各库保留其上游许可。当前构建使用的版本与复现步骤见 `docs/firmware/STATIC_DISPLAY.md`。静态 sketch 不依赖 GxEPD2、ArduinoJson、Wi-Fi 或 Backend。

## 联网演示与 ArduinoJson 7.4.2

`firmware/focusdesk_live/` 中新的 config、示例私有配置、model/state/page 和 sketch，以及 `tests/firmware/live*` 中新写的测试，标注 GPL-3.0-only。未复制其他项目的私有配置或联网业务代码。联网 sketch 使用 ESP32 core 自带的 WiFi/HTTPClient/SPI、已安装的 GFX/BusIO，以及下列项目局部 vendor；不需要用户全局安装 ArduinoJson。

| 本地文件 | 官方来源 | 保留许可与 SHA-256 |
| --- | --- | --- |
| `firmware/focusdesk_live/src/ArduinoJson.h` | [官方 v7.4.2 release 单头文件](https://github.com/bblanchon/ArduinoJson/releases/download/v7.4.2/ArduinoJson-v7.4.2.h) | Copyright © 2014–2025 Benoit BLANCHON，MIT；`A05AC98F4481D2398C103CA5FFCCE8E2FCD7FA2FA1D8D9F38D5757454F448D97` |
| `firmware/focusdesk_live/src/ArduinoJson.LICENSE.txt` | [同一 tag 的 LICENSE.txt](https://raw.githubusercontent.com/bblanchon/ArduinoJson/v7.4.2/LICENSE.txt) | 原样 MIT 正文；`EBBA0906D6C8B3DAA8A1B59ACB2D3A416485DD77FC10F6DD4C9ED2CBE467EE2D` |

上述两个下载文件未修改；单头版本宏为 `7.4.2`。联网依赖、操作与验证边界见 `docs/firmware/LIVE_DISPLAY.md`。

本轮不提供固件二进制发行包。以后如分发修改版、组合固件或设备，应针对实际组合保留通知并落实 GPLv3 对应源码、构建/安装材料及其他适用要求，不能仅凭这份文件宣称整个发行合规已完成。
