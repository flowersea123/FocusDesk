# FocusDesk M2-RC1 发布清单

记录日期为2026-11-07。公共交付目录计划为 `dist/releases/FocusDesk-M2-RC1-preflashed/`，版本标签用于发布组合，Windows程序版本保持0.1.0。

## Windows安装包

| 项目 | 已核对值 |
| --- | --- |
| 文件 | FocusDesk-Setup.exe |
| 应用版本 | 0.1.0，由匹配manifest和payload package.json确认 |
| 文件大小 | 24,686,884字节 |
| SHA-256 | `d5b23bc2476d60d0698fbf31772007740eba367951986f4c8cbc86a2f1fec4ec` |
| Node运行时 | 官方Windows x64 v24.16.0，匹配payload实测版本 |
| Node可执行文件SHA-256 | `b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3` |
| 构建器 | Inno Setup6.7.4，原生Win32启动器 |
| 签名 | NotSigned |
| payload审核 | 27/27文件大小与哈希匹配，额外/缺失/禁止路径为0 |

现有安装包源位置为 `.cache/m1-dist/FocusDesk-Setup.exe`。本轮复用现有字节。PE ProductVersion为0.1.0，FileVersion字段为空，版本同时由manifest及匹配package.json核对。未重新安装、独立提取或重建原安装包，本轮以匹配staging与既有验收报告复核安装行为。

## 固件冻结基线

以下固件文件已在本地核验，按用户批准的预刷设备模式留在本地。

| 对象 | 字节 | SHA-256 |
| --- | ---: | --- |
| focusdesk_device.ino | 2,164 | `961b43ece368d9fee6ae2555982675d6187cc91e653196a81befcc5439416188` |
| focusdesk_device.ino.bin | 987,808 | `7837d38fbb231c3c211fe08d42816222298f3ed2bc2b7ba0b94f2030c8f564d4` |
| focusdesk_device.ino.elf | 12,674,240 | `1faf7d733409f9e9dd7a4fa8b9d88a4eceae322a3433d8af0892df0cb1dd4d77` |
| focusdesk_device.ino.map | 14,654,595 | `d4b79d961ab5658e34e1434e090be1cb08b3326f20d192da3081e60a14b8b2b5` |

原固件位置由 `.cache/device-latest-build.json` 指向的构建manifest定位。本次固定manifest为 `.cache/device-builds/20261107-144919-828c58ca/build-manifest.json`，复用产物目录为 `.cache/p1-builds/20261104-005851-dcc87771/build/`。

固件内置测试AP热点凭证，具备二进制提取条件。原BIN、ELF、MAP、merged镜像、bootloader/分区二进制均排除公共目录，防止绕过批准的固件准入边界。单独交付热点连接卡和准备硬件由交付负责人执行。

## 构建环境及依赖

| 项目 | 固定记录 |
| --- | --- |
| Arduino-ESP32 Core | 3.3.12 |
| 底层SDK | ESP-IDF5.5.5，包内commit b774170ff46 |
| Arduino CLI | 1.5.1 |
| 编译器 | esp-x32/2601，GCC14.2.0 |
| FQBN | esp32:esp32:esp32s3 |
| 编译基线 | 4MB、default分区、memory_type qio_qspi、Debug0 |
| Adafruit GFX | 1.13.0 |
| Adafruit BusIO | 1.17.4 |
| Wire/SPI | 3.3.12 |
| ArduinoJson | 7.4.2，项目内原文件 |
| Flash占用 | 987,661 / 1,310,720字节，75% |
| 静态RAM占用 | 83,372 / 327,680字节，25% |

编译配置与此前成功P2构建属性一致。具体硬件Flash/PSRAM沿用已工作IDE配置。静态RAM和链接剩余预算分别记录，运行时heap由H7后续测量。

## 源码和文档版本

项目当前没有Git元数据，采用文件SHA-256冻结版本。18份本地构建输入核验一致，公共应用源码保留其中17份，含真实AP密钥的输入排除。公开源码保留原目录层级，另含配置模板、准备/构建脚本、相关回归源码及合成fixtures。真实任务文件与个人配置排除。

发布文档采用M2-RC1/2026-11-07标签。公共目录的 `release-manifest.json` 记录实际文件角色和哈希，`SHA256SUMS.txt` 校验除其自身之外的全部文件。两份清单随最终装配生成，当前发布说明自身的最终字节也由该校验清单覆盖。

源码包用于审查和构建准备。开发者以配置模板生成本地独立热点密钥，所得新镜像需要单独记录哈希和验收，当前冻结BIN继续受分发限制。用户安装与设备连接见 [用户指南](USER_GUIDE.md)，预刷与源码前提见 [固件说明](FIRMWARE_UPLOAD.md)。
