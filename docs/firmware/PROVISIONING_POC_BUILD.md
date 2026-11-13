# 独立配网 PoC 构建记录

本页只记录开发机编译、链接与工具环境。手机连接、AP+STA 信道切换和运行内存必须由板上测试确认，不能从编译结果推断。

## P2 NVS 实施与验证（2026-11-04）

独立实验已升级为Wi-Fi/Hub持久化配置。入口路径不变，Core仍为3.3.12。`config_store.h`实现版本化CRC双槽与选择标记，`nvs_config_store.h`适配同Core的原生NVS，`config_session.h`串行协调RAM候选验证、持久化及旧网络恢复；`hub_validation.h`提供有界HTTP头/JSON规模验证，实际Hub检查使用非阻塞SDK socket、6秒总期限及现有只读server-info接口。

电脑端已统一重新执行以下验证。

| 验证 | 实际结果 |
| --- | --- |
| 原P1输入/socket映射/状态测试 | 83条C++断言通过 |
| 配置校验、NVS提交、读写故障及断电边界 | 331条C++断言通过 |
| P2候选/重启恢复/失败回退/窗口取消状态机 | 81条C++断言通过 |
| Hub HTTP头与JSON规模校验 | 295条C++断言通过 |
| 页面实际JavaScript执行 | 32/32项Node测试通过 |

C++测试均以C++17及 `-Wall -Wextra -Werror` 实际编译运行，共790条断言；页面命令仍为 `node --test tests/provisioning/portal.test.mjs`。已核对正式联网sketch及两份显示驱动哈希与P1记录一致。

最终源码完整编译/链接成功，CLI退出码0，Core3.3.12，通用S3/Debug0配置，最终增量构建耗时264.3秒。9份源码哈希在构建前后及完成后核对一致。

| 编译项目 | P2最终结果 |
| --- | --- |
| Flash占用 | 891,116 / 1,310,720字节，67% |
| 静态RAM占用 | 51,180 / 327,680字节，15% |
| 链接报告动态预算 | 276,500字节，非运行heap |
| 应用.bin文件 | 891,264字节 |
| 应用.elf文件 | 11,162,712字节 |
| 应用.bin SHA-256 | `030391735d8e668e03a5af9ade1cfaea9708598f7e2f66b5a12d663a20d5a827` |

- 最终manifest `.cache/p1-builds/20261104-133930-e6383221/build-manifest.json`。
- 完整日志 `.cache/p1-builds/20261104-133930-e6383221/compile.log`。
- `.bin`、`.elf`、`.map`及bootloader/分区位于复用的 `.cache/p1-builds/20261104-005851-dcc87771/build/`，文件基名 `focusdesk_provisioning_poc.ino`。
- 构建脚本沿用 `scripts/build-provisioning-poc.ps1`，缓存目录的p1前缀是既有构建约定，目录内当前产物为P2。`.cache/p1-latest-build.json`已指向P2最终manifest。
- 整合期间的两次构建因源码继续修改被脚本哈希保护拒绝发布成功清单；上列最终构建使用冻结源码通过，不将中间产物作为交付版本。

下方P1容量和运行heap是历史版本数据，复用目录中的原P1文件已被本次P2构建更新。P2尚无用户上传结果，断电恢复、真实NVS写入和P2运行heap均为待实物验证。当前默认FQBN仅为编译配置，实际板型/Flash/PSRAM未新增实物确认。

闪存错误若发生在选择标记已落盘之后，读取持久状态可能得到已经通过验证的新配置。失败时会重读并恢复实际已发布记录，页面保留保存错误。未验证候选不会发布。Core在setup之前对特定损坏/满页/不兼容的默认NVS分区存在既有自动格式化行为，当前双槽不覆盖此分区级边界。配置以普通明文NVS存储，本轮没有启用NVS/Flash加密。

## P1 历史构建与实物记录

## 固定环境

- Arduino CLI 1.5.1，IDE 自带可执行文件。
- Arduino-ESP32 Core 3.3.12；底层 S3 SDK 为 ESP-IDF 5.5.5，包内 `network_provisioning` 为 1.0.2。
- 官方已安装 Xtensa 工具链 `esp-x32/2601`，GCC 14.2.0。
- 本 PoC 仅使用当前 Core 提供的运行库，不安装或升级依赖。
- 默认构建目标 `esp32:esp32:esp32s3`，Core Debug Level 固定为 0。
- 默认目标表示通用 ESP32-S3 **编译基线**，不能证明实物 Flash、PSRAM、USB 或分区设置。用户仍应沿用原 Arduino IDE 正常工作的实际设置。

## 重复构建

在项目根目录运行：

```powershell
.\scripts\build-provisioning-poc.ps1
```

需要显式指定 IDE 对应选项时，例如 native USB CDC：

```powershell
.\scripts\build-provisioning-poc.ps1 -Fqbn 'esp32:esp32:esp32s3:CDCOnBoot=cdc'
```

不要只凭本例更改原来正常工作的 USB 或 PSRAM 选项。脚本也可接受 `-ArduinoCli`、`-ToolchainRoot` 和 `-Jobs`；它不会下载工具、访问串口、上传、擦除 NVS 或修改全局配置。

每次构建创建 `.cache/p1-builds/<时间及随机后缀>/`，保留：

