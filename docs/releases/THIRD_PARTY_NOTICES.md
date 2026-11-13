# FocusDesk M2 RC1 第三方许可与对应源码说明

核对日期为2026-11-07。本次发布固定现有Windows安装包0.1.0与P3统一设备固件，M2 RC1为交付批次标识。

本批公开试用包采用“预刷设备”模式，包含安装包、使用文档和脱敏项目源码。当前BIN、ELF、MAP及热点连接卡由维护者本地保管。源码样例由重建者生成自己的实验热点密钥。项目源与已经vendored的ArduinoJson随包提供，Core、Adafruit库及SDK使用发布说明中的固定版本来源取得。

## 固件许可

FocusDesk固件文件保留各自SPDX及版权声明，整体固件源采用GPL-3.0-only。公开包中的许可全文位于 `source/firmware/LICENSE`，对应源树内路径为 `firmware/LICENSE`，根目录licenses另附原文。JD79668/GDEM042F52显示驱动保留 `Copyright 2026 flowersea123` 和GPL-3.0-only声明。FocusDesk固件其他自有源保留其文件内的贡献者声明。

分发固件二进制时，应随该交付提供对应项目源码、构建脚本、所需依赖来源和许可。用户可根据本文所列源树重新构建并通过Arduino工具上传。设备是否允许安装修改后的固件及相关安装信息，应与实际硬件交付方式一致。

预刷设备上的固件交付同样涉及对应源码要求。当前脱敏源包覆盖以下项目源集合，完整Core/SDK依赖对应材料的核对状态见本文末节。

该许可说明覆盖固件。Windows应用自有代码的整体发行许可需由项目所有者确定，现有固件许可范围不会据此扩展成整套应用的许可声明。

## 已核对的依赖

| 组件 | 固定版本与核对事实 | 许可材料及对应来源 |
| --- | --- | --- |
| ArduinoJson | 单头文件内版本7.4.2，MIT，Copyright 2014–2025 Benoit BLANCHON | `firmware/focusdesk_live/src/ArduinoJson.h` 与 `ArduinoJson.LICENSE.txt` |
| Adafruit GFX | 已安装1.13.0，`license.txt`为BSD二条款，Copyright 2012 Adafruit Industries | 随包保留许可，固定版本来源用于取得库和Fonts源 |
| Adafruit BusIO | 已安装1.17.4，MIT，Copyright 2017 Adafruit Industries | 随包保留许可，固定版本来源用于取得完整库源 |
| Arduino-ESP32 | 已安装3.3.12，`package.json`标记LGPL-2.1-or-later，`cores/esp32/Arduino.h`保留LGPL2.1或后续版本声明 | LGPL2.1全文、源内声明和版本材料，Core源码按固定来源取得 |
| ESP32-S3 SDK | 当前版本文件记录ESP-IDF v5.5.5，提交 `b774170ff46` | 已固定版本，完整组件源码/许可映射仍为待核对项 |
| Node.js Windows x64 | 已有安装包随附24.16.0运行时，主许可为MIT，许可证文件同时包含Node第三方组件通知 | 安装payload中的 `runtime/LICENSE` 原文 |
| React、React DOM、scheduler | 原安装payload已分别附MIT许可证，Copyright Meta Platforms, Inc. and affiliates | `licenses/react.LICENSE.txt`、`react-dom.LICENSE.txt`、`scheduler.LICENSE.txt` |
| Inno Setup | 构建工具6.7.4，许可原文包含Jordan Russell及Martijn Laan版权和再分发条件 | 所用工具的 `license.txt` 作为补充通知 |
| GCC/MinGW运行时 | Windows启动器构建参数包含静态libgcc、libstdc++及pthread链接 | 对应GCC运行时例外、GCC许可、MinGW-w64及winpthreads实际通知 |

Node、React和编译器的通知应采用原文文件。本文中的摘要与版本表同原文一并提供。

## 对应项目源码的最小文件集合

P3构建清单记录18份项目源输入，其中一份为仅包含实验热点凭据的本地 `private_config.h`。公开源码保留其余17份运行源、配置样例及生成器，保持下面的相对目录层级。

