# FocusDesk M2-RC1 脱敏固件应用源码

本目录面向审查和维护人员。普通试用者使用交付负责人提供的预刷设备，按公共包根目录的用户指南安装Windows应用并配网。

## 源码版本

目录包含P3构建18份项目输入中的17份公开运行源，保持原始字节与相对层级。构建时使用的本地热点凭据输入已排除。入口为 `firmware/focusdesk_device/focusdesk_device.ino`，对应SHA-256为 `961b43ece368d9fee6ae2555982675d6187cc91e653196a81befcc5439416188`。

原构建BIN的SHA-256为 `7837d38fbb231c3c211fe08d42816222298f3ed2bc2b7ba0b94f2030c8f564d4`，本批公共目录排除该文件。公开源附配置样例、密钥生成器、构建脚本、相关主机回归及合成fixtures。各文件哈希由包根目录的release-manifest与SHA256SUMS记录。

## 开发者重建

安装Arduino IDE、Arduino-ESP32 Core3.3.12、Adafruit GFX1.13.0及BusIO1.17.4。固定版本定位如下。

- Arduino-ESP32源位于 https://github.com/espressif/arduino-esp32/tree/3.3.12
- ESP-IDF源定位为 https://github.com/espressif/esp-idf/tree/b774170ff46
- GFX源位于 https://github.com/adafruit/Adafruit-GFX-Library/tree/1.13.0
- BusIO源位于 https://github.com/adafruit/Adafruit_BusIO/tree/1.17.4
- ArduinoJson原文件已包含，版本源定位为 https://github.com/bblanchon/ArduinoJson/tree/v7.4.2

以上为版本定位资料，Core/SDK及外部库完整源码通过对应项目取得。SDK组件和FreeSans字体来源材料的未决核查见包根目录THIRD_PARTY_NOTICES。

1. 维护人员使用Node.js24运行 `node scripts/prepare-provisioning-poc.mjs`，生成本地独立实验热点密钥和连接卡。
2. Arduino IDE打开 `firmware/focusdesk_device/focusdesk_device.ino`，Core Debug Level设为None。按实际板卡确认Flash、USB、分区及PSRAM。本批编译基线为通用ESP32-S3、4MB/default、PSRAM未启用。
3. 在IDE验证编译。维护人员通过另行授权的硬件准备流程上传和验收。重新生成热点密钥后得到的新镜像需要记录新哈希。
4. 命令行构建可用 `scripts/build-provisioning-poc.ps1 -SketchDirectory firmware/focusdesk_device`，先按自己的Arduino安装位置准备本机 `.cache/arduino-cli.yaml`。所需CLI配置和缓存由本机生成，源码包保留构建脚本。

主机回归位于tests/provisioning和tests/firmware，需要Node.js24及支持C++17的主机编译器。合成fixtures只用于测试，用户任务由Windows应用在独立用户目录初始化。

## 许可与分发范围

固件应用源按GPL-3.0-only，保留各文件原始版权声明。ArduinoJson及其他第三方声明按各自许可保留。项目内许可全文为 `firmware/LICENSE`，包根目录licenses同时提供已核对许可文本。

本源码集合覆盖项目应用层，外部Core/SDK、字体及新设备固件再分发的材料核查仍按THIRD_PARTY_NOTICES所列事项处理。本批采用现有预刷设备的软件试用方式，当前冻结固件镜像继续留在维护者本地。
