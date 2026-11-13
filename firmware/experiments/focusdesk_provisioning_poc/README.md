# P2 NVS 持久化配置实验

需要同时配网并同步电子纸时，打开 [统一设备固件](../../focusdesk_device/README.md)，上传 `firmware/focusdesk_device/focusdesk_device.ino`。本目录继续用于独立配置验证。

入口为同目录 `focusdesk_provisioning_poc.ino`，沿用已验证的P1热点和页面。本版保存Wi-Fi名称、密码和Hub地址，启动时恢复，并支持通过同一页面修改。Core固定 **Arduino-ESP32 3.3.12**。

## 手动使用

1. 在Arduino IDE打开本目录sketch，沿用原板型、USB、Flash及分区设置，Core Debug Level设为None。普通上传保留NVS；Erase All Flash Before Sketch Upload设为Disabled。上传和串口操作由用户执行。
2. 首次开发准备沿用 `node scripts/prepare-provisioning-poc.mjs`。现有本地配置会保留。独立热点密码由用户在 `E:\FocusDesk\.cache\p1-local\connection.txt` 查看，勿发送密码或私有文件。
3. 电脑启动FocusDesk，在设备连接页面复制当前ESP32 API地址，例如 `http://192.168.1.10:8787/api/v1/daily-overview`。Hub也支持只填 `http://192.168.1.10:8787`。电脑和设备需能在同一局域网互访，保存时Hub需在线。
4. 手机连接 `FocusDesk-Setup-XXXXXX` 热点，浏览器打开 **http://192.168.4.1**，填写路由器的2.4GHz Wi-Fi名称、密码和Hub地址，点击 **Save and connect**。
5. 手机如果因信道切换掉线，重新连接同一热点并打开页面。等待页面明确显示配置已保存，单独获得IP还处于验证过程。
6. 断电再上电，设备自动读取NVS并连接已保存的Wi-Fi。启动后的10分钟内也可重新进入热点页面查看结果或修改配置。
7. 修改Wi-Fi或电脑IP时，按RST重新打开10分钟窗口，再提交完整配置。设备后台重连期间也允许修改。

热点继续使用本地随机独立WPA2密码。首次缺少本地密钥时编译会提示运行生成器。不会在网页、串口或日志中输出Wi-Fi密码。

## 保存与恢复规则

- 请求先经过字段、UTF-8长度、密码和Hub地址校验，候选只进入RAM。
- 先断开原关联，等待断开事件，随后要求新GOT_IP、目标SSID匹配及非零STA地址，避免同SSID错误密码沿用旧连接结果。
- Wi-Fi成功后验证现有Hub的 `GET /api/v1/server-info`，要求HTTP200、有效JSON、FocusDesk服务名称及匹配端口。连接/收发总期限6秒，响应头最多2048字节、正文最多4096字节，限制JSON深度和节点预算。
- 通过Wi-Fi和Hub验证后，写入NVS命名空间 `focusdesk_p2`。记录含版本、generation和CRC，双槽先写入/提交/读回校验，再发布选择标记。
- Wi-Fi、Hub失败及窗口到期均取消未保存候选，保留原配置并重连。第一次配网失败则继续等待新提交。
- 页面分别显示最近提交结果和当前Wi-Fi状态。旧网络重连成功后，失败候选仍显示失败。
- 保存记录在启动时恢复，网络断开后先等待10秒再尝试重连，每次Wi-Fi试连期限30秒。重连不反复写入NVS。
- AP和网页窗口10分钟后关闭，已保存Wi-Fi的连接与重试继续运行，按RST重新进入修改窗口。

闪存接口可能在数据已经落盘后返回错误。此时重新读取持久选择标记决定恢复哪个已验证配置，页面仍保留保存错误提示。断电边界允许恢复到旧配置或已验证的新配置，未验证的候选始终不会成为有效配置。旧配置槽的字节保留至下一轮成功更新复用该槽。

## 配置及实验范围

- Wi-Fi名称为1–32个UTF-8字节，保留空格和特殊字符；密码为8–63个可打印ASCII字符。继续支持个人WPA2兼容网络。
- Hub支持HTTP IPv4和1–65535端口，支持origin或现有完整daily-overview地址，持久化为规范origin。回环、未指定、多播、AP重叠网段和歧义前导零地址会被拒绝。
- NVS采用本地明文配置存储，本轮没有启用NVS加密或Flash Encryption。设备配置页面仅在受密码保护的AP上可访问。
- Core3.3.12在应用setup之前会对特定损坏/不兼容的默认NVS分区执行自动格式化。双槽覆盖正常写入及断电事务；分区损坏、变更分区表或用户选择擦除Flash仍可能清除配置。
- 用户确认ESP32-S3及BOOT/RST，具体厂商/模组后缀与PSRAM仍未确认。实验不分配新GPIO。
- 原JD79668接线记录为BUSY4、CS5、RST16、DC17、SCK18、MOSI13。本实验独立运行，后续阶段再把配置读取接入正式电子纸固件。

设备内部接口的字段和错误语义见 [统一契约](../../../docs/API_CONTRACT.md)。构建命令仍为 `scripts/build-provisioning-poc.ps1`，工具版本及实际产物见 [构建记录](../../../docs/firmware/PROVISIONING_POC_BUILD.md)。

## P2 手动验收

| 操作 | 预期结果 | 实物记录 |
| --- | --- | --- |
| 正确Wi-Fi及在线Hub保存 | 显示配置已保存 | 待上传P2验证 |
| 拔电再上电，不重新填写 | 自动连接已保存Wi-Fi，页面显示已保存Hub | 待验证 |
| 修改为另一可用Wi-Fi/Hub | 验证并保存，重启后使用新配置 | 待验证 |
| 同SSID填错密码 | 约30秒失败，恢复旧Wi-Fi，重启保留旧配置 | 待验证 |
| 正确Wi-Fi但填不可达/非FocusDesk Hub | 显示Hub失败，旧配置保留 | 待验证 |
| 提交途中断电 | 重启加载旧配置或已经完成验证并提交的新配置 | 待验证 |
| 窗口结束后路由器短暂离线 | 设备继续自动重连，RST可重新编辑 | 待验证 |

P1实物正常流程及运行heap测量属于上一版本，保留在构建记录中。P2运行heap与上述断电/回退行为仍需用户手动验证。

源码许可为GPL-3.0-only，正文见 `firmware/LICENSE`。