```text
firmware/
  LICENSE
  focusdesk_device/
    focusdesk_device.ino
    display_driver.cpp
    display_sync.h
    README.md
  experiments/focusdesk_provisioning_poc/
    focusdesk_provisioning_poc.ino
    poc_logic.h
    config_store.h
    nvs_config_store.h
    config_session.h
    hub_validation.h
    portal_page.h
    private_config.example.h
    README.md
  focusdesk_live/
    config.h
    gdem042f52_display.h
    gdem042f52_display.cpp
    live_model.h
    live_page.h
    live_state.h
    src/
      ArduinoJson.h
      ArduinoJson.LICENSE.txt
scripts/
  build-provisioning-poc.ps1
  prepare-provisioning-poc.mjs
```

统一入口通过父目录相对包含复用配网和显示源，完整源树层级是构建输入的一部分。配套测试可附在 `tests/provisioning` 和 `tests/firmware`，用于重跑输入、NVS、传输、任务、专注和刷新保护回归。

项目源码包同时应附当前构建manifest的脱敏副本、Core/SDK版本、Adafruit依赖版本、编译配置及本文。公开清单保留源路径和哈希时应移除开发机用户目录与本地凭据文件项。

原构建热点密钥由发布者单独管理。重建者运行生成器生成自己的实验热点密钥，所得固件哈希随密钥变化。SSID、路由器密码、Hub地址和任务数据由用户配置或在运行时取得。

## 重建与安装资料

1. 按原目录层级取得上述项目源、Core3.3.12、Adafruit GFX1.13.0及BusIO1.17.4。
2. 开发者可运行 `node scripts/prepare-provisioning-poc.mjs` 生成自己的实验热点密钥。脚本保留已存在的本地配置。
3. Arduino IDE打开 `firmware/focusdesk_device/focusdesk_device.ino`，使用Core3.3.12，Core Debug Level设为None。按实际板卡确认USB、Flash、分区和PSRAM设置。
4. 当前可重复编译基线为 `esp32:esp32:esp32s3`、4MB/default、PSRAM未启用，SDK记为ESP-IDF5.5.5。该配置是已构建工件的配置，实物容量依据对应硬件记录。
5. 命令行开发者可使用 `scripts/build-provisioning-poc.ps1 -SketchDirectory firmware/focusdesk_device`。脚本需要Arduino IDE随附的Arduino CLI和本机 `.cache/arduino-cli.yaml`，开发者须按自己的安装位置配置其中的 `directories.data`、`directories.downloads` 和 `directories.user`。该配置是机器本地材料。脚本仅编译，记录所有项目包含源的哈希和最终 `.bin/.elf/.map`。Arduino IDE验证/上传流程也可直接使用完整项目源。
6. 手动上传和偏移说明见本目录 `FIRMWARE_UPLOAD.md`。预刷设备的试用者按普通用户流程供电和配网。

## 本次许可核对的具体未决项

- 本机已安装Core3.3.12源码目录可用，共2,184个文件、77,439,567字节。目录保留了源文件内的LGPL声明及 `libb64` 许可，包内文件名核对未找到顶层LGPL许可全文。本机GCC许可目录中的 `COPYING.LIB` 已确认是完整LGPL2.1标准文本，可作为许可全文随包补充；该标准文本与Core的LGPL2.1-or-later声明一并保留。完整Core依赖来源及对应源码交付仍需按本批实际清单核对。
- 当前SDK工具目录主要提供头文件、链接脚本和预编译静态库，文件名核对未找到完整SDK许可集合。SDK含多种组件及无线预编译部分，完整依赖源码/许可材料仍需逐项对应实际链接输入。
- 已使用GFX内的 `FreeSans9pt7b`、`FreeSansBold9pt7b`、`FreeSansBold12pt7b`、`FreeSansBold24pt7b`。本地GFX包的总许可为BSD，所核对字体头本身没有独立字体来源许可文本，相关字体来源材料应随完整依赖材料补齐。

本轮已核对应用源、项目内vendored源和表中本地许可文本。独立固件二进制分发之前仍需补齐SDK组件及字体来源许可材料。预刷设备的对应源码交付也应持续对应实际硬件上的固件版本。以上记录本机实际可验证的材料和缺口，发布审核应依据原始许可全文及完整分发内容完成。