- `compile.log`：完整命令和编译输出；不读取正式 `private_config.h`。
- `build/`：应用 `.elf`、`.bin`、`.map`、分区及生成文件。
- `build-manifest.json`：源码哈希、编译选项、工具版本、产物哈希和编译容量汇总。

`.cache/p1-latest-build.json` 指向最近成功构建清单。只有 CLI 成功且应用 `.bin` 与 `.elf` 同时存在才报告完整编译成功。`staticRamUsedBytes` 是静态数据占用，**不是 Wi-Fi 工作时剩余 heap**；清单显式记为 `runtimeHeapMeasured:false`、`uploaded:false`。

## 本机工具问题及处理

1. 当前受限执行环境启动 Xtensa 编译器会遇到 Windows DLL 重定位错误；本轮已授权仅编译检查在受审查的沙箱外执行。不要求用户重装工具。
2. 旧完整构建失败还包含路径问题：平台预处理钩子使用 Windows `cmd COPY`，将 `compiler.sdk.path` 覆盖为 `E:/...` 时会报语法错误。脚本统一传入 Windows 反斜杠路径，不修改 Core。
3. 若已有 `.cache/arduino-data/packages/esp32/tools` 的同版本局部工具副本，脚本优先使用；否则使用原安装位置。没有复制全局库或改变系统 PATH。

## 实际结果

早期 Arduino WiFi 包装版本的 `.ino` 曾单独编译为 `.cache/p1-api-check.o`，退出码 0，目标文件 264,720 字节。随后发现包装层可能在设置 WPA2 密码前启动 AP，已停止该版构建，改用同一 SDK 的标准 ESP-IDF Wi-Fi 接口，先设安全配置再启动射频。旧目标文件只作为过程记录，不代表修正版已验证。

安全修正版再次单独编译通过（退出码 0），新 `.cache/p1-api-check.o` 为 219,784 字节，SHA-256 为 `D6D34510821A81725B628A5EF9139185AA9F4452825D8ACC6CE1144D126F0553`。本机 SDK 的原生 Wi-Fi、netif/事件 API 与 IPv4-mapped socket 处理均可编译；仍不是完整固件体积或运行 RAM。

2026-11-04，Tech Lead接手后使用Core3.3.12、默认通用S3配置、Debug0和原缓存，完整CLI编译及链接成功，退出码0，耗时533.8秒。没有借用其他工程的预编译Core归档。源码哈希在构建前后相同。

| 项目 | 实际结果 |
| --- | --- |
| Flash占用 | 865,756 / 1,310,720字节，66% |
| 静态RAM占用 | 44,364 / 327,680字节，13% |
| 链接报告剩余动态内存预算 | 283,316字节，非Wi-Fi运行后的heap |
| 应用.bin文件 | 865,904字节，包含固件镜像头部等开销 |
| 应用.elf文件 | 10,961,748字节，含调试/链接信息 |
| 应用.bin SHA-256 | `7938bf68ebffc70a73bc0553f74b5eed6844fe29e1531e0860acf2fd2ad41970` |

- 完整日志 `.cache/p1-builds/20261104-124713-25f074e5/compile.log`。
- 构建清单 `.cache/p1-builds/20261104-124713-25f074e5/build-manifest.json`，入口 `.cache/p1-latest-build.json`。
- 实际复用产物目录 `.cache/p1-builds/20261104-005851-dcc87771/build/`，含 `focusdesk_provisioning_poc.ino.bin`、`.elf`、`.map`及分区/bootloader。
- 重新运行C++17主机测试，83条断言通过；页面测试18/18通过。正式联网sketch和显示驱动哈希与前次记录一致，另核对M1的16份现存后端/前端构建/启动脚本payload文件，均与安装包manifest一致。

构建清单仍保留 `runtimeHeapMeasured:false`、`uploaded:false`，因为脚本只编译；下节用户反馈单独记录手动上传后的功能和运行内存，不将本次CLI产物视作已由Agent烧录。

## 用户手动真机反馈

2026-11-04，用户确认手机可以打开配置页面，ESP32试连后页面显示路由器IP；手机手动断开并重新加入设备热点后仍能查询连接结果。未回传具体IP及操作ID，因此记录为用户功能确认。

连接成功且手机重连后，用户抄录页面运行内存如下，单位为字节。

| 指标 | 实测值 |
| --- | --- |
| Internal heap free | 201,084 |
| Internal heap minimum | 176,576 |
| Largest internal block | 155,636 |

这组数值来自独立配网程序。尚无各启动阶段的串口采样、长期压力数据、原电子纸程序同期基线或集成后的实测内存。PSRAM和任务栈数据未回传。

错误密码试验中，用户反馈没有显示连接失败，等待后刷新可用。此反馈不足以确认失败提示、失败后恢复及旧IP保护的真机结果，保留为未确认。中文SSID/特殊字符未回传实测结果。正常配网流程已通过，当前按同学试用范围收尾，不继续要求用户追加手动测试。

最终源码变更后可保留原编译缓存增量重建，例如：

```powershell
.\scripts\build-provisioning-poc.ps1 -ReuseBuildDirectory '.cache\p1-builds\<之前构建目录>\build'
```

脚本只接受自己构建根目录中的既有 `build` 目录，不清理任何缓存。若编译期间源码改变，拒绝生成成功 manifest，应在源码冻结后重新构建。
